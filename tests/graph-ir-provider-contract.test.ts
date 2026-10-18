import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Environment } from '../src/config/env.js';
import { AiOrchestrator } from '../src/modules/ai/orchestrator.js';
import { buildApp } from '../src/app.js';
import { graphIrProviderSchema, normalizeGraphIrProviderValue } from '../src/modules/graph-ir/provider-schema.js';
import { lowerGraphIRToProcessSpec } from '../src/modules/graph-ir/processspec.adapter.js';
import { diagnoseGraphIRSchema, sanitizeGraphIrDiagnostics, validateGraphIR, validateGraphIRStructure } from '../src/modules/graph-ir/graph-ir.js';
import { requirementFromEvidence, verifyRequirementEvidence } from '../src/modules/ai/requirement-coverage.js';
import { InMemoryConversationRepository } from '../src/modules/projects/conversation.repository.js';
import { g03ReimbursementProcessSpec } from './fixtures/g03-reimbursement.js';
import { OpenAICompatibleProvider, ProviderFailure, toStrictProviderSchema, type ModelProvider, type StructuredRequest, type StructuredResponse } from '../src/modules/providers/model-provider.js';
import { semanticIntentSchema } from '../src/modules/ai/semantic-process.js';

// These hand-authored fixtures are independent of AJV/GraphIR validation and
// state expected semantics directly. Conditions use the exact flat wire shape.
function r01(): any {
  return {
    schemaVersion: '1.0.0', process: { id: 'purchase_process', name: 'Compra de material', description: null, locale: 'pt-BR', targetProfile: 'generic-bpmn2' },
    roles: [
      { id: 'employee', label: 'Funcionário', resolution: 'requester', groupKey: null },
      { id: 'manager', label: 'Gestor', resolution: 'unresolved', groupKey: null },
      { id: 'finance', label: 'Financeiro', resolution: 'unresolved', groupKey: null },
    ],
    variables: [
      { id: 'var_material', key: 'material', type: 'string', required: true, sensitive: false, scope: 'process', enumValues: null, source: { kind: 'form', formRef: 'form_request', fieldKey: 'material' } },
      { id: 'var_approved', key: 'approved', type: 'boolean', required: true, sensitive: false, scope: 'task', enumValues: null, source: { kind: 'form', formRef: 'form_manager', fieldKey: 'approved' } },
    ],
    requirements: [
      { id: 'req_submit', kind: 'activity', mandatory: true, nodeId: 'submit', sourceNodeId: null, targetNodeId: null, roleId: null, variableId: null, formRef: null, fieldKey: null, operator: null, value: null },
      { id: 'req_review', kind: 'activity', mandatory: true, nodeId: 'review', sourceNodeId: null, targetNodeId: null, roleId: null, variableId: null, formRef: null, fieldKey: null, operator: null, value: null },
      { id: 'req_gateway', kind: 'structure', mandatory: true, nodeId: 'decision', sourceNodeId: null, targetNodeId: null, roleId: null, variableId: null, formRef: null, fieldKey: null, operator: null, value: null },
      { id: 'req_purchase', kind: 'activity', mandatory: true, nodeId: 'purchase', sourceNodeId: null, targetNodeId: null, roleId: null, variableId: null, formRef: null, fieldKey: null, operator: null, value: null },
      { id: 'req_approved', kind: 'condition', mandatory: true, nodeId: null, sourceNodeId: null, targetNodeId: null, roleId: null, variableId: 'var_approved', formRef: null, fieldKey: null, operator: 'eq', value: true },
      { id: 'req_rejected', kind: 'condition', mandatory: true, nodeId: null, sourceNodeId: null, targetNodeId: null, roleId: null, variableId: 'var_approved', formRef: null, fieldKey: null, operator: 'eq', value: false },
      { id: 'req_material', kind: 'form-field', mandatory: true, nodeId: null, sourceNodeId: null, targetNodeId: null, roleId: null, variableId: null, formRef: 'form_request', fieldKey: 'material', operator: null, value: null },
      { id: 'req_decision', kind: 'form-field', mandatory: true, nodeId: null, sourceNodeId: null, targetNodeId: null, roleId: null, variableId: null, formRef: 'form_manager', fieldKey: 'approved', operator: null, value: null },
    ],
    nodes: [
      { id: 'start', type: 'start', name: 'Início', roleId: null, formRef: 'form_request', defaultEdgeId: null, requirementRefs: [], provenance: null },
      { id: 'submit', type: 'humanTask', name: 'Solicitar compra de material', roleId: 'employee', formRef: null, defaultEdgeId: null, requirementRefs: ['req_submit'], provenance: null },
      { id: 'review', type: 'humanTask', name: 'Analisar solicitação de compra', roleId: 'manager', formRef: 'form_manager', defaultEdgeId: null, requirementRefs: ['req_review'], provenance: null },
      { id: 'decision', type: 'exclusiveGateway', name: 'Compra aprovada?', roleId: null, formRef: null, defaultEdgeId: null, requirementRefs: ['req_gateway'], provenance: null },
      { id: 'purchase', type: 'humanTask', name: 'Providenciar compra de material', roleId: 'finance', formRef: null, defaultEdgeId: null, requirementRefs: ['req_purchase'], provenance: null },
      { id: 'end_approved', type: 'end', name: 'Compra providenciada', roleId: null, formRef: null, defaultEdgeId: null, requirementRefs: [], provenance: null },
      { id: 'end_rejected', type: 'end', name: 'Solicitação reprovada', roleId: null, formRef: null, defaultEdgeId: null, requirementRefs: [], provenance: null },
    ],
    edges: [
      { id: 'start_submit', source: 'start', target: 'submit', kind: 'sequence', gatewayId: null, condition: null, isDefault: null, label: null, requirementRefs: [], provenance: null },
      { id: 'submit_review', source: 'submit', target: 'review', kind: 'sequence', gatewayId: null, condition: null, isDefault: null, label: null, requirementRefs: [], provenance: null },
      { id: 'review_decision', source: 'review', target: 'decision', kind: 'sequence', gatewayId: null, condition: null, isDefault: null, label: null, requirementRefs: [], provenance: null },
      { id: 'approve_purchase', source: 'decision', target: 'purchase', kind: 'sequence', gatewayId: 'decision', condition: { op: 'eq', variableId: 'var_approved', value: true }, isDefault: null, label: 'Aprovada', requirementRefs: ['req_approved'], provenance: null },
      { id: 'reject_end', source: 'decision', target: 'end_rejected', kind: 'sequence', gatewayId: 'decision', condition: { op: 'eq', variableId: 'var_approved', value: false }, isDefault: null, label: 'Reprovada', requirementRefs: ['req_rejected'], provenance: null },
      { id: 'purchase_end', source: 'purchase', target: 'end_approved', kind: 'sequence', gatewayId: null, condition: null, isDefault: null, label: null, requirementRefs: [], provenance: null },
    ],
    formRefs: [
      { id: 'form_request', name: 'Solicitação de compra', usage: 'start', fields: [{ key: 'material', label: 'Material solicitado', type: 'text', bindTo: 'var_material', required: true, sensitive: false, options: null, visibleWhen: null, requiredWhen: null, requirementRefs: ['req_material'] }] },
      { id: 'form_manager', name: 'Análise do gestor', usage: 'task', fields: [{ key: 'approved', label: 'Decisão', type: 'boolean', bindTo: 'var_approved', required: true, sensitive: false, options: null, visibleWhen: null, requiredWhen: null, requirementRefs: ['req_decision'] }] },
    ],
    metadata: { provenance: [], sourceVersion: null },
  };
}

