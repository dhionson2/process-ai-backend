import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool | PoolClient, 'query'>;
export class ConversationSchemaError extends Error {
  constructor(message: string) { super(message); this.name = 'ConversationSchemaError'; }
}

const requiredColumns: Record<string, Record<string, string>> = {
  process_ai_projects: { id: 'uuid', tenant_id: 'text', name: 'text', target_profile: 'text', created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone' },
  process_ai_sessions: { id: 'uuid', tenant_id: 'text', project_id: 'uuid', state: 'text', current_revision: 'integer', pending_questions: 'jsonb', confirmed_facts: 'jsonb', version: 'bigint', generation_started_at: 'timestamp with time zone', created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone' },
  process_ai_messages: { id: 'uuid', tenant_id: 'text', session_id: 'uuid', role: 'text', content: 'text', created_at: 'timestamp with time zone' },
  process_ai_revisions: { id: 'uuid', tenant_id: 'text', session_id: 'uuid', revision: 'integer', base_revision: 'integer', status: 'text', process_spec: 'jsonb', artifacts: 'jsonb', summary: 'text', metadata: 'jsonb', created_at: 'timestamp with time zone' },
  process_ai_generation_runs: { id: 'uuid', tenant_id: 'text', session_id: 'uuid', status: 'text', result: 'jsonb', error_code: 'text', provider: 'text', model: 'text', metrics: 'jsonb', operation_id: 'text', request_hash: 'text', source_message_id: 'uuid', created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone' },
};
const requiredNotNull = new Set(['tenant_id','name','target_profile','project_id','state','current_revision','pending_questions','confirmed_facts','version','role','content','revision','base_revision','status','process_spec','summary','metadata','created_at','updated_at']);

export async function assertConversationSchema(db: Queryable, requireMigrationRecord = true, minimumVersion = Number.MAX_SAFE_INTEGER): Promise<void> {
  const schema = (await db.query<{ schema: string }>('SELECT current_schema() AS schema')).rows[0]?.schema;
  if (!schema) throw new ConversationSchemaError('Não há schema PostgreSQL selecionado');
  const columns = await db.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
    `SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2::text[])`,
    [schema, Object.keys(requiredColumns)],
  );
  const available = new Map<string, Map<string, { dataType: string; nullable: string }>>();
  for (const row of columns.rows) { const entries = available.get(row.table_name) || new Map(); entries.set(row.column_name, { dataType: row.data_type, nullable: row.is_nullable }); available.set(row.table_name, entries); }
  const missingColumns = Object.entries(requiredColumns).flatMap(([table, names]) => Object.entries(names).filter(([name]) => !available.get(table)?.has(name)).map(([name]) => `${table}.${name}`));
  if (missingColumns.length) throw new ConversationSchemaError(`Schema incompatível; colunas ausentes: ${missingColumns.join(', ')}`);
  const invalidColumns = Object.entries(requiredColumns).flatMap(([table, names]) => Object.entries(names).flatMap(([name, dataType]) => {
    const actual = available.get(table)!.get(name)!;
    return actual.dataType !== dataType || (requiredNotNull.has(name) && actual.nullable !== 'NO') ? [`${table}.${name} esperado ${dataType}${requiredNotNull.has(name) ? ' NOT NULL' : ''}, atual ${actual.dataType}${actual.nullable === 'YES' ? ' NULL' : ' NOT NULL'}`] : [];
  }));
  if (invalidColumns.length) throw new ConversationSchemaError(`Schema incompatível; definição de colunas divergente: ${invalidColumns.join(', ')}`);
  if (minimumVersion >= 3) {
    const v3 = await db.query<{ table_name: string; column_name: string }>(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2::text[])`, [schema, ['process_ai_requirements', 'process_ai_accepted_examples']]);
    const present = new Set(v3.rows.map(row => `${row.table_name}.${row.column_name}`));
    const expected = ['process_ai_requirements.state', 'process_ai_requirements.origin', 'process_ai_requirements.last_revision', 'process_ai_accepted_examples.request_text', 'process_ai_accepted_examples.summary'];
    const missing = expected.filter(name => !present.has(name));
    if (missing.length) throw new ConversationSchemaError(`Schema incompatível; migration V3 ausente (${missing.join(', ')}); execute npm run db:migrate`);
  }
  if (minimumVersion >= 2) {
    const providerBoundary = await db.query<{ data_type: string; is_nullable: string }>(`SELECT data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='process_ai_generation_runs' AND column_name='provider_started_at'`, [schema]);
    if (providerBoundary.rows[0]?.data_type !== 'timestamp with time zone' || providerBoundary.rows[0]?.is_nullable !== 'YES') throw new ConversationSchemaError('Schema incompatível; process_ai_generation_runs.provider_started_at ausente ou inválida');
  }

  const constraints = await db.query<{ table_name: string; type: string; definition: string }>(
    `SELECT c.relname AS table_name,con.contype AS type,pg_get_constraintdef(con.oid) AS definition
     FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1`, [schema],
  );
  const defs = constraints.rows;
  const normalized = (definition: string) => definition.replaceAll('"', '').replace(/\s+/g, '').toLowerCase();
  const has = (table: string, type: string, expected: string) => defs.some(item => item.table_name === table && item.type === type && normalized(item.definition) === normalized(expected));
  for (const table of Object.keys(requiredColumns)) if (!has(table, 'p', 'PRIMARY KEY (id)')) throw new ConversationSchemaError(`Schema incompatível; falta primary key em ${table}`);
  if (!has('process_ai_projects', 'u', 'UNIQUE (tenant_id, id)') || !has('process_ai_sessions', 'u', 'UNIQUE (tenant_id, id)') || !has('process_ai_revisions', 'u', 'UNIQUE (tenant_id, session_id, revision)')) throw new ConversationSchemaError('Schema incompatível; constraints únicas de tenant/revisão ausentes');
  const fkPairs = [['process_ai_sessions','FOREIGN KEY (project_id) REFERENCES process_ai_projects(id)'],['process_ai_messages','FOREIGN KEY (session_id) REFERENCES process_ai_sessions(id)'],['process_ai_revisions','FOREIGN KEY (session_id) REFERENCES process_ai_sessions(id)'],['process_ai_generation_runs','FOREIGN KEY (session_id) REFERENCES process_ai_sessions(id)']];
  for (const [table, definition] of fkPairs) if (!has(table, 'f', definition)) throw new ConversationSchemaError(`Schema incompatível; foreign key inválida em ${table}`);
  const messageRoleConstraint = defs.some(item => item.table_name === 'process_ai_messages' && item.type === 'c' && item.definition.includes('role') && item.definition.includes('user') && item.definition.includes('assistant'));
  const revisionStatusConstraint = defs.some(item => item.table_name === 'process_ai_revisions' && item.type === 'c' && item.definition.includes('status') && item.definition.includes('proposed') && item.definition.includes('accepted'));
  if (!messageRoleConstraint || !revisionStatusConstraint) throw new ConversationSchemaError('Schema incompatível; constraints de domínio ausentes');

  const indexes = await db.query<{ indexname: string; indexdef: string }>(`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1`, [schema]);
  const indexDefs = new Map(indexes.rows.map(index => [index.indexname, index.indexdef]));
  const messagesIndex = indexDefs.get('process_ai_messages_session_idx');
  const operationsIndex = indexDefs.get('process_ai_generation_operation_idx');
  if (!messagesIndex?.includes('(tenant_id, session_id, created_at)')) throw new ConversationSchemaError('Schema incompatível; índice de mensagens ausente');
  if (!operationsIndex?.includes('UNIQUE') || !operationsIndex.includes('(tenant_id, session_id, operation_id)') || !operationsIndex.includes('operation_id IS NOT NULL')) throw new ConversationSchemaError('Schema incompatível; índice idempotente ausente ou incorreto');

  if (requireMigrationRecord) {
    const ledger = await db.query<{ exists: boolean }>(`SELECT to_regclass(format('%I.process_ai_schema_migrations',$1::text)) IS NOT NULL AS exists`, [schema]);
    if (!ledger.rows[0]?.exists) throw new ConversationSchemaError('Migrations ausentes; execute npm run db:migrate explicitamente');
    const applied = await db.query<{ version: number }>('SELECT version FROM process_ai_schema_migrations ORDER BY version DESC LIMIT 1');
    if (Number(applied.rows[0]?.version) < 3) throw new ConversationSchemaError('Schema sem a migration V3 (ledger de requisitos e exemplos aceitos); execute npm run db:migrate');
  }
}
