import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { readEnvironment } from '../src/config/env.js';
import { projectUnderstanding } from '../src/modules/ai/understanding.js';
import { InMemoryConversationRepository } from '../src/modules/projects/conversation.repository.js';

const generatedSpec = async () => JSON.parse(await readFile('reports/marco2-recovery-2026-10-14/C.process-spec.json', 'utf8'));

test('projeção de negócio mostra participantes, etapas, decisões, campos, origem e pendências', async () => {
  const view = projectUnderstanding(await generatedSpec(), 2, 'proposed');
  assert.equal(view.revision, 2);
  assert.ok(view.actors.some(actor => actor.label === 'Gestor' && actor.origin === 'user' && actor.confirmed));
  assert.ok(view.actors.every(actor => actor.detail === 'responsável no ambiente ainda não definido'));
  assert.ok(view.activities.some(activity => activity.label === 'Registrar férias' && activity.detail === 'RH'));
  assert.ok(view.decisions.length >= 2, 'duas aprovações em série');
  assert.ok(view.decisions.every(decision => decision.outcomes.length >= 2));
  assert.ok(view.fields.some(field => field.label === 'Decisão' && field.required));
  assert.ok(view.pending.some(item => /Como o runtime deve atribuir o papel/.test(item)));
  assert.ok(view.provenance.user > 0 && view.provenance.inference > 0);
});

test('projeção tolera spec vazio sem lançar', () => {
  const view = projectUnderstanding({}, 1, 'proposed');
  assert.deepEqual([view.actors, view.activities, view.decisions, view.fields, view.pending], [[], [], [], [], []]);
});

test('GET /understanding devolve vazio antes da proposta e a projeção depois de uma revisão', async () => {
  const app = await buildApp(readEnvironment({ LOG_LEVEL: 'silent' }), { conversationRepository: new InMemoryConversationRepository() });
  try {
    const project = (await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Entendimento', targetProfile: 'generic-bpmn2' } })).json();
    const empty = await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${project.sessionId}/understanding` });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual({ ...empty.json(), sessionId: undefined }, { sessionId: undefined, currentRevision: 0, confirmedFacts: [], pendingQuestions: [], proposal: null, requirements: [] });
    const draft = await app.inject({ method: 'PUT', url: `/api/v1/design-sessions/${project.sessionId}/draft`, payload: { baseRevision: 0, processSpec: await generatedSpec() } });
    assert.equal(draft.statusCode, 200, draft.body);
    const filled = (await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${project.sessionId}/understanding` })).json();
    assert.equal(filled.proposal.revision, 1);
    assert.ok(filled.proposal.activities.length > 0);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/design-sessions/00000000-0000-4000-8000-000000000000/understanding' });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().recovery.category, 'invalid-request');
  } finally { await app.close(); }
});