function r02(): any {
  const requirements: any[] = [];
  const activity = (nodeId: string) => { const id = `req_${nodeId}`; requirements.push({ id, kind: 'activity', mandatory: true, nodeId }); return id; };
  const structure = (nodeId: string) => { const id = `req_${nodeId}`; requirements.push({ id, kind: 'structure', mandatory: true, nodeId }); return id; };
  const condition = (edgeId: string, variableId: string, operator: string, value: unknown) => { const id = `req_${edgeId}`; requirements.push({ id, kind: 'condition', mandatory: true, variableId, operator, value }); return id; };
  const field = (formRef: string, fieldKey: string) => { const id = `req_${formRef}_${fieldKey}`; requirements.push({ id, kind: 'form-field', mandatory: true, formRef, fieldKey }); return id; };
  const roles = [
    { id: 'employee', label: 'Funcionário', resolution: 'requester' },
    { id: 'manager', label: 'Gestor', resolution: 'unresolved' },
    { id: 'director', label: 'Diretor', resolution: 'unresolved' },
    { id: 'finance', label: 'Financeiro', resolution: 'unresolved' },
  ];
  const variables = [
    { id: 'var_description', key: 'description', type: 'string', source: { kind: 'form', formRef: 'form_request', fieldKey: 'description' } },
    { id: 'var_amount', key: 'amount', type: 'decimal', source: { kind: 'form', formRef: 'form_request', fieldKey: 'amount' } },
    { id: 'var_receipt', key: 'receipt', type: 'string', source: { kind: 'form', formRef: 'form_request', fieldKey: 'receipt' } },
    { id: 'var_manager_approved', key: 'manager_approved', type: 'boolean', source: { kind: 'form', formRef: 'form_manager', fieldKey: 'approved' } },
    { id: 'var_director_approved', key: 'director_approved', type: 'boolean', source: { kind: 'form', formRef: 'form_director', fieldKey: 'approved' } },
  ];
  const nodes: any[] = [
    { id: 'start', type: 'start', name: 'Início', formRef: 'form_request', requirementRefs: [] },
    { id: 'submit', type: 'humanTask', name: 'Solicitar reembolso', roleId: 'employee', requirementRefs: [activity('submit')] },
    { id: 'manager_review', type: 'humanTask', name: 'Analisar reembolso', roleId: 'manager', formRef: 'form_manager', requirementRefs: [activity('manager_review')] },
    { id: 'manager_decision', type: 'exclusiveGateway', name: 'Gestor aprovou?', requirementRefs: [structure('manager_decision')] },
    { id: 'amount_decision', type: 'exclusiveGateway', name: 'Valor excede R$ 2.000?', requirementRefs: [structure('amount_decision')] },
    { id: 'director_review', type: 'humanTask', name: 'Aprovar reembolso', roleId: 'director', formRef: 'form_director', requirementRefs: [activity('director_review')] },
    { id: 'director_decision', type: 'exclusiveGateway', name: 'Diretor aprovou?', requirementRefs: [structure('director_decision')] },
    { id: 'finance', type: 'humanTask', name: 'Processar reembolso', roleId: 'finance', requirementRefs: [activity('finance')] },
    { id: 'end_rejected', type: 'end', name: 'Reembolso reprovado', requirementRefs: [] },
    { id: 'end_paid', type: 'end', name: 'Reembolso processado', requirementRefs: [] },
  ];
  const edge = (id: string, source: string, target: string, conditionValue?: { variableId: string; op: string; value: unknown }) => ({
    id, source, target, kind: 'sequence', ...(source.endsWith('_decision') ? { gatewayId: source } : {}),
    ...(conditionValue ? { condition: { op: conditionValue.op, variableId: conditionValue.variableId, value: conditionValue.value }, requirementRefs: [condition(id, conditionValue.variableId, conditionValue.op, conditionValue.value)] } : { requirementRefs: [] }),
  });
  const edges = [
    edge('e_start_submit', 'start', 'submit'), edge('e_submit_manager', 'submit', 'manager_review'), edge('e_manager_gateway', 'manager_review', 'manager_decision'),
    edge('e_manager_reject', 'manager_decision', 'end_rejected', { variableId: 'var_manager_approved', op: 'eq', value: false }),
    edge('e_manager_pass', 'manager_decision', 'amount_decision', { variableId: 'var_manager_approved', op: 'eq', value: true }),
    edge('e_amount_high', 'amount_decision', 'director_review', { variableId: 'var_amount', op: 'gt', value: 2000 }),
    edge('e_amount_low', 'amount_decision', 'finance', { variableId: 'var_amount', op: 'lte', value: 2000 }),
    edge('e_director_gateway', 'director_review', 'director_decision'),
    edge('e_director_reject', 'director_decision', 'end_rejected', { variableId: 'var_director_approved', op: 'eq', value: false }),
    edge('e_director_pass', 'director_decision', 'finance', { variableId: 'var_director_approved', op: 'eq', value: true }),
    edge('e_finance_end', 'finance', 'end_paid'),
  ];
  const requestFields = [
    { key: 'description', label: 'Descrição', type: 'textarea', bindTo: 'var_description' },
    { key: 'amount', label: 'Valor', type: 'decimal', bindTo: 'var_amount' },
    { key: 'receipt', label: 'Comprovante', type: 'attachment', bindTo: 'var_receipt' },
  ].map(item => ({ ...item, required: true, requirementRefs: [field('form_request', item.key)] }));
  const approvalForm = (id: string) => ({ id, name: id === 'form_manager' ? 'Análise do gestor' : 'Análise do diretor', usage: 'task', fields: [{ key: 'approved', label: 'Aprovado', type: 'boolean', bindTo: id === 'form_manager' ? 'var_manager_approved' : 'var_director_approved', required: true, requirementRefs: [field(id, 'approved')] }] });
  return {
    schemaVersion: '1.0.0', process: { id: 'reimbursement', name: 'Reembolso', locale: 'pt-BR', targetProfile: 'generic-bpmn2' }, roles, variables, requirements, nodes, edges,
    formRefs: [{ id: 'form_request', name: 'Solicitação de reembolso', usage: 'start', fields: requestFields }, approvalForm('form_manager'), approvalForm('form_director')],
    metadata: { provenance: [] },
  };
}

class QueueProvider implements ModelProvider {
  readonly id = 'offline-graphir-fixture';
  readonly requests: StructuredRequest[] = [];
  constructor(private readonly values: unknown[]) {}
  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    this.requests.push(request);
    const value = this.values.shift();
    if (value instanceof Error) throw value;
    return { value: structuredClone(value), usage: { inputTokens: 350, outputTokens: 700 }, latencyMs: 5, model: request.model };
  }
}

function removeNulls(value: any): any {
  if (Array.isArray(value)) return value.map(removeNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, removeNulls(item)]));
}

function providerTransport(value: any): any {
  const graph = structuredClone(value);
  for (const edge of graph.edges || []) delete edge.gatewayId;
  return graph;
}

const env = (overrides: Partial<Environment> = {}): Environment => ({
  host: '127.0.0.1', port: 3333, corsOrigins: [], logLevel: 'silent', localTenantId: 'offline', aiProvider: 'disabled', ollamaBaseUrl: 'http://127.0.0.1:11434', externalAiApproved: false,
  aiTimeoutMs: 180000, aiContextTokens: 8192, aiMaxOutputTokens: 8192, aiMaxInputChars: 40000, aiMaxConcurrency: 1, externalAiStructuredOutput: 'json-schema-strict', aiMaxProviderCalls: 1, aiMaxProviderTokens: 24000, aiSemanticGroundingMode: 'legacy', aiGraphIrMode: 'controlled', ...overrides,
});

function auditStrict(schema: any) {
  const defects: string[] = [];
  const refs: string[] = [];
  const walk = (value: any, path = '$', depth = 0) => {
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}[${index}]`, depth)); return; }
    if (!value || typeof value !== 'object') return;
    if (depth > 20) defects.push(`depth:${path}`);
    if (value.$ref) refs.push(value.$ref);
    if (value.type === 'object' || value.properties) {
      const properties = Object.keys(value.properties || {});
      const required = Array.isArray(value.required) ? value.required : [];
      if (value.additionalProperties !== false) defects.push(`open:${path}`);
      if (properties.length !== required.length || properties.some(key => !required.includes(key))) defects.push(`required:${path}`);
    }
    if (Array.isArray(value.enum) && value.type === undefined) defects.push(`untyped-enum:${path}`);
    for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`, depth + 1);
  };
  walk(schema);
  const known = new Set(Object.keys(schema.$defs || {}));
  for (const ref of refs) if (ref.startsWith('#/$defs/') && !known.has(ref.slice('#/$defs/'.length))) defects.push(`unresolved:${ref}`);
  return defects;
}

