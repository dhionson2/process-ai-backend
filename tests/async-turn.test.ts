import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { readEnvironment } from '../src/config/env.js';
import { InMemoryConversationRepository } from '../src/modules/projects/conversation.repository.js';
import { ProviderFailure, type ModelProvider, type StructuredRequest, type StructuredResponse } from '../src/modules/providers/model-provider.js';

const clarification = { kind: 'need_clarification', questions: [{ question: 'Quem aprova o pedido?', blocking: true }], summary: 'Falta o aprovador.' };
const async = { prefer: 'respond-async' };

class GatedProvider implements ModelProvider {
  readonly id = 'gated-test';
  private release!: () => void;
  readonly gate = new Promise<void>(resolve => { this.release = resolve; });
  constructor(private readonly outcome: unknown) {}
  open() { this.release(); }
  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    await this.gate;
    if (this.outcome instanceof Error) throw this.outcome;
    return { value: this.outcome, usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 3, model: request.model };
  }
}

function parseEvents(body: string) {
  return body.split('\n\n').filter(block => block.startsWith('event:')).map(block => {
    const [eventLine, dataLine] = block.split('\n');
    return { event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) };
  });
}

async function setup(provider: ModelProvider) {
  const app = await buildApp(readEnvironment({ LOG_LEVEL: 'silent' }), { conversationRepository: new InMemoryConversationRepository(), modelProvider: provider });
  const project = (await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Assíncrono', targetProfile: 'generic-bpmn2' } })).json();
  return { app, sessionId: project.sessionId as string };
}

test('Prefer: respond-async responde 202 antes do modelo terminar e o SSE entrega etapas e o resultado no formato síncrono', async () => {
  const provider = new GatedProvider(clarification);
  const { app, sessionId } = await setup(provider);
  try {
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, headers: async, payload: { text: 'Um pedido sintético qualquer.', baseRevision: 0 } });
    assert.equal(accepted.statusCode, 202, 'resposta chega com o modelo ainda bloqueado');
    const { generationRunId, status } = accepted.json();
    assert.equal(status, 'generating');
    provider.open();
    const stream = await app.inject({ method: 'GET', url: `/api/v1/generation-runs/${generationRunId}/events` });
    assert.match(String(stream.headers['content-type']), /text\/event-stream/);
    const events = parseEvents(stream.body);
    assert.ok(events.some(item => item.event === 'stage' && item.data.stage === 'provider'), 'etapas do pipeline são transmitidas');
    const result = events.at(-1)!;
    assert.equal(result.event, 'result');
    assert.equal(result.data.result.status, 'needs-input');
    assert.equal(result.data.result.generationRunId, generationRunId);
    assert.equal(result.data.result.questions[0].question, 'Quem aprova o pedido?');

    const late = parseEvents((await app.inject({ method: 'GET', url: `/api/v1/generation-runs/${generationRunId}/events` })).body);
    assert.deepEqual(late.map(item => item.event), events.map(item => item.event), 'quem conecta depois recebe a sequência inteira');
  } finally { await app.close(); }
});

test('erro antes do run mantém o status HTTP; erro depois do run vira evento error com recovery', async () => {
  const provider = new GatedProvider(new ProviderFailure('PROVIDER_TIMEOUT', 'Tempo limite do provedor excedido', undefined, { category: 'timeout' }));
  const { app, sessionId } = await setup(provider);
  try {
    const conflict = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, headers: async, payload: { text: 'Um pedido.', baseRevision: 7 } });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().recovery.category, 'conflict');
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, headers: async, payload: { text: 'Um pedido sintético.', baseRevision: 0 } });
    assert.equal(accepted.statusCode, 202);
    provider.open();
    const events = parseEvents((await app.inject({ method: 'GET', url: `/api/v1/generation-runs/${accepted.json().generationRunId}/events` })).body);
    const failure = events.at(-1)!;
    assert.equal(failure.event, 'error');
    assert.equal(failure.data.error.code, 'PROVIDER_TIMEOUT');
    assert.deepEqual(failure.data.error.recovery.actions, ['retry']);
  } finally { await app.close(); }
});

test('sem Prefer o turno continua síncrono, e o SSE de um run síncrono responde a partir do run persistido', async () => {
  const provider = new GatedProvider(clarification);
  provider.open();
  const { app, sessionId } = await setup(provider);
  try {
    const sync = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: 'Um pedido sintético.', baseRevision: 0 } });
    assert.equal(sync.statusCode, 200);
    assert.equal(sync.json().status, 'needs-input');
    const events = parseEvents((await app.inject({ method: 'GET', url: `/api/v1/generation-runs/${sync.json().generationRunId}/events` })).body);
    assert.deepEqual(events.map(item => item.event), ['result']);
    assert.equal(events[0].data.result.status, 'needs-input');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/generation-runs/00000000-0000-4000-8000-000000000000/events' })).statusCode, 404);
  } finally { await app.close(); }
});
