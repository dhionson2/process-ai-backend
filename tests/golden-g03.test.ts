import { test } from 'node:test';
import assert from 'node:assert/strict';
import { g03ReimbursementProcessSpec as spec } from './fixtures/g03-reimbursement.js';
import { validateFormSubmission, validateProcessSpec } from '../src/modules/validation/validation.service.js';
import { generateArtifacts } from '../src/modules/generation/artifact-generator.js';
import { analyzeNumericXor } from '../src/modules/validation/numeric-xor.js';

const nodeById = new Map((spec.nodes as any[]).map(node => [node.id, node]));
const flowById = new Map((spec.flows as any[]).map(flow => [flow.id, flow]));
const routesFrom = (source: string) => (spec.flows as any[]).filter(flow => flow.source === source);
function reachable(from: string, to: string): boolean {
  const visited = new Set<string>(); const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    if (id === to) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const flow of routesFrom(id)) if (!visited.has(flow.target)) queue.push(flow.target);
  }
  return false;
}

test('G03 fixture validates and proves the two independent rework cycles and approval paths', async () => {
  const validation = await validateProcessSpec(spec);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  assert.ok(validation.diagnostics.every(item => item.severity === 'warning' && item.code === 'GATEWAY_CONDITION_UNPROVABLE'), JSON.stringify(validation.diagnostics));

  const requiredNodes = [
    'start', 'manager_check', 'completeness_gateway', 'employee_adjust', 'manager_approval', 'manager_decision_gateway',
    'amount_gateway', 'director_approval', 'director_decision_gateway', 'finance_check', 'documents_gateway',
    'employee_correct_docs', 'finance_eligibility', 'reimbursability_gateway', 'finance_register', 'end_manager_rejected',
    'end_director_rejected', 'end_not_reimbursable', 'end_registered',
  ];
  for (const id of requiredNodes) assert.ok(nodeById.has(id), `missing node ${id}`);
  assert.ok((spec.nodes as any[]).every(node => node.type !== 'serviceTask'), 'all activities must remain human');
  assert.ok((spec.nodes as any[]).filter(node => node.type === 'userTask').every(node => node.roleId && spec.roles.some(role => role.id === node.roleId)));
  const expectedRoles: Record<string, string> = { manager_check: 'manager', employee_adjust: 'employee', manager_approval: 'manager', director_approval: 'director', finance_check: 'finance', employee_correct_docs: 'employee', finance_eligibility: 'finance', finance_register: 'finance' };
  for (const [id, roleId] of Object.entries(expectedRoles)) assert.equal(nodeById.get(id)?.roleId, roleId);
  for (const flow of spec.flows as any[]) {
    assert.ok(nodeById.has(flow.source), `${flow.id} has a missing source`);
    assert.ok(nodeById.has(flow.target), `${flow.id} has a missing target`);
  }

  assert.equal(flowById.get('f_adjust_return')?.source, 'employee_adjust');
  assert.equal(flowById.get('f_adjust_return')?.target, 'manager_check');
  assert.equal(reachable('employee_adjust', 'manager_approval'), true);
  assert.equal(flowById.get('f_docs_return')?.source, 'employee_correct_docs');
  assert.equal(flowById.get('f_docs_return')?.target, 'finance_check');
  assert.notEqual(flowById.get('f_adjust_return')?.target, flowById.get('f_docs_return')?.target);
  assert.equal(reachable('employee_correct_docs', 'manager_approval'), false);
  assert.equal(reachable('employee_correct_docs', 'director_approval'), false);
  assert.equal(reachable('employee_correct_docs', 'finance_check'), true);

  assert.equal(flowById.get('f_amount_low')?.target, 'finance_check');
  assert.equal(flowById.get('f_amount_low')?.condition.op, 'lte');
  assert.equal(flowById.get('f_amount_low')?.condition.right.literal, 2000);
  assert.equal(flowById.get('f_amount_high')?.target, 'director_approval');
  assert.equal(flowById.get('f_amount_high')?.condition.op, 'gt');
  assert.equal(flowById.get('f_amount_high')?.condition.right.literal, 2000);
  assert.equal(flowById.get('f_director_approved')?.target, 'finance_check');
  assert.equal(reachable('finance_check', 'manager_approval'), false);
  assert.equal(reachable('finance_check', 'director_approval'), false);

  for (const [flowId, endId] of [['f_manager_rejected', 'end_manager_rejected'], ['f_director_rejected', 'end_director_rejected'], ['f_not_reimbursable', 'end_not_reimbursable']] as const) {
    assert.equal(flowById.get(flowId)?.target, endId);
  }
  assert.equal(reachable('start', 'end_registered'), true);

  const variables = new Map((spec.variables as any[]).map(variable => [variable.key, variable]));
  assert.equal(variables.get('requested_amount')?.type, 'decimal');
  assert.equal(flowById.get('f_amount_low')?.condition.left.var, 'requested_amount');
  assert.equal(flowById.get('f_amount_high')?.condition.left.var, 'requested_amount');
  assert.deepEqual(analyzeNumericXor(routesFrom('amount_gateway'), spec.variables as any[]), []);

  const forms = new Map((spec.forms as any[]).map(form => [form.id, form]));
  const request = forms.get('form_request') as any;
  const requestKeys = new Set(request.fields.map((field: any) => field.key));
  for (const key of ['employee_name', 'department', 'expense_type', 'expense_date', 'requested_amount', 'justification', 'receipt_reference']) {
    assert.ok(requestKeys.has(key));
    assert.equal(request.fields.find((field: any) => field.key === key)?.required, true, `${key} must be required`);
  }
  const register = forms.get('form_register') as any;
  for (const key of ['approved_amount', 'payment_date', 'finance_reference', 'finance_notes']) assert.ok(register.fields.some((field: any) => field.key === key));
  for (const node of spec.nodes as any[]) if (node.formId) assert.ok(forms.has(node.formId), `${node.id} form missing`);
  for (const form of spec.forms as any[]) for (const field of form.fields) assert.ok(variables.has(field.bindTo), `${form.id}.${field.key} variable missing`);

  assert.deepEqual(await validateFormSubmission(spec, 'form_manager_approval', { manager_approved: true }), { valid: true, diagnostics: [] });
  assert.equal((await validateFormSubmission(spec, 'form_manager_approval', { manager_approved: false, manager_rejection_reason: '' })).valid, false);
  assert.equal((await validateFormSubmission(spec, 'form_director_approval', { director_approved: false, director_rejection_reason: '' })).valid, false);
  assert.equal((await validateFormSubmission(spec, 'form_finance_check', { documents_correct: false, document_discrepancy: '' })).valid, false);
  assert.equal((await validateFormSubmission(spec, 'form_reimbursability', { reimbursable: false, non_reimbursable_reason: '' })).valid, false);
  assert.equal((await validateFormSubmission(spec, 'form_register', { approved_amount: 1800, payment_date: '2026-11-01', finance_reference: 'FIN-1' })).valid, true);
  const conditionalFields = [
    ['form_completeness', 'adjustments_needed', 'request_complete'],
    ['form_manager_approval', 'manager_rejection_reason', 'manager_approved'],
    ['form_director_approval', 'director_rejection_reason', 'director_approved'],
    ['form_finance_check', 'document_discrepancy', 'documents_correct'],
    ['form_reimbursability', 'non_reimbursable_reason', 'reimbursable'],
  ];
  for (const [formId, fieldKey, decisionKey] of conditionalFields) {
    const field = (forms.get(formId) as any).fields.find((candidate: any) => candidate.key === fieldKey);
    assert.equal(field.requiredWhen.op, 'eq');
    assert.equal(field.requiredWhen.left.var, decisionKey);
    assert.equal(field.requiredWhen.right.literal, false);
  }

  const first = await generateArtifacts(spec); const second = await generateArtifacts(spec);
  assert.deepEqual(second, first, 'artifact generation must be deterministic');
  assert.equal(first.forms.length, spec.forms.length);
  const expectedXmlEdges = [
    ['f_adjust_return', 'employee_adjust', 'manager_check'], ['f_docs_return', 'employee_correct_docs', 'finance_check'],
    ['f_amount_low', 'amount_gateway', 'finance_check'], ['f_amount_high', 'amount_gateway', 'director_approval'],
    ['f_director_approved', 'director_decision_gateway', 'finance_check'], ['f_manager_rejected', 'manager_decision_gateway', 'end_manager_rejected'],
  ];
  for (const [id, source, target] of expectedXmlEdges) {
    const flowXml = first.bpmnXml.split(/\r?\n/).find(line => line.includes(`<bpmn:sequenceFlow id="${id}"`) && line.includes(`sourceRef="${source}"`) && line.includes(`targetRef="${target}"`));
    assert.ok(flowXml, `BPMN must preserve ${id}: ${source} -> ${target}`);
  }
  assert.deepEqual(new Set(first.forms.map(form => form.id)), new Set(spec.forms.map(form => form.id)));
});
