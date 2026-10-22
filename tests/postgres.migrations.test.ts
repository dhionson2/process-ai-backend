import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { runMigrations } from '../src/modules/projects/migration.runner.js';
import { PostgresConversationRepository } from '../src/modules/projects/conversation.repository.js';
import { ConversationSchemaError } from '../src/modules/projects/schema-verification.js';

const rawTestUrl = process.env.TEST_DATABASE_URL;
const targetUrl = rawTestUrl && process.env.DATABASE_URL !== rawTestUrl && (() => {
  try { const url = new URL(rawTestUrl); return url.hostname === '127.0.0.1' && url.port === '55432' && url.pathname === '/processai_v2c1'; } catch { return false; }
})() ? rawTestUrl : undefined;
const skip = !targetUrl;

function ident(value: string) { return `"${value.replaceAll('"', '""')}"`; }
async function isolatedSchema() {
  const admin = new Pool({ connectionString: targetUrl, max: 4 });
  const schema = `m_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${ident(schema)} AUTHORIZATION processai_test`);
  const url = new URL(targetUrl!); url.searchParams.set('options', `-c search_path=${schema}`);
  return { admin, schema, connectionString: url.toString(), dispose: async () => { await admin.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`); await admin.end(); } };
}

async function schemaFingerprint(connectionString: string) {
  const pool = new Pool({ connectionString });
  const schema = (await pool.query('SELECT current_schema() AS name')).rows[0].name;
  const [columns, constraints, indexes] = await Promise.all([
    pool.query('SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,ordinal_position', [schema]),
    pool.query(`SELECT c.relname,con.contype,pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname,con.contype,definition`, [schema]),
    pool.query('SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 ORDER BY indexname', [schema]),
  ]);
  await pool.end();
  return JSON.stringify([columns.rows, constraints.rows, indexes.rows]);
}

async function legacySql() {
  let sql = await readFile(new URL('../migrations/001_conversation_persistence.sql', import.meta.url), 'utf8');
  // Shape emitted by the previous startup DDL: all V2-02C.1 columns except request_hash.
  sql = sql.replace('  request_hash text,\n', '').replace('ALTER TABLE process_ai_generation_runs ADD COLUMN IF NOT EXISTS request_hash text;\n', '');
  return sql;
}

test('M01 banco vazio recebe a migration completa e registra versão somente após verificação', { skip }, async () => {
  const db = await isolatedSchema();
  try {
    const pool = new Pool({ connectionString: db.connectionString });
    const results = await runMigrations(pool);
    assert.equal(results.length, 4); assert.deepEqual(results.map(item => item.version), [1, 2, 3, 4]); assert.equal(results.every(item => item.applied), true);
    const ledger = await pool.query('SELECT version,name,checksum FROM process_ai_schema_migrations ORDER BY version');
    assert.equal(ledger.rows.length, 4); assert.equal(ledger.rows[3].version, 4); assert.equal(ledger.rows.every(row => row.checksum.length === 64), true);
    await pool.end();
  } finally { await db.dispose(); }
});

test('M02 segunda execução é no-op e mantém o fingerprint do schema', { skip }, async () => {
  const db = await isolatedSchema();
  try {
    const pool = new Pool({ connectionString: db.connectionString });
    await runMigrations(pool); const before = await schemaFingerprint(db.connectionString);
    const second = await runMigrations(pool); const after = await schemaFingerprint(db.connectionString);
    assert.equal(second.every(item => !item.applied), true); assert.equal(before, after);
    await pool.end();
  } finally { await db.dispose(); }
});

test('M03 migration reconhece schema legado completo e adiciona hash sem perder dados', { skip }, async () => {
  const db = await isolatedSchema();
  const tenant = `legacy-${crypto.randomUUID()}`; const projectId = crypto.randomUUID(); const sessionId = crypto.randomUUID();
  const messageId = crypto.randomUUID(); const revisionId = crypto.randomUUID(); const runId = crypto.randomUUID();
  try {
    const pool = new Pool({ connectionString: db.connectionString });
    await pool.query(await legacySql());
    await pool.query('INSERT INTO process_ai_projects(id,tenant_id,name,target_profile) VALUES($1,$2,$3,$4)', [projectId, tenant, 'Legacy project', 'generic-bpmn2']);
    await pool.query("INSERT INTO process_ai_sessions(id,tenant_id,project_id,state,pending_questions,confirmed_facts) VALUES($1,$2,$3,'needs-input',$4::jsonb,$5::jsonb)", [sessionId, tenant, projectId, JSON.stringify([{ question: 'Quem aprova?', blocking: true }]), JSON.stringify([{ question: 'Quem aprova?', answer: 'Gestor selecionado pelo operador', confirmedAt: '2026-01-01T00:00:00.000Z', state: 'confirmed' }])]);
    await pool.query("INSERT INTO process_ai_messages(id,tenant_id,session_id,role,content) VALUES($1,$2,$3,'user','Pedido sintético legado')", [messageId, tenant, sessionId]);
    await pool.query("INSERT INTO process_ai_revisions(id,tenant_id,session_id,revision,base_revision,status,process_spec,summary,metadata) VALUES($1,$2,$3,1,0,'accepted',$4::jsonb,'Legacy accepted', '{}'::jsonb)", [revisionId, tenant, sessionId, JSON.stringify({ id: 'legacy-spec' })]);
    await pool.query("INSERT INTO process_ai_generation_runs(id,tenant_id,session_id,status,result,provider,model,operation_id,source_message_id) VALUES($1,$2,$3,'needs-input',$4::jsonb,'test','synthetic','legacy-operation-001',$5)", [runId, tenant, sessionId, JSON.stringify({ kind: 'needs-input' }), messageId]);
    const migrated = await runMigrations(pool);
    assert.equal(migrated[0].applied, true);
    const repo = new PostgresConversationRepository(pool);
    const session = await repo.getSession(tenant, sessionId);
    assert.equal(session?.name, 'Legacy project'); assert.equal(session?.status, 'needs-input');
    assert.deepEqual(session?.pendingQuestions, [{ question: 'Quem aprova?', blocking: true }]);
    assert.equal((await repo.listConfirmedFacts(tenant, sessionId))[0].answer, 'Gestor selecionado pelo operador');
    assert.equal((await repo.listMessages(tenant, sessionId, 10))[0].content, 'Pedido sintético legado');
    assert.equal((await repo.listRevisions(tenant, sessionId))[0].status, 'accepted');
    assert.equal((await repo.getRun(tenant, runId))?.operationId, 'legacy-operation-001');
    await pool.end();
  } finally { await db.dispose(); }
});

test('M04 schema legado incompatível falha sem stamp de versão e registra a falha', { skip }, async () => {
  const db = await isolatedSchema();
  try {
    const pool = new Pool({ connectionString: db.connectionString });
    await pool.query('CREATE TABLE process_ai_projects(id uuid PRIMARY KEY)');
    await assert.rejects(() => runMigrations(pool), /Schema incompatível/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM process_ai_schema_migrations')).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM process_ai_schema_migration_failures')).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='process_ai_sessions'")).rows[0].n, 0, 'DDL da migration foi revertido');
    await pool.end();
  } finally { await db.dispose(); }
});

test('M05 duas execuções concorrentes são serializadas pelo advisory lock', { skip }, async () => {
  const db = await isolatedSchema();
  try {
    const first = new Pool({ connectionString: db.connectionString, max: 1 }); const second = new Pool({ connectionString: db.connectionString, max: 1 });
    const results = await Promise.all([runMigrations(first), runMigrations(second)]);
    assert.equal(results.flat().filter(item => item.applied).length, 4);
    assert.equal((await first.query('SELECT count(*)::int AS n FROM process_ai_schema_migrations')).rows[0].n, 4);
    await first.end(); await second.end();
  } finally { await db.dispose(); }
});

test('M06 runtime consegue persistir com usuário sem privilégios DDL', { skip }, async () => {
  const db = await isolatedSchema();
  const role = `runtime_${randomUUID().replaceAll('-', '')}`; const password = randomUUID().replaceAll('-', '');
  try {
    const admin = new Pool({ connectionString: db.connectionString }); await runMigrations(admin);
    await admin.query(`CREATE ROLE ${ident(role)} LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA ${ident(db.schema)} TO ${ident(role)}`);
    await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${ident(db.schema)} TO ${ident(role)}`);
    await admin.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${ident(db.schema)} TO ${ident(role)}`);
    const privilege = await admin.query('SELECT has_schema_privilege($1,$2,\'CREATE\') AS can_create', [role, db.schema]);
    assert.equal(privilege.rows[0].can_create, false);
    const url = new URL(targetUrl!); url.username = role; url.password = password; url.searchParams.set('options', `-c search_path=${db.schema}`);
    const runtimePool = new Pool({ connectionString: url.toString(), max: 1 });
    const runtimeRepo = new PostgresConversationRepository(runtimePool);
    const created = await runtimeRepo.createProject('m06-tenant', 'Runtime without DDL', 'generic-bpmn2');
    assert.ok(created.sessionId);
    await runtimeRepo.close();
    await admin.query('DROP OWNED BY ' + ident(role)); await admin.query(`DROP ROLE ${ident(role)}`); await admin.end();
  } finally {
    const cleanup = new Pool({ connectionString: targetUrl });
    await cleanup.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND pid<>pg_backend_pid()', [role]).catch(() => undefined);
    await cleanup.query('DROP OWNED BY ' + ident(role)).catch(() => undefined);
    await cleanup.query(`DROP ROLE IF EXISTS ${ident(role)}`).catch(() => undefined);
    await cleanup.end(); await db.dispose();
  }
});

test('M07 runtime rejeita schema incompatível sem alterá-lo', { skip }, async () => {
  const db = await isolatedSchema();
  try {
    const admin = new Pool({ connectionString: db.connectionString });
    await admin.query('CREATE TABLE process_ai_projects(id uuid PRIMARY KEY)');
    const before = await schemaFingerprint(db.connectionString);
    const repo = new PostgresConversationRepository(admin);
    await assert.rejects(() => repo.getSession('tenant', crypto.randomUUID()), ConversationSchemaError);
    const after = await schemaFingerprint(db.connectionString);
    assert.equal(before, after);
    await repo.close();
  } finally { await db.dispose(); }
});

test('M08 migração preserva sessão, perguntas, fatos e revisão recuperáveis via repository', { skip }, async () => {
  const db = await isolatedSchema();
  const tenant = `m08-${crypto.randomUUID()}`; const projectId = crypto.randomUUID(); const sessionId = crypto.randomUUID(); const revisionId = crypto.randomUUID();
  try {
    const pool = new Pool({ connectionString: db.connectionString }); await pool.query(await legacySql());
    await pool.query('INSERT INTO process_ai_projects(id,tenant_id,name,target_profile) VALUES($1,$2,$3,$4)', [projectId, tenant, 'Recovery fixture', 'generic-bpmn2']);
    await pool.query("INSERT INTO process_ai_sessions(id,tenant_id,project_id,state,pending_questions,confirmed_facts,current_revision) VALUES($1,$2,$3,'accepted',$4::jsonb,$5::jsonb,1)", [sessionId, tenant, projectId, JSON.stringify([{ questionId: 'q_legacy', question: 'Quem aprova?', blocking: true }]), JSON.stringify([{ questionId: 'q_legacy', question: 'Quem aprova?', answer: 'Gestor sintético', confirmedAt: '2026-02-01T00:00:00.000Z' }])]);
    await pool.query("INSERT INTO process_ai_revisions(id,tenant_id,session_id,revision,base_revision,status,process_spec,summary,metadata) VALUES($1,$2,$3,1,0,'accepted',$4::jsonb,'Accepted legacy revision', '{}'::jsonb)", [revisionId, tenant, sessionId, JSON.stringify({ id: 'legacy-accepted-process' })]);
    await runMigrations(pool);
    const repo = new PostgresConversationRepository(pool);
    const [session, facts, revisions, currentSpec] = await Promise.all([repo.getSession(tenant, sessionId), repo.listConfirmedFacts(tenant, sessionId), repo.listRevisions(tenant, sessionId), repo.getCurrentSpec(tenant, sessionId)]);
    assert.equal(session?.currentRevision, 1); assert.deepEqual(session?.pendingQuestions, [{ questionId: 'q_legacy', question: 'Quem aprova?', blocking: true }]);
    assert.equal(facts[0].answer, 'Gestor sintético'); assert.equal(revisions[0].status, 'accepted'); assert.deepEqual(currentSpec, { id: 'legacy-accepted-process' });
    await pool.end();
  } finally { await db.dispose(); }
});
