import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { Environment } from '../src/config/env.js';
import { buildApp } from '../src/app.js';
import { BpmKnowledgeEngine } from '../src/modules/knowledge/knowledge.engine.js';
import { AiOrchestrator } from '../src/modules/ai/orchestrator.js';
import { interpretationSchema, normalizeInterpretation } from '../src/modules/ai/interpretation-context.js';
import { composeProcessSpec } from '../src/modules/ai/process-plan.js';
import { validateProcessSpec } from '../src/modules/validation/validation.service.js';
import { InMemoryConversationRepository } from '../src/modules/projects/conversation.repository.js';
import { OllamaProvider, OpenAICompatibleProvider, ProviderFailure, toStrictProviderSchema, type ModelProvider, type StructuredRequest, type StructuredResponse } from '../src/modules/providers/model-provider.js';
import { configuredProvider } from '../src/modules/ai/provider.factory.js';
import { semanticIntentSchema } from '../src/modules/ai/semantic-process.js';
import { identityForQuestion, latestSemanticFactEvents } from '../src/modules/ai/semantic-grounding.js';
import { requirementFromEvidence, type RequirementLedgerV1 } from '../src/modules/ai/requirement-coverage.js';
import { graphIrProviderSchema, normalizeGraphIrProviderValue } from '../src/modules/graph-ir/provider-schema.js';
import { validateGraphIR } from '../src/modules/graph-ir/graph-ir.js';

async function fixture(): Promise<any> { return JSON.parse(await readFile('specs/foundation/examples/ferias.json', 'utf8')); }
function compactExpression(value: any): any {
  if (!value || typeof value !== 'object') return value;
  if (value.op && value.left?.var && Object.hasOwn(value.right || {}, 'literal')) return { variable: value.left.var, operator: value.op, value: value.right.literal };
  return value;
}
function proposal(spec: any, changeSummary = 'Processo de férias proposto') {
  const project = structuredClone(spec);
  return {
    kind: 'process_plan', id: project.id, name: project.name, description: project.description || '', changeSummary,
    roles: project.roles, variables: project.variables, forms: project.forms.map((form: any) => ({ ...form, fields: form.fields.map((field: any) => ({ ...field, ...(field.visibleWhen ? { visibleWhen: compactExpression(field.visibleWhen) } : {}), ...(field.requiredWhen ? { requiredWhen: compactExpression(field.requiredWhen) } : {}) })) })),
    nodes: project.nodes.map((node: any) => ({ ...node, ...(node.action ? { action: { ...node.action, inputMapping: Object.fromEntries(Object.entries(node.action.inputMapping || {}).map(([key, value]) => [key, compactExpression(value)])), ...(node.action.idempotencyKey ? { idempotencyKey: compactExpression(node.action.idempotencyKey) } : {}) } } : {}) })),
    flows: project.flows.map((flow: any) => ({ ...flow, ...(flow.condition ? { condition: compactExpression(flow.condition) } : {}) })),
    pendingQuestions: project.pendingQuestions.map(({ question, blocking }: any) => ({ question, blocking })),
  };
}
function semanticVacationIntent() {
  return { kind: 'business_intent', name: 'Solicitação de férias', purpose: 'Solicitar férias, obter decisão do gestor e registrar no RH quando aprovada.',
    actors: [{ name: 'Servidor', resolution: 'requester', evidence: 'servidor solicitante faz a solicitação', resolutionEvidence: 'servidor solicitante faz a solicitação' }, { name: 'Gestor', evidence: 'O gestor é selecionado manualmente pelo operador autorizado e aprova ou reprova' }, { name: 'RH', evidence: 'O RH é grupo RH e registra se houver aprovação' }],
    startFields: [{ name: 'Data inicial', type: 'date', required: true, evidence: 'data inicial e a data final das férias' }, { name: 'Data final', type: 'date', required: true, evidence: 'data inicial e a data final das férias' }],
    activities: [{ kind: 'approval', name: 'Aprovar ou reprovar solicitação', actor: 'Gestor', evidence: 'O gestor é selecionado manualmente pelo operador autorizado e aprova ou reprova', requiresRejectionReason: true,
      onApproved: [{ kind: 'task', name: 'Registrar férias', actor: 'RH', evidence: 'O RH é grupo RH e registra se houver aprovação' }], onRejected: [{ kind: 'task', name: 'Receber motivo', actor: 'Servidor', evidence: 'o servidor deve ser informado do motivo' }] }],
    rules: [{ text: 'Exigir motivo quando houver reprovação.', evidence: 'Se reprovado, o servidor deve ser informado do motivo.' }], suggestions: [], pendingConfiguration: [],
  };
}
const supportedVacationRequest = 'O servidor solicitante faz a solicitação informando a data inicial e a data final das férias. O gestor é selecionado manualmente pelo operador autorizado e aprova ou reprova. O RH é grupo RH e registra se houver aprovação. Se reprovado, o servidor deve ser informado do motivo.';
function environment(overrides: Partial<Environment> = {}): Environment {
  return { host: '127.0.0.1', port: 3333, corsOrigins: [], logLevel: 'silent', localTenantId: 'test-tenant', aiProvider: 'disabled', ollamaBaseUrl: 'http://127.0.0.1:11434', externalAiApproved: false, aiTimeoutMs: 400, aiContextTokens: 8192, aiMaxOutputTokens: 2048, aiMaxInputChars: 24000, aiMaxConcurrency: 2, externalAiStructuredOutput: 'json-object', aiMaxProviderCalls: 0, aiMaxProviderTokens: 0, aiSemanticGroundingMode: 'legacy', aiGraphIrMode: 'off', ...overrides };
}
class QueueProvider implements ModelProvider {
  readonly id = 'queue-test';
  readonly prompts: StructuredRequest[] = [];
  constructor(private readonly responses: unknown[]) {}
  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    this.prompts.push(request);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return { value: response, usage: { inputTokens: 101, outputTokens: 57 }, latencyMs: 15, model: request.model };
  }
}
const clarification = { kind: 'need_clarification', questions: [{ question: 'Qual unidade deve localizar o gestor?', blocking: true }], summary: 'Falta definir como obter o responsável.' };

function graphIrApproval(): any {
  return {
    schemaVersion: '1.0.0', process: { id: 'purchase_process', name: 'Compra de material', description: 'Solicitação de compra', locale: 'pt-BR', targetProfile: 'generic-bpmn2' },
    roles: [{ id: 'employee', label: 'Funcionário', resolution: 'requester' }, { id: 'manager', label: 'Gestor', resolution: 'unresolved' }, { id: 'finance', label: 'Financeiro', resolution: 'unresolved' }],
    variables: [
      { id: 'var_material', key: 'material', type: 'string', required: true, source: { kind: 'form', formRef: 'form_request', fieldKey: 'material' } },
      { id: 'var_approved', key: 'approved', type: 'boolean', required: true, source: { kind: 'form', formRef: 'form_manager', fieldKey: 'approved' } },
    ],
    requirements: [
      { id: 'req_submit', kind: 'activity', mandatory: true, nodeId: 'submit' },
      { id: 'req_review', kind: 'activity', mandatory: true, nodeId: 'review' },
      { id: 'req_purchase', kind: 'activity', mandatory: true, nodeId: 'purchase' },
      { id: 'req_gateway', kind: 'structure', mandatory: true, nodeId: 'decision' },
      { id: 'req_approved', kind: 'condition', mandatory: true, variableId: 'var_approved', operator: 'eq', value: true },
      { id: 'req_rejected', kind: 'condition', mandatory: true, variableId: 'var_approved', operator: 'eq', value: false },
      { id: 'req_material', kind: 'form-field', mandatory: true, formRef: 'form_request', fieldKey: 'material' },
      { id: 'req_decision_field', kind: 'form-field', mandatory: true, formRef: 'form_manager', fieldKey: 'approved' },
    ],
    nodes: [
      { id: 'start', type: 'start', name: 'Início', formRef: 'form_request', requirementRefs: [] },
      { id: 'submit', type: 'humanTask', name: 'Solicitar compra de material', roleId: 'employee', requirementRefs: ['req_submit'] },
      { id: 'review', type: 'humanTask', name: 'Analisar a solicitação de compra', roleId: 'manager', formRef: 'form_manager', requirementRefs: ['req_review'] },
      { id: 'decision', type: 'exclusiveGateway', name: 'Compra aprovada?', requirementRefs: ['req_gateway'] },
      { id: 'purchase', type: 'humanTask', name: 'Providenciar a compra', roleId: 'finance', requirementRefs: ['req_purchase'] },
      { id: 'end_approved', type: 'end', name: 'Compra providenciada', requirementRefs: [] },
      { id: 'end_rejected', type: 'end', name: 'Solicitação reprovada', requirementRefs: [] },
    ],
    edges: [
      { id: 'start_submit', source: 'start', target: 'submit', kind: 'sequence', requirementRefs: [] },
      { id: 'submit_review', source: 'submit', target: 'review', kind: 'sequence', requirementRefs: [] },
      { id: 'review_decision', source: 'review', target: 'decision', kind: 'sequence', requirementRefs: [] },
      { id: 'approve_purchase', source: 'decision', target: 'purchase', kind: 'sequence', gatewayId: 'decision', condition: { op: 'eq', variableId: 'var_approved', value: true }, requirementRefs: ['req_approved'] },
      { id: 'reject_end', source: 'decision', target: 'end_rejected', kind: 'sequence', gatewayId: 'decision', condition: { op: 'eq', variableId: 'var_approved', value: false }, requirementRefs: ['req_rejected'] },
      { id: 'purchase_end', source: 'purchase', target: 'end_approved', kind: 'sequence', requirementRefs: [] },
    ],
    formRefs: [
      { id: 'form_request', name: 'Solicitação de compra', usage: 'start', fields: [{ key: 'material', label: 'Material solicitado', type: 'text', bindTo: 'var_material', required: true, requirementRefs: ['req_material'] }] },
      { id: 'form_manager', name: 'Análise do gestor', usage: 'task', fields: [{ key: 'approved', label: 'Decisão', type: 'boolean', bindTo: 'var_approved', required: true, requirementRefs: ['req_decision_field'] }] },
    ], metadata: { provenance: [] },
  };
}

