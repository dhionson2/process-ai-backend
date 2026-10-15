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
  return { host: '127.0.0.1', port: 3333, corsOrigins: [], logLevel: 'silent', localTenantId: 'test-tenant', aiProvider: 'disabled', ollamaBaseUrl: 'http://127.0.0.1:11434', externalAiApproved: false, aiTimeoutMs: 400, aiContextTokens: 8192, aiMaxOutputTokens: 2048, aiMaxInputChars: 24000, aiMaxConcurrency: 2, externalAiStructuredOutput: 'json-object', aiMaxProviderCalls: 0, aiMaxProviderTokens: 0, ...overrides };
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
  assert.equal(providerSchema.properties.response.anyOf[0].properties.summary.anyOf[1].type, 'null');
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

test('falha de plano registra keywords do schema e remove esclarecimentos respondidos da sessão', async () => {
  const provider = new QueueProvider([clarification, { kind: 'business_intent', name: 'incomplete' }]);
  class TracingRepository extends InMemoryConversationRepository {
    latestRunId?: string;
    override async createRun(tenantId: string, sessionId: string, providerId: string, model: string) {
      const run = await super.createRun(tenantId, sessionId, providerId, model);
      this.latestRunId = run.id;
      return run;
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
