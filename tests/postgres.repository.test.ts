import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PostgresConversationRepository, RevisionConflict } from '../src/modules/projects/conversation.repository.js';
import { readFile } from 'node:fs/promises';
import { validateProcessSpec } from '../src/modules/validation/validation.service.js';
import { generateArtifacts } from '../src/modules/generation/artifact-generator.js';
import { buildApp } from '../src/app.js';
import { readEnvironment } from '../src/config/env.js';

test('PostgreSQL persiste sessões e revisões com isolamento tenant e controle otimista', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  let repository = PostgresConversationRepository.fromConnectionString(process.env.TEST_DATABASE_URL!);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const tenant = `test-${crypto.randomUUID()}`;
  try {
    const created = await repository.createProject(tenant, 'Postgres repository test', 'generic-bpmn2');
    const session = await repository.getSession(tenant, created.sessionId);
    assert.equal(session?.currentRevision, 0);
    assert.equal(await repository.getSession('other-tenant', created.sessionId), undefined);
    const spec = JSON.parse(await readFile('specs/foundation/examples/ferias.json', 'utf8')) as Record<string, unknown>;
    assert.equal((await validateProcessSpec(spec)).valid, true);
    const artifacts = await generateArtifacts(spec);
    const proposal = await repository.createProposal(tenant, created.sessionId, 0, spec, artifacts, 'test', { source: 'postgres-test' });
    assert.equal(proposal.revision, 1);
    const competingProposal = await repository.createProposal(tenant, created.sessionId, 0, spec, artifacts, 'competing test', { source: 'postgres-test' });
    assert.equal(competingProposal.revision, 2);
    await assert.rejects(() => repository.createProposal(tenant, created.sessionId, 1, spec, artifacts, 'stale', {}), RevisionConflict);
    const accepts = await Promise.allSettled([
      repository.acceptRevision(tenant, created.sessionId, 1, 0),
      repository.acceptRevision(tenant, created.sessionId, 2, 0),
    ]);
    assert.equal(accepts.filter(result => result.status === 'fulfilled').length, 1);
    const conflict = accepts.find(result => result.status === 'rejected');
    assert.equal(conflict?.status, 'rejected');
    if (conflict?.status === 'rejected') assert.ok(conflict.reason instanceof RevisionConflict);
    const currentRevision = (await repository.getSession(tenant, created.sessionId))?.currentRevision;
    assert.ok(currentRevision === 1 || currentRevision === 2);
    assert.deepEqual(await repository.getCurrentSpec(tenant, created.sessionId), spec);
    await repository.appendMessage(tenant, created.sessionId, 'user', 'synthetic test');
    assert.equal((await repository.listMessages(tenant, created.sessionId, 10)).length, 1);
    const fact = { question: 'Como localizar o gestor?', answer: 'O RH informa o gestor', confirmedAt: new Date().toISOString() };
    await repository.appendConfirmedFacts(tenant, created.sessionId, [fact]);
    assert.deepEqual(await repository.listConfirmedFacts(tenant, created.sessionId), [fact]);
    const run = await repository.createRun(tenant, created.sessionId, 'ollama', 'test-local');
    await repository.updateRun(tenant, run.id, { status: 'validated', result: { revision: currentRevision }, metrics: { latencyMs: 11, usage: { inputTokens: 20, outputTokens: 10 } } });
    await repository.close();
    repository = PostgresConversationRepository.fromConnectionString(process.env.TEST_DATABASE_URL!);
    assert.equal((await repository.getSession(tenant, created.sessionId))?.currentRevision, currentRevision);
    assert.equal((await repository.listMessages(tenant, created.sessionId, 10))[0].content, 'synthetic test');
    assert.deepEqual(await repository.listConfirmedFacts(tenant, created.sessionId), [fact]);
    assert.equal((await repository.getRun(tenant, run.id))?.status, 'validated');
    assert.equal((await repository.listRevisions(tenant, created.sessionId)).length, 2);
  } finally {
    await pool.query('DELETE FROM process_ai_generation_runs WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM process_ai_messages WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM process_ai_revisions WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM process_ai_sessions WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM process_ai_projects WHERE tenant_id=$1', [tenant]);
    await pool.end();
    await repository.close();
  }
});