test('GraphIR provider projection supports strict structured outputs and keeps the internal schema authoritative', () => {
  const schema = graphIrProviderSchema();
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  const providerValue = graphIrApproval();
  assert.equal(validate(providerValue), true, JSON.stringify(validate.errors));
  assert.equal(validateGraphIR(normalizeGraphIrProviderValue(providerValue)).valid, true);
  const strict = toStrictProviderSchema(schema);
  assert.equal(strict.properties.response.additionalProperties, false);
  const optionalCondition = strict.properties.response.properties.edges.items.properties.condition;
  assert.deepEqual(optionalCondition.type, ['object', 'null']);
  assert.deepEqual(optionalCondition.properties.op.enum, ['eq', 'ne', 'gt', 'gte', 'lt', 'lte']);
  const forbidden = graphIrApproval(); forbidden.nodes[2].type = 'serviceTask';
  assert.equal(validate(forbidden), false, 'provider projection does not authorize undeclared operations');
  assert.equal(validateGraphIR(normalizeGraphIrProviderValue(graphIrApproval())).valid, true);
});

test('AI_GRAPH_IR_MODE controlled uses one provider call, lowers to validated ProcessSpec and generates existing artifacts', async () => {
  const provider = new QueueProvider([graphIrApproval()]);
  const result = await new AiOrchestrator(provider, 'model', environment({ aiGraphIrMode: 'controlled' })).generate({
    text: 'Um funcionário solicita compra de material, informando o material solicitado. O gestor analisa a solicitação. Se aprovar, o financeiro recebe para providenciar a compra. Se reprovar, o processo termina.', history: [],
  });
  assert.equal(provider.prompts.length, 1);
  assert.equal(result.kind, 'proposed_spec');
  if (result.kind !== 'proposed_spec') throw new Error('Expected GraphIR proposal');
  assert.equal(result.validation.valid, true);
  assert.equal(result.spec.status, 'needs-input');
  assert.equal((result.spec.pendingQuestions as any[]).length, 2);
  assert.match(String(result.artifacts?.bpmnXml), /userTask/);
  assert.equal(result.artifacts?.forms.length, 2);
  assert.match(provider.prompts[0].prompt, /GraphIR v1/);
});

test('AI_GRAPH_IR_MODE controlled rejects invalid GraphIR without trying legacy fallback', async () => {
  const invalid = graphIrApproval(); invalid.edges[2].target = 'missing';
  const provider = new QueueProvider([invalid]);
  await assert.rejects(() => new AiOrchestrator(provider, 'model', environment({ aiGraphIrMode: 'controlled' })).generate({ text: 'Um funcionário solicita compra de material.', history: [] }),
    (error: any) => error.code === 'GRAPHIR_INVALID');
  assert.equal(provider.prompts.length, 1);
});

test('AI_GRAPH_IR_MODE controlled rejects invented activity and a role assigned to the wrong evidence', async () => {
  const invented = graphIrApproval(); invented.nodes[1].name = 'Executar pagamento';
  const inventedProvider = new QueueProvider([invented]);
  await assert.rejects(() => new AiOrchestrator(inventedProvider, 'model', environment({ aiGraphIrMode: 'controlled' })).generate({ text: 'Um funcionário solicita compra de material, informando o material solicitado. O gestor analisa a solicitação. Se aprovar, o financeiro recebe para providenciar a compra. Se reprovar, o processo termina.', history: [] }),
    (error: any) => error.code === 'GRAPHIR_ACTIVITY_UNGROUNDED');
  const wrongRole = graphIrApproval(); wrongRole.nodes[1].roleId = 'manager';
  const wrongRoleProvider = new QueueProvider([wrongRole]);
  await assert.rejects(() => new AiOrchestrator(wrongRoleProvider, 'model', environment({ aiGraphIrMode: 'controlled' })).generate({ text: 'Um funcionário solicita compra de material, informando o material solicitado. O gestor analisa a solicitação. Se aprovar, o financeiro recebe para providenciar a compra. Se reprovar, o processo termina.', history: [] }),
    (error: any) => error.code === 'GRAPHIR_ROLE_UNGROUNDED');
});

test('API GraphIR controlled gera uma proposta, aceita e recupera a revisão sem mudar o contrato público', async () => {
  const provider = new QueueProvider([graphIrApproval()]);
  const repository = new InMemoryConversationRepository();
  const app = await buildApp(environment({ aiGraphIrMode: 'controlled' }), { conversationRepository: repository, modelProvider: provider });
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Compra sintética', targetProfile: 'generic-bpmn2' } });
    assert.equal(project.statusCode, 201);
    const sessionId = project.json().sessionId;
    const proposal = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: 'Um funcionário solicita compra de material, informando o material solicitado. O gestor analisa a solicitação. Se aprovar, o financeiro recebe para providenciar a compra. Se reprovar, o processo termina.', baseRevision: 0 } });
    assert.equal(proposal.statusCode, 200);
    assert.equal(proposal.json().status, 'validated');
    assert.ok(proposal.json().artifacts.bpmnXml.includes('<bpmn:process'));
    assert.equal(proposal.json().artifacts.forms.length, 2);
    const proposedRevision = await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}/revisions/1` });
    assert.equal(proposedRevision.json().processSpec.status, 'needs-input');
    assert.equal(provider.prompts.length, 1);
    assert.match(provider.prompts[0].prompt, /Retorne somente GraphIR v1/);
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/revisions/1/accept`, payload: { baseRevision: 0 } });
    assert.equal(accepted.json().status, 'accepted');
    const recovered = await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}/revisions/1` });
    assert.equal(recovered.json().processSpec.id, 'purchase_process');
    assert.ok(recovered.json().artifacts.bpmnXml.includes('purchase_process'));
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}` })).json().currentRevision, 1);
  } finally { await app.close(); }
});

test('Knowledge Engine seleciona módulos versionados por intenção e limita contexto', async () => {
  const knowledge = new BpmKnowledgeEngine();
  const vacation = await knowledge.select('Solicitação de férias: gestor aprova ou rejeita e exige motivo', 7000);
  assert.equal(vacation.version, '1.1.0');
  assert.ok(vacation.moduleIds.includes('policy'));
  assert.ok(vacation.moduleIds.includes('bpmn'));
  assert.ok(vacation.moduleIds.includes('forms'));
  assert.ok(vacation.moduleIds.includes('few-shots'));
  const withoutFixtureCopy = await knowledge.select('Solicitação de férias, gestor aprova/reprova e formulário', 12000);
  assert.ok(withoutFixtureCopy.moduleIds.includes('few-shots'));
  assert.doesNotMatch(withoutFixtureCopy.text, /Exemplo sintético válido de ProcessSpec v1/);
  assert.doesNotMatch(withoutFixtureCopy.text, /1Doc/);
  assert.ok(!vacation.moduleIds.includes('integrations'));
  assert.ok(vacation.text.length <= 7000);
  const integration = await knowledge.select('Consultar API HTTP e atualizar registro no banco por operação aprovada', 7000);
  assert.ok(integration.moduleIds.includes('integrations'));
  assert.ok(integration.moduleIds.includes('few-shots'));
  assert.doesNotMatch(integration.text, /Pedido de férias/);
  assert.match(vacation.text, /Preserve qualquer resolução de papéis/);
  assert.doesNotMatch(vacation.text, /qual regra de dias/);
});

