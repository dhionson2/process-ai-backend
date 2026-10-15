import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGraphIR, type GraphIRV1 } from '../src/modules/graph-ir/graph-ir.js';

// Hand-authored acceptance fixtures: expected semantics are stated here, independently
// of the validator and adapter under review.
function approvalFixture(withCorrection = false): GraphIRV1 {
  const graph: GraphIRV1 = {
    schemaVersion: '1.0.0',
    process: { id: 'leave_request', name: 'Aprovar férias', locale: 'pt-BR', targetProfile: 'generic-bpmn2' },
    roles: [
      { id: 'role_requester', label: 'Solicitante', resolution: 'requester' },
      { id: 'role_manager', label: 'Gestor', resolution: 'group', groupKey: 'managers' },
    ],
    variables: [{ id: 'var_approved', key: 'approved', type: 'boolean', source: { kind: 'constant', value: false } }],
    requirements: [
      { id: 'req_review', kind: 'activity', mandatory: true, nodeId: 'review' },
      { id: 'req_decision', kind: 'structure', mandatory: true, nodeId: 'decision' },
      { id: 'req_approve', kind: 'condition', mandatory: true, variableId: 'var_approved', operator: 'eq', value: true },
      { id: 'req_reject', kind: 'condition', mandatory: true, variableId: 'var_approved', operator: 'eq', value: false },
    ],
    nodes: [
      { id: 'start', type: 'start', name: 'Início', requirementRefs: [] },
      { id: 'review', type: 'humanTask', name: 'Analisar solicitação', roleId: 'role_manager', requirementRefs: ['req_review'] },
      { id: 'decision', type: 'exclusiveGateway', name: 'Decisão do gestor', requirementRefs: ['req_decision'] },
      { id: 'approved_end', type: 'end', name: 'Férias aprovadas', requirementRefs: [] },
      { id: 'rejected_end', type: 'end', name: 'Solicitação reprovada', requirementRefs: [] },
    ],
    edges: [
      { id: 'start_review', source: 'start', target: 'review', kind: 'sequence', requirementRefs: [] },
      { id: 'review_decision', source: 'review', target: 'decision', kind: 'sequence', requirementRefs: [] },
      { id: 'approve_route', source: 'decision', target: 'approved_end', kind: 'sequence', gatewayId: 'decision', condition: { op: 'eq', left: { var: 'var_approved' }, right: { literal: true } }, requirementRefs: ['req_approve'] },
      { id: 'reject_route', source: 'decision', target: 'rejected_end', kind: 'sequence', gatewayId: 'decision', condition: { op: 'eq', left: { var: 'var_approved' }, right: { literal: false } }, requirementRefs: ['req_reject'] },
    ],
    formRefs: [], metadata: { provenance: [] },
  };
  if (!withCorrection) return graph;

  graph.requirements.push(
    { id: 'req_correct', kind: 'activity', mandatory: true, nodeId: 'correct' },
    { id: 'req_loop', kind: 'loop', mandatory: true, sourceNodeId: 'decision', targetNodeId: 'correct' },
  );
  graph.nodes.splice(3, 0, { id: 'correct', type: 'humanTask', name: 'Corrigir solicitação', roleId: 'role_requester', requirementRefs: ['req_correct'] });
  graph.nodes = graph.nodes.filter(node => node.id !== 'rejected_end');
  graph.edges = graph.edges.filter(edge => edge.id !== 'reject_route');
  graph.edges.push(
    { id: 'correction_route', source: 'decision', target: 'correct', kind: 'loop-back', gatewayId: 'decision', condition: { op: 'eq', left: { var: 'var_approved' }, right: { literal: false } }, requirementRefs: ['req_reject', 'req_loop'] },
    { id: 'corrected_review', source: 'correct', target: 'review', kind: 'sequence', requirementRefs: [] },
  );
  return graph;
}

function rejectionAndConditionalFormFixture(): GraphIRV1 {
  const graph = approvalFixture();
  graph.variables = [
    { id: 'var_approved', key: 'approved', type: 'boolean', source: { kind: 'form', formRef: 'decision_form', fieldKey: 'approved' } },
    { id: 'var_reason', key: 'rejection_reason', type: 'string', source: { kind: 'form', formRef: 'decision_form', fieldKey: 'reason' } },
  ];
  graph.requirements.push(
    { id: 'req_approved_field', kind: 'form-field', mandatory: true, formRef: 'decision_form', fieldKey: 'approved' },
    { id: 'req_reason_field', kind: 'form-field', mandatory: true, formRef: 'decision_form', fieldKey: 'reason' },
  );
  graph.nodes[1].formRef = 'decision_form';
  graph.formRefs = [{ id: 'decision_form', name: 'Decisão', usage: 'task', fields: [
    { key: 'approved', label: 'Aprovada', type: 'boolean', bindTo: 'var_approved', required: true, requirementRefs: ['req_approved_field'] },
    { key: 'reason', label: 'Motivo da reprovação', type: 'textarea', bindTo: 'var_reason', required: false, requiredWhen: { op: 'eq', left: { var: 'var_approved' }, right: { literal: false } }, visibleWhen: { op: 'eq', left: { var: 'var_approved' }, right: { literal: false } }, requirementRefs: ['req_reason_field'] },
  ] }];
  return graph;
}