test('SC01-SC06: payload estrito Groq é válido, fechado, totalmente requerido e representa arrays/nós sem perder o contrato canônico', () => {
  const projected = graphIrProviderSchema();
  const payload = toStrictProviderSchema(projected);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  assert.equal(ajv.validateSchema(payload), true, JSON.stringify(ajv.errors));
  assert.doesNotThrow(() => ajv.compile(payload));
  assert.deepEqual(auditStrict(payload), []);
  const response = payload.properties.response;
  assert.equal(payload.type, 'object', 'raiz da resposta é objeto');
  assert.deepEqual(payload.required, ['response']);
  assert.equal(response.properties.nodes.type, 'array');
  assert.equal(response.properties.edges.type, 'array');
  assert.deepEqual(response.properties.nodes.items.properties.type.enum, ['start', 'end', 'humanTask', 'exclusiveGateway']);
  const raw = r01();
  const providerRaw: any = providerTransport(raw);
  assert.equal(ajv.compile(projected)(removeNulls(providerRaw)), true);
  const normalized = normalizeGraphIrProviderValue(removeNulls(providerRaw)) as any;
  assert.equal(validateGraphIR(normalized).valid, true);
  assert.ok(normalized.requirements.every((item: any) => typeof item.id === 'string'));
  assert.deepEqual(normalized.nodes.find((item: any) => item.id === 'review').requirementRefs, ['req_review']);
  assert.ok(projected.properties.nodes.items.properties.action === undefined, 'serviceTask executável não entra no payload controlado');
  assert.equal(projected.properties.edges.items.properties.gatewayId, undefined, 'gatewayId derivável é interno ao compilador');
  assert.ok(projected.properties.nodes.items.properties.requirementRefs, 'transporte preserva refs explícitas validadas pelo Gate');
  assert.ok(projected.properties.requirements.items.properties.id, 'transporte mantém identidade GraphIR distinta do Ledger');
});

test('R01 normaliza gatewayId ausente somente quando source identifica um gateway XOR; preserva referências conflitantes', () => {
  const providerValue = r01();
  for (const edge of providerValue.edges.filter((item: any) => item.source === 'decision')) delete edge.gatewayId;
  const normalized: any = normalizeGraphIrProviderValue(providerValue);
  assert.deepEqual(normalized.edges.filter((item: any) => item.source === 'decision').map((item: any) => item.gatewayId), ['decision', 'decision']);
  assert.equal(validateGraphIR(normalized).valid, true, 'duas saídas mantêm destinos, condições e operador originais');
  assert.deepEqual(normalized.edges.filter((item: any) => item.source === 'decision').map((item: any) => [item.target, item.condition.op, item.condition.right.literal]), [['purchase', 'eq', true], ['end_rejected', 'eq', false]]);

  const divergent: any = structuredClone(providerValue);
  divergent.edges.find((item: any) => item.source === 'decision').gatewayId = 'other_gateway';
  const divergence = validateGraphIR(normalizeGraphIrProviderValue(divergent));
  assert.ok(divergence.diagnostics.some(item => item.code === 'GRAPHIR_GATEWAY_ASSOCIATION_INVALID'));

  const missingSource: any = structuredClone(providerValue);
  const edge = missingSource.edges.find((item: any) => item.source === 'decision');
  delete edge.gatewayId;
  edge.source = 'missing_gateway';
  const unresolved: any = normalizeGraphIrProviderValue(missingSource);
  assert.equal(Object.hasOwn(unresolved.edges.find((item: any) => item.id === edge.id), 'gatewayId'), false);
  assert.ok(validateGraphIR(unresolved).diagnostics.some(item => item.code === 'GRAPHIR_NODE_REFERENCE_MISSING' && item.path.endsWith('/source')));
});

test('transporte GraphIR resolve alias de variável único e preserva refs explícitas; alias ambíguo continua inválido', () => {
  const transport: any = providerTransport(r01());
  transport.formRefs[0].fields[0].bindTo = 'material';
  transport.formRefs[1].fields[0].bindTo = 'approved';
  for (const edge of transport.edges.filter((item: any) => item.condition)) edge.condition.variableId = 'approved';
  for (const requirement of transport.requirements.filter((item: any) => item.variableId)) requirement.variableId = 'approved';
  const normalized: any = normalizeGraphIrProviderValue(transport);
  assert.equal(validateGraphIR(normalized).valid, true);
  assert.equal(normalized.formRefs[0].fields[0].bindTo, 'var_material');
  assert.equal(normalized.formRefs[1].fields[0].bindTo, 'var_approved');
  assert.ok(normalized.edges.filter((item: any) => item.condition).every((item: any) => item.condition.left.var === 'var_approved'));
  assert.deepEqual(normalized.nodes.find((item: any) => item.id === 'review').requirementRefs, ['req_review']);
  assert.equal(validateGraphIR(normalized).valid, true);
  assert.equal(normalized.requirements.find((item: any) => item.kind === 'activity' && item.nodeId === 'review').id, 'req_review', 'IDs de requisito preservam identidade declarada');

  const ambiguous: any = structuredClone(transport);
  ambiguous.variables.push({ ...ambiguous.variables.find((item: any) => item.id === 'var_approved'), id: 'var_approved_duplicate' });
  const invalid: any = normalizeGraphIrProviderValue(ambiguous);
  assert.ok(validateGraphIR(invalid).diagnostics.some(item => item.code === 'GRAPHIR_VARIABLE_REFERENCE_MISSING'));

  const identityConflict: any = structuredClone(transport);
  identityConflict.variables.push({ id: 'approved', key: 'manager_approved', type: 'boolean', required: true, sensitive: false, scope: 'task', enumValues: null, source: { kind: 'form', formRef: 'form_manager', fieldKey: 'approved' } });
  identityConflict.edges.find((item: any) => item.condition).condition.variableId = 'approved';
  const conflictNormalized: any = normalizeGraphIrProviderValue(identityConflict);
  assert.notEqual(conflictNormalized.edges.find((item: any) => item.condition).condition.left.var, 'var_approved');
  assert.ok(validateGraphIR(conflictNormalized).diagnostics.some(item => item.code === 'GRAPHIR_VARIABLE_REFERENCE_MISSING'), 'ID de uma variável em conflito com chave de outra falha fechado');
});

test('RequirementRefs ausentes ou incorretos não são inferidos das declarações do próprio provider', () => {
  const missing: any = providerTransport(r01());
  delete missing.nodes.find((item: any) => item.id === 'review').requirementRefs;
  const missingNormalized: any = normalizeGraphIrProviderValue(missing);
  assert.equal(Object.hasOwn(missingNormalized.nodes.find((item: any) => item.id === 'review'), 'requirementRefs'), false);
  assert.ok(validateGraphIR(missingNormalized).diagnostics.some(item => item.code === 'GRAPHIR_SCHEMA_INVALID'));

  const incorrect: any = providerTransport(r01());
  incorrect.nodes.find((item: any) => item.id === 'review').requirementRefs = ['req_submit'];
  const incorrectResult = validateGraphIR(normalizeGraphIrProviderValue(incorrect));
  assert.ok(incorrectResult.diagnostics.some(item => item.code === 'GRAPHIR_REQUIREMENT_BINDING_INVALID'));

  const contradictedIdentity: any = providerTransport(r01());
  contradictedIdentity.requirements.find((item: any) => item.id === 'req_review').nodeId = 'submit';
  const contradictedResult = validateGraphIR(normalizeGraphIrProviderValue(contradictedIdentity));
  assert.ok(contradictedResult.diagnostics.some(item => item.code === 'GRAPHIR_REQUIREMENT_BINDING_INVALID'));
});