test('Ollama Provider usa JSON Schema, timeout e registra uso sem divulgar conteúdo sensível', async () => {
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ model: 'local-model', message: { content: JSON.stringify(clarification) }, prompt_eval_count: 91, eval_count: 33 }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    const provider = new OllamaProvider(`http://127.0.0.1:${address.port}`);
    const result = await provider.generateStructured({ model: 'local-model', system: 'system', prompt: 'Synthetic vacation request', outputSchema: { type: 'object' }, timeoutMs: 1000, contextTokens: 8192, maxOutputTokens: 512 });
    assert.deepEqual(result.value, clarification);
    assert.deepEqual(result.usage, { inputTokens: 91, outputTokens: 33 });
    assert.equal(result.model, 'local-model');
    assert.deepEqual(requests[0].format, { type: 'object' });
    assert.equal(requests[0].stream, false);
    assert.equal(requests[0].options.num_predict, 512);
    assert.equal(requests[0].options.num_ctx, 8192);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('OpenAI-compatible adapter sends backend credential, and provider errors are typed and bounded', async () => {
  let authorization = '';
  const server = createServer(async (request, response) => {
    authorization = String(request.headers.authorization || '');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ model: 'external-model', choices: [{ message: { content: JSON.stringify(clarification) } }], usage: { prompt_tokens: 12, completion_tokens: 6 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    const result = await new OpenAICompatibleProvider(`http://127.0.0.1:${address.port}/v1`, 'synthetic-test-secret').generateStructured({ model: 'external-model', system: 'system', prompt: 'synthetic', outputSchema: { type: 'object' }, timeoutMs: 1000, contextTokens: 8192, maxOutputTokens: 128 });
    assert.equal(authorization, 'Bearer synthetic-test-secret');
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 6 });
    assert.deepEqual(result.value, clarification);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }

  const unavailable = new OllamaProvider('http://127.0.0.1:1');
  await assert.rejects(() => unavailable.generateStructured({ model: 'x', system: '', prompt: '', outputSchema: {}, timeoutMs: 100, contextTokens: 4096, maxOutputTokens: 1 }), (error: any) => error instanceof ProviderFailure && error.code === 'PROVIDER_UNAVAILABLE');
  const invalidResponseServer = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ message: { content: 'not-json' } })); });
  await new Promise<void>(resolve => invalidResponseServer.listen(0, '127.0.0.1', resolve));
  const invalidAddress = invalidResponseServer.address() as { port: number };
  try {
    await assert.rejects(() => new OllamaProvider(`http://127.0.0.1:${invalidAddress.port}`).generateStructured({ model: 'x', system: '', prompt: '', outputSchema: {}, timeoutMs: 1000, contextTokens: 4096, maxOutputTokens: 1 }), (error: any) => error instanceof ProviderFailure && error.code === 'PROVIDER_INVALID_RESPONSE');
  } finally { await new Promise<void>(resolve => invalidResponseServer.close(() => resolve())); }
  const slow = createServer((_request, _response) => { /* deliberately never responds */ });
  await new Promise<void>(resolve => slow.listen(0, '127.0.0.1', resolve));
  const slowAddress = slow.address() as { port: number };
  try {
    await assert.rejects(() => new OllamaProvider(`http://127.0.0.1:${slowAddress.port}`).generateStructured({ model: 'x', system: '', prompt: '', outputSchema: {}, timeoutMs: 30, contextTokens: 4096, maxOutputTokens: 1 }), (error: any) => error instanceof ProviderFailure && error.code === 'PROVIDER_TIMEOUT');
  } finally { slow.closeAllConnections?.(); await new Promise<void>(resolve => slow.close(() => resolve())); }
});

