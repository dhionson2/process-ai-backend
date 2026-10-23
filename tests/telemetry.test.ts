import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { readEnvironment } from '../src/config/env.js';
import { sessionTelemetry } from '../src/modules/ai/telemetry.js';
import { InMemoryConversationRepository, type GenerationRun } from '../src/modules/projects/conversation.repository.js';
import type { ModelProvider, StructuredRequest, StructuredResponse } from '../src/modules/providers/model-provider.js';

const run = (overrides: Partial<GenerationRun>): GenerationRun => ({ id: crypto.randomUUID(), sessionId: 's', status: 'validated', createdAt: '2026-10-22T10:00:00.000Z', updatedAt: '2026-10-22T10:00:00.000Z', ...overrides });

test('telemetria soma tokens, cache e custo e conta chamadas pelas etapas do pipeline', () => {
  const view = sessionTelemetry([
    run({ status: 'needs-input', provider: 'claude-cli', metrics: { model: 'claude-sonnet', latencyMs: 4000, usage: { inputTokens: 3000, cachedInputTokens: 2000, outputTokens: 400, costUsd: 0.01 }, pipeline: [{ stage: 'provider', status: 'received' }, { stage: 'readiness', status: 'needs-input' }] } }),
    run({ provider: 'claude-cli', metrics: { latencyMs: 6000, repairAttempts: 1, usage: { inputTokens: 5000, cachedInputTokens: 2500, outputTokens: 900, costUsd: 0.02 }, pipeline: [{ stage: 'provider', status: 'received' }, { stage: 'normalization', status: 'repair-valid' }] } }),
    run({ status: 'failed', errorCode: 'PROVIDER_TIMEOUT', providerStartedAt: '2026-10-22T10:00:01.000Z' }),
  ]);
  assert.deepEqual(view.runs.map(item => item.calls), [1, 2, 1]);
  assert.equal(sessionTelemetry([run({ metrics: { pipeline: [{ stage: 'provider', status: 'received' }, { stage: 'compilation', status: 'omission-repair' }, { stage: 'compilation', status: 'omission-repaired' }] } })]).runs[0].calls, 2, 'reparo de omissão conta como uma chamada extra');
  assert.equal(view.runs[0].model, 'claude-sonnet');
  assert.deepEqual(view.runs[0].stages, [{ stage: 'provider', status: 'received' }, { stage: 'readiness', status: 'needs-input' }]);
  assert.equal(view.runs[2].errorCode, 'PROVIDER_TIMEOUT');
  assert.equal(view.runs[2].costUsd, null);
  assert.equal(view.totals.calls, 4);
  assert.equal(view.totals.validated, 1);
  assert.equal(view.totals.inputTokens, 8000);
  assert.equal(view.totals.cacheHitRate, 4500 / 8000);
  assert.ok(Math.abs((view.totals.costUsd ?? 0) - 0.03) < 1e-9);
});

class CostlyProvider implements ModelProvider {
  readonly id = 'costly-test';
  constructor(private readonly responses: unknown[]) {}
  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    return { value: this.responses.shift(), usage: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 100, costUsd: 0.005 }, latencyMs: 10, model: request.model };
  }
}

test('turno com correção estrutural acumula custo e cache das duas chamadas na telemetria da sessão', async () => {
  const clarification = { kind: 'need_clarification', questions: [{ question: 'Quem aprova?', blocking: true }], summary: 'Falta o aprovador.' };
  const provider = new CostlyProvider([{ kind: 'resposta fora do contrato' }, clarification]);
  const app = await buildApp(readEnvironment({ LOG_LEVEL: 'silent' }), { conversationRepository: new InMemoryConversationRepository(), modelProvider: provider });
  try {
    const project = (await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Telemetria', targetProfile: 'generic-bpmn2' } })).json();
    const turn = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${project.sessionId}/messages`, payload: { text: 'Um pedido sintético.', baseRevision: 0 } });
    assert.equal(turn.json().status, 'needs-input');
    const telemetry = (await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${project.sessionId}/telemetry` })).json();
    assert.equal(telemetry.runs.length, 1);
    assert.equal(telemetry.totals.inputTokens, 2000);
    assert.equal(telemetry.totals.cachedInputTokens, 1200);
    assert.ok(Math.abs(telemetry.totals.costUsd - 0.01) < 1e-9, 'custo da chamada de correção não se perde');
    const missing = await app.inject({ method: 'GET', url: '/api/v1/design-sessions/00000000-0000-4000-8000-000000000000/telemetry' });
    assert.equal(missing.statusCode, 404);
  } finally { await app.close(); }
});

test('placar é servido sem os ProcessSpecs e responde 404 quando ainda não há avaliação', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scoreboard-'));
  const path = join(directory, 'scoreboard.json');
  const app = await buildApp(readEnvironment({ LOG_LEVEL: 'silent', EVALUATION_SCOREBOARD_PATH: path }));
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/evaluation/scoreboard' })).statusCode, 404);
    await writeFile(path, JSON.stringify({ generatedAt: 'agora', corpus: [], runs: [{ provider: 'p', model: 'm', summary: {}, results: [{ id: 'S01', spec: { nodes: [] } }] }] }));
    const served = (await app.inject({ method: 'GET', url: '/api/v1/evaluation/scoreboard' })).json();
    assert.equal(served.runs[0].results[0].id, 'S01');
    assert.equal(served.runs[0].results[0].spec, undefined);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