test('SC04/SC07: condição opcional nullable sem anyOf ambíguo preserva os operadores numericamente exatos', () => {
  const payload = toStrictProviderSchema(graphIrProviderSchema());
  const response = payload.properties.response;
  const condition = response.properties.edges.items.properties.condition;
  assert.deepEqual(condition.type, ['object', 'null']);
  assert.equal(condition.anyOf, undefined);
  const fieldCondition = response.properties.formRefs.items.properties.fields.items.properties.requiredWhen;
  assert.deepEqual(fieldCondition.type, ['object', 'null']);
  assert.equal(fieldCondition.anyOf, undefined);
  const operators = ['gt', 'gte', 'lt', 'lte'];
  for (const op of operators) {
    const flat = { op, variableId: 'var_amount', value: 2000 };
    const normalized: any = normalizeGraphIrProviderValue({ edges: [{ condition: flat }], formRefs: [] });
    assert.deepEqual(normalized.edges[0].condition, { op, left: { var: 'var_amount' }, right: { literal: 2000 } });
  }
});

test('SC08-SC11: loops, campos condicionais e normalização preservam destinos, required e visibilidade', () => {
  // The two canonical G03 cycles are authored in the existing independent
  // golden ProcessSpec and mapped here without using the validator as oracle.
  const loops = [
    { id: 'loop_adjust', source: 'employee_adjust', target: 'manager_check', kind: 'loop-back' },
    { id: 'loop_documents', source: 'employee_correct_docs', target: 'finance_check', kind: 'loop-back' },
  ];
  const providerValue = { ...r01(), edges: [...r01().edges, ...loops.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, kind: edge.kind, gatewayId: null, condition: null, isDefault: null, label: null, requirementRefs: [], provenance: null }))] };
  const providerEdges = structuredClone(providerValue.edges) as any[];
  for (const edge of providerEdges.filter(item => item.source === 'decision')) delete edge.gatewayId;
  const providerProjection = providerTransport({ ...providerValue, edges: providerEdges });
  assert.equal(new Ajv2020({ allErrors: true, strict: false }).compile(graphIrProviderSchema())(removeNulls(providerProjection)), true, 'array de edges no contrato aceita múltiplos loop-backs');
  assert.deepEqual(providerValue.edges.filter((edge: any) => edge.kind === 'loop-back').map((edge: any) => [edge.source, edge.target]), [['employee_adjust', 'manager_check'], ['employee_correct_docs', 'finance_check']]);
  const field = { key: 'reason', label: 'Motivo', type: 'textarea', bindTo: 'var_reason', required: false, visibleWhen: { op: 'eq', variableId: 'var_approved', value: false }, requiredWhen: { op: 'eq', variableId: 'var_approved', value: false } };
  const normalized: any = normalizeGraphIrProviderValue({ edges: [{ condition: { op: 'lte', variableId: 'var_amount', value: 2000 } }], formRefs: [{ fields: [field] }] });
  assert.equal(normalized.edges[0].condition.op, 'lte');
  assert.deepEqual(normalized.formRefs[0].fields[0].visibleWhen, { op: 'eq', left: { var: 'var_approved' }, right: { literal: false } });
  assert.deepEqual(normalized.formRefs[0].fields[0].requiredWhen, normalized.formRefs[0].fields[0].visibleWhen);
  assert.equal(normalized.formRefs[0].fields[0].required, false, 'nullability de metadados não confirma obrigatoriedade');
});

test('SC10/R01/R02: fixtures independentes atravessam o orquestrador inteiro, mantêm papéis desconhecidos e compilam ProcessSpec/artefatos', async () => {
  const r01Text = 'Um funcionário solicita compra de material, informando o material solicitado. O gestor analisa a solicitação. Se aprovar, o financeiro recebe para providenciar a compra. Se reprovar, o processo termina.';
  const r01Provider = new QueueProvider([providerTransport(r01())]);
  const first = await new AiOrchestrator(r01Provider, 'openai/gpt-oss-120b', env()).generate({ text: r01Text, history: [] });
  assert.equal(r01Provider.requests.length, 1);
  assert.equal(r01Provider.requests[0].outputSchema.title, 'GraphIR v1');
  assert.equal(first.kind, 'proposed_spec');
  if (first.kind === 'proposed_spec') {
    assert.equal(first.validation.valid, true);
    assert.equal(first.spec.status, 'needs-input');
    assert.deepEqual((first.spec.pendingQuestions as any[]).map(item => item.relatedNodeId).sort(), ['purchase', 'review']);
    assert.equal(first.artifacts?.forms.length, 2);
    assert.match(String(first.artifacts?.bpmnXml), /exclusiveGateway/);
  }

  const r02Text = 'Um funcionário solicita reembolso informando descrição, valor e comprovante. O gestor analisa o reembolso. Se o valor for maior que R$ 2.000, o diretor também precisa aprovar o reembolso. Solicitações de até R$ 2.000 seguem diretamente para o financeiro. O financeiro processa o reembolso. Gestor ou diretor podem reprovar, e reprovações encerram o processo.';
  const r02Provider = new QueueProvider([providerTransport(r02())]);
  const second = await new AiOrchestrator(r02Provider, 'openai/gpt-oss-120b', env()).generate({ text: r02Text, history: [] });
  assert.equal(second.kind, 'proposed_spec');
  if (second.kind === 'proposed_spec') {
    assert.equal(second.validation.valid, true);
    const amountRoutes = (second.intermediate as any).edges.filter((edge: any) => edge.source === 'amount_decision');
    assert.deepEqual(amountRoutes.map((edge: any) => [edge.condition.op, edge.condition.right.literal]).sort(), [['gt', 2000], ['lte', 2000]]);
    assert.deepEqual((second.intermediate as any).formRefs[0].fields.map((item: any) => item.key), ['description', 'amount', 'receipt']);
    assert.equal(second.artifacts?.forms.length, 3);
  }
});