test('modo JSON Schema estrito prepara schema interno, normaliza campos nulos e aplica limite local', async () => {
  const schema = { oneOf: [
    { type: 'object', additionalProperties: false, required: ['kind', 'questions'], properties: { kind: { const: 'need_clarification' }, questions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['question', 'blocking'], properties: { question: { type: 'string' }, blocking: { type: 'boolean' } } } }, summary: { type: 'string', maxLength: 1000 } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'name'], properties: { kind: { const: 'business_intent' }, name: { type: 'string' } } },
  ] };
  const providerSchema = toStrictProviderSchema(schema) as any;
  assert.deepEqual(providerSchema.required, ['response']);
  assert.equal(providerSchema.additionalProperties, false);
  assert.equal(providerSchema.properties.response.anyOf[0].additionalProperties, false);
  assert.deepEqual(providerSchema.properties.response.anyOf[0].required, ['kind', 'questions', 'summary']);
  assert.deepEqual(providerSchema.properties.response.anyOf[0].properties.summary.type, ['string', 'null']);
  assert.equal(providerSchema.properties.response.anyOf[0].properties.questions.items.additionalProperties, false);
  const recursiveSchema = toStrictProviderSchema(semanticIntentSchema()) as any;
  assert.equal(recursiveSchema.$defs.step.anyOf.length, 4);
  assert.ok(recursiveSchema.properties.response.anyOf[1].properties.activities.items.$ref === '#/$defs/step');
  assert.throws(() => toStrictProviderSchema({ type: 'object', properties: { map: { type: 'object', additionalProperties: { type: 'string' } } } }), /mapas dinâmicos/);

  let calls = 0;
  let sent: any;
  const server = createServer(async (request, response) => {
    calls++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    sent = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ model: 'openai/gpt-oss-120b', choices: [{ message: { content: JSON.stringify({ response: { kind: 'need_clarification', questions: [{ question: 'Qual grupo?', blocking: true }], summary: null } }) } }], usage: { prompt_tokens: 100, completion_tokens: 40 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${address.port}/v1`, 'synthetic-test-secret', 'json-schema-strict', { maxCalls: 1, maxTokens: 5000 });
    const request: StructuredRequest = { model: 'openai/gpt-oss-120b', system: 'system', prompt: 'Synthetic request', outputSchema: schema, timeoutMs: 1000, contextTokens: 8192, maxOutputTokens: 128 };
    const result = await provider.generateStructured(request);
    assert.equal(sent.response_format.type, 'json_schema');
    assert.equal(sent.response_format.json_schema.strict, true);
    assert.equal(sent.tools, undefined);
    assert.deepEqual(result.value, { kind: 'need_clarification', questions: [{ question: 'Qual grupo?', blocking: true }] });
    await assert.rejects(() => provider.generateStructured(request), (error: any) => error instanceof ProviderFailure && error.code === 'PROVIDER_RATE_LIMITED');
    assert.equal(calls, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('projeção estrita preserva estrutura fechada, mas relaxa limites que continuam sob autoridade do AJV', () => {
  const schema = semanticIntentSchema() as Record<string, any>;
  const providerSchema = toStrictProviderSchema(schema);
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const internal = ajv.compile(schema);
  const provider = ajv.compile(providerSchema);
  const response = { response: { kind: 'need_clarification', summary: null, questions: [{ question: '', blocking: true }] } };
  assert.equal(provider(response), true, 'a projeção remove minLength para se manter no subconjunto do provider');
  assert.equal(internal(response.response), false, 'AJV interno continua exigindo minLength e é autoridade final');
  const invalidShape = { response: { kind: 'need_clarification', summary: null, questions: [{ question: 'Qual?', blocking: true, surprise: true }] } };
  assert.equal(provider(invalidShape), false, 'additionalProperties:false continua fechado na projeção estrita');
});

test('schema estrito projeta e valida fixtures de tarefa, aprovação, integração e decisão recursiva', () => {
  const internalSchema = interpretationSchema(true);
  const providerSchema = toStrictProviderSchema(internalSchema);
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const internalValidator = ajv.compile(semanticIntentSchema());
  const providerValidator = ajv.compile(providerSchema);
  const nestedTask = { kind: 'task', name: 'Registrar retorno' };
  const intent = {
    kind: 'business_intent', name: 'Processo sintético', purpose: 'Validar variantes estruturais', actors: [{ name: 'Solicitante' }],
    startFields: [{ name: 'Valor', type: 'decimal' }],
    activities: [
      { kind: 'task', name: 'Preencher solicitação' },
      { kind: 'approval', name: 'Aprovar solicitação', onApproved: [nestedTask], onRejected: [] },
      { kind: 'integration', name: 'Consultar catálogo aprovado', connectorId: 'catalog', operationId: 'lookup', inputs: [], outputs: [] },
      { kind: 'decision', name: 'Avaliar faixa', field: 'Valor', alternatives: [
        { label: 'Até 100', value: 100, operator: 'lte', steps: [{ kind: 'task', name: 'Corrigir dados' }], returnTo: 'Verificar completude' },
        { label: 'Acima de 100', value: 100, operator: 'gt', steps: [{ kind: 'approval', name: 'Aprovação do gestor', onApproved: [
          { kind: 'approval', name: 'Aprovação do diretor', onApproved: [nestedTask], onRejected: [] },
        ], onRejected: [{ kind: 'task', name: 'Registrar justificativa' }] }] },
      ] },
    ], rules: [], suggestions: [], pendingConfiguration: [],
  };
  const defs = (internalSchema.$defs || {}) as Record<string, any>;
  const completeStrictFields = (value: any, rawSchema: any): any => {
    const schema = rawSchema?.$ref ? defs[rawSchema.$ref.slice('#/$defs/'.length)] : rawSchema;
    if (!schema) return value;
    if (Array.isArray(schema.oneOf)) {
      const variant = schema.oneOf.find((candidate: any) => candidate.properties?.kind?.const === value?.kind) || schema.oneOf[0];
      return completeStrictFields(value, variant);
    }
    if (Array.isArray(value) && schema.items) return value.map(item => completeStrictFields(item, schema.items));
    if (value && typeof value === 'object' && schema.properties) {
      const required = new Set(schema.required || []);
      return Object.fromEntries(Object.entries(schema.properties).map(([key, childSchema]) => [key, Object.hasOwn(value, key) ? completeStrictFields((value as any)[key], childSchema) : required.has(key) ? undefined : null]).filter(([, child]) => child !== undefined));
    }
    return value;
  };
  const normalizedForProvider = completeStrictFields(intent, internalSchema);
  assert.equal(internalValidator(normalizeInterpretation(intent)), true, JSON.stringify(internalValidator.errors));
  assert.equal(providerValidator({ response: normalizedForProvider }), true, JSON.stringify(providerValidator.errors));
});

test('diagnóstico HTTP 400 classifica mensagem Groq em resumo allowlist e descarta texto potencialmente sensível', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(400, { 'content-type': 'application/json', 'x-request-id': 'req-safe-123' }).end(JSON.stringify({ error: {
      code: 'json_validate_failed', type: 'invalid_request_error', param: 'response_format',
      message: 'Generated JSON does not match the expected schema. Please adjust your prompt. private prompt fragment',
      failed_generation: 'sensitive generated content',
    } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${address.port}/v1`, 'synthetic-test-secret', 'json-schema-strict');
    await assert.rejects(() => provider.generateStructured({ model: 'test', system: '', prompt: '', outputSchema: {}, timeoutMs: 1000, contextTokens: 4096, maxOutputTokens: 128 }), (error: any) => {
      assert.equal(error.diagnostic.httpStatus, 400);
      assert.equal(error.diagnostic.providerCode, 'json_validate_failed');
      assert.equal(error.diagnostic.providerType, 'invalid_request_error');
      assert.equal(error.diagnostic.providerParam, 'response_format');
      assert.equal(error.diagnostic.category, 'structured_output_mismatch');
      assert.equal(error.diagnostic.providerMessage, 'A saída estruturada não correspondeu ao schema.');
      assert.equal(error.diagnostic.requestId, 'req-safe-123');
      assert.equal(error.diagnostic.attempts, 1);
      assert.doesNotMatch(JSON.stringify(error.diagnostic), /private prompt fragment|sensitive generated content/);
      return true;
    });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('HTTP 429 respeita Retry-After sem fazer repetição automática', async () => {
  let calls = 0;
  const server = createServer((_request, response) => { calls++; response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' }).end(JSON.stringify({ error: { message: 'redacted' } })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${address.port}/v1`, 'synthetic-test-secret');
    await assert.rejects(() => provider.generateStructured({ model: 'external-model', system: '', prompt: '', outputSchema: {}, timeoutMs: 1000, contextTokens: 4096, maxOutputTokens: 128 }), (error: any) => error instanceof ProviderFailure && error.code === 'PROVIDER_RATE_LIMITED' && error.retryAfterMs === 3000);
    assert.equal(calls, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('rejeições HTTP preservam diagnóstico sanitizado e nunca repetem erros permanentes', async () => {
  for (const status of [400, 401, 403, 413, 429, 502]) {
    let calls = 0;
    const server = createServer((_request, response) => {
      calls++;
      response.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'req-test-1', 'retry-after': '120' })
        .end(JSON.stringify({ error: { code: 'invalid_schema', message: 'secret payload must not be stored' } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    try {
      const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${address.port}/v1`, 'synthetic-test-secret', 'json-object', {}, 2);
      await assert.rejects(() => provider.generateStructured({ model: 'test', system: '', prompt: '', outputSchema: {}, timeoutMs: 1000, contextTokens: 4096, maxOutputTokens: 128 }), (error: any) => {
        assert.equal(error.code, status === 429 ? 'PROVIDER_RATE_LIMITED' : status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED');
        assert.equal(error.diagnostic.httpStatus, status);
        assert.equal(error.diagnostic.providerCode, 'invalid_schema');
        assert.equal(error.diagnostic.requestId, 'req-test-1');
        assert.equal(error.diagnostic.attempts, 1);
        assert.ok(!JSON.stringify(error.diagnostic).includes('secret payload'));
        return true;
      });
      assert.equal(calls, 1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});

test('Retry-After zero permite apenas uma nova chamada explicitamente limitada', async () => {
  let calls = 0;
  const server = createServer((_request, response) => {
    calls++;
    response.setHeader('content-type', 'application/json');
    if (calls === 1) response.writeHead(429, { 'retry-after': '0' }).end(JSON.stringify({ error: {} }));
    else response.end(JSON.stringify({ model: 'external-model', choices: [{ message: { content: JSON.stringify(clarification) } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    const provider = new OpenAICompatibleProvider(`http://127.0.0.1:${address.port}/v1`, 'synthetic-test-secret', 'json-object', { maxCalls: 2 }, 1);
    const result = await provider.generateStructured({ model: 'external-model', system: '', prompt: '', outputSchema: {}, timeoutMs: 1000, contextTokens: 4096, maxOutputTokens: 128 });
    assert.deepEqual(result.value, clarification);
    assert.deepEqual(provider.usageTotals, { calls: 2, tokens: 7, retries: 1, lastRetryAfterMs: 0 });
    assert.equal(calls, 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('provedor externo exige aprovação explícita e input classificado como sintético ou público', async () => {
  assert.throws(() => configuredProvider(environment({ aiProvider: 'openai-compatible', aiModel: 'm', externalAiBaseUrl: 'http://127.0.0.1:1', externalAiApiKey: 'secret', externalAiApproved: false })), /não foi habilitado/);
  const spec = await fixture();
  const repository = new InMemoryConversationRepository();
  const provider = new QueueProvider([semanticVacationIntent()]);
  const app = await buildApp(environment({ aiModel: 'external-test', aiProvider: 'disabled' }), { conversationRepository: repository, modelProvider: { id: 'openai-compatible', generateStructured: request => provider.generateStructured(request) } });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'External policy' } });
    const session = created.json().sessionId;
    const rejected = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${session}/messages`, payload: { text: 'synthetic', baseRevision: 0 } });
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.json().code, 'EXTERNAL_DATA_CLASSIFICATION_REQUIRED');
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${session}/messages`, payload: { text: supportedVacationRequest, baseRevision: 0, dataClassification: 'synthetic' } });
    assert.equal(accepted.statusCode, 200);
  } finally { await app.close(); }
});

test('orquestrador pergunta lacunas, valida ProcessSpec, gera artefatos e limita reparo a uma tentativa', async () => {
  const spec = await fixture();
  const asking = new QueueProvider([clarification]);
  const first = await new AiOrchestrator(asking, 'local-model', environment()).generate({ text: 'Quero férias com aprovação do gestor', history: [] });
  assert.equal(first.kind, 'need_clarification');
  assert.equal(first.questions[0].blocking, true);
  assert.ok(first.knowledgeModules.includes('business-interpretation'));
  const schema = asking.prompts[0].outputSchema as any;
  assert.match(asking.prompts[0].prompt, /targetProfile=generic-bpmn2/);
  assert.match(asking.prompts[0].system, /Omissões de regras legais, prazos e limites fora do pedido ficam fora do escopo/);
  assert.match(asking.prompts[0].system, /Atores identificados por frases como/);
  assert.match(asking.prompts[0].system, /não há regra adicional.*resolve a pergunta/s);
  assert.equal(schema.oneOf[1].properties.kind.const, 'business_intent');
  assert.equal(schema.properties, undefined);
  assert.doesNotMatch(JSON.stringify(schema), /sequenceFlow|gatewayId|nodeId|flowId/);
  assert.ok(JSON.stringify(schema).length < 7000, 'contrato interno expressa intenção sem grafo técnico');

  const valid = new QueueProvider([semanticVacationIntent()]);
  const generated = await new AiOrchestrator(valid, 'local-model', environment()).generate({ text: supportedVacationRequest, history: [] });
  assert.equal(generated.kind, 'proposed_spec', JSON.stringify(generated));
  if (generated.kind !== 'proposed_spec') throw new Error('Esperava proposta');
  assert.equal(generated.validation.valid, true);
  assert.equal(generated.artifacts?.forms.length, 2);
  assert.match(generated.artifacts!.bpmnXml, /isExecutable="false"/);
  assert.equal(generated.repairAttempts, 0);
  assert.equal(generated.spec.status, 'needs-input');
  assert.equal(generated.artifacts?.manifest.publication.eligible, false);
  assert.ok(generated.artifacts?.manifest.configuration.unresolvedRoles.length);
  const shadow = generated.diagnostics?.find(item => item.stage === 'requirement-coverage-shadow');
  assert.equal(shadow?.status, 'audited');
  assert.ok(shadow?.details.coverage);
  assert.equal(Object.hasOwn(shadow!.details, 'findings'), false, 'shadow diagnostic retains aggregates only');

  const refined = structuredClone(spec); refined.name = 'Solicitação de férias revisada';
  const refineProvider = new QueueProvider([{ kind: 'refinement', changeSummary: 'Renomear mantendo o restante', operations: [{ kind: 'renameProcess', name: refined.name }] }]);
  const refinement = await new AiOrchestrator(refineProvider, 'local-model', environment()).generate({ text: 'Renomeie o processo', history: [], currentSpec: spec });
  assert.equal(refinement.kind, 'proposed_spec');
  if (refinement.kind !== 'proposed_spec') throw new Error('Esperava proposta refinada');
  assert.equal(refinement.spec.name, refined.name);
  assert.deepEqual(refinement.spec.nodes, spec.nodes);
  assert.deepEqual(refinement.spec.description, spec.description);
  assert.equal((refineProvider.prompts[0].outputSchema as any).oneOf[1].properties.operations.items.oneOf.length, 4);

  const unknownRole = new QueueProvider([{ kind: 'refinement', changeSummary: 'Aprovação adicional', operations: [{ kind: 'insertTaskAfter', afterActivity: 'Registrar férias no RH', task: { name: 'Segunda aprovação', actor: { name: 'Segundo gestor' } } }] }]);
  const unresolved = await new AiOrchestrator(unknownRole, 'local-model', environment()).generate({ text: 'Adicionar segunda aprovação', history: [], currentSpec: spec });
  assert.equal(unresolved.kind, 'need_clarification');
  if (unresolved.kind !== 'need_clarification') throw new Error('Papel não resolvido deveria bloquear como pergunta');
  assert.equal(unresolved.questions[0].blocking, true);

  const ambiguousBranch = new QueueProvider([{ kind: 'refinement', changeSummary: 'Aprovação adicional', operations: [{ kind: 'insertTaskAfter', afterActivity: 'Analisar solicitação', task: { name: 'Segunda aprovação', actor: { name: 'Gestor aprovador', resolution: 'manager-of-requester' } } }] }]);
  const ambiguous = await new AiOrchestrator(ambiguousBranch, 'local-model', environment()).generate({ text: 'Adicionar segunda aprovação', history: [], currentSpec: spec });
  assert.equal(ambiguous.kind, 'need_clarification');
  if (ambiguous.kind !== 'need_clarification') throw new Error('Inserção ramificada deveria bloquear como pergunta');
  assert.match(ambiguous.questions[0].question, /ponto exato|ramificada/);

  const invalidSpec = structuredClone(spec); invalidSpec.flows[0].target = 'missing';
  const oneCall = new QueueProvider([semanticVacationIntent()]);
  const compiled = await new AiOrchestrator(oneCall, 'local-model', environment()).generate({ text: supportedVacationRequest, history: [] });
  assert.equal(compiled.kind, 'proposed_spec');
  if (compiled.kind !== 'proposed_spec') throw new Error('Esperava proposta composta');
  assert.equal(compiled.validation.valid, true);
  assert.equal(compiled.repairAttempts, 0);
  assert.equal(oneCall.prompts.length, 1);
});

test('compositor completa somente referências de formulário inequivocamente deriváveis e mantém o validador canônico', async () => {
  const spec = await fixture();
  const plan = proposal(spec);
  plan.variables = plan.variables.filter((variable: any) => variable.key !== 'decision');
  const composed = composeProcessSpec(plan, { targetProfile: 'generic-bpmn2', knowledgeVersion: '1.0.0', model: 'test-model' });
  const decision = composed.variables.find((variable: any) => variable.key === 'decision');
  assert.deepEqual(decision.source, { kind: 'form', formId: 'form_gestor', fieldKey: 'decision' });
  assert.equal((await validateProcessSpec(composed)).valid, true);
});

test('API persiste conversas, perguntas, runs e revisões; refinamento mantém alterações manuais e controla concorrência', async () => {
  const spec = await fixture();
  const manuallyEdited = structuredClone(spec); manuallyEdited.description = 'Descrição manual preservada';
  const refined = structuredClone(manuallyEdited); refined.name = 'Solicitação de férias refinada';
  const provider = new QueueProvider([clarification, semanticVacationIntent(), { kind: 'refinement', changeSummary: 'Nome refinado; descrição manual preservada', operations: [{ kind: 'renameProcess', name: refined.name }] }]);
  const repository = new InMemoryConversationRepository();
  const app = await buildApp(environment(), { conversationRepository: repository, modelProvider: provider });
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Férias', targetProfile: 'generic-bpmn2' } });
    assert.equal(project.statusCode, 201);
    const sessionId = project.json().sessionId;
    const questions = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: supportedVacationRequest, baseRevision: 0 } });
    assert.equal(questions.statusCode, 200);
    assert.equal(questions.json().status, 'needs-input');
    const firstRun = await app.inject({ method: 'GET', url: `/api/v1/generation-runs/${questions.json().generationRunId}` });
    assert.equal(firstRun.json().status, 'needs-input');
    const session = await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}` });
    assert.equal(session.json().pendingQuestions.length, 1);
    assert.equal(session.json().status, 'needs-input');
    const answer = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/answers`, payload: { answers: ['O gestor é selecionado manualmente pelo operador autorizado.'], baseRevision: 0 } });
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.json().status, 'validated');
    const answeredRun = await app.inject({ method: 'GET', url: `/api/v1/generation-runs/${answer.json().generationRunId}` });
    assert.ok(!answeredRun.json().metrics.pipeline.some((item: any) => item.stage === 'requirement-coverage-shadow'), 'shadow diagnostics stay out of the public run response');
    assert.match(provider.prompts[1].prompt, /Fatos confirmados pelo solicitante/);
    assert.match(provider.prompts[1].prompt, /selecionado manualmente pelo operador autorizado/);
    const facts = await repository.listConfirmedFacts('test-tenant', sessionId);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].answer, 'O gestor é selecionado manualmente pelo operador autorizado.');
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/revisions/1/accept`, payload: { baseRevision: 0 } });
    assert.equal(accepted.json().status, 'accepted');
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}` })).json().status, 'accepted');

    const manual = await app.inject({ method: 'PUT', url: `/api/v1/design-sessions/${sessionId}/draft`, payload: { baseRevision: 1, processSpec: manuallyEdited } });
    assert.equal(manual.statusCode, 200);
    const acceptedManual = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/revisions/2/accept`, payload: { baseRevision: 1 } });
    assert.equal(acceptedManual.json().status, 'accepted');
    const refinement = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/refinements`, payload: { text: 'Renomeie o processo', baseRevision: 2 } });
    assert.equal(refinement.statusCode, 200);
    assert.equal(refinement.json().revision, 3);
    const proposed = await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}/revisions/3` });
    assert.equal(proposed.json().processSpec.description, 'Descrição manual preservada');
    assert.equal(proposed.json().processSpec.name, 'Solicitação de férias refinada');
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}/draft` })).json().processSpec.description, 'Descrição manual preservada');
    const stale = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/refinements`, payload: { text: 'Mensagem com base obsoleta', baseRevision: 1 } });
    assert.equal(stale.statusCode, 409);
    assert.equal(provider.prompts.length, 3);
    const history = await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}/history` });
    assert.ok(history.json().messages.length >= 5);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/capabilities' })).json().executionEnabled, false);
  } finally { await app.close(); }
});

