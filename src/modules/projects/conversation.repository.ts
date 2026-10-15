import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

export type ProjectTarget = 'generic-bpmn2' | 'flowable-oss' | 'unique-future';
export type ChatRole = 'user' | 'assistant';
export type ProjectCreated = { projectId: string; sessionId: string };
export type ConversationSession = { id: string; projectId: string; name: string; targetProfile: ProjectTarget; status: string; currentRevision: number; pendingQuestions: unknown[]; createdAt: string };
export type StoredMessage = { id: string; role: ChatRole; content: string; createdAt: string };
export type ConfirmedFact = { question: string; answer: string; confirmedAt: string };
export type RunStatus = 'queued' | 'generating' | 'needs-input' | 'validated' | 'validation-failed' | 'failed';
export type GenerationRun = { id: string; sessionId: string; status: RunStatus; result?: unknown; errorCode?: string; provider?: string; model?: string; metrics?: unknown; createdAt: string; updatedAt: string };
export type StoredRevision = { id: string; sessionId: string; revision: number; baseRevision: number; status: 'proposed' | 'accepted'; processSpec: Record<string, unknown>; artifacts?: unknown; summary: string; metadata: Record<string, unknown>; createdAt: string };

export class RevisionConflict extends Error { constructor() { super('A revisão base não é mais a revisão atual'); this.name = 'RevisionConflict'; } }
export class ConversationNotFound extends Error { constructor() { super('Conversa não encontrada'); this.name = 'ConversationNotFound'; } }

export interface ConversationRepository {
  createProject(tenantId: string, name: string, targetProfile: ProjectTarget): Promise<ProjectCreated>;
  getSession(tenantId: string, sessionId: string): Promise<ConversationSession | undefined>;
  getCurrentSpec(tenantId: string, sessionId: string): Promise<Record<string, unknown> | undefined>;
  setPendingQuestions(tenantId: string, sessionId: string, questions: unknown[]): Promise<void>;
  setSessionStatus(tenantId: string, sessionId: string, status: string): Promise<void>;
  appendMessage(tenantId: string, sessionId: string, role: ChatRole, content: string): Promise<StoredMessage>;
  listMessages(tenantId: string, sessionId: string, limit: number): Promise<StoredMessage[]>;
  appendConfirmedFacts(tenantId: string, sessionId: string, facts: ConfirmedFact[]): Promise<void>;
  listConfirmedFacts(tenantId: string, sessionId: string): Promise<ConfirmedFact[]>;
  createRun(tenantId: string, sessionId: string, provider: string, model: string): Promise<GenerationRun>;
  updateRun(tenantId: string, runId: string, patch: Partial<GenerationRun>): Promise<void>;
  getRun(tenantId: string, runId: string): Promise<GenerationRun | undefined>;
  createProposal(tenantId: string, sessionId: string, baseRevision: number, processSpec: Record<string, unknown>, artifacts: unknown, summary: string, metadata: Record<string, unknown>): Promise<StoredRevision>;
  listRevisions(tenantId: string, sessionId: string): Promise<StoredRevision[]>;
  acceptRevision(tenantId: string, sessionId: string, revision: number, baseRevision: number): Promise<StoredRevision>;
}

const schemaSql = `
CREATE TABLE IF NOT EXISTS process_ai_projects (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL, target_profile text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS process_ai_sessions (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, project_id uuid NOT NULL REFERENCES process_ai_projects(id),
  state text NOT NULL DEFAULT 'draft', current_revision integer NOT NULL DEFAULT 0, pending_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  confirmed_facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, id)
);
ALTER TABLE process_ai_sessions ADD COLUMN IF NOT EXISTS confirmed_facts jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE IF NOT EXISTS process_ai_messages (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, session_id uuid NOT NULL REFERENCES process_ai_sessions(id),
  role text NOT NULL CHECK (role IN ('user','assistant')), content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS process_ai_messages_session_idx ON process_ai_messages(tenant_id, session_id, created_at);
CREATE TABLE IF NOT EXISTS process_ai_revisions (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, session_id uuid NOT NULL REFERENCES process_ai_sessions(id),
  revision integer NOT NULL, base_revision integer NOT NULL, status text NOT NULL CHECK(status IN ('proposed','accepted')),
  process_spec jsonb NOT NULL, artifacts jsonb, summary text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id, session_id, revision)
);
CREATE TABLE IF NOT EXISTS process_ai_generation_runs (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, session_id uuid NOT NULL REFERENCES process_ai_sessions(id),
  status text NOT NULL, result jsonb, error_code text, provider text, model text, metrics jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
`;

