import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Environment } from '../src/config/env.js';
import { AiOrchestrator } from '../src/modules/ai/orchestrator.js';
import { buildApp } from '../src/app.js';
import { graphIrProviderSchema, normalizeGraphIrProviderValue } from '../src/modules/graph-ir/provider-schema.js';
import { lowerGraphIRToProcessSpec } from '../src/modules/graph-ir/processspec.adapter.js';
import { validateGraphIR } from '../src/modules/graph-ir/graph-ir.js';
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
    return { value: removeNulls(value), usage: { inputTokens: 350, outputTokens: 700 }, latencyMs: 5, model: request.model };
  }
}

function removeNulls(value: any): any {
  if (Array.isArray(value)) return value.map(removeNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, removeNulls(item)]));
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
  assert.equal(ajv.compile(projected)(removeNulls(raw)), true);
  assert.equal(validateGraphIR(normalizeGraphIrProviderValue(removeNulls(raw))).valid, true);
  assert.ok(projected.properties.nodes.items.properties.action === undefined, 'serviceTask executável não entra no payload controlado');
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
  assert.equal(new Ajv2020({ allErrors: true, strict: false }).compile(graphIrProviderSchema())(removeNulls(providerValue)), true, 'array de edges no contrato aceita múltiplos loop-backs');
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
  const r01Provider = new QueueProvider([r01()]);
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
  const r02Provider = new QueueProvider([r02()]);
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
  const app = await buildApp(env({ aiGraphIrMode: 'controlled' }), { conversationRepository: repository, modelProvider: new QueueProvider([new ProviderFailure('PROVIDER_REJECTED', 'schema rejected')]) });
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Falha sintética', targetProfile: 'generic-bpmn2' } });
    const sessionId = project.json().sessionId;
    const response = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: 'Descrição sintética.', baseRevision: 0 } });
    assert.equal(response.statusCode, 502);
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
    assert.equal(sent.max_tokens, 8192);
    assert.equal(sent.tools, undefined);
    assert.equal(sent.response_format.type, 'json_schema');
    assert.equal(sent.response_format.json_schema.strict, true);
    assert.deepEqual(sent.response_format.json_schema.schema, toStrictProviderSchema(request.outputSchema));
    assert.ok(JSON.stringify(sent.response_format).length < 12000, 'payload schema remains bounded and finite');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

