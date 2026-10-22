import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { ConversationSchemaError, PostgresConversationRepository, RevisionConflict, StaleQuestionSet } from '../src/modules/projects/conversation.repository.js';
import { runMigrations } from '../src/modules/projects/migration.runner.js';
import { readFile } from 'node:fs/promises';
import { validateProcessSpec } from '../src/modules/validation/validation.service.js';
import { generateArtifacts } from '../src/modules/generation/artifact-generator.js';
import { buildApp } from '../src/app.js';
import { readEnvironment } from '../src/config/env.js';
import { latestSemanticFactEvents } from '../src/modules/ai/semantic-grounding.js';
import { ProviderFailure, type ModelProvider, type StructuredRequest, type StructuredResponse } from '../src/modules/providers/model-provider.js';

const isolatedTestDatabase = process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ? process.env.TEST_DATABASE_URL : undefined;
const providerClarification = { kind: 'need_clarification', questions: [{ question: 'Quem escolhe o gestor?', blocking: true }], summary: 'Falta definir o gestor.' };

class PostgreSqlRecoveryProvider implements ModelProvider {
  readonly id = 'postgres-recovery-test';
  readonly prompts: string[] = [];
  private call = 0;
  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    this.prompts.push(request.prompt);
    this.call++;
    if (this.call === 2) throw new ProviderFailure('PROVIDER_UNAVAILABLE', 'simulated provider outage');
    const value = this.call === 3 ? { kind: 'need_clarification', questions: [{ question: 'Existe outra regra pendente?', blocking: true }], summary: 'Há outra lacuna.' } : providerClarification;
    return { value, usage: { inputTokens: 5, outputTokens: 5 }, latencyMs: 1, model: request.model };
  }
}

function processPlan(spec: Record<string, any>, changeSummary = 'Proposta sintética para teste') {
  const project = structuredClone(spec);
  const compact = (value: any): any => value && typeof value === 'object' && value.op && value.left?.var && Object.hasOwn(value.right || {}, 'literal')
    ? { variable: value.left.var, operator: value.op, value: value.right.literal } : value;
  return {
    kind: 'process_plan', id: project.id, name: project.name, description: project.description || '', changeSummary,
    roles: project.roles, variables: project.variables,
    forms: project.forms.map((form: any) => ({ ...form, fields: form.fields.map((field: any) => ({ ...field, ...(field.visibleWhen ? { visibleWhen: compact(field.visibleWhen) } : {}), ...(field.requiredWhen ? { requiredWhen: compact(field.requiredWhen) } : {}) })) })),
    nodes: project.nodes.map((node: any) => ({ ...node, ...(node.action ? { action: { ...node.action, inputMapping: Object.fromEntries(Object.entries(node.action.inputMapping || {}).map(([key, value]) => [key, compact(value)])), ...(node.action.idempotencyKey ? { idempotencyKey: compact(node.action.idempotencyKey) } : {}) } } : {}) })),
    flows: project.flows.map((flow: any) => ({ ...flow, ...(flow.condition ? { condition: compact(flow.condition) } : {}) })),
    pendingQuestions: project.pendingQuestions.map(({ question, blocking }: any) => ({ question, blocking })),
  };
}

class PostgreSqlPlanProvider implements ModelProvider {
  readonly id = 'postgres-plan-test';
  calls = 0;
  idleTransactionsObserved: number[] = [];
  constructor(private readonly value: unknown, private readonly probe: Pool, private readonly applicationName: string) {}
  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    this.calls++;
    const result = await this.probe.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND state=\'idle in transaction\'', [this.applicationName]);
    this.idleTransactionsObserved.push(result.rows[0].count);
    return { value: this.value, usage: { inputTokens: 7, outputTokens: 9 }, latencyMs: 2, model: request.model };
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class PostgreSqlDelayedProvider implements ModelProvider {
  readonly id = 'postgres-delayed-test';
  calls = 0;
  readonly started = deferred<void>();
  readonly gate = deferred<void>();
  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    this.calls++; this.started.resolve(); await this.gate.promise;
    return { value: providerClarification, usage: { inputTokens: 3, outputTokens: 3 }, latencyMs: 1, model: request.model };
  }
}