test('repetição exata de pergunta respondida força uma única recuperação antes de perguntar ao usuário', async () => {
  const fact = { question: 'Qual unidade deve localizar o gestor?', answer: 'O gestor é selecionado manualmente pelo operador autorizado.', confirmedAt: new Date().toISOString() };
  const provider = new QueueProvider([clarification, semanticVacationIntent()]);
  const result = await new AiOrchestrator(provider, 'local-model', environment()).generate({ text: supportedVacationRequest, history: [], confirmedFacts: [fact] });
  assert.equal(result.kind, 'proposed_spec');
  assert.equal(provider.prompts.length, 2);
  assert.match(provider.prompts[1].prompt, /selecionado manualmente pelo operador autorizado/);
  if (result.kind === 'proposed_spec') assert.equal(result.repairAttempts, 1);
});

test('paráfrase de pergunta já respondida também usa uma única recuperação', async () => {
  const repeated = { kind: 'need_clarification', questions: [{ question: 'Como será a atribuição do segundo aprovador solicitado?', blocking: true }] };
  const fact = { question: 'Quem é o segundo aprovador solicitado e como será atribuído?', answer: 'O diretor da unidade será escolhido manualmente por um operador.', confirmedAt: new Date().toISOString() };
  const provider = new QueueProvider([repeated, semanticVacationIntent()]);
  const result = await new AiOrchestrator(provider, 'local-model', environment()).generate({ text: supportedVacationRequest, history: [], confirmedFacts: [fact] });
  assert.equal(result.kind, 'proposed_spec');
  assert.equal(provider.prompts.length, 2);
  assert.match(provider.prompts[1].prompt, /O diretor da unidade será escolhido manualmente/);
});