test('R01 Ledger actor sem IDs é coberto só por role e tarefa únicos com prova literal e grounding', async () => {
  const source = 'Um funcionário solicita compra de material. O gestor analisa a solicitação. Se aprovar, o financeiro recebe para providenciar a compra. Se reprovar, o processo termina.';
  const messageId = 'r01-manager-evidence';
  const quote = 'O gestor analisa a solicitação.';
  const actorStart = source.indexOf(quote);
  const requirement = { ...requirementFromEvidence({ messageId, text: source, type: 'actor', start: actorStart, end: actorStart + quote.length }), state: 'user-stated' as const };
  const decisionQuote = 'Se aprovar, o financeiro recebe para providenciar a compra.';
  const decisionRequirement = { ...requirementFromEvidence({ messageId, text: source, type: 'decision', start: source.indexOf(decisionQuote), end: source.indexOf(decisionQuote) + decisionQuote.length }), state: 'user-stated' as const };
  const actorLedger = { schemaVersion: '1.0.0' as const, extraction: { complete: false, method: 'independent-r01-review', diagnostics: ['Actor isolated for targeted association regression.'] }, requirements: [requirement, decisionRequirement] };
  assert.ok(actorLedger.requirements.every(item => verifyRequirementEvidence(item, [{ id: messageId, text: source }])));
  const providerValue: any = r01();
  const provider = new QueueProvider([providerValue]);
  const outcome = await new AiOrchestrator(provider, 'offline-model', env()).generate({ text: source, sourceMessageId: messageId, history: [], requirementLedger: actorLedger });
  assert.equal(outcome.kind, 'proposed_spec');

  const incompleteActor: any = structuredClone(providerValue);
  incompleteActor.requirements.push({ id: 'req_actor_missing_role', kind: 'actor', mandatory: true, nodeId: 'review' });
  incompleteActor.nodes.find((item: any) => item.id === 'review').requirementRefs.push('req_actor_missing_role');
  const invalidActor = validateGraphIR(normalizeGraphIrProviderValue(incompleteActor));
  assert.ok(invalidActor.diagnostics.some(item => item.code === 'GRAPHIR_ACTOR_REQUIREMENT_INCOMPLETE'));
  assert.ok(invalidActor.diagnostics.some(item => item.code === 'GRAPHIR_REQUIREMENT_BINDING_INVALID'));
  const missingAssignment = structuredClone(providerValue);
  delete missingAssignment.nodes.find((item: any) => item.id === 'review').roleId;
  assert.ok(validateGraphIR(normalizeGraphIrProviderValue(missingAssignment)).diagnostics.some(item => item.code === 'GRAPHIR_ROLE_REQUIRED'));

  const wrongRole = structuredClone(providerValue);
  wrongRole.requirements.push({ id: 'req_actor_divergent_role', kind: 'actor', mandatory: true, nodeId: 'review', roleId: 'employee' });
  wrongRole.nodes.find((item: any) => item.id === 'review').requirementRefs.push('req_actor_divergent_role');
  assert.ok(validateGraphIR(normalizeGraphIrProviderValue(wrongRole)).diagnostics.some(item => item.code === 'GRAPHIR_ROLE_REQUIREMENT_DIVERGENCE'));

  const ambiguous = structuredClone(providerValue);
  ambiguous.nodes.push({ id: 'review_again', type: 'humanTask', name: 'Analisar a solicitação de compra', roleId: 'manager', requirementRefs: ['req_review_again'] });
  ambiguous.requirements.push({ id: 'req_review_again', kind: 'activity', mandatory: true, nodeId: 'review_again' });
  ambiguous.edges.push({ id: 'review_again_decision', source: 'review_again', target: 'decision', kind: 'sequence', requirementRefs: [] });
  await assert.rejects(() => new AiOrchestrator(new QueueProvider([ambiguous]), 'offline-model', env()).generate({ text: source, sourceMessageId: messageId, history: [], requirementLedger: actorLedger }), (error: any) => error.code === 'GRAPHIR_INVALID' || error.code === 'GRAPHIR_COVERAGE_INCONCLUSIVE');

  const actorMissing = structuredClone(providerValue);
  actorMissing.requirements.push({ id: 'req_actor_missing', kind: 'actor', mandatory: true, roleId: 'manager' });
  const actorMissingResult = validateGraphIR(normalizeGraphIrProviderValue(actorMissing));
  assert.ok(actorMissingResult.diagnostics.some(item => item.code === 'GRAPHIR_ACTOR_REQUIREMENT_INCOMPLETE'));
  assert.ok(actorMissingResult.diagnostics.some(item => item.code === 'GRAPHIR_REQUIREMENT_UNCOVERED'));
});

test('reembolso com múltiplas tarefas do mesmo papel mantém cobertura de ator válida', async () => {
  const source = 'Um funcionário solicita compra de material. O gestor analisa a solicitação. O funcionário corrige solicitação. O funcionário corrige dados de pagamento. O financeiro providencia a compra.';
  const messageId = 'reembolso-multi-task-actor';
  const actorQuote = 'O funcionário corrige solicitação.';
  const start = source.indexOf(actorQuote);
  const actor = { ...requirementFromEvidence({ messageId, text: source, type: 'actor', start, end: start + actorQuote.length }), state: 'user-stated' as const };
  const ledger = { schemaVersion: '1.0.0' as const, extraction: { complete: false, method: 'actor-multi-task-regression', diagnostics: [] }, requirements: [actor] };
  const graph: any = r01();
  graph.nodes.find((item: any) => item.id === 'submit').roleId = 'employee';
  for (const [nodeId, name] of [['correct_request', 'Corrigir solicitação'], ['correct_payment', 'Corrigir dados de pagamento']] as const) {
    const requirementId = `req_${nodeId}`;
    graph.requirements.push({ id: requirementId, kind: 'activity', mandatory: true, nodeId });
    graph.nodes.push({ id: nodeId, type: 'humanTask', name, roleId: 'employee', requirementRefs: [requirementId] });
  }
  graph.edges.push(
    { id: 'submit_correct_request', source: 'submit', target: 'correct_request', kind: 'sequence', requirementRefs: [] },
    { id: 'correct_request_correct_payment', source: 'correct_request', target: 'correct_payment', kind: 'sequence', requirementRefs: [] },
    { id: 'correct_payment_review', source: 'correct_payment', target: 'review', kind: 'sequence', requirementRefs: [] },
  );
  const outcome = await new AiOrchestrator(new QueueProvider([graph]), 'offline-model', env()).generate({ text: source, sourceMessageId: messageId, history: [], requirementLedger: ledger });
  assert.equal(outcome.kind, 'proposed_spec', JSON.stringify(outcome));
});

test('SC11/SC12/SC13/SC14: rejeita GraphIR inválido, lowering inválido e falha provider sem produzir proposta parcial', async () => {
  const invalid = r01(); invalid.edges.find((edge: any) => edge.id === 'approve_purchase').target = 'node_invented';
  const provider = new QueueProvider([invalid]);
  await assert.rejects(() => new AiOrchestrator(provider, 'model', env()).generate({ text: 'O funcionário solicita compra de material.', history: [] }), (error: any) => error.code === 'GRAPHIR_INVALID');
  const unsupported = r01(); unsupported.process.targetProfile = 'flowable-oss';
  const lowered = await lowerGraphIRToProcessSpec(normalizeGraphIrProviderValue(removeNulls(unsupported)));
  assert.equal(lowered.valid, false);
  assert.ok(lowered.diagnostics.some(item => item.code === 'GRAPHIR_TARGET_PROFILE_UNSUPPORTED'));
  const failedProvider = new QueueProvider([new ProviderFailure('PROVIDER_REJECTED', 'schema rejected')]);
  await assert.rejects(() => new AiOrchestrator(failedProvider, 'model', env()).generate({ text: 'Sintético.', history: [] }), (error: any) => error.code === 'PROVIDER_REJECTED');
  assert.equal(failedProvider.requests.length, 1);

  const repository = new InMemoryConversationRepository();
  const app = await buildApp(env({ aiGraphIrMode: 'controlled', aiProvider: 'openai-compatible', aiModel: 'openai/gpt-oss-120b', externalAiApiKey: 'test-only-key', externalAiBaseUrl: 'https://api.groq.com/openai/v1' }), { conversationRepository: repository, modelProvider: new QueueProvider([new ProviderFailure('PROVIDER_REJECTED', 'schema rejected', undefined, { httpStatus: 400, category: 'structured_output_parameters', providerParam: 'response_format', providerType: 'invalid_request_error', requestId: 'req-synthetic-test' })]) });
  try {
    const providerStatus = await app.inject({ method: 'GET', url: '/api/v1/providers/status' });
    assert.equal(providerStatus.json().provider.provider, 'offline-graphir-fixture');
    assert.equal(providerStatus.json().provider.model, 'openai/gpt-oss-120b');
    assert.equal(providerStatus.json().provider.endpointOrigin, 'https://api.groq.com');
    assert.equal(providerStatus.json().provider.apiKeyConfigured, true);
    assert.doesNotMatch(providerStatus.body, /test-only-key/);
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Falha sintética', targetProfile: 'generic-bpmn2' } });
    const sessionId = project.json().sessionId;
    const response = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: 'Descrição sintética.', baseRevision: 0 } });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().providerDiagnostic.httpStatus, 400);
    assert.equal(response.json().providerDiagnostic.providerParam, 'response_format');
    assert.equal(response.json().providerDiagnostic.requestId, 'req-synthetic-test');
    assert.deepEqual((await repository.listRevisions('offline', sessionId)), []);
  } finally { await app.close(); }
});