function sessionRow(row: any): ConversationSession {
  return { id: row.id, projectId: row.project_id, name: row.name, targetProfile: row.target_profile, status: row.state, currentRevision: row.current_revision, pendingQuestions: row.pending_questions, createdAt: new Date(row.created_at).toISOString() };
}
function messageRow(row: any): StoredMessage { return { id: row.id, role: row.role, content: row.content, createdAt: new Date(row.created_at).toISOString() }; }
function runRow(row: any): GenerationRun { return { id: row.id, sessionId: row.session_id, status: row.status, result: row.result ?? undefined, errorCode: row.error_code ?? undefined, provider: row.provider ?? undefined, model: row.model ?? undefined, metrics: row.metrics ?? undefined, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }; }
function revisionRow(row: any): StoredRevision { return { id: row.id, sessionId: row.session_id, revision: row.revision, baseRevision: row.base_revision, status: row.status, processSpec: row.process_spec, artifacts: row.artifacts ?? undefined, summary: row.summary, metadata: row.metadata, createdAt: new Date(row.created_at).toISOString() }; }

export class PostgresConversationRepository implements ConversationRepository {
  private initialized?: Promise<void>;
  constructor(private readonly pool: Pool) {}
  static fromConnectionString(connectionString: string): PostgresConversationRepository { return new PostgresConversationRepository(new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 })); }
  async close(): Promise<void> { await this.pool.end(); }
  private init(): Promise<void> { this.initialized ||= this.pool.query(schemaSql).then(() => undefined); return this.initialized; }
  private async query<T extends Record<string, any> = Record<string, any>>(sql: string, values: unknown[] = []) { await this.init(); return this.pool.query<T>(sql, values); }

  async createProject(tenantId: string, name: string, targetProfile: ProjectTarget): Promise<ProjectCreated> {
    await this.init();
    const client = await this.pool.connect();
    const projectId = randomUUID(); const sessionId = randomUUID();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO process_ai_projects(id,tenant_id,name,target_profile) VALUES($1,$2,$3,$4)', [projectId, tenantId, name, targetProfile]);
      await client.query('INSERT INTO process_ai_sessions(id,tenant_id,project_id) VALUES($1,$2,$3)', [sessionId, tenantId, projectId]);
      await client.query('COMMIT');
      return { projectId, sessionId };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async getSession(tenantId: string, sessionId: string): Promise<ConversationSession | undefined> {
    const result = await this.query('SELECT s.*,p.name,p.target_profile FROM process_ai_sessions s JOIN process_ai_projects p ON p.id=s.project_id AND p.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.id=$2', [tenantId, sessionId]);
    return result.rows[0] ? sessionRow(result.rows[0]) : undefined;
  }
  async getCurrentSpec(tenantId: string, sessionId: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.query('SELECT r.process_spec FROM process_ai_sessions s JOIN process_ai_revisions r ON r.tenant_id=s.tenant_id AND r.session_id=s.id AND r.revision=s.current_revision WHERE s.tenant_id=$1 AND s.id=$2 AND r.status=$3', [tenantId, sessionId, 'accepted']);
    return result.rows[0]?.process_spec;
  }
  async setPendingQuestions(tenantId: string, sessionId: string, questions: unknown[]): Promise<void> {
    const result = await this.query('UPDATE process_ai_sessions SET pending_questions=$3::jsonb,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id', [tenantId, sessionId, JSON.stringify(questions)]);
    if (!result.rowCount) throw new ConversationNotFound();
  }
  async setSessionStatus(tenantId: string, sessionId: string, status: string): Promise<void> {
    const result = await this.query('UPDATE process_ai_sessions SET state=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id', [tenantId, sessionId, status]);
    if (!result.rowCount) throw new ConversationNotFound();
  }
  async appendMessage(tenantId: string, sessionId: string, role: ChatRole, content: string): Promise<StoredMessage> {
    const result = await this.query('INSERT INTO process_ai_messages(id,tenant_id,session_id,role,content) SELECT $1,$2,s.id,$4,$5 FROM process_ai_sessions s WHERE s.tenant_id=$2 AND s.id=$3 RETURNING *', [randomUUID(), tenantId, sessionId, role, content]);
    if (!result.rows[0]) throw new ConversationNotFound();
    return messageRow(result.rows[0]);
  }
  async listMessages(tenantId: string, sessionId: string, limit: number): Promise<StoredMessage[]> {
    const result = await this.query('SELECT * FROM (SELECT * FROM process_ai_messages WHERE tenant_id=$1 AND session_id=$2 ORDER BY created_at DESC LIMIT $3) m ORDER BY created_at ASC', [tenantId, sessionId, limit]);
    return result.rows.map(messageRow);
  }
  async appendConfirmedFacts(tenantId: string, sessionId: string, facts: ConfirmedFact[]): Promise<void> {
    if (!facts.length) return;
    const result = await this.query('UPDATE process_ai_sessions SET confirmed_facts=confirmed_facts || $3::jsonb,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id', [tenantId, sessionId, JSON.stringify(facts)]);
    if (!result.rowCount) throw new ConversationNotFound();
  }
  async listConfirmedFacts(tenantId: string, sessionId: string): Promise<ConfirmedFact[]> {
    const result = await this.query('SELECT confirmed_facts FROM process_ai_sessions WHERE tenant_id=$1 AND id=$2', [tenantId, sessionId]);
    if (!result.rows[0]) throw new ConversationNotFound();
    return result.rows[0].confirmed_facts || [];
  }
  async createRun(tenantId: string, sessionId: string, provider: string, model: string): Promise<GenerationRun> {
    const result = await this.query("INSERT INTO process_ai_generation_runs(id,tenant_id,session_id,status,provider,model) SELECT $1,$2,s.id,'queued',$4,$5 FROM process_ai_sessions s WHERE s.tenant_id=$2 AND s.id=$3 RETURNING *", [randomUUID(), tenantId, sessionId, provider, model]);
    if (!result.rows[0]) throw new ConversationNotFound();
    return runRow(result.rows[0]);
  }
  async updateRun(tenantId: string, runId: string, patch: Partial<GenerationRun>): Promise<void> {
    const result = await this.query('UPDATE process_ai_generation_runs SET status=COALESCE($3,status),result=COALESCE($4::jsonb,result),error_code=COALESCE($5,error_code),metrics=COALESCE($6::jsonb,metrics),updated_at=now() WHERE tenant_id=$1 AND id=$2', [tenantId, runId, patch.status ?? null, patch.result === undefined ? null : JSON.stringify(patch.result), patch.errorCode ?? null, patch.metrics === undefined ? null : JSON.stringify(patch.metrics)]);
    if (!result.rowCount) throw new ConversationNotFound();
  }
  async getRun(tenantId: string, runId: string): Promise<GenerationRun | undefined> {
    const result = await this.query('SELECT * FROM process_ai_generation_runs WHERE tenant_id=$1 AND id=$2', [tenantId, runId]);
    return result.rows[0] ? runRow(result.rows[0]) : undefined;
  }
  async createProposal(tenantId: string, sessionId: string, baseRevision: number, processSpec: Record<string, unknown>, artifacts: unknown, summary: string, metadata: Record<string, unknown>): Promise<StoredRevision> {
    await this.init(); const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query('SELECT current_revision FROM process_ai_sessions WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, sessionId]);
      if (!session.rows[0]) throw new ConversationNotFound();
      if (session.rows[0].current_revision !== baseRevision) throw new RevisionConflict();
      const next = await client.query('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM process_ai_revisions WHERE tenant_id=$1 AND session_id=$2', [tenantId, sessionId]);
      const result = await client.query('INSERT INTO process_ai_revisions(id,tenant_id,session_id,revision,base_revision,status,process_spec,artifacts,summary,metadata) VALUES($1,$2,$3,$4,$5,\'proposed\',$6::jsonb,$7::jsonb,$8,$9::jsonb) RETURNING *', [randomUUID(), tenantId, sessionId, next.rows[0].revision, baseRevision, JSON.stringify(processSpec), JSON.stringify(artifacts), summary, JSON.stringify(metadata)]);
      await client.query('COMMIT'); return revisionRow(result.rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async listRevisions(tenantId: string, sessionId: string): Promise<StoredRevision[]> {
    const result = await this.query('SELECT * FROM process_ai_revisions WHERE tenant_id=$1 AND session_id=$2 ORDER BY revision DESC', [tenantId, sessionId]);
    return result.rows.map(revisionRow);
  }
  async acceptRevision(tenantId: string, sessionId: string, revision: number, baseRevision: number): Promise<StoredRevision> {
    await this.init(); const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query('SELECT current_revision FROM process_ai_sessions WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, sessionId]);
      if (!session.rows[0]) throw new ConversationNotFound();
      if (session.rows[0].current_revision !== baseRevision) throw new RevisionConflict();
      const result = await client.query("UPDATE process_ai_revisions SET status='accepted' WHERE tenant_id=$1 AND session_id=$2 AND revision=$3 AND base_revision=$4 AND status='proposed' RETURNING *", [tenantId, sessionId, revision, baseRevision]);
      if (!result.rows[0]) throw new ConversationNotFound();
      await client.query("UPDATE process_ai_sessions SET current_revision=$3,pending_questions='[]'::jsonb,state='accepted',updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, sessionId, revision]);
      await client.query('COMMIT'); return revisionRow(result.rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}

export class InMemoryConversationRepository implements ConversationRepository {
  private sessions = new Map<string, ConversationSession>();
  private sessionTenants = new Map<string, string>();
  private messages = new Map<string, StoredMessage[]>();
  private runs = new Map<string, GenerationRun>();
  private runTenants = new Map<string, string>();
  private revisions = new Map<string, StoredRevision[]>();
  private specs = new Map<string, Record<string, unknown>>();
  private confirmedFacts = new Map<string, ConfirmedFact[]>();
  async createProject(tenant: string, name: string, targetProfile: ProjectTarget): Promise<ProjectCreated> {
    const projectId = randomUUID(); const sessionId = randomUUID();
    this.sessions.set(sessionId, { id: sessionId, projectId, name, targetProfile, status: 'draft', currentRevision: 0, pendingQuestions: [], createdAt: new Date().toISOString() });
    this.sessionTenants.set(sessionId, tenant);
    return { projectId, sessionId };
  }
  async getSession(tenant: string, sessionId: string) { return this.owns(tenant, sessionId) ? this.sessions.get(sessionId) : undefined; }
  async getCurrentSpec(tenant: string, sessionId: string) { return this.owns(tenant, sessionId) ? this.specs.get(sessionId) : undefined; }
  async setPendingQuestions(tenant: string, sessionId: string, questions: unknown[]) { const session = this.owns(tenant, sessionId) ? this.sessions.get(sessionId) : undefined; if (!session) throw new ConversationNotFound(); session.pendingQuestions = questions; }
  async setSessionStatus(tenant: string, sessionId: string, status: string) { const session = this.owns(tenant, sessionId) ? this.sessions.get(sessionId) : undefined; if (!session) throw new ConversationNotFound(); session.status = status; }
  async appendMessage(tenant: string, sessionId: string, role: ChatRole, content: string) {
    if (!this.owns(tenant, sessionId)) throw new ConversationNotFound();
    const message = { id: randomUUID(), role, content, createdAt: new Date().toISOString() }; this.messages.set(sessionId, [...(this.messages.get(sessionId) || []), message]); return message;
  }
  async listMessages(tenant: string, sessionId: string, limit: number) { if (!this.owns(tenant, sessionId)) throw new ConversationNotFound(); return (this.messages.get(sessionId) || []).slice(-limit); }
  async appendConfirmedFacts(tenant: string, sessionId: string, facts: ConfirmedFact[]) { if (!this.owns(tenant, sessionId)) throw new ConversationNotFound(); this.confirmedFacts.set(sessionId, [...(this.confirmedFacts.get(sessionId) || []), ...facts]); }
  async listConfirmedFacts(tenant: string, sessionId: string) { if (!this.owns(tenant, sessionId)) throw new ConversationNotFound(); return [...(this.confirmedFacts.get(sessionId) || [])]; }
  async createRun(tenant: string, sessionId: string, provider: string, model: string) {
    if (!this.owns(tenant, sessionId)) throw new ConversationNotFound();
    const now = new Date().toISOString(); const run: GenerationRun = { id: randomUUID(), sessionId, status: 'queued', provider, model, createdAt: now, updatedAt: now }; this.runs.set(run.id, run); this.runTenants.set(run.id, tenant); return run;
  }
  async updateRun(tenant: string, runId: string, patch: Partial<GenerationRun>) { const run = this.runTenants.get(runId) === tenant ? this.runs.get(runId) : undefined; if (!run) throw new ConversationNotFound(); this.runs.set(runId, { ...run, ...patch, updatedAt: new Date().toISOString() }); }
  async getRun(tenant: string, runId: string) { return this.runTenants.get(runId) === tenant ? this.runs.get(runId) : undefined; }
  async createProposal(tenant: string, sessionId: string, baseRevision: number, processSpec: Record<string, unknown>, artifacts: unknown, summary: string, metadata: Record<string, unknown>) {
    const session = this.owns(tenant, sessionId) ? this.sessions.get(sessionId) : undefined; if (!session) throw new ConversationNotFound(); if (session.currentRevision !== baseRevision) throw new RevisionConflict();
    const items = this.revisions.get(sessionId) || []; const revision: StoredRevision = { id: randomUUID(), sessionId, revision: Math.max(0, ...items.map(x => x.revision)) + 1, baseRevision, status: 'proposed', processSpec, artifacts, summary, metadata, createdAt: new Date().toISOString() }; items.push(revision); this.revisions.set(sessionId, items); return revision;
  }
  async listRevisions(tenant: string, sessionId: string) { if (!this.owns(tenant, sessionId)) throw new ConversationNotFound(); return [...(this.revisions.get(sessionId) || [])].sort((a,b) => b.revision-a.revision); }
  async acceptRevision(tenant: string, sessionId: string, revision: number, baseRevision: number) {
    const session = this.owns(tenant, sessionId) ? this.sessions.get(sessionId) : undefined; if (!session) throw new ConversationNotFound(); if (session.currentRevision !== baseRevision) throw new RevisionConflict();
    const item = (this.revisions.get(sessionId) || []).find(x => x.revision === revision && x.baseRevision === baseRevision && x.status === 'proposed'); if (!item) throw new ConversationNotFound();
    item.status = 'accepted'; session.currentRevision = revision; session.pendingQuestions = []; session.status = 'accepted'; this.specs.set(sessionId, item.processSpec); return item;
  }
  private owns(tenant: string, sessionId: string) { return this.sessionTenants.get(sessionId) === tenant; }
}
