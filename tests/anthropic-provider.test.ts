import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { readEnvironment } from '../src/config/env.js';
import { configuredProvider } from '../src/modules/ai/provider.factory.js';
import { interpretationSchema } from '../src/modules/ai/interpretation-context.js';
import { AiOrchestrator } from '../src/modules/ai/orchestrator.js';
import { AnthropicProvider, estimateCostUsd } from '../src/modules/providers/anthropic-provider.js';
import { anthropicOutputSchema } from '../src/modules/providers/schema-projection.js';
import { ProviderFailure, type ModelProvider, type StructuredRequest, type StructuredResponse } from '../src/modules/providers/model-provider.js';

const prompt = 'Contexto estável do projeto e conhecimento.\n\nHistórico recente:\n(início)\n\nSolicitação atual:\nUm pedido sintético.';
const request: StructuredRequest = { model: 'claude-opus-5-5', system: 'Sistema sintético', prompt, cacheablePrefixChars: prompt.indexOf('\n\nHistórico recente:'), outputSchema: interpretationSchema(false), timeoutMs: 30000, contextTokens: 8192, maxOutputTokens: 4096, temperature: 0.1 };
const clarification = { kind: 'need_clarification', questions: [{ question: 'Quem aprova?', blocking: true }], summary: 'Falta o aprovador.' };

function fakeClient(reply: unknown | Error) {
  const calls: Array<{ params: any; options: any }> = [];
  return {
    calls,
    client: { beta: { messages: { create: async (params: any, options: any) => { calls.push({ params, options }); if (reply instanceof Error) throw reply; return reply; } } } } as any,
  };
}
const message = (overrides: Record<string, unknown> = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_details: null,
  content: [{ type: 'text', text: JSON.stringify({ response: clarification }) }],
  usage: { input_tokens: 200, output_tokens: 300, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 },
  ...overrides,
});

test('requisição: saída estruturada, cache do system e do prefixo estável, sem sampling, fallback do servidor', async () => {
  const { client, calls } = fakeClient(message());
  const response = await new AnthropicProvider({ client, effort: 'low' }).generateStructured(request);
  const { params, options } = calls[0];
  assert.equal(params.model, 'claude-opus-5-5');
  assert.equal(params.temperature, undefined, 'modelos atuais rejeitam sampling');
  assert.deepEqual(params.system, [{ type: 'text', text: 'Sistema sintético', cache_control: { type: 'ephemeral' } }]);
  assert.equal(params.messages[0].content.length, 2);
  assert.deepEqual(params.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(params.messages[0].content[0].text + params.messages[0].content[1].text, prompt, 'o prompt é dividido sem perder nada');
  assert.equal(params.output_config.format.type, 'json_schema');
  assert.equal(params.output_config.effort, 'low');
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(params.fallbacks, 'default');
  assert.equal(options.timeout, 30000);
  assert.deepEqual(response.value, clarification);
  assert.deepEqual(response.usage, { inputTokens: 3200, outputTokens: 300, cachedInputTokens: 3000, costUsd: estimateCostUsd('claude-opus-5-5', message().usage) });
});

test('custo estimado pelo preço de tabela, inclusive leitura e escrita de cache', () => {
  const cost = estimateCostUsd('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 })!;
  assert.ok(Math.abs(cost - (2 + 1 + 0.2 + 2.5)) < 1e-9);
  assert.equal(estimateCostUsd('modelo-desconhecido', { input_tokens: 1, output_tokens: 1 }), undefined);
});

test('modelo sem fallback do servidor não envia o beta; fallback pode ser desligado', async () => {
  const haiku = fakeClient(message({ model: 'claude-haiku-5-5' }));
  await new AnthropicProvider({ client: haiku.client }).generateStructured({ ...request, model: 'claude-haiku-5-5' });
  assert.equal(haiku.calls[0].params.fallbacks, undefined);
  const off = fakeClient(message());
  await new AnthropicProvider({ client: off.client, fallbacks: false }).generateStructured(request);
  assert.equal(off.calls[0].params.betas, undefined);
});

test('projeção do schema cumpre o subconjunto aceito e continua validando as respostas do contrato', () => {
  const projected = anthropicOutputSchema(interpretationSchema(false));
  const text = JSON.stringify(projected);
  assert.doesNotMatch(text, /"oneOf"|"minLength"|"maxLength"|"minItems"|"maxItems"|"\$schema"/);
  const objects: any[] = [];
  const walk = (node: any) => { if (Array.isArray(node)) node.forEach(walk); else if (node && typeof node === 'object') { if (node.type === 'object') objects.push(node); Object.values(node).forEach(walk); } };
  walk(projected);
  assert.ok(objects.every(item => item.additionalProperties === false), 'todo objeto fecha suas propriedades');
  const validate = new Ajv2020({ strict: false }).compile(projected);
  assert.equal(validate({ response: clarification }), true);
  assert.equal(validate({ response: { kind: 'inventado' } }), false);
});

test('recusa, truncamento e erros HTTP viram ProviderFailure tipada', async () => {
  const cases: Array<[unknown, string, string?]> = [
    [message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' }, content: [] }), 'PROVIDER_REJECTED', 'refusal'],
    [message({ stop_reason: 'max_tokens' }), 'PROVIDER_INVALID_RESPONSE', 'token_limit'],
    [message({ content: [{ type: 'text', text: 'não é json' }] }), 'PROVIDER_INVALID_RESPONSE'],
    [Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }, 'x', new Headers({ 'retry-after': '3' })), 'PROVIDER_RATE_LIMITED', 'rate_limit'],
    [Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }, 'x', new Headers()), 'PROVIDER_UNAVAILABLE', 'overloaded'],
    [Anthropic.APIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: 'x' } }, 'x', new Headers()), 'PROVIDER_REJECTED', 'authentication'],
    [new Anthropic.APIConnectionTimeoutError(), 'PROVIDER_TIMEOUT', 'timeout'],
  ];
  for (const [reply, code, category] of cases) {
    const { client } = fakeClient(reply as any);
    await assert.rejects(() => new AnthropicProvider({ client }).generateStructured(request), (error: unknown) => error instanceof ProviderFailure && error.code === code && (!category || error.diagnostic?.category === category));
  }
  const { client } = fakeClient(Anthropic.APIError.generate(429, {}, 'x', new Headers({ 'retry-after': '3' })));
  await assert.rejects(() => new AnthropicProvider({ client }).generateStructured(request), (error: any) => error.retryAfterMs === 3000);
});