test('SC15/SC16: off segue pelo contrato anterior e controlled envia GraphIR em uma única chamada', async () => {
  const offProvider = new QueueProvider([{ kind: 'need_clarification', summary: 'Falta esclarecer.', questions: [{ question: 'Qual grupo?', blocking: true }] }]);
  const off = await new AiOrchestrator(offProvider, 'model', env({ aiGraphIrMode: 'off' })).generate({ text: 'Uma solicitação.', history: [] });
  assert.equal(off.kind, 'need_clarification');
  assert.notEqual(offProvider.requests[0].outputSchema.title, 'GraphIR v1');
  const controlledProvider = new QueueProvider([r01()]);
  await new AiOrchestrator(controlledProvider, 'model', env({ aiGraphIrMode: 'controlled' })).generate({ text: 'Um funcionário solicita compra de material, informando o material solicitado. O gestor analisa a solicitação. Se aprovar, o financeiro recebe para providenciar a compra. Se reprovar, o processo termina.', history: [] });
  assert.equal(controlledProvider.requests.length, 1);
  assert.equal(controlledProvider.requests[0].outputSchema.title, 'GraphIR v1');
});

test('JSON Object GraphIR inclui o schema de transporte no prompt; strict continua com schema no provider', async () => {
  const fixtureProvider = new QueueProvider([r01()]);
  const objectProvider: ModelProvider = { id: 'openai-compatible', generateStructured: request => fixtureProvider.generateStructured(request) };
  const sourceText = 'Um funcionário solicita compra de material, informando o material solicitado. O gestor analisa a solicitação. Se aprovar, o financeiro recebe para providenciar a compra. Se reprovar, o processo termina.';
  await new AiOrchestrator(objectProvider, 'model', env({ aiGraphIrMode: 'controlled', externalAiStructuredOutput: 'json-object' })).generate({ text: sourceText, history: [] });
  assert.match(fixtureProvider.requests[0].prompt, /Schema JSON de transporte GraphIR v1/);
  assert.match(fixtureProvider.requests[0].prompt, /"required":\["schemaVersion","process","roles","variables","requirements","nodes","edges","formRefs","metadata"\]/);
  assert.match(fixtureProvider.requests[0].prompt, /requirement kind=activity com nodeId igual ao próprio node/);
  assert.match(fixtureProvider.requests[0].prompt, /Nunca use constant null para uma variável tipada/);
  assert.match(fixtureProvider.requests[0].prompt, /Não envie gatewayId/);
  assert.match(fixtureProvider.requests[0].prompt, /não crie actor incompleto/);

  const strictFixtureProvider = new QueueProvider([r01()]);
  const strictProvider: ModelProvider = { id: 'openai-compatible', generateStructured: request => strictFixtureProvider.generateStructured(request) };
  await new AiOrchestrator(strictProvider, 'model', env({ aiGraphIrMode: 'controlled', externalAiStructuredOutput: 'json-schema-strict' })).generate({ text: sourceText, history: [] });
  assert.doesNotMatch(strictFixtureProvider.requests[0].prompt, /Schema JSON de transporte GraphIR v1/);
});