test('PostgreSQL persiste sessões e revisões com isolamento tenant e controle otimista', { skip: !isolatedTestDatabase }, async () => {
  let repository = PostgresConversationRepository.fromConnectionString(isolatedTestDatabase!);
  const pool = new Pool({ connectionString: isolatedTestDatabase });
  const tenant = `test-${crypto.randomUUID()}`;
  try {
    const created = await repository.createProject(tenant, 'Postgres repository test', 'generic-bpmn2');
    const session = await repository.getSession(tenant, created.sessionId);
    assert.equal(session?.currentRevision, 0);
    assert.equal(await repository.getSession('other-tenant', created.sessionId), undefined);
    const legacyQuestion = { question: 'Pergunta legada sem identidade', blocking: true };
    await repository.setPendingQuestions(tenant, created.sessionId, [legacyQuestion]);
    await repository.close();
    repository = PostgresConversationRepository.fromConnectionString(isolatedTestDatabase!);
    assert.deepEqual((await repository.getSession(tenant, created.sessionId))?.pendingQuestions, [legacyQuestion]);
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
    assert.deepEqual((await repository.listRuns(tenant, created.sessionId)).map(item => [item.id, item.metrics]), [[run.id, { latencyMs: 11, usage: { inputTokens: 20, outputTokens: 10 } }]]);
    assert.deepEqual(await repository.listRuns(`${tenant}-other`, created.sessionId), [], 'runs isolados por tenant');
    await repository.syncRequirements(tenant, created.sessionId, 1, [{ kind: 'activity', label: 'Aprovar', origin: 'user' }, { kind: 'actor', label: 'Gestor', origin: 'inference' }]);
    await repository.syncRequirements(tenant, created.sessionId, 2, [{ kind: 'activity', label: 'Aprovar', origin: 'inference' }]);
    const ledger = await repository.listRequirements(tenant, created.sessionId);
    const approve = ledger.find(item => item.label === 'Aprovar')!;
    assert.deepEqual([approve.origin, approve.firstRevision, approve.lastRevision, approve.state], ['user', 1, 2, 'proposed'], 'origem declarada nunca rebaixa para inferência');
    assert.equal((await repository.setRequirementState(tenant, created.sessionId, approve.id, 'rejected')).state, 'rejected');
    await repository.syncRequirements(tenant, created.sessionId, 3, [{ kind: 'activity', label: 'Aprovar', origin: 'user' }]);
    assert.equal((await repository.listRequirements(tenant, created.sessionId)).find(item => item.id === approve.id)?.state, 'rejected', 'sincronização nunca apaga o veredito');
    await assert.rejects(() => repository.setRequirementState(`${tenant}-other`, created.sessionId, approve.id, 'confirmed'));
    await repository.saveAcceptedExample(tenant, created.sessionId, 1, 'pedido sintético', 'resumo');
    await repository.saveAcceptedExample(tenant, created.sessionId, 1, 'pedido sintético', 'resumo');
    assert.equal((await repository.listAcceptedExamples(tenant, 10)).length, 1, 'exemplo idempotente por revisão');
    assert.deepEqual(await repository.listAcceptedExamples(`${tenant}-other`, 10), [], 'exemplos isolados por tenant');
    await repository.appendAudit({ tenantId: tenant, subject: 'ana', action: 'POST /api/v1/projects', sessionId: created.sessionId, statusCode: 201, details: { revision: '1' } });
    const audit = await repository.listAudit(tenant, 10);
    assert.deepEqual(audit.map(event => [event.subject, event.action, event.statusCode, event.sessionId]), [['ana', 'POST /api/v1/projects', 201, created.sessionId]]);
    assert.deepEqual(await repository.listAudit(`${tenant}-other`, 10), [], 'auditoria isolada por tenant');
  } finally {
    await pool.query('DELETE FROM process_ai_audit_events WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM process_ai_generation_runs WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM process_ai_messages WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM process_ai_requirements WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM process_ai_accepted_examples WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM process_ai_revisions WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM process_ai_sessions WHERE tenant_id=$1', [tenant]);
    await pool.query('DELETE FROM process_ai_projects WHERE tenant_id=$1', [tenant]);
    await pool.end();
    await repository.close();
  }
});