test('modo controlado evita perguntas exatas e parafraseadas por semanticSlot com uma recuperação limitada', async () => {
  const priorQuestion = 'Quem executa a segunda aprovação e qual é sua atribuição?';
  const questions = [priorQuestion, 'Como atribuir o papel ao segundo aprovador solicitado?'];
  const newQuestion = { kind: 'need_clarification', questions: [{ question: 'Qual campo deve registrar a decisão final?', blocking: true }] };
  const fact = { question: priorQuestion, answer: 'O segundo aprovador é escolhido manualmente por operador.', confirmedAt: new Date().toISOString(), ...identityForQuestion(priorQuestion), state: 'confirmed' as const, sourceId: 'answer-turn-1' };
  for (const question of questions) {
    const provider = new QueueProvider([{ kind: 'need_clarification', questions: [{ question, blocking: true }] }, newQuestion]);
    const result = await new AiOrchestrator(provider, 'local-model', environment({ aiSemanticGroundingMode: 'controlled' })).generate({ text: supportedVacationRequest, history: [], confirmedFacts: [fact] });
    assert.equal(result.kind, 'need_clarification');
    if (result.kind === 'need_clarification') assert.match(result.questions[0].question, /campo deve registrar/);
    assert.equal(provider.prompts.length, 2, 'semantic matching does not make a provider call; one existing bounded recovery continues generation');
    assert.match(provider.prompts[1].prompt, /escolhido manualmente por operador/i);
  }
});