test('anthropic é provedor externo e lê effort, fallback e retries do ambiente', () => {
  assert.throws(() => configuredProvider(readEnvironment({ AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-opus-5-5' })), (error: any) => error.code === 'AI_PROVIDER_NOT_APPROVED');
  const environment = readEnvironment({ AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-opus-5-5', EXTERNAL_AI_APPROVED: 'true', ANTHROPIC_API_KEY: 'chave-de-teste', ANTHROPIC_EFFORT: 'medium', ANTHROPIC_FALLBACKS: 'off', ANTHROPIC_MAX_RETRIES: '3' });
  assert.equal(configuredProvider(environment)?.provider.id, 'anthropic');
  assert.deepEqual([environment.anthropicEffort, environment.anthropicFallbacks, environment.anthropicMaxRetries], ['medium', false, 3]);
  assert.throws(() => readEnvironment({ ANTHROPIC_EFFORT: 'turbo' }), /ANTHROPIC_EFFORT/);
});

class ModelRecorder implements ModelProvider {
  readonly id = 'model-recorder';
  readonly models: string[] = [];
  constructor(private readonly responses: unknown[]) {}
  async generateStructured(structured: StructuredRequest): Promise<StructuredResponse> {
    this.models.push(structured.model);
    return { value: this.responses.shift(), usage: {}, latencyMs: 1, model: structured.model };
  }
}

test('cascata: a chamada principal usa o modelo barato e só a correção escala para AI_REPAIR_MODEL', async () => {
  const provider = new ModelRecorder([{ kind: 'resposta fora do contrato' }, clarification]);
  const environment = readEnvironment({ LOG_LEVEL: 'silent', AI_REPAIR_MODEL: 'modelo-forte' });
  const outcome = await new AiOrchestrator(provider, 'modelo-barato', environment).generate({ text: 'Um pedido sintético.', history: [] });
  assert.equal(outcome.kind, 'need_clarification');
  assert.deepEqual(provider.models, ['modelo-barato', 'modelo-forte']);
  assert.ok(outcome.diagnostics?.some(item => item.stage === 'model-call' && item.details.purpose === 'repair' && item.details.model === 'modelo-forte'));
});