test('PostgreSQL grava turno e fatos atomicamente, rejeita perguntas antigas, serializa concorrência e reconcilia interrupção', { skip: !isolatedTestDatabase }, async () => {
  const repository = PostgresConversationRepository.fromConnectionString(isolatedTestDatabase!);
  const tenant = `turn-${crypto.randomUUID()}`;
  const otherTenant = `other-${crypto.randomUUID()}`;
  let created: { projectId: string; sessionId: string } | undefined;
  try {
    created = await repository.createProject(tenant, 'Isolated turn test', 'generic-bpmn2');
    const questions = [{ questionId: 'q_manager', requirementId: 'req_manager', semanticSlot: 'slot:manager', question: 'Quem escolhe o gestor?', blocking: true }];
    await repository.setPendingQuestions(tenant, created.sessionId, questions);
    const session = await repository.getSession(tenant, created.sessionId);
    assert.ok(session);
    const questionSetId = `qs_${(await import('node:crypto')).createHash('sha256').update(JSON.stringify(questions.map(item => ({ questionId: item.questionId, requirementId: item.requirementId, semanticSlot: item.semanticSlot, question: item.question })))).digest('hex').slice(0, 24)}`;
    const fact = { question: questions[0].question, answer: 'Operador seleciona', confirmedAt: new Date().toISOString(), questionId: 'q_manager', requirementId: 'req_manager', semanticSlot: 'slot:manager', state: 'confirmed' as const };
    await assert.rejects(() => repository.beginTurn(tenant, created!.sessionId, { baseRevision: 0, role: 'user', content: 'answer', expectedQuestionSetId: 'qs_stale_0000000000', facts: [fact] }, 'test', 'test'), StaleQuestionSet);
    assert.equal((await repository.listMessages(tenant, created.sessionId, 10)).length, 0);
    assert.equal((await repository.listConfirmedFacts(tenant, created.sessionId)).length, 0);
    const input = { baseRevision: 0, role: 'user' as const, content: 'answer', expectedQuestionSetId: questionSetId, facts: [fact], operationId: 'pg-turn-operation-0001' };
    const results = await Promise.allSettled([
      repository.beginTurn(tenant, created.sessionId, input, 'test', 'test'),
      repository.beginTurn(tenant, created.sessionId, { ...input, operationId: 'pg-turn-operation-0002' }, 'test', 'test'),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected' && result.reason instanceof RevisionConflict).length, 1);
    const begun = results.find(result => result.status === 'fulfilled');
    assert.ok(begun && begun.status === 'fulfilled');
    const duplicate = await repository.beginTurn(tenant, created.sessionId, input, 'test', 'test');
    assert.equal(duplicate.replay, true);
    assert.equal(duplicate.run.id, begun.value.run.id);
    assert.equal((await repository.listConfirmedFacts(tenant, created.sessionId)).length, 1);
    const semanticEvents = [
      { question: 'Qual limite?', answer: 'gt:2000', confirmedAt: new Date().toISOString(), semanticFactId: 'threshold:approval', semanticSlot: 'slot:approval-limit', state: 'superseded' as const },
      { question: 'Qual limite?', answer: 'gt:5000', confirmedAt: new Date().toISOString(), semanticFactId: 'threshold:approval', semanticSlot: 'slot:approval-limit', state: 'confirmed' as const },
    ];
    await repository.appendConfirmedFacts(tenant, created.sessionId, semanticEvents);
    await repository.close();
    const reopened = PostgresConversationRepository.fromConnectionString(isolatedTestDatabase!);
    const restoredFacts = await reopened.listConfirmedFacts(tenant, created.sessionId);
    assert.equal(restoredFacts[0].semanticSlot, 'slot:manager');
    assert.equal(restoredFacts.filter(fact => fact.semanticFactId === 'threshold:approval').length, 2);
    const effective = latestSemanticFactEvents(restoredFacts.filter(fact => fact.semanticFactId === 'threshold:approval'));
    assert.equal(effective.length, 1);
    assert.equal(effective[0].answer, 'gt:5000');
    assert.equal(await reopened.getSession(otherTenant, created.sessionId), undefined);
    const ageing = new Pool({ connectionString: isolatedTestDatabase });
    await ageing.query("UPDATE process_ai_generation_runs SET updated_at=now()-interval '6 minutes' WHERE tenant_id=$1 AND id=$2", [tenant, begun.value.run.id]);
    await ageing.end();
    assert.equal(await reopened.reconcileInterruptedRuns(tenant, created.sessionId), 1);
    assert.equal((await reopened.getRun(tenant, begun.value.run.id))?.errorCode, 'GENERATION_INTERRUPTED');
    await reopened.close();
  } finally {
    const cleanup = new Pool({ connectionString: isolatedTestDatabase });
    await cleanup.query('DELETE FROM process_ai_generation_runs WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_messages WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_requirements WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_accepted_examples WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_revisions WHERE tenant_id=$1', [tenant]);
    if (created) await cleanup.query('DELETE FROM process_ai_sessions WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_projects WHERE tenant_id=$1', [tenant]);
    await cleanup.end();
    await repository.close().catch(() => undefined);
  }
});

test('PostgreSQL faz rollback integral após falha injetada na gravação do run', { skip: !isolatedTestDatabase }, async () => {
  const repository = PostgresConversationRepository.fromConnectionString(isolatedTestDatabase!);
  const pool = new Pool({ connectionString: isolatedTestDatabase });
  const tenant = `rollback-${crypto.randomUUID()}`;
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const functionName = `fail_run_${suffix}`;
  const triggerName = `fail_run_trigger_${suffix}`;
  let created: { projectId: string; sessionId: string } | undefined;
  try {
    created = await repository.createProject(tenant, 'Rollback test', 'generic-bpmn2');
    await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test-only injected failure'; END $$`);
    await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON process_ai_generation_runs FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    const fact = { question: 'synthetic question', answer: 'synthetic answer', confirmedAt: new Date().toISOString(), questionId: 'q_rollback', semanticSlot: 'slot:rollback', state: 'confirmed' as const };
    await assert.rejects(() => repository.beginTurn(tenant, created!.sessionId, { baseRevision: 0, role: 'user', content: 'synthetic answer', facts: [fact], operationId: 'rollback-operation-0001' }, 'test', 'test'));
    assert.equal((await repository.listMessages(tenant, created.sessionId, 10)).length, 0);
    assert.equal((await repository.listConfirmedFacts(tenant, created.sessionId)).length, 0);
    assert.equal((await repository.getSession(tenant, created.sessionId))?.status, 'draft');
    const runs = await pool.query('SELECT count(*)::int AS count FROM process_ai_generation_runs WHERE tenant_id=$1 AND session_id=$2', [tenant, created.sessionId]);
    assert.equal(runs.rows[0].count, 0);
  } finally {
    if (created) await pool.query('DELETE FROM process_ai_generation_runs WHERE tenant_id=$1 AND session_id=$2', [tenant, created.sessionId]);
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON process_ai_generation_runs`);
    await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    if (created) {
      await pool.query('DELETE FROM process_ai_messages WHERE tenant_id=$1 AND session_id=$2', [tenant, created.sessionId]);
      await pool.query('DELETE FROM process_ai_sessions WHERE tenant_id=$1 AND id=$2', [tenant, created.sessionId]);
      await pool.query('DELETE FROM process_ai_projects WHERE tenant_id=$1 AND id=$2', [tenant, created.projectId]);
    }
    await pool.end();
    await repository.close();
  }
});

test('PostgreSQL reverte proposta, mensagem e run na falha de conclusão e permite recuperação explícita', { skip: !isolatedTestDatabase }, async () => {
  const tenant = `p07-${crypto.randomUUID()}`;
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const functionName = `fail_completion_${suffix}`;
  const triggerName = `fail_completion_trigger_${suffix}`;
  const applicationName = `p07_${suffix}`;
  const connectionUrl = new URL(isolatedTestDatabase!); connectionUrl.searchParams.set('application_name', applicationName);
  const config = readEnvironment({ ...process.env, DATABASE_URL: connectionUrl.toString(), LOCAL_TENANT_ID: tenant, AI_PROVIDER: 'disabled', LOG_LEVEL: 'silent' });
  const spec = JSON.parse(await readFile('specs/foundation/examples/ferias.json', 'utf8')) as Record<string, any>;
  const admin = new Pool({ connectionString: isolatedTestDatabase });
  const provider = new PostgreSqlPlanProvider({ kind: 'refinement', changeSummary: 'Renomear para comprovar conclusão atômica', operations: [{ kind: 'renameProcess', name: 'Solicitação de férias revisada' }] }, admin, applicationName);
  const app = await buildApp(config, { modelProvider: provider });
  let created: { projectId: string; sessionId: string } | undefined;
  const repo = PostgresConversationRepository.fromConnectionString(isolatedTestDatabase!);
  try {
    created = await repo.createProject(tenant, 'P07 synthetic atomicity', 'generic-bpmn2');
    const artifacts = await generateArtifacts(spec);
    const accepted = await repo.createProposal(tenant, created.sessionId, 0, spec, artifacts, 'Accepted baseline', { source: 'p07-test' });
    await repo.acceptRevision(tenant, created.sessionId, accepted.revision, 0);
    await admin.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='validated' THEN RAISE EXCEPTION 'injected P07 completion failure'; END IF; RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER ${triggerName} BEFORE UPDATE OF status ON process_ai_generation_runs FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);

    const request = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${created.sessionId}/messages`, payload: { text: 'Renomeie o processo para Solicitação de férias revisada.', baseRevision: 1, operationId: 'p07-first-attempt-001' } });
    assert.equal(request.statusCode, 500, request.body);
    assert.equal(provider.calls, 1);
    assert.deepEqual(provider.idleTransactionsObserved, [0], 'provider foi chamado fora de uma transação PostgreSQL aberta pela API');

    const revisionsAfterRollback = await repo.listRevisions(tenant, created.sessionId);
    assert.equal(revisionsAfterRollback.length, 1, 'a proposta parcial foi revertida');
    assert.equal(revisionsAfterRollback[0].status, 'accepted');
    assert.deepEqual(revisionsAfterRollback[0].processSpec, spec);
    const sessionAfterRollback = await repo.getSession(tenant, created.sessionId);
    assert.equal(sessionAfterRollback?.currentRevision, 1, 'revisão aceita não mudou');
    assert.equal(sessionAfterRollback?.status, 'generating', 'falha deixou o run recuperável, sem estado falso de conclusão');
    const messagesAfterRollback = await repo.listMessages(tenant, created.sessionId, 20);
    assert.equal(messagesAfterRollback.filter(message => message.role === 'user').length, 1);
    assert.equal(messagesAfterRollback.filter(message => message.role === 'assistant').length, 0, 'mensagem de conclusão parcial foi revertida');
    const failedAttempt = await admin.query("SELECT status FROM process_ai_generation_runs WHERE tenant_id=$1 AND operation_id='p07-first-attempt-001'", [tenant]);
    assert.equal(failedAttempt.rows[0]?.status, 'generating', 'run permanece explicitamente recuperável após rollback');

    await admin.query(`DROP TRIGGER ${triggerName} ON process_ai_generation_runs`);
    await repo.reconcileInterruptedRuns(tenant, created.sessionId, 0);
    const recoveredAttempt = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${created.sessionId}/messages`, payload: { text: 'Renomeie o processo para Solicitação de férias revisada.', baseRevision: 1, operationId: 'p07-explicit-recovery-001' } });
    assert.equal(recoveredAttempt.statusCode, 200, recoveredAttempt.body);
    assert.equal(recoveredAttempt.json().status, 'validated');
    assert.equal(provider.calls, 2, 'a recuperação explícita usou operação nova');
    const finalRevisions = await repo.listRevisions(tenant, created.sessionId);
    assert.equal(finalRevisions.length, 2);
    assert.equal(finalRevisions.find(item => item.revision === 1)?.status, 'accepted');
    assert.equal(finalRevisions.find(item => item.revision === 2)?.status, 'proposed');
    assert.equal((await repo.getSession(tenant, created.sessionId))?.currentRevision, 1);
    assert.equal((await repo.getRun(tenant, recoveredAttempt.json().generationRunId))?.status, 'validated');
    assert.equal((await repo.listMessages(tenant, created.sessionId, 20)).filter(message => message.role === 'assistant').length, 1);
  } finally {
    await app.close();
    await admin.query(`DROP TRIGGER IF EXISTS ${triggerName} ON process_ai_generation_runs`);
    await admin.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    if (created) {
      await admin.query('DELETE FROM process_ai_generation_runs WHERE tenant_id=$1', [tenant]);
      await admin.query('DELETE FROM process_ai_messages WHERE tenant_id=$1', [tenant]);
      await admin.query('DELETE FROM process_ai_requirements WHERE tenant_id=$1', [tenant]);
      await admin.query('DELETE FROM process_ai_accepted_examples WHERE tenant_id=$1', [tenant]);
      await admin.query('DELETE FROM process_ai_revisions WHERE tenant_id=$1', [tenant]);
      await admin.query('DELETE FROM process_ai_sessions WHERE tenant_id=$1', [tenant]);
      await admin.query('DELETE FROM process_ai_projects WHERE tenant_id=$1', [tenant]);
    }
    await admin.end(); await repo.close();
  }
});

test('PostgreSQL retry durante run ativo e após interrupção não chama provider novamente', { skip: !isolatedTestDatabase }, async () => {
  const tenant = `p15-active-${crypto.randomUUID()}`;
  const config = readEnvironment({ ...process.env, DATABASE_URL: isolatedTestDatabase, LOCAL_TENANT_ID: tenant, AI_PROVIDER: 'disabled', LOG_LEVEL: 'silent' });
  const provider = new PostgreSqlDelayedProvider(); const app = await buildApp(config, { modelProvider: provider });
  const admin = new Pool({ connectionString: isolatedTestDatabase });
  let sessionId = ''; let originalRequest: Promise<any> | undefined;
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'P15 active state' } }); sessionId = project.json().sessionId;
    const payload = { text: 'Pedido sintético durante geração ativa.', baseRevision: 0, operationId: 'p15-uncertain-0001' };
    const path = `/api/v1/design-sessions/${sessionId}/messages`;
    originalRequest = app.inject({ method: 'POST', url: path, payload });
    await provider.started.promise;
    const activeRetry = await app.inject({ method: 'POST', url: path, payload });
    assert.equal(activeRetry.statusCode, 200); assert.equal(activeRetry.json().status, 'generating'); assert.equal(activeRetry.json().replayed, true);
    assert.equal(provider.calls, 1, 'retry ativo apenas observa o run já existente');
    await admin.query("UPDATE process_ai_generation_runs SET updated_at=now()-interval '6 minutes' WHERE tenant_id=$1 AND operation_id=$2", [tenant, payload.operationId]);
    const repository = PostgresConversationRepository.fromConnectionString(isolatedTestDatabase!);
    assert.equal(await repository.reconcileInterruptedRuns(tenant, sessionId), 1);
    const interruptedRetry = await app.inject({ method: 'POST', url: path, payload });
    assert.equal(interruptedRetry.statusCode, 200); assert.equal(interruptedRetry.json().status, 'failed'); assert.equal(interruptedRetry.json().replayed, true);
    assert.equal(interruptedRetry.json().error.code, 'GENERATION_INTERRUPTED');
    assert.equal(provider.calls, 1, 'estado incerto/interrompido nunca relança provider automaticamente');
    provider.gate.resolve();
    const original = await originalRequest;
    assert.equal(original.statusCode, 404, 'a conclusão atrasada não pode sobrescrever o run já reconciliado');
    await repository.close();
  } finally {
    provider.gate.resolve();
    if (originalRequest) await originalRequest.catch(() => undefined);
    await app.close();
    await admin.query('DELETE FROM process_ai_generation_runs WHERE tenant_id=$1', [tenant]);
    await admin.query('DELETE FROM process_ai_messages WHERE tenant_id=$1', [tenant]);
    await admin.query('DELETE FROM process_ai_requirements WHERE tenant_id=$1', [tenant]);
    await admin.query('DELETE FROM process_ai_accepted_examples WHERE tenant_id=$1', [tenant]);
    await admin.query('DELETE FROM process_ai_revisions WHERE tenant_id=$1', [tenant]);
    if (sessionId) await admin.query('DELETE FROM process_ai_sessions WHERE tenant_id=$1', [tenant]);
    await admin.query('DELETE FROM process_ai_projects WHERE tenant_id=$1', [tenant]);
    await admin.end();
  }
});

test('PostgreSQL repete o mesmo operationId quando a falha comprovadamente ocorreu antes do provider', { skip: !isolatedTestDatabase }, async () => {
  const tenant = `p15-pre-provider-${crypto.randomUUID()}`;
  const config = readEnvironment({ ...process.env, DATABASE_URL: isolatedTestDatabase, LOCAL_TENANT_ID: tenant, AI_PROVIDER: 'disabled', LOG_LEVEL: 'silent' });
  config.aiMaxInputChars = 1000;
  const provider = new PostgreSqlRecoveryProvider(); const app = await buildApp(config, { modelProvider: provider });
  const admin = new Pool({ connectionString: isolatedTestDatabase });
  let sessionId = '';
  try {
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'P15 pre-provider failure' } }); sessionId = project.json().sessionId;
    const payload = { text: 'Solicitação sintética simples.', baseRevision: 0, operationId: 'p15-safe-retry-0001' };
    const path = `/api/v1/design-sessions/${sessionId}/messages`;
    const first = await app.inject({ method: 'POST', url: path, payload });
    assert.equal(first.statusCode, 413); assert.equal(provider.prompts.length, 0);
    let stored = await admin.query("SELECT id,status,provider_started_at,metrics FROM process_ai_generation_runs WHERE tenant_id=$1 AND operation_id=$2", [tenant, payload.operationId]);
    assert.equal(stored.rows[0].status, 'failed'); assert.equal(stored.rows[0].provider_started_at, null); assert.equal(stored.rows[0].metrics.providerCallStarted, false);

    config.aiMaxInputChars = 40000;
    const retry = await app.inject({ method: 'POST', url: path, payload });
    assert.equal(retry.statusCode, 200, retry.body); assert.equal(retry.json().status, 'needs-input');
    assert.equal(provider.prompts.length, 1, 'retry seguro chamou o provider uma única vez após remover a falha local');
    stored = await admin.query("SELECT id,status,provider_started_at FROM process_ai_generation_runs WHERE tenant_id=$1 AND operation_id=$2", [tenant, payload.operationId]);
    assert.equal(stored.rows[0].id, retry.json().generationRunId, 'mesma operação recuperou o mesmo run');
    assert.equal(stored.rows[0].status, 'needs-input'); assert.ok(stored.rows[0].provider_started_at);
  } finally {
    await app.close();
    await admin.query('DELETE FROM process_ai_generation_runs WHERE tenant_id=$1', [tenant]);
    await admin.query('DELETE FROM process_ai_messages WHERE tenant_id=$1', [tenant]);
    await admin.query('DELETE FROM process_ai_requirements WHERE tenant_id=$1', [tenant]);
    await admin.query('DELETE FROM process_ai_accepted_examples WHERE tenant_id=$1', [tenant]);
    await admin.query('DELETE FROM process_ai_revisions WHERE tenant_id=$1', [tenant]);
    if (sessionId) await admin.query('DELETE FROM process_ai_sessions WHERE tenant_id=$1', [tenant]);
    await admin.query('DELETE FROM process_ai_projects WHERE tenant_id=$1', [tenant]);
    await admin.end();
  }
});

test('PostgreSQL replay de answers após resposta perdida devolve resultado, conflito de payload e exige operação nova após falha', { skip: !isolatedTestDatabase }, async () => {
  const tenant = `p15-${crypto.randomUUID()}`;
  const config = readEnvironment({ ...process.env, DATABASE_URL: isolatedTestDatabase, LOCAL_TENANT_ID: tenant, AI_PROVIDER: 'disabled', LOG_LEVEL: 'silent' });
  const provider = new PostgreSqlRecoveryProvider();
  const app = await buildApp(config, { modelProvider: provider });
  let sessionId = '';
  try {
    let response = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'P15 synthetic replay', targetProfile: 'generic-bpmn2' } });
    sessionId = response.json().sessionId;
    const initial = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: 'Solicitação sintética de férias com aprovação do gestor e registro pelo RH.', baseRevision: 0, operationId: 'p15-start-0001' } });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().status, 'needs-input');
    const answerPayload = { answers: ['Operador autorizado seleciona o gestor.'], baseRevision: 0, questionSetId: initial.json().questionSetId, operationId: 'p15-answer-0001' };
    const original = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/answers`, payload: answerPayload });
    assert.equal(original.statusCode, 503, 'o provider simulado falhou após persistir o turno');
    const replay = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/answers`, payload: answerPayload });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().status, 'failed');
    assert.equal(replay.json().replayed, true);
    const runLookupPool = new Pool({ connectionString: isolatedTestDatabase });
    const storedFailedRun = await runLookupPool.query("SELECT id FROM process_ai_generation_runs WHERE tenant_id=$1 AND operation_id='p15-answer-0001'", [tenant]);
    assert.equal(replay.json().generationRunId, storedFailedRun.rows[0].id);
    await runLookupPool.end();
    assert.equal(provider.prompts.length, 2, 'replay após falha não chama provider de novo');
    const differentPayload = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/answers`, payload: { ...answerPayload, answers: ['Outra resposta sintética.'] } });
    assert.equal(differentPayload.statusCode, 409);
    assert.equal(differentPayload.json().code, 'OPERATION_ID_CONFLICT');

    response = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: 'Recuperação explícita com nova operação e fatos já persistidos.', baseRevision: 0, operationId: 'p15-recovery-0001' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'needs-input');
    assert.equal(provider.prompts.length, 3);
    const successfulReplay = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: 'Recuperação explícita com nova operação e fatos já persistidos.', baseRevision: 0, operationId: 'p15-recovery-0001' } });
    assert.equal(successfulReplay.statusCode, 200);
    assert.equal(successfulReplay.json().replayed, true);
    assert.equal(successfulReplay.json().generationRunId, response.json().generationRunId);
    assert.deepEqual(successfulReplay.json().questions, response.json().questions);
    assert.equal(provider.prompts.length, 3, 'resultado persistido foi reutilizado após perda simulada da resposta');
    const repository = PostgresConversationRepository.fromConnectionString(isolatedTestDatabase!);
    const messages = await repository.listMessages(tenant, sessionId, 20);
    const facts = await repository.listConfirmedFacts(tenant, sessionId);
    assert.equal(messages.filter(message => message.role === 'user' && message.content === answerPayload.answers[0]).length, 1);
    assert.equal(facts.length, 1, 'fato confirmado não duplicou no replay');
    assert.equal((await repository.listRevisions(tenant, sessionId)).length, 0, 'replay não criou revisão extra');
    await repository.close();
  } finally {
    await app.close();
    const cleanup = new Pool({ connectionString: isolatedTestDatabase });
    await cleanup.query('DELETE FROM process_ai_generation_runs WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_messages WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_requirements WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_accepted_examples WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_revisions WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_sessions WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_projects WHERE tenant_id=$1', [tenant]);
    await cleanup.end();
  }
});