test('SC18/SC20: resposta e erro HTTP têm diagnóstico seguro, sem echo de conteúdo privado', async () => {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'invalid_json_schema', type: 'invalid_request_error', param: 'response_format', message: 'invalid schema with SECRET_SYNTHETIC_SENTINEL' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${address.port}/v1`, 'offline-key', 'json-schema-strict');
    const request: StructuredRequest = { model: 'openai/gpt-oss-120b', system: 'synthetic system', prompt: 'synthetic prompt', outputSchema: graphIrProviderSchema(), timeoutMs: 1000, contextTokens: 8192, maxOutputTokens: 8192 };
    await assert.rejects(() => provider.generateStructured(request), (error: any) => {
      assert.ok(error instanceof ProviderFailure);
      assert.equal(error.diagnostic?.category, 'schema_rejected');
      assert.doesNotMatch(JSON.stringify(error.diagnostic), /SECRET_SYNTHETIC_SENTINEL|synthetic prompt|offline-key/);
      return true;
    });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('SC01/SC19: contrato de saída configurado é json_schema strict, sem streaming/tools, dentro dos limites locais', async () => {
  let sent: any;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      sent = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'invalid_json_schema', message: 'synthetic rejection' } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${address.port}/v1`, 'offline-key', 'json-schema-strict', { maxCalls: 1, maxTokens: 24000 });
    const request: StructuredRequest = { model: 'openai/gpt-oss-120b', system: 'system', prompt: 'synthetic R01', outputSchema: graphIrProviderSchema(), timeoutMs: 180000, contextTokens: 8192, maxOutputTokens: 8192 };
    await assert.rejects(() => provider.generateStructured(request), ProviderFailure);
    assert.equal(sent.model, 'openai/gpt-oss-120b');
    assert.equal(sent.stream, false);
    assert.equal(sent.max_completion_tokens, 8192);
    assert.equal(sent.max_tokens, undefined);
    assert.equal(sent.tools, undefined);
    assert.equal(sent.response_format.type, 'json_schema');
    assert.equal(sent.response_format.json_schema.strict, true);
    assert.deepEqual(sent.response_format.json_schema.schema, toStrictProviderSchema(request.outputSchema));
    assert.ok(JSON.stringify(sent.response_format).length < 12000, 'payload schema remains bounded and finite');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('SC21: JSON Object Mode envia somente type=json_object e faz parse JSON local', async () => {
  let sent: any;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      sent = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        model: 'openai/gpt-oss-120b',
        choices: [{ message: { content: JSON.stringify({ marker: 'parsed-locally' }) } }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${address.port}/v1`, 'offline-key', 'json-object', { maxCalls: 1, maxTokens: 1000 });
    let measured: any;
    const request: StructuredRequest = { model: 'openai/gpt-oss-120b', system: 'system', prompt: 'synthetic R01', outputSchema: graphIrProviderSchema(), timeoutMs: 1000, contextTokens: 8192, maxOutputTokens: 128, onTransportMetrics: value => { measured = value; } };
    const result = await provider.generateStructured(request);
    assert.deepEqual(sent.response_format, { type: 'json_object' });
    assert.equal(Object.hasOwn(sent.response_format, 'json_schema'), false);
    assert.deepEqual(result.value, { marker: 'parsed-locally' });
    assert.equal(measured.jsonBytes, Buffer.byteLength(JSON.stringify(sent), 'utf8'));
    assert.equal(measured.promptChars, request.prompt.length);
    assert.equal(measured.systemBytes, Buffer.byteLength(`${request.system}\n\nReturn the response as a valid json object.`, 'utf8'));
    assert.equal(measured.schemaBytes, 0, 'JSON Object não serializa JSON Schema no request_format');
    assert.equal(measured.messageCount, 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('DIAG01-DIAG03: normalização remove null opcional não anulável sem preencher valores e R01 segue válido', () => {
  const normalized: any = normalizeGraphIrProviderValue(r01());
  assert.equal(validateGraphIR(normalized).valid, true);
  assert.equal(Object.hasOwn(normalized.process, 'description'), false, 'null opcional não anulável vira propriedade ausente');
  assert.equal(Object.hasOwn(normalized.nodes[0], 'roleId'), false, 'null opcional não vira valor inventado');
  assert.equal(normalized.requirements[0].value, null, 'null explicitamente permitido pelo schema é preservado');
  assert.deepEqual(normalized.edges.find((edge: any) => edge.id === 'approve_purchase')?.condition, { op: 'eq', left: { var: 'var_approved' }, right: { literal: true } });
});

test('DIAG04-DIAG12: AJV diagnostics identify structural failures with bounded, value-free paths', () => {
  const invalidId: any = r01(); delete invalidId.nodes[1].id;
  const missingId = diagnoseGraphIRSchema(normalizeGraphIrProviderValue(invalidId));
  assert.ok(missingId);
  assert.ok(missingId.errors.some(item => item.path === '/nodes/1' && item.keyword === 'required' && item.missingProperty === 'id' && item.arrayIndex === 1));

  const badEnum: any = r01(); badEnum.nodes[1].type = 'human-task';
  const enumErrors = diagnoseGraphIRSchema(normalizeGraphIrProviderValue(badEnum))!;
  assert.ok(enumErrors.errors.some(item => item.path === '/nodes/1/type' && item.keyword === 'enum' && item.expectedValues?.includes('humanTask')));

  const badType: any = r01(); badType.variables[0].required = 'true';
  const typeErrors = diagnoseGraphIRSchema(normalizeGraphIrProviderValue(badType))!;
  assert.ok(typeErrors.errors.some(item => item.path === '/variables/0/required' && item.keyword === 'type' && item.expectedType === 'boolean' && item.receivedType === 'string' && item.arrayIndex === 0));

  const extra: any = r01(); extra.process.apiToken = 'sentinel-value';
  const extraErrors = diagnoseGraphIRSchema(normalizeGraphIrProviderValue(extra))!;
  const extraDiagnostic = extraErrors.errors.find(item => item.keyword === 'additionalProperties');
  assert.equal(extraDiagnostic?.additionalProperty, '[redacted]');
  assert.equal(extraDiagnostic?.path, '/process', 'additionalProperties points to its containing object; the field name is separate');
  assert.doesNotMatch(JSON.stringify(extraErrors), /apiToken|sentinel-value/);

  const badUnion: any = r01(); badUnion.variables[0].source = { kind: 'form', formRef: 'form_request' };
  const unionErrors = diagnoseGraphIRSchema(normalizeGraphIrProviderValue(badUnion))!;
  assert.ok(unionErrors.errors.some(item => item.path === '/variables/0/source' && item.keyword === 'oneOf'));
  assert.ok(unionErrors.errors.some(item => item.path === '/variables/0/source' && item.keyword === 'required' && item.missingProperty === 'fieldKey'));

  const badForm: any = r01(); badForm.formRefs[0].fields[0].required = 'yes';
  const formErrors = diagnoseGraphIRSchema(normalizeGraphIrProviderValue(badForm))!;
  const formRequired = formErrors.errors.find(item => item.path === '/formRefs/0/fields/0/required' && item.keyword === 'type');
  assert.equal(formRequired?.expectedType, 'boolean');
  assert.deepEqual(formRequired?.arrayIndices?.map(item => item.index), [0, 0]);
  assert.deepEqual(formRequired?.arrayIndices?.map(item => item.arrayPath), ['/formRefs', '/formRefs/0/fields']);

  const emptyNodes: any = r01(); emptyNodes.nodes = [];
  const emptyErrors = diagnoseGraphIRSchema(normalizeGraphIrProviderValue(emptyNodes))!;
  assert.ok(emptyErrors.errors.some(item => item.path === '/nodes' && item.keyword === 'minItems'));

  const manyExtras: any = r01(); for (let index = 0; index < 40; index++) manyExtras.process[`extra_${index}`] = true;
  const bounded = diagnoseGraphIRSchema(normalizeGraphIrProviderValue(manyExtras))!;
  assert.equal(bounded.errors.length, 25);
  assert.ok(bounded.truncated > 0);
  assert.equal(bounded.totalErrors, bounded.errors.length + bounded.truncated);
});

test('DIAG13-DIAG16: falhas de referência/role/condição ficam na validação semântica, não viram schema permissivo', () => {
  const missingRole: any = normalizeGraphIrProviderValue(r01()); delete missingRole.nodes.find((node: any) => node.id === 'purchase').roleId;
  assert.equal(validateGraphIRStructure(missingRole).valid, true, 'roleId é opcional no schema estrutural');
  assert.ok(validateGraphIR(missingRole).diagnostics.some(item => item.code === 'GRAPHIR_ROLE_REQUIRED' && item.path === '/nodes/purchase/roleId'));

  const missingTarget: any = normalizeGraphIrProviderValue(r01()); missingTarget.edges[0].target = 'not_a_node';
  assert.ok(validateGraphIR(missingTarget).diagnostics.some(item => item.code === 'GRAPHIR_NODE_REFERENCE_MISSING' && item.path === '/edges/start_submit/target'));

  const missingVariable: any = structuredClone(normalizeGraphIrProviderValue(r01()));
  missingVariable.edges.find((edge: any) => edge.id === 'approve_purchase').condition.left.var = 'not_a_variable';
  assert.ok(validateGraphIR(missingVariable).diagnostics.some(item => item.code === 'GRAPHIR_VARIABLE_REFERENCE_MISSING'));

  const missingCondition: any = structuredClone(normalizeGraphIrProviderValue(r01()));
  delete missingCondition.edges.find((edge: any) => edge.id === 'approve_purchase').condition;
  assert.ok(validateGraphIR(missingCondition).diagnostics.some(item => item.code === 'GRAPHIR_GATEWAY_ROUTE_UNCONDITIONED'));
});

test('R01 real regression: requisito actor não substitui activity, gateway exige structure e aprovação não aceita constant null', () => {
  const returnedPattern: any = structuredClone(r01());
  const managerActivity = returnedPattern.requirements.find((item: any) => item.id === 'req_review');
  managerActivity.kind = 'actor';
  managerActivity.roleId = 'manager';
  returnedPattern.requirements = returnedPattern.requirements.filter((item: any) => item.id !== 'req_gateway' && item.id !== 'req_purchase');
  returnedPattern.nodes.find((item: any) => item.id === 'decision').requirementRefs = [];
  returnedPattern.nodes.find((item: any) => item.id === 'purchase').requirementRefs = [];
  returnedPattern.variables.find((item: any) => item.id === 'var_approved').source = { kind: 'constant', value: null };

  const result = validateGraphIR(normalizeGraphIrProviderValue(returnedPattern));
  const diagnostics = result.diagnostics.map(item => `${item.code}:${item.path}`);
  assert.ok(diagnostics.includes('GRAPHIR_ELEMENT_REQUIREMENT_KIND_INVALID:/nodes/review/requirementRefs'));
  assert.ok(diagnostics.includes('GRAPHIR_ELEMENT_UNGROUNDED:/nodes/decision'));
  assert.ok(diagnostics.includes('GRAPHIR_ELEMENT_REQUIREMENT_KIND_INVALID:/nodes/decision/requirementRefs'));
  assert.ok(diagnostics.includes('GRAPHIR_ELEMENT_UNGROUNDED:/nodes/purchase'));
  assert.ok(diagnostics.includes('GRAPHIR_ELEMENT_REQUIREMENT_KIND_INVALID:/nodes/purchase/requirementRefs'));
  assert.ok(diagnostics.includes('GRAPHIR_VARIABLE_SOURCE_TYPE_INVALID:/variables/var_approved/source/value'));
});

test('R01 second-attempt regression: actor incompleto permanece erro explícito mesmo com gatewayId derivável', () => {
  const returnedPattern: any = structuredClone(r01());
  returnedPattern.requirements.push({ id: 'req_actor_manager', kind: 'actor', mandatory: true, roleId: 'manager' });
  for (const edge of returnedPattern.edges.filter((item: any) => item.source === 'decision')) delete edge.gatewayId;

  const normalized: any = normalizeGraphIrProviderValue(returnedPattern);
  assert.deepEqual(normalized.edges.filter((item: any) => item.source === 'decision').map((item: any) => item.gatewayId), ['decision', 'decision']);
  const diagnostics = validateGraphIR(normalized).diagnostics.map(item => `${item.code}:${item.path}`);
  assert.ok(diagnostics.includes('GRAPHIR_ACTOR_REQUIREMENT_INCOMPLETE:/requirements/req_actor_manager'));
  assert.ok(diagnostics.includes('GRAPHIR_REQUIREMENT_UNCOVERED:/requirements/req_actor_manager'));
  assert.ok(diagnostics.includes('GRAPHIR_ROLE_REQUIREMENT_DIVERGENCE:/requirements/req_actor_manager'));
});

test('DIAG17: detalhes estruturados ficam no erro de desenvolvimento/teste e não na resposta pública', async () => {
  const malformed: any = r01(); malformed.process.apiToken = 'private-sentinel-value';
  const provider = new QueueProvider([malformed, malformed]);
  await assert.rejects(
    () => new AiOrchestrator(provider, 'model', env({ aiGraphIrMode: 'controlled' })).generate({ text: 'Pedido sintético.', history: [] }),
    (error: any) => {
      assert.equal(error.code, 'GRAPHIR_INVALID');
      assert.ok(error.graphIrSchemaDiagnostics.totalErrors > 0);
      assert.ok(error.graphIrSchemaDiagnostics.errors.length > 0);
      assert.doesNotMatch(JSON.stringify(error.graphIrSchemaDiagnostics), /private-sentinel-value|apiToken/);
      return true;
    },
  );

  const repository = new InMemoryConversationRepository();
  const app = await buildApp(env({ aiGraphIrMode: 'controlled' }), { conversationRepository: repository, modelProvider: new QueueProvider([malformed, malformed]) });
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Falha diagnóstica sintética', targetProfile: 'generic-bpmn2' } });
    const response = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${project.json().sessionId}/messages`, payload: { text: 'Pedido sintético.', baseRevision: 0, dataClassification: 'synthetic' } });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().code, 'GRAPHIR_INVALID');
    assert.ok(response.json().generationRunId, 'erro permite consultar o run persistido sem acesso ao banco');
    const failedRun = await app.inject({ method: 'GET', url: `/api/v1/generation-runs/${response.json().generationRunId}` });
    assert.equal(failedRun.statusCode, 200);
    assert.ok(failedRun.json().metrics.pipeline.find((item: any) => item.stage === 'graph-ir-validation').details.schemaDiagnostics.errors.length > 0);
    assert.doesNotMatch(response.body, /schemaPath|additionalProperty|private-sentinel-value|apiToken/);
  } finally { await app.close(); }
});