test('resposta recém-confirmada é reutilizada antes do único retry de recuperação, sem chamada de identificação semântica', async () => {
  const nextQuestion = { kind: 'need_clarification', questions: [{ question: 'Qual campo deve registrar a decisão final?', blocking: true }] };
  const repository = new InMemoryConversationRepository();
  const provider = new QueueProvider([clarification, clarification, nextQuestion]);
  const app = await buildApp(environment({ aiSemanticGroundingMode: 'controlled' }), { conversationRepository: repository, modelProvider: provider });
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Answered slot', targetProfile: 'generic-bpmn2' } });
    const sessionId = project.json().sessionId;
    const asked = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: supportedVacationRequest, baseRevision: 0 } });
    assert.equal(asked.json().questions[0].question, clarification.questions[0].question);
    const answered = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/answers`, payload: { answers: ['O Diretor da unidade será escolhido manualmente por operador.'], baseRevision: 0 } });
    assert.equal(answered.statusCode, 200);
    assert.equal(answered.json().questions[0].question, nextQuestion.questions[0].question);
    assert.equal(provider.prompts.length, 3, 'one initial question, one normal answer-turn generation, and one bounded corrective retry');
    assert.match(provider.prompts[2].prompt, /escolhido manualmente por operador/i);
    assert.equal(provider.prompts.filter(prompt => /semanticSlot|questionId/.test(prompt.prompt)).length, 0, 'no provider call is made to compute semantic identity');
  } finally { await app.close(); }
});

test('provider simulado percorre o orquestrador e mantém Verificação de completude com proveniência nos dois modos', async () => {
  const evidence = 'O Gestor executa Verificar completude da solicitação.';
  const intent = {
    kind: 'business_intent', name: 'Verificação da solicitação', purpose: evidence,
    actors: [{ name: 'Gestor', resolution: 'unresolved', evidence }], startFields: [],
    activities: [{ kind: 'task', name: 'Verificação de completude da solicitação', actor: 'Gestor', evidence }],
    rules: [], suggestions: [], pendingConfiguration: [],
  };
  for (const mode of ['legacy', 'controlled'] as const) {
    const provider = new QueueProvider([intent]);
    const result = await new AiOrchestrator(provider, 'local-model', environment({ aiSemanticGroundingMode: mode })).generate({ text: evidence, history: [] });
    assert.equal(result.kind, 'proposed_spec', `${mode} must produce the explicitly requested activity`);
    if (result.kind === 'proposed_spec') {
      assert.ok(result.spec.nodes.some((node: any) => node.type === 'userTask' && node.name === 'Verificação de completude da solicitação'));
      assert.ok((result.intermediate as any).activities[0].provenance.confirmed);
      assert.ok(result.diagnostics?.some(item => item.stage === 'requirement-coverage-shadow' && item.status === 'audited'));
    }
    assert.equal(provider.prompts.length, 1, 'equivalence is resolved without an extra provider call');
  }
});

test('orquestrador audita Ledger completo em shadow: atividade inventada rejeitada e requisito omitido medido', async () => {
  const source = 'O Gestor analisa o pedido. O RH registra o protocolo obrigatório.';
  const messageId = 'complete-ledger-source';
  const activityQuote = 'O Gestor analisa o pedido.';
  const fieldQuote = 'O RH registra o protocolo obrigatório.';
  const ledger: RequirementLedgerV1 = {
    schemaVersion: '1.0.0',
    extraction: { complete: true, method: 'independent-review-fixture', diagnostics: [] },
    requirements: [
      requirementFromEvidence({ messageId, text: source, type: 'activity', start: source.indexOf(activityQuote), end: source.indexOf(activityQuote) + activityQuote.length }),
      requirementFromEvidence({ messageId, text: source, type: 'field', start: source.indexOf(fieldQuote), end: source.indexOf(fieldQuote) + fieldQuote.length }),
    ],
  };
  const intent = {
    kind: 'business_intent', name: 'Análise de pedido', purpose: source,
    actors: [{ name: 'Gestor', resolution: 'unresolved', evidence: activityQuote }], startFields: [],
    activities: [{ kind: 'task', name: 'Analisar pedido', actor: 'Gestor', evidence: activityQuote }],
    rules: [], suggestions: [], pendingConfiguration: [],
  };
  const provider = new QueueProvider([intent]);
  const generated = await new AiOrchestrator(provider, 'local-model', environment({ aiSemanticGroundingMode: 'controlled' })).generate({ text: source, sourceMessageId: messageId, history: [], requirementLedger: ledger });
  assert.equal(generated.kind, 'proposed_spec');
  const shadow = generated.diagnostics?.find(item => item.stage === 'requirement-coverage-shadow');
  assert.equal(shadow?.details.extractionComplete, true);
  assert.equal((shadow?.details.coverage as any)?.proven, 1);
  assert.equal((shadow?.details.coverage as any)?.missing, 1, 'the complete independent Ledger exposes the omitted field as missing');
  assert.equal(provider.prompts.length, 1);

  const inventedIntent = structuredClone(intent);
  inventedIntent.activities.push({ kind: 'task', name: 'Autorizar pagamento', actor: 'Gestor', evidence: activityQuote });
  const inventedProvider = new QueueProvider([inventedIntent]);
  await assert.rejects(
    () => new AiOrchestrator(inventedProvider, 'local-model', environment({ aiSemanticGroundingMode: 'controlled' })).generate({ text: source, sourceMessageId: messageId, history: [], requirementLedger: { ...ledger, requirements: [ledger.requirements[0]] } }),
    (error: any) => {
      assert.equal(error.code, 'SEMANTIC_GROUNDING_DIVERGENT');
      const rawIntentAudit = error.diagnostics?.find((item: any) => item.stage === 'requirement-coverage-shadow');
      assert.equal(rawIntentAudit?.details.extractionComplete, true);
      assert.equal(rawIntentAudit?.details.unsupportedActivityCount, 1);
      return true;
    },
  );
  assert.equal(inventedProvider.prompts.length, 1, 'the shadow audit adds no provider call and does not relax the compiler rejection');
});

test('orquestrador controlado aceita o papel correto com paráfrase e rejeita papel divergente, negação e inconclusão', async () => {
  const source = 'O Gestor aprova a solicitação.';
  const base = {
    kind: 'business_intent', name: 'Análise da solicitação', purpose: source,
    actors: [{ name: 'Gestor', resolution: 'unresolved', evidence: source }], startFields: [],
    activities: [{ kind: 'task', name: 'Aprovação da solicitação', actor: 'Gestor', evidence: source }],
    rules: [], suggestions: [], pendingConfiguration: [],
  };
  const validProvider = new QueueProvider([base]);
  const valid = await new AiOrchestrator(validProvider, 'local-model', environment({ aiSemanticGroundingMode: 'controlled' })).generate({ text: source, history: [] });
  assert.equal(valid.kind, 'proposed_spec');
  assert.equal(validProvider.prompts.length, 1);

  for (const mutate of [
    (intent: any) => { intent.activities[0].actor = 'Diretor'; },
    (intent: any) => { intent.activities[0].name = 'Não aprovar a solicitação'; },
    (intent: any) => { intent.activities[0].name = 'Etapa operacional'; },
  ]) {
    const candidate = structuredClone(base);
    mutate(candidate);
    const provider = new QueueProvider([candidate]);
    await assert.rejects(() => new AiOrchestrator(provider, 'local-model', environment({ aiSemanticGroundingMode: 'controlled' })).generate({ text: source, history: [] }));
    assert.equal(provider.prompts.length, 1);
  }
  const deniedSource = 'O Gestor não aprova a solicitação.';
  const deniedIntent = structuredClone(base);
  deniedIntent.purpose = deniedSource;
  deniedIntent.actors[0].evidence = deniedSource;
  deniedIntent.activities[0].evidence = deniedSource;
  const deniedProvider = new QueueProvider([deniedIntent]);
  await assert.rejects(() => new AiOrchestrator(deniedProvider, 'local-model', environment({ aiSemanticGroundingMode: 'controlled' })).generate({ text: deniedSource, history: [] }));
  assert.equal(deniedProvider.prompts.length, 1, 'explicit source negation cannot confirm the positive activity');
});

test('reconciliação numérica no modo controlado marca o limite substituído e preserva o novo valor', async () => {
  const provider = new QueueProvider([clarification]);
  const result = await new AiOrchestrator(provider, 'local-model', environment({ aiSemanticGroundingMode: 'controlled' })).generate({
    text: 'Altere o limite para R$ 5.000.',
    history: [{ role: 'user', content: 'O Diretor aprova solicitações acima de R$ 2.000.' }],
  });
  assert.equal(result.kind, 'need_clarification');
  assert.match(provider.prompts[0].prompt, /gt:2000 foi substituído por gt:5000/);
  assert.ok(result.diagnostics?.some(item => item.stage === 'semantic-reconciliation' && item.status === 'reconciled'));
});

test('contradição numérica sem verbo de correção permanece explícita e não recebe diretiva de substituição', async () => {
  const provider = new QueueProvider([clarification]);
  const result = await new AiOrchestrator(provider, 'local-model', environment({ aiSemanticGroundingMode: 'controlled' })).generate({
    text: 'O Diretor aprova solicitações acima de R$ 5.000.',
    history: [{ role: 'user', content: 'O Diretor aprova solicitações acima de R$ 2.000.' }],
  });
  assert.equal(result.kind, 'need_clarification');
  assert.match(provider.prompts[0].prompt, /acima de R\$ 2\.000/i);
  assert.match(provider.prompts[0].prompt, /acima de R\$ 5\.000/i);
  assert.doesNotMatch(provider.prompts[0].prompt, /foi substituído por/);
  assert.ok(result.diagnostics?.some(item => item.stage === 'semantic-reconciliation' && item.status === 'unchanged'));
});

test('reconciliação de limite persiste eventos superseded/confirmed no JSONB existente entre turnos', async () => {
  const repository = new InMemoryConversationRepository();
  const provider = new QueueProvider([clarification, clarification, clarification, clarification]);
  const app = await buildApp(environment({ aiSemanticGroundingMode: 'controlled' }), { conversationRepository: repository, modelProvider: provider });
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Threshold reconciliation', targetProfile: 'generic-bpmn2' } });
    const sessionId = project.json().sessionId;
    await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: 'O Diretor aprova solicitações acima de R$ 2.000.', baseRevision: 0 } });
    await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: 'Altere o limite para R$ 5.000.', baseRevision: 0 } });
    const afterFirstCorrection = await repository.listConfirmedFacts('test-tenant', sessionId);
    assert.ok(afterFirstCorrection.some(item => item.semanticFact?.value === 'gt:2000' && item.semanticFact.state === 'superseded'));
    assert.ok(afterFirstCorrection.some(item => item.semanticFact?.value === 'gt:5000' && item.semanticFact.state === 'confirmed'));
    await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: 'Altere o limite para R$ 8.000.', baseRevision: 0 } });
    const latest = await repository.listConfirmedFacts('test-tenant', sessionId);
    assert.ok(latest.some(item => item.semanticFact?.value === 'gt:5000' && item.semanticFact.state === 'superseded'));
    assert.ok(latest.some(item => item.semanticFact?.value === 'gt:8000' && item.semanticFact.state === 'confirmed'));
    assert.match(provider.prompts[2].prompt, /gt:5000 foi substituído por gt:8000/);
    assert.doesNotMatch(provider.prompts[2].prompt, /acima de R\$ 5\.000/i, 'a superseded threshold is masked in effective model context while stored history remains intact');
    const activeThresholds = latestSemanticFactEvents(latest).filter(item => item.semanticFact?.attribute === 'numeric-threshold' && item.state === 'confirmed');
    assert.equal(activeThresholds.length, 1);
    assert.equal(activeThresholds[0].semanticFact?.value, 'gt:8000');
    const beforeIdempotentRepeat = latest.length;
    await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: 'Altere o limite para R$ 8.000.', baseRevision: 0 } });
    const afterIdempotentRepeat = await repository.listConfirmedFacts('test-tenant', sessionId);
    assert.equal(afterIdempotentRepeat.length, beforeIdempotentRepeat, 'repeating the current correction adds no semantic event');
  } finally { await app.close(); }
});

test('identidade interna de esclarecimento persiste com a resposta mesmo após falha do provider sem mudar contrato público', async () => {
  const repository = new InMemoryConversationRepository();
  const provider = new QueueProvider([clarification, new ProviderFailure('PROVIDER_UNAVAILABLE', 'provider offline', undefined, { category: 'network' })]);
  const app = await buildApp(environment(), { conversationRepository: repository, modelProvider: provider });
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Semantic identity', targetProfile: 'generic-bpmn2' } });
    const sessionId = project.json().sessionId;
    const asked = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: supportedVacationRequest, baseRevision: 0 } });
    assert.equal(asked.json().questions.length, 1);
    assert.deepEqual(Object.keys(asked.json().questions[0]).sort(), ['blocking', 'question']);
    const beforeAnswer = await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}` });
    assert.deepEqual(Object.keys(beforeAnswer.json().pendingQuestions[0]).sort(), ['blocking', 'question']);
    const answer = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/answers`, payload: { answers: ['Não há regra adicional.'], baseRevision: 0 } });
    assert.equal(answer.statusCode, 503);
    const facts = await repository.listConfirmedFacts('test-tenant', sessionId);
    assert.equal(facts.length, 1);
    assert.ok(facts[0].questionId && facts[0].requirementId && facts[0].semanticSlot && facts[0].semanticFactId);
    assert.equal(facts[0].state, 'confirmed');
    assert.equal(facts[0].questionStatus, 'answered');
    assert.equal(facts[0].sourceId, (await repository.listMessages('test-tenant', sessionId, 10)).find(item => item.role === 'user' && item.content === 'Não há regra adicional.')?.id);
  } finally { await app.close(); }
});

test('turno conversacional é idempotente por operationId e publica identificador estável do question set', async () => {
  const repository = new InMemoryConversationRepository();
  const provider = new QueueProvider([clarification]);
  const app = await buildApp(environment(), { conversationRepository: repository, modelProvider: provider });
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Idempotency', targetProfile: 'generic-bpmn2' } });
    const sessionId = project.json().sessionId;
    const payload = { text: supportedVacationRequest, baseRevision: 0, operationId: 'turn-000001' };
    const first = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload });
    const replay = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload });
    assert.equal(first.statusCode, 200);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().generationRunId, first.json().generationRunId);
    assert.equal(replay.json().replayed, true);
    assert.equal(provider.prompts.length, 1);
    const session = await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}` });
    assert.equal(session.json().questionSetId, first.json().questionSetId);
  } finally { await app.close(); }
});