test('PostgreSQL preserva resposta confirmada após falha do provider e permite retomada explícita após recriar a API', { skip: !isolatedTestDatabase }, async () => {
  const tenant = `provider-recovery-${crypto.randomUUID()}`;
  const config = readEnvironment({ ...process.env, DATABASE_URL: isolatedTestDatabase, LOCAL_TENANT_ID: tenant, AI_PROVIDER: 'disabled', LOG_LEVEL: 'silent' });
  const provider = new PostgreSqlRecoveryProvider();
  let app = await buildApp(config, { modelProvider: provider });
  let sessionId = '';
  try {
    let response = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Provider recovery', targetProfile: 'generic-bpmn2' } });
    sessionId = response.json().sessionId;
    response = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: 'Synthetic process request', baseRevision: 0, operationId: 'provider-request-0001' } });
    assert.equal(response.json().status, 'needs-input');
    const set = response.json().questionSetId;
    response = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/answers`, payload: { answers: ['Operador autorizado seleciona o gestor.'], baseRevision: 0, questionSetId: set, operationId: 'provider-answer-0001' } });
    assert.equal(response.statusCode, 503);
    const repository = PostgresConversationRepository.fromConnectionString(isolatedTestDatabase!);
    const factsAfterFailure = await repository.listConfirmedFacts(tenant, sessionId);
    assert.equal(factsAfterFailure.length, 1);
    assert.equal(factsAfterFailure[0].answer, 'Operador autorizado seleciona o gestor.');
    assert.equal((await repository.getSession(tenant, sessionId))?.status, 'failed');
    const runs = await repository.listMessages(tenant, sessionId, 10);
    assert.ok(runs.some(message => message.content === 'Operador autorizado seleciona o gestor.'));
    await repository.close();
    await app.close();
    app = await buildApp(config, { modelProvider: provider });
    response = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: 'Retome usando os fatos já confirmados.', baseRevision: 0, operationId: 'provider-resume-0001' } });
    assert.equal(response.json().status, 'needs-input');
    assert.match(provider.prompts[2], /Operador autorizado seleciona o gestor/);
    const reopened = PostgresConversationRepository.fromConnectionString(isolatedTestDatabase!);
    assert.equal((await reopened.listConfirmedFacts(tenant, sessionId)).length, 1);
    await reopened.close();
  } finally {
    await app.close();
    const cleanup = new Pool({ connectionString: isolatedTestDatabase });
    await cleanup.query('DELETE FROM process_ai_generation_runs WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_messages WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_requirements WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_accepted_examples WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_revisions WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_sessions WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_projects WHERE tenant_id=$1', [tenant]);
    await cleanup.end();
  }
});

test('API recupera projeto, mensagens, run, revisão e artefatos do PostgreSQL após reinicializar', { skip: !isolatedTestDatabase }, async () => {
  const tenant = `api-restart-${crypto.randomUUID()}`;
  const config = readEnvironment({ ...process.env, DATABASE_URL: isolatedTestDatabase, LOCAL_TENANT_ID: tenant, AI_PROVIDER: 'disabled', LOG_LEVEL: 'silent' });
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

    const repository = PostgresConversationRepository.fromConnectionString(isolatedTestDatabase!);
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
    const recoveredRepository = PostgresConversationRepository.fromConnectionString(isolatedTestDatabase!);
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
    const cleanup = new Pool({ connectionString: isolatedTestDatabase });
    await cleanup.query('DELETE FROM process_ai_generation_runs WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_messages WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_requirements WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_accepted_examples WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_revisions WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_sessions WHERE tenant_id=$1', [tenant]);
    await cleanup.query('DELETE FROM process_ai_projects WHERE tenant_id=$1', [tenant]);
    await cleanup.end();
  }
});
