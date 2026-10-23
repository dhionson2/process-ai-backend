import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { readEnvironment } from '../src/config/env.js';
import { recoveryGuidance, recoveryMessage } from '../src/modules/ai/recovery-guidance.js';
import { InMemoryConversationRepository } from '../src/modules/projects/conversation.repository.js';
import { ProviderFailure, type ModelProvider, type StructuredRequest, type StructuredResponse } from '../src/modules/providers/model-provider.js';

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? sourceFiles(`${directory}/${entry.name}`) : Promise.resolve(entry.name.endsWith('.ts') ? [`${directory}/${entry.name}`] : [])));
  return nested.flat();
}

test('todo código de falha lançado pelo backend tem orientação específica, nunca a genérica', async () => {
  const codes = new Set<string>();
  for (const file of await sourceFiles('src')) {
    for (const match of (await readFile(file, 'utf8')).matchAll(/(?:OrchestrationFailure|ConversationServiceFailure|ProviderFailure)\('([A-Z_]+)'/g)) codes.add(match[1]);
  }
  assert.ok(codes.size > 20);
  const generic = [...codes].filter(code => code !== 'GENERATION_FAILED' && recoveryGuidance(code).category === 'unexpected');
  assert.deepEqual(generic, []);
});

test('falta de informação e divergência de interpretação recebem caminhos distintos', () => {
  assert.equal(recoveryGuidance('GRAPHIR_COVERAGE_INCOMPLETE').category, 'missing-information');
  assert.equal(recoveryGuidance('GRAPHIR_ACTIVITY_UNGROUNDED').category, 'interpretation-divergence');
  assert.equal(recoveryGuidance('MODEL_PLAN_INVALID').category, 'model-output-invalid');
  assert.equal(recoveryGuidance('REVISION_CONFLICT').category, 'conflict');
  const waiting = recoveryGuidance('PROVIDER_RATE_LIMITED', 1500);
  assert.deepEqual(waiting.actions, ['wait', 'retry']);
  assert.equal(waiting.retryAfterMs, 1500);
  assert.match(recoveryMessage(recoveryGuidance('GRAPHIR_ACTIVITY_UNGROUNDED')), /preservados/);
  assert.doesNotMatch(recoveryMessage(recoveryGuidance('MODEL_PLAN_INVALID')), /MODEL_PLAN_INVALID/, 'a mensagem ao usuário não expõe o código técnico');
});

class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted-test';
  calls = 0;
  constructor(private readonly responses: unknown[]) {}
  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    this.calls += 1;
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    return { value: next, usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 3, model: request.model };
  }
}

test('API devolve recovery no erro, preserva a revisão e grava mensagem orientada à ação no histórico', async () => {
  const provider = new ScriptedProvider([{ kind: 'nada' }, { kind: 'ainda nada' }]);
  const app = await buildApp(readEnvironment({ LOG_LEVEL: 'silent' }), { conversationRepository: new InMemoryConversationRepository(), modelProvider: provider });
  try {
    const project = (await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Recuperação', targetProfile: 'generic-bpmn2' } })).json();
    const text = 'O servidor solicita férias e o gestor aprova ou reprova.';
    const failed = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${project.sessionId}/messages`, payload: { text, baseRevision: 0 } });
    assert.equal(failed.statusCode, 422);
    assert.equal(failed.json().code, 'MODEL_PLAN_INVALID');
    assert.equal(failed.json().recovery.category, 'model-output-invalid');
    assert.equal(failed.json().recovery.preserved, true);
    assert.equal(provider.calls, 2, 'uma única correção estrutural; nenhuma chamada silenciosa adicional');
    const session = (await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${project.sessionId}` })).json();
    assert.equal(session.currentRevision, 0);
    const history = (await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${project.sessionId}/history` })).json();
    const contents = JSON.stringify(history);
    assert.ok(contents.includes(text), 'texto do usuário preservado');
    assert.match(contents, /não passou na validação/);
  } finally { await app.close(); }
});

test('falha de provedor também carrega recovery com espera sugerida', async () => {
  const provider = new ScriptedProvider([new ProviderFailure('PROVIDER_RATE_LIMITED', 'Limite do provedor atingido', 2000, { category: 'rate_limit' })]);
  const app = await buildApp(readEnvironment({ LOG_LEVEL: 'silent' }), { conversationRepository: new InMemoryConversationRepository(), modelProvider: provider });
  try {
    const project = (await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Limite', targetProfile: 'generic-bpmn2' } })).json();
    const failed = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${project.sessionId}/messages`, payload: { text: 'Um pedido sintético qualquer.', baseRevision: 0 } });
    assert.equal(failed.statusCode, 429);
    assert.deepEqual(failed.json().recovery.actions, ['wait', 'retry']);
    assert.equal(failed.json().recovery.retryAfterMs, 2000);
  } finally { await app.close(); }
});