test('API recupera projeto, mensagens, run, revisão e artefatos do PostgreSQL após reinicializar', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const tenant = `api-restart-${crypto.randomUUID()}`;
  const config = readEnvironment({ ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, LOCAL_TENANT_ID: tenant, AI_PROVIDER: 'disabled', LOG_LEVEL: 'silent' });
  const spec = JSON.parse(await readFile('specs/foundation/examples/ferias.json', 'utf8')) as Record<string, unknown>;
  let app = await buildApp(config);
  let projectId = '';
  let sessionId = '';
  let runId = '';
  const closeAndListen = async (application: Awaited<ReturnType<typeof buildApp>>) => {
    await application.listen({ host: '127.0.0.1', port: 0 });
    const address = application.server.address();
    if (!address || typeof address === 'string') throw new Error('API não abriu uma porta TCP');
    return `http://127.0.0.1:${address.port}`;
  };
  try {
    let baseUrl = await closeAndListen(app);
    let response = await fetch(`${baseUrl}/api/v1/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Persisted vacation project' }) });
    assert.equal(response.status, 201);
    ({ projectId, sessionId } = await response.json() as { projectId: string; sessionId: string });
    response = await fetch(`${baseUrl}/api/v1/design-sessions/${sessionId}/draft`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseRevision: 0, processSpec: spec }) });
    assert.equal(response.status, 200);
    response = await fetch(`${baseUrl}/api/v1/design-sessions/${sessionId}/revisions/1/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseRevision: 0 }) });
    assert.equal(response.status, 200);

    const repository = PostgresConversationRepository.fromConnectionString(process.env.TEST_DATABASE_URL!);
    await repository.appendMessage(tenant, sessionId, 'user', 'Mensagem local sintética persistida');
    const confirmedFact = { question: 'Como localizar o gestor?', answer: 'O RH informa o gestor', confirmedAt: new Date().toISOString() };
    await repository.appendConfirmedFacts(tenant, sessionId, [confirmedFact]);
    const run = await repository.createRun(tenant, sessionId, 'ollama', 'local-integration-fixture');
    runId = run.id;
    await repository.updateRun(tenant, run.id, { status: 'validated', result: { revision: 1 }, metrics: { latencyMs: 13, usage: { inputTokens: 20, outputTokens: 8 } } });
    await repository.close();
    await app.close();

    app = await buildApp(config);
    baseUrl = await closeAndListen(app);
    response = await fetch(`${baseUrl}/api/v1/design-sessions/${sessionId}`);
    assert.equal(response.status, 200);
    const persistedSession = await response.json() as any;
    assert.equal(persistedSession.currentRevision, 1);
    assert.equal(persistedSession.status, 'accepted');
    response = await fetch(`${baseUrl}/api/v1/design-sessions/${sessionId}/history`);
    assert.equal((await response.json() as any).messages[0].content, 'Mensagem local sintética persistida');
    response = await fetch(`${baseUrl}/api/v1/design-sessions/${sessionId}/draft`);
    assert.equal((await response.json() as any).processSpec.id, spec.id);
    const recoveredRepository = PostgresConversationRepository.fromConnectionString(process.env.TEST_DATABASE_URL!);
    assert.deepEqual(await recoveredRepository.listConfirmedFacts(tenant, sessionId), [confirmedFact]);
    await recoveredRepository.close();
    response = await fetch(`${baseUrl}/api/v1/design-sessions/${sessionId}/revisions`);
    assert.equal((await response.json() as any).revisions[0].status, 'accepted');
    response = await fetch(`${baseUrl}/api/v1/generation-runs/${runId}`);
    const persistedRun = await response.json() as any;
    assert.equal(persistedRun.status, 'validated');
    assert.equal(persistedRun.metrics.latencyMs, 13);
  } finally {
    await app.close();
    const cleanup = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await cleanup.query('DELETE FROM process_ai_generation_runs WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_messages WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_revisions WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_sessions WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_projects WHERE tenant_id=$1', [tenant]);
    await cleanup.end();
  }
});