test('resposta com questionSetId antigo é recusada sem gravar mensagem nem fato', async () => {
  const repository = new InMemoryConversationRepository();
  const provider = new QueueProvider([clarification]);
  const app = await buildApp(environment(), { conversationRepository: repository, modelProvider: provider });
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Stale answer', targetProfile: 'generic-bpmn2' } });
    const sessionId = project.json().sessionId;
    const asked = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: supportedVacationRequest, baseRevision: 0 } });
    const before = await repository.listMessages('test-tenant', sessionId, 20);
    const stale = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/answers`, payload: { answers: ['Resposta antiga'], baseRevision: 0, questionSetId: 'qs_obsolete_000000000000' } });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().code, 'QUESTION_SET_STALE');
    assert.deepEqual(await repository.listMessages('test-tenant', sessionId, 20), before);
    assert.deepEqual(await repository.listConfirmedFacts('test-tenant', sessionId), []);
    assert.equal(asked.json().status, 'needs-input');
  } finally { await app.close(); }
});

test('duas submissões concorrentes serializam por sessão e provider não roda duas vezes', async () => {
  const repository = new InMemoryConversationRepository();
  const provider = new QueueProvider([clarification, clarification]);
  const app = await buildApp(environment(), { conversationRepository: repository, modelProvider: provider });
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Concurrent', targetProfile: 'generic-bpmn2' } });
    const sessionId = project.json().sessionId;
    const submit = (operationId: string) => app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: supportedVacationRequest, baseRevision: 0, operationId } });
    const results = await Promise.all([submit('turn-concurrent-1'), submit('turn-concurrent-2')]);
    assert.equal(results.filter(response => response.statusCode === 200).length, 1);
    assert.equal(results.filter(response => response.statusCode === 409).length, 1);
    assert.equal(provider.prompts.length, 1);
    assert.equal((await repository.listMessages('test-tenant', sessionId, 20)).filter(message => message.role === 'user').length, 1);
  } finally { await app.close(); }
});

test('run interrompido é reconciliado sem chamar provider e mensagem fica disponível', async () => {
  const repository = new InMemoryConversationRepository();
  const project = await repository.createProject('test-tenant', 'Interrupted', 'generic-bpmn2');
  const begun = await repository.beginTurn('test-tenant', project.sessionId, { baseRevision: 0, role: 'user', content: 'Synthetic durable turn', operationId: 'interrupted-0001' }, 'queue-test', 'local-model');
  assert.equal(begun.run.status, 'generating');
  assert.equal(await repository.reconcileInterruptedRuns('test-tenant', project.sessionId, 0), 1);
  const run = await repository.getRun('test-tenant', begun.run.id);
  assert.equal(run?.status, 'failed');
  assert.equal(run?.errorCode, 'GENERATION_INTERRUPTED');
  assert.equal((await repository.listMessages('test-tenant', project.sessionId, 10))[0].content, 'Synthetic durable turn');
  assert.equal((await repository.getSession('test-tenant', project.sessionId))?.status, 'failed');
});

test('histórico extenso mantém fatos confirmados dentro do orçamento e sem depender das mensagens antigas', async () => {
  const facts = Array.from({ length: 45 }, (_, index) => ({ question: `Pergunta de ator ${index}`, answer: `Resposta confirmada ${index}`, confirmedAt: new Date(index).toISOString(), semanticSlot: `slot:actor-assignment:entity_${index}`, state: 'confirmed' as const }));
  const provider = new QueueProvider([clarification]);
  await new AiOrchestrator(provider, 'local-model', environment({ aiSemanticGroundingMode: 'controlled' })).generate({ text: supportedVacationRequest, history: [], confirmedFacts: facts });
  const prompt = provider.prompts[0].prompt;
  assert.doesNotMatch(prompt, /slot:actor-assignment:entity_0\b/);
  assert.match(prompt, /slot:actor-assignment:entity_44/);
  assert.ok(prompt.length < 24000);
});

test('falha de plano registra keywords do schema e remove esclarecimentos respondidos da sessão', async () => {
  const provider = new QueueProvider([clarification, { kind: 'business_intent', name: 'incomplete' }]);
  class TracingRepository extends InMemoryConversationRepository {
    latestRunId?: string;
    override async beginTurn(tenantId: string, sessionId: string, input: any, providerId: string, model: string) {
      const result = await super.beginTurn(tenantId, sessionId, input, providerId, model);
      this.latestRunId = result.run.id;
      return result;
    }
  }
  const repository = new TracingRepository();
  const app = await buildApp(environment(), { conversationRepository: repository, modelProvider: provider });
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Synthetic diagnostics', targetProfile: 'generic-bpmn2' } });
    const sessionId = project.json().sessionId;
    const questions = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: supportedVacationRequest, baseRevision: 0 } });
    assert.equal(questions.json().status, 'needs-input');
    const failed = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/answers`, payload: { answers: ['O gestor será escolhido manualmente pelo operador.'], baseRevision: 0 } });
    assert.equal(failed.statusCode, 422);
    assert.equal(failed.json().code, 'MODEL_PLAN_INVALID');
    const session = await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}` });
    assert.equal(session.json().status, 'failed');
    assert.deepEqual(session.json().pendingQuestions, []);
    const run = await app.inject({ method: 'GET', url: `/api/v1/generation-runs/${repository.latestRunId}` });
    const diagnostics = run.json().metrics.pipeline.find((item: any) => item.stage === 'normalization' && item.status === 'rejected').details.schemaDiagnostics;
    assert.ok(diagnostics.length > 0);
    assert.ok(diagnostics.every((item: any) => item.keyword && item.path && item.message));
    assert.ok(diagnostics.some((item: any) => item.keyword === 'required' && item.property === 'questions'));
    assert.doesNotMatch(JSON.stringify(diagnostics), /incomplete|Synthetic diagnostics/);
  } finally { await app.close(); }
});

test('conversational API fails closed without PostgreSQL/provider and isolates tenant-scoped repositories', async () => {
  const app = await buildApp(environment());
  try {
    const noDatabase = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Local' } });
    assert.equal(noDatabase.statusCode, 503);
    assert.equal(noDatabase.json().code, 'PERSISTENCE_NOT_CONFIGURED');
  } finally { await app.close(); }
  const repo = new InMemoryConversationRepository();
  const project = await repo.createProject('tenant-one', 'Isolado', 'generic-bpmn2');
  assert.ok(await repo.getSession('tenant-one', project.sessionId));
  assert.equal(await repo.getSession('tenant-two', project.sessionId), undefined);
});

test('API converte falhas reais do repositório em erro de persistência sem vazar detalhes', async () => {
  const repository = new InMemoryConversationRepository();
  repository.createProject = async () => { throw new Error('private database connection details'); };
  const app = await buildApp(environment(), { conversationRepository: repository });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Falha persistência' } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'PERSISTENCE_UNAVAILABLE');
    assert.ok(!response.body.includes('private database connection details'));
  } finally { await app.close(); }
});