test('DIAG18: falha semântica persiste diagnósticos sanitizados no run, sem expor valores nem IDs de elementos', async () => {
  const malformed: any = structuredClone(normalizeGraphIrProviderValue(r01()));
  malformed.process.name = 'private-sentinel-value';
  malformed.edges.find((edge: any) => edge.id === 'approve_purchase').condition.left.var = 'missing_private_variable';
  malformed.nodes.find((node: any) => node.id === 'review').name = 'private-sentinel-node';
  malformed.requirements.find((requirement: any) => requirement.id === 'req_review').nodeId = 'submit';
  const diagnostics = validateGraphIR(malformed).diagnostics;
  const safe = sanitizeGraphIrDiagnostics(diagnostics);
  assert.ok(safe.some(item => item.code === 'GRAPHIR_VARIABLE_REFERENCE_MISSING' && item.path === '/edges/[id]/condition/left' && item.type === 'semantic'));
  assert.ok(safe.some(item => item.code === 'GRAPHIR_REQUIREMENT_BINDING_INVALID' && item.path === '/nodes/[id]/requirementRefs' && item.requirementId === 'req_review' && item.type === 'coverage'));
  assert.doesNotMatch(JSON.stringify(safe), /private-sentinel|missing_private_variable/);
  const validatorStages = sanitizeGraphIrDiagnostics([
    { code: 'GRAPHIR_SCHEMA_INVALID', path: '/nodes/0', message: 'schema', severity: 'error' },
    { code: 'GRAPHIR_REQUIREMENT_REFERENCE_MISSING', path: '/nodes/review/requirementRefs', message: 'coverage', severity: 'error' },
    { code: 'GRAPHIR_REQUIREMENT_REFERENCE_MISSING', path: '/requirements/req_actor/roleId', message: 'semantic', severity: 'error' },
  ]);
  assert.deepEqual(validatorStages.map(item => [item.stage, item.type]), [['graph-ir-schema', 'schema'], ['graph-ir-coverage', 'coverage'], ['graph-ir-semantic', 'semantic']]);

  const provider = new QueueProvider([malformed, malformed]);
  const repository = new InMemoryConversationRepository();
  const app = await buildApp(env({ aiGraphIrMode: 'controlled' }), { conversationRepository: repository, modelProvider: provider });
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Falha semântica sintética', targetProfile: 'generic-bpmn2' } });
    const generated = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${project.json().sessionId}/messages`, payload: { text: 'Pedido sintético.', baseRevision: 0, dataClassification: 'synthetic' } });
    assert.equal(generated.statusCode, 200);
    assert.equal(generated.json().status, 'needs-input');
    assert.equal(generated.json().kind, 'need_clarification');
    assert.doesNotMatch(generated.body, /private-sentinel|missing_private_variable/);
    const runId = generated.json().generationRunId;
    assert.ok(runId, 'falha de semântica expõe ID consultável do run');
    const run = await app.inject({ method: 'GET', url: `/api/v1/generation-runs/${runId}` });
    assert.equal(run.statusCode, 200);
    const validation = run.json().metrics.pipeline.find((item: any) => item.stage === 'graph-ir-validation');
    assert.ok(validation.details.diagnostics.some((item: any) => item.code === 'GRAPHIR_VARIABLE_REFERENCE_MISSING'));
    assert.ok(run.json().metrics.pipeline.some((item: any) => item.stage === 'clarification' && item.status === 'required'));
    assert.doesNotMatch(run.body, /private-sentinel|missing_private_variable|"condition"\s*:\s*\{/);
  } finally { await app.close(); }
});

test('GraphIR: erro exclusivamente estrutural recebe uma correção limitada e volta a passar pelos validadores', async () => {
  const malformed = structuredClone(r01());
  malformed.nodes.find((node: any) => node.id === 'review').unexpected = 'discard-me';
  const provider = new QueueProvider([malformed, r01()]);
  const result = await new AiOrchestrator(provider, 'model', env({ aiGraphIrMode: 'controlled' })).generate({
    text: 'Um funcionário solicita compra de material. O gestor analisa a solicitação. Se aprovar, o financeiro recebe para providenciar a compra. Se reprovar, o processo termina.',
    history: [],
  });
  assert.equal(provider.requests.length, 2);
  assert.equal(result.kind, 'proposed_spec');
  assert.equal((result as any).validation.valid, true);
  assert.ok(result.diagnostics?.some(item => item.stage === 'graph-ir-validation' && item.status === 'valid-after-structural-repair'));
});

test('GraphIR: contexto após esclarecimentos mantém a fonte original e envia cada resposta uma só vez', async () => {
  const provider = new QueueProvider([r01()]);
  const original = 'O funcionário solicita compra de material. O gestor analisa. Acima de R$ 2.000, o diretor aprova; até R$ 2.000, o financeiro processa. Há dois ciclos independentes de correção.';
  const answer = 'O gestor pode devolver para correção e o solicitante reenviar.';
  const result = await new AiOrchestrator(provider, 'model', env({ aiGraphIrMode: 'controlled' })).generate({
    text: answer, sourceMessageType: 'confirmed-answer', sourceMessageId: 'answer-turn-2', originalSource: { id: 'original-1', text: original }, history: [],
    confirmedFacts: [{ question: 'Como funciona a correção?', answer, confirmedAt: new Date(0).toISOString(), questionId: 'q_1', requirementId: 'req_1', semanticSlot: 'slot_1', state: 'confirmed' }],
  });
  assert.equal(result.kind, 'proposed_spec');
  const prompt = provider.requests[0].prompt;
  assert.equal(prompt.split(original).length - 1, 1);
  assert.equal(prompt.split(answer).length - 1, 1);
  assert.match(prompt, /Fonte original imutável/);
  assert.match(prompt, /Ledger V1/);
  assert.match(prompt, /R\$ 2\.000/);
  assert.match(prompt, /dois ciclos independentes/);
});