const diagnosticCodes = (graph: GraphIRV1) => validateGraphIR(graph).diagnostics.map(item => item.code);

test('review corpus: linear, aprovação, reprovação terminal e correção com retorno', () => {
  const terminalDecision = approvalFixture();
  assert.equal(validateGraphIR(terminalDecision).valid, true, JSON.stringify(validateGraphIR(terminalDecision).diagnostics));
  assert.equal(terminalDecision.edges.find(edge => edge.id === 'reject_route')?.target, 'rejected_end');
  assert.equal(terminalDecision.nodes.find(node => node.id === 'rejected_end')?.type, 'end');

  const correctionCycle = approvalFixture(true);
  assert.equal(validateGraphIR(correctionCycle).valid, true, JSON.stringify(validateGraphIR(correctionCycle).diagnostics));
  assert.deepEqual(correctionCycle.edges.filter(edge => edge.kind === 'loop-back').map(edge => [edge.source, edge.target]), [['decision', 'correct']]);
  assert.ok(correctionCycle.edges.some(edge => edge.source === 'correct' && edge.target === 'review'), 'correção retorna à análise');
});

test('review corpus: campo obrigatório condicional usa variável de gateway vinculada ao formulário', () => {
  const graph = rejectionAndConditionalFormFixture();
  assert.equal(validateGraphIR(graph).valid, true, JSON.stringify(validateGraphIR(graph).diagnostics));
  const reason = graph.formRefs[0].fields.find(field => field.key === 'reason')!;
  assert.deepEqual(reason.requiredWhen, { op: 'eq', left: { var: 'var_approved' }, right: { literal: false } });
  assert.deepEqual(reason.visibleWhen, reason.requiredWhen);
  assert.equal(graph.variables[0].source?.fieldKey, 'approved');
  assert.equal(graph.edges.find(edge => edge.id === 'approve_route')?.condition?.left && (graph.edges.find(edge => edge.id === 'approve_route')!.condition as any).left.var, 'var_approved');
});

test('review corpus: rejeita nó inventado, omissão, destino inexistente e condição divergente', () => {
  const invented = approvalFixture();
  invented.nodes.splice(2, 0, { id: 'invented_activity', type: 'humanTask', name: 'Enviar notificação', roleId: 'role_manager', requirementRefs: [] });
  invented.edges.splice(2, 0, { id: 'review_invented', source: 'review', target: 'invented_activity', kind: 'sequence', requirementRefs: [] });
  invented.edges.splice(3, 0, { id: 'invented_decision', source: 'invented_activity', target: 'decision', kind: 'sequence', requirementRefs: [] });
  assert.ok(diagnosticCodes(invented).includes('GRAPHIR_ELEMENT_UNGROUNDED'));

  const omitted = approvalFixture();
  omitted.nodes.find(node => node.id === 'review')!.requirementRefs = [];
  assert.ok(diagnosticCodes(omitted).includes('GRAPHIR_REQUIREMENT_UNCOVERED'));

  const missingTarget = approvalFixture();
  missingTarget.edges.find(edge => edge.id === 'approve_route')!.target = 'missing_end';
  assert.ok(diagnosticCodes(missingTarget).includes('GRAPHIR_NODE_REFERENCE_MISSING'));

  const divergentCondition = approvalFixture();
  divergentCondition.requirements.find(requirement => requirement.id === 'req_approve')!.value = false;
  assert.ok(diagnosticCodes(divergentCondition).includes('GRAPHIR_CONDITION_REQUIREMENT_DIVERGENCE'));
});

test('review corpus: nós e arestas reordenados mantêm os mesmos diagnósticos estáveis', () => {
  const graph = approvalFixture();
  graph.edges.find(edge => edge.id === 'approve_route')!.target = 'missing_end';
  const expected = validateGraphIR(graph).diagnostics;
  const reordered = structuredClone(graph);
  reordered.roles.reverse(); reordered.variables.reverse(); reordered.requirements.reverse();
  reordered.nodes.reverse(); reordered.edges.reverse();
  assert.deepEqual(validateGraphIR(reordered).diagnostics, expected);
});
