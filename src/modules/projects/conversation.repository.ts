import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { SemanticFact } from '../ai/semantic-grounding.js';
import { assertConversationSchema } from './schema-verification.js';

export type ProjectTarget = 'generic-bpmn2' | 'flowable-oss' | 'unique-future';
export type ChatRole = 'user' | 'assistant';
export type ProjectCreated = { projectId: string; sessionId: string };
export type ConversationSession = { id: string; projectId: string; name: string; targetProfile: ProjectTarget; status: string; currentRevision: number; version: number; pendingQuestions: unknown[]; createdAt: string };
export type StoredMessage = { id: string; role: ChatRole; content: string; createdAt: string };
export type ConfirmedFact = { question: string; answer: string; confirmedAt: string; answeredAt?: string; questionId?: string; requirementId?: string; semanticSlot?: string; semanticFactId?: string; sourceId?: string; questionStatus?: 'answered'; state?: 'confirmed' | 'superseded' | 'contradictory' | 'removed'; supersedesFactId?: string; semanticFact?: SemanticFact };
export type RequirementKind = 'actor' | 'activity' | 'decision' | 'field';
export type RequirementOrigin = 'user' | 'confirmed-answer' | 'inference' | 'unknown';
export type RequirementVerdict = 'proposed' | 'confirmed' | 'rejected';
export type StoredRequirement = { id: string; sessionId: string; kind: RequirementKind; label: string; origin: RequirementOrigin; state: RequirementVerdict; firstRevision: number; lastRevision: number; createdAt: string; updatedAt: string };
export type AcceptedExample = { sessionId: string; revision: number; requestText: string; summary: string };
export type RunStatus = 'queued' | 'generating' | 'needs-input' | 'validated' | 'validation-failed' | 'failed';
export type GenerationRun = { id: string; sessionId: string; status: RunStatus; operationId?: string; requestHash?: string; providerStartedAt?: string; sourceMessageId?: string; result?: unknown; errorCode?: string; provider?: string; model?: string; metrics?: unknown; createdAt: string; updatedAt: string };
export type StoredRevision = { id: string; sessionId: string; revision: number; baseRevision: number; status: 'proposed' | 'accepted'; processSpec: Record<string, unknown>; artifacts?: unknown; summary: string; metadata: Record<string, unknown>; createdAt: string };

export class RevisionConflict extends Error { constructor() { super('A revisão base não é mais a revisão atual'); this.name = 'RevisionConflict'; } }
export class ConversationNotFound extends Error { constructor() { super('Conversa não encontrada'); this.name = 'ConversationNotFound'; } }
export class StaleQuestionSet extends Error { constructor() { super('O conjunto de perguntas não corresponde mais à sessão'); this.name = 'StaleQuestionSet'; } }
export class OperationConflict extends Error { constructor() { super('operationId já foi usado com outro payload ou sem hash verificável'); this.name = 'OperationConflict'; } }
export type BeginTurnInput = { operationId?: string; requestHash?: string; baseRevision: number; role: ChatRole; content: string; facts?: ConfirmedFact[]; expectedQuestionSetId?: string };
export type BeginTurnResult = { session: ConversationSession; message: StoredMessage; run: GenerationRun; replay: boolean };
export type TurnOutcomeInput = { status: 'needs-input' | 'validation-failed' | 'failed' | 'review-required'; questions?: unknown[]; assistantMessage?: string; proposal?: { processSpec: Record<string, unknown>; artifacts: unknown; summary: string; metadata: Record<string, unknown>; baseRevision: number }; runPatch: Partial<GenerationRun> };

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
  listRuns(tenantId: string, sessionId: string): Promise<GenerationRun[]>;
  /** Upserts the business items of a revision; the requester's verdict (state) is never overwritten. */
  syncRequirements(tenantId: string, sessionId: string, revision: number, items: Array<{ kind: RequirementKind; label: string; origin: RequirementOrigin }>): Promise<void>;
  listRequirements(tenantId: string, sessionId: string): Promise<StoredRequirement[]>;
  setRequirementState(tenantId: string, sessionId: string, requirementId: string, state: RequirementVerdict): Promise<StoredRequirement>;
  saveAcceptedExample(tenantId: string, sessionId: string, revision: number, requestText: string, summary: string): Promise<void>;
  listAcceptedExamples(tenantId: string, limit: number): Promise<AcceptedExample[]>;
  getOperation(tenantId: string, sessionId: string, operationId: string, requestHash: string): Promise<GenerationRun | undefined>;
  markProviderStarted(tenantId: string, runId: string): Promise<void>;
  createProposal(tenantId: string, sessionId: string, baseRevision: number, processSpec: Record<string, unknown>, artifacts: unknown, summary: string, metadata: Record<string, unknown>): Promise<StoredRevision>;
  listRevisions(tenantId: string, sessionId: string): Promise<StoredRevision[]>;
  acceptRevision(tenantId: string, sessionId: string, revision: number, baseRevision: number): Promise<StoredRevision>;
  beginTurn(tenantId: string, sessionId: string, input: BeginTurnInput, provider: string, model: string): Promise<BeginTurnResult>;
  completeTurn(tenantId: string, sessionId: string, runId: string, outcome: TurnOutcomeInput): Promise<void>;
  reconcileInterruptedRuns(tenantId: string, sessionId: string, olderThanMs?: number): Promise<number>;
}

function sessionRow(row: any): ConversationSession {
  return { id: row.id, projectId: row.project_id, name: row.name, targetProfile: row.target_profile, status: row.state, currentRevision: row.current_revision, version: Number(row.version || 0), pendingQuestions: row.pending_questions, createdAt: new Date(row.created_at).toISOString() };
}
function messageRow(row: any): StoredMessage { return { id: row.id, role: row.role, content: row.content, createdAt: new Date(row.created_at).toISOString() }; }
function runRow(row: any): GenerationRun { return { id: row.id, sessionId: row.session_id, status: row.status, operationId: row.operation_id ?? undefined, requestHash: row.request_hash ?? undefined, providerStartedAt: row.provider_started_at ? new Date(row.provider_started_at).toISOString() : undefined, sourceMessageId: row.source_message_id ?? undefined, result: row.result ?? undefined, errorCode: row.error_code ?? undefined, provider: row.provider ?? undefined, model: row.model ?? undefined, metrics: row.metrics ?? undefined, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }; }
function requirementRow(row: any): StoredRequirement { return { id: row.id, sessionId: row.session_id, kind: row.kind, label: row.label, origin: row.origin, state: row.state, firstRevision: row.first_revision, lastRevision: row.last_revision, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }; }
function revisionRow(row: any): StoredRevision { return { id: row.id, sessionId: row.session_id, revision: row.revision, baseRevision: row.base_revision, status: row.status, processSpec: row.process_spec, artifacts: row.artifacts ?? undefined, summary: row.summary, metadata: row.metadata, createdAt: new Date(row.created_at).toISOString() }; }
function questionSetId(value: unknown[]): string { const questions = value.map((item: any) => ({ questionId: item?.questionId || item?.id || null, requirementId: item?.requirementId || null, semanticSlot: item?.semanticSlot || null, question: item?.question || null })); return `qs_${createHash('sha256').update(JSON.stringify(questions)).digest('hex').slice(0, 24)}`; }

export class PostgresConversationRepository implements ConversationRepository {
  private initialized?: Promise<void>;
  constructor(private readonly pool: Pool) {}
  static fromConnectionString(connectionString: string): PostgresConversationRepository { return new PostgresConversationRepository(new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 })); }
  async close(): Promise<void> { await this.pool.end(); }
  private init(): Promise<void> { this.initialized ||= assertConversationSchema(this.pool); return this.initialized; }
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
  async listRuns(tenantId: string, sessionId: string): Promise<GenerationRun[]> {
    const result = await this.query('SELECT * FROM process_ai_generation_runs WHERE tenant_id=$1 AND session_id=$2 ORDER BY created_at, id', [tenantId, sessionId]);
    return result.rows.map(runRow);
  }
  async syncRequirements(tenantId: string, sessionId: string, revision: number, items: Array<{ kind: RequirementKind; label: string; origin: RequirementOrigin }>): Promise<void> {
    for (const item of items) {
      // A stated origin (user/confirmed answer) is never downgraded back to an inference.
      await this.query(`INSERT INTO process_ai_requirements(id,tenant_id,session_id,kind,label,origin,first_revision,last_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$7)
        ON CONFLICT (tenant_id,session_id,kind,label) DO UPDATE SET last_revision=GREATEST(process_ai_requirements.last_revision,EXCLUDED.last_revision),
        origin=CASE WHEN process_ai_requirements.origin IN ('user','confirmed-answer') THEN process_ai_requirements.origin ELSE EXCLUDED.origin END, updated_at=now()`,
        [randomUUID(), tenantId, sessionId, item.kind, item.label, item.origin, revision]);
    }
  }
  async listRequirements(tenantId: string, sessionId: string): Promise<StoredRequirement[]> {
    const result = await this.query('SELECT * FROM process_ai_requirements WHERE tenant_id=$1 AND session_id=$2 ORDER BY first_revision, created_at, label', [tenantId, sessionId]);
    return result.rows.map(requirementRow);
  }
  async setRequirementState(tenantId: string, sessionId: string, requirementId: string, state: RequirementVerdict): Promise<StoredRequirement> {
    const result = await this.query('UPDATE process_ai_requirements SET state=$4, updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND id=$3 RETURNING *', [tenantId, sessionId, requirementId, state]);
    if (!result.rows[0]) throw new ConversationNotFound();
    return requirementRow(result.rows[0]);
  }
  async saveAcceptedExample(tenantId: string, sessionId: string, revision: number, requestText: string, summary: string): Promise<void> {
    await this.query('INSERT INTO process_ai_accepted_examples(id,tenant_id,session_id,revision,request_text,summary) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,session_id,revision) DO NOTHING', [randomUUID(), tenantId, sessionId, revision, requestText, summary]);
  }
  async listAcceptedExamples(tenantId: string, limit: number): Promise<AcceptedExample[]> {
    const result = await this.query('SELECT session_id,revision,request_text,summary FROM process_ai_accepted_examples WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2', [tenantId, limit]);
    return result.rows.map(row => ({ sessionId: row.session_id, revision: row.revision, requestText: row.request_text, summary: row.summary }));
  }
  async getOperation(tenantId: string, sessionId: string, operationId: string, requestHash: string): Promise<GenerationRun | undefined> {
    const result = await this.query('SELECT * FROM process_ai_generation_runs WHERE tenant_id=$1 AND session_id=$2 AND operation_id=$3', [tenantId, sessionId, operationId]);
    if (!result.rows[0]) return undefined;
    const run = runRow(result.rows[0]);
    if (!run.requestHash || run.requestHash !== requestHash) throw new OperationConflict();
    if (run.status === 'failed' && !run.providerStartedAt) return undefined;
    return run;
  }
  async markProviderStarted(tenantId: string, runId: string): Promise<void> {
    const result = await this.query('UPDATE process_ai_generation_runs SET provider_started_at=COALESCE(provider_started_at,now()),updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN (\'generating\',\'queued\') RETURNING provider_started_at', [tenantId, runId]);
    if (!result.rowCount) throw new ConversationNotFound();
  }
  async beginTurn(tenantId: string, sessionId: string, input: BeginTurnInput, provider: string, model: string): Promise<BeginTurnResult> {
    await this.init(); const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT s.*,p.name,p.target_profile FROM process_ai_sessions s JOIN process_ai_projects p ON p.id=s.project_id AND p.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.id=$2 FOR UPDATE OF s', [tenantId, sessionId]);
      if (!locked.rows[0]) throw new ConversationNotFound();
      const before = sessionRow(locked.rows[0]);
      if (input.operationId) {
        const prior = await client.query('SELECT * FROM process_ai_generation_runs WHERE tenant_id=$1 AND session_id=$2 AND operation_id=$3', [tenantId, sessionId, input.operationId]);
        if (prior.rows[0]) {
          const run = runRow(prior.rows[0]);
          const expectedHash = input.requestHash || createHash('sha256').update(JSON.stringify({ baseRevision: input.baseRevision, role: input.role, content: input.content, facts: input.facts || [], expectedQuestionSetId: input.expectedQuestionSetId || null })).digest('hex');
          if (!run.requestHash || run.requestHash !== expectedHash) throw new OperationConflict();
          const messageResult = await client.query('SELECT * FROM process_ai_messages WHERE tenant_id=$1 AND session_id=$2 AND id=$3', [tenantId, sessionId, run.sourceMessageId]);
          if (!messageResult.rows[0]) throw new ConversationNotFound();
          if (run.status === 'failed' && !run.providerStartedAt) {
            if (before.currentRevision !== input.baseRevision) throw new RevisionConflict();
            await client.query("UPDATE process_ai_generation_runs SET status='generating',result=NULL,error_code=NULL,metrics=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, run.id]);
            await client.query("UPDATE process_ai_sessions SET state='generating',generation_started_at=now(),version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, sessionId]);
            const current = await client.query('SELECT s.*,p.name,p.target_profile FROM process_ai_sessions s JOIN process_ai_projects p ON p.id=s.project_id AND p.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.id=$2', [tenantId, sessionId]);
            const restarted = await client.query('SELECT * FROM process_ai_generation_runs WHERE tenant_id=$1 AND id=$2', [tenantId, run.id]);
            await client.query('COMMIT'); return { session: sessionRow(current.rows[0]), message: messageRow(messageResult.rows[0]), run: runRow(restarted.rows[0]), replay: false };
          }
          await client.query('COMMIT'); return { session: before, message: messageRow(messageResult.rows[0]), run, replay: true };
        }
      }
      if (before.currentRevision !== input.baseRevision) throw new RevisionConflict();
      if (before.status === 'generating') throw new RevisionConflict();
      if (input.expectedQuestionSetId) {
        const actual = questionSetId(before.pendingQuestions);
        if (actual !== input.expectedQuestionSetId) throw new StaleQuestionSet();
      }
      const messageId = randomUUID();
      const insertedMessage = await client.query('INSERT INTO process_ai_messages(id,tenant_id,session_id,role,content) VALUES($1,$2,$3,$4,$5) RETURNING *', [messageId, tenantId, sessionId, input.role, input.content]);
      if (input.facts?.length) await client.query('UPDATE process_ai_sessions SET confirmed_facts=confirmed_facts || $3::jsonb WHERE tenant_id=$1 AND id=$2', [tenantId, sessionId, JSON.stringify(input.facts.map(fact => ({ ...fact, sourceId: messageId })))]);
      const runId = randomUUID();
      const requestHash = input.operationId ? input.requestHash || createHash('sha256').update(JSON.stringify({ baseRevision: input.baseRevision, role: input.role, content: input.content, facts: input.facts || [], expectedQuestionSetId: input.expectedQuestionSetId || null })).digest('hex') : null;
      const insertedRun = await client.query("INSERT INTO process_ai_generation_runs(id,tenant_id,session_id,status,provider,model,operation_id,request_hash,source_message_id) VALUES($1,$2,$3,'generating',$4,$5,$6,$7,$8) RETURNING *", [runId, tenantId, sessionId, provider, model, input.operationId ?? null, requestHash, messageId]);
      await client.query("UPDATE process_ai_sessions SET state='generating',pending_questions='[]'::jsonb,generation_started_at=now(),version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, sessionId]);
      const current = await client.query('SELECT s.*,p.name,p.target_profile FROM process_ai_sessions s JOIN process_ai_projects p ON p.id=s.project_id AND p.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.id=$2', [tenantId, sessionId]);
      await client.query('COMMIT');
      return { session: sessionRow(current.rows[0]), message: messageRow(insertedMessage.rows[0]), run: runRow(insertedRun.rows[0]), replay: false };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async completeTurn(tenantId: string, sessionId: string, runId: string, outcome: TurnOutcomeInput): Promise<void> {
    await this.init(); const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query('SELECT current_revision FROM process_ai_sessions WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, sessionId]);
      if (!session.rows[0]) throw new ConversationNotFound();
      const run = await client.query('SELECT id FROM process_ai_generation_runs WHERE tenant_id=$1 AND session_id=$2 AND id=$3 AND status IN (\'generating\',\'queued\') FOR UPDATE', [tenantId, sessionId, runId]);
      if (!run.rows[0]) throw new ConversationNotFound();
      const newState = outcome.status;
      if (outcome.status === 'review-required' && outcome.proposal) {
        if (Number(session.rows[0].current_revision) !== outcome.proposal.baseRevision) throw new RevisionConflict();
        const proposal = await client.query('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM process_ai_revisions WHERE tenant_id=$1 AND session_id=$2', [tenantId, sessionId]);
        const revision = Number(proposal.rows[0].revision);
        await client.query("INSERT INTO process_ai_revisions(id,tenant_id,session_id,revision,base_revision,status,process_spec,artifacts,summary,metadata) VALUES($1,$2,$3,$4,$5,'proposed',$6::jsonb,$7::jsonb,$8,$9::jsonb)", [randomUUID(), tenantId, sessionId, revision, outcome.proposal.baseRevision, JSON.stringify(outcome.proposal.processSpec), JSON.stringify(outcome.proposal.artifacts), outcome.proposal.summary, JSON.stringify(outcome.proposal.metadata)]);
        outcome.runPatch.result = { ...(outcome.runPatch.result as any), revision, baseRevision: outcome.proposal.baseRevision };
      }
      await client.query('UPDATE process_ai_sessions SET state=CASE WHEN state=\'accepted\' THEN \'accepted\' ELSE $3 END,pending_questions=$4::jsonb,generation_started_at=NULL,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2', [tenantId, sessionId, newState, JSON.stringify(outcome.questions || [])]);
      if (outcome.assistantMessage) await client.query('INSERT INTO process_ai_messages(id,tenant_id,session_id,role,content) VALUES($1,$2,$3,\'assistant\',$4)', [randomUUID(), tenantId, sessionId, outcome.assistantMessage]);
      await client.query('UPDATE process_ai_generation_runs SET status=$4,result=COALESCE($5::jsonb,result),error_code=COALESCE($6,error_code),metrics=COALESCE($7::jsonb,metrics),updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND id=$3', [tenantId, sessionId, runId, outcome.runPatch.status ?? (outcome.status === 'review-required' ? 'validated' : outcome.status), outcome.runPatch.result === undefined ? null : JSON.stringify(outcome.runPatch.result), outcome.runPatch.errorCode ?? null, outcome.runPatch.metrics === undefined ? null : JSON.stringify(outcome.runPatch.metrics)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async reconcileInterruptedRuns(tenantId: string, sessionId: string, olderThanMs = 5 * 60_000): Promise<number> {
    const errorResult = JSON.stringify({ error: { code: 'GENERATION_INTERRUPTED', message: 'A geração foi interrompida e pode ser retomada explicitamente' } });
    const result = await this.query("UPDATE process_ai_generation_runs SET status='failed',error_code='GENERATION_INTERRUPTED',result=$3::jsonb,updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND status IN ('queued','generating') AND updated_at < now() - ($4 * interval '1 millisecond')", [tenantId, sessionId, errorResult, olderThanMs]);
    if (result.rowCount) await this.query("UPDATE process_ai_sessions SET state=CASE WHEN current_revision>0 THEN 'review-required' ELSE 'failed' END,generation_started_at=NULL,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND state='generating' AND NOT EXISTS (SELECT 1 FROM process_ai_generation_runs r WHERE r.tenant_id=$1 AND r.session_id=$2 AND r.status='generating')", [tenantId, sessionId]);
    return result.rowCount || 0;
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
    this.sessions.set(sessionId, { id: sessionId, projectId, name, targetProfile, status: 'draft', currentRevision: 0, version: 0, pendingQuestions: [], createdAt: new Date().toISOString() });
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
  private requirements = new Map<string, StoredRequirement[]>();
  private examples: Array<AcceptedExample & { tenant: string }> = [];
  async syncRequirements(tenant: string, sessionId: string, revision: number, items: Array<{ kind: RequirementKind; label: string; origin: RequirementOrigin }>) {
    if (!this.owns(tenant, sessionId)) throw new ConversationNotFound();
    const list = this.requirements.get(sessionId) || [];
    const now = new Date().toISOString();
    for (const item of items) {
      const existing = list.find(entry => entry.kind === item.kind && entry.label === item.label);
      if (existing) { existing.lastRevision = Math.max(existing.lastRevision, revision); if (!['user', 'confirmed-answer'].includes(existing.origin)) existing.origin = item.origin; existing.updatedAt = now; }
      else list.push({ id: randomUUID(), sessionId, kind: item.kind, label: item.label, origin: item.origin, state: 'proposed', firstRevision: revision, lastRevision: revision, createdAt: now, updatedAt: now });
    }
    this.requirements.set(sessionId, list);
  }
  async listRequirements(tenant: string, sessionId: string) { if (!this.owns(tenant, sessionId)) throw new ConversationNotFound(); return (this.requirements.get(sessionId) || []).map(item => ({ ...item })); }
  async setRequirementState(tenant: string, sessionId: string, requirementId: string, state: RequirementVerdict) {
    const item = this.owns(tenant, sessionId) ? (this.requirements.get(sessionId) || []).find(entry => entry.id === requirementId) : undefined;
    if (!item) throw new ConversationNotFound();
    item.state = state; item.updatedAt = new Date().toISOString();
    return { ...item };
  }
  async saveAcceptedExample(tenant: string, sessionId: string, revision: number, requestText: string, summary: string) {
    if (!this.examples.some(item => item.tenant === tenant && item.sessionId === sessionId && item.revision === revision)) this.examples.unshift({ tenant, sessionId, revision, requestText, summary });
  }
  async listAcceptedExamples(tenant: string, limit: number) { return this.examples.filter(item => item.tenant === tenant).slice(0, limit).map(({ tenant: _tenant, ...item }) => item); }
  async listRuns(tenant: string, sessionId: string) { if (!this.owns(tenant, sessionId)) throw new ConversationNotFound(); return [...this.runs.values()].filter(run => this.runTenants.get(run.id) === tenant && run.sessionId === sessionId); }
  async getOperation(tenant: string, sessionId: string, operationId: string, requestHash: string) {
    const run = [...this.runs.values()].find(item => this.runTenants.get(item.id) === tenant && item.sessionId === sessionId && item.operationId === operationId);
    if (!run) return undefined;
    if (!run.requestHash || run.requestHash !== requestHash) throw new OperationConflict();
    if (run.status === 'failed' && !run.providerStartedAt) return undefined;
    return run;
  }
  async markProviderStarted(tenant: string, runId: string) { const run = this.runTenants.get(runId) === tenant ? this.runs.get(runId) : undefined; if (!run || !['generating','queued'].includes(run.status)) throw new ConversationNotFound(); this.runs.set(runId, { ...run, providerStartedAt: run.providerStartedAt || new Date().toISOString(), updatedAt: new Date().toISOString() }); }
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
  async beginTurn(tenant: string, sessionId: string, input: BeginTurnInput, provider: string, model: string): Promise<BeginTurnResult> {
    const session = this.owns(tenant, sessionId) ? this.sessions.get(sessionId) : undefined; if (!session) throw new ConversationNotFound();
    const requestHash = input.operationId ? input.requestHash || createHash('sha256').update(JSON.stringify({ baseRevision: input.baseRevision, role: input.role, content: input.content, facts: input.facts || [], expectedQuestionSetId: input.expectedQuestionSetId || null })).digest('hex') : undefined;
    if (input.operationId) { const prior = [...this.runs.values()].find(run => this.runTenants.get(run.id) === tenant && run.sessionId === sessionId && run.operationId === input.operationId); if (prior) { if (!prior.requestHash || prior.requestHash !== requestHash) throw new OperationConflict(); const message = (this.messages.get(sessionId) || []).find(item => item.id === prior.sourceMessageId); if (!message) throw new ConversationNotFound(); if (prior.status === 'failed' && !prior.providerStartedAt) { if (session.currentRevision !== input.baseRevision) throw new RevisionConflict(); const restarted = { ...prior, status: 'generating' as const, result: undefined, errorCode: undefined, metrics: undefined, updatedAt: new Date().toISOString() }; this.runs.set(prior.id, restarted); session.status = 'generating'; session.version++; return { session, message, run: restarted, replay: false }; } return { session, message, run: prior, replay: true }; } }
    if (input.operationId) {
      const message = (this.messages.get(sessionId) || []).find(item => [...this.runs.values()].some(run => this.runTenants.get(run.id) === tenant && run.sessionId === sessionId && run.operationId === input.operationId && run.sourceMessageId === item.id));
      if (message) {
        if (session.currentRevision !== input.baseRevision || session.status === 'generating') throw new RevisionConflict();
        const oldFacts = this.confirmedFacts.get(sessionId) || [];
        const missing = (input.facts || []).filter(fact => !oldFacts.some(old => old.sourceId === message.id && old.questionId === fact.questionId && old.answer === fact.answer));
        if (missing.length) await this.appendConfirmedFacts(tenant, sessionId, missing.map(fact => ({ ...fact, sourceId: message.id })));
        session.status = 'generating'; session.pendingQuestions = []; session.version++;
        const now = new Date().toISOString(); const run: GenerationRun = { id: randomUUID(), sessionId, status: 'generating', operationId: `${input.operationId}:resume:${randomUUID()}`, sourceMessageId: message.id, provider, model, createdAt: now, updatedAt: now };
        this.runs.set(run.id, run); this.runTenants.set(run.id, tenant); return { session, message, run, replay: false };
      }
    }
    if (session.currentRevision !== input.baseRevision || session.status === 'generating') throw new RevisionConflict();
    if (input.expectedQuestionSetId && input.expectedQuestionSetId !== questionSetId(session.pendingQuestions)) throw new StaleQuestionSet();
    const previous = { status: session.status, questions: session.pendingQuestions, facts: [...(this.confirmedFacts.get(sessionId) || [])], messages: [...(this.messages.get(sessionId) || [])] };
    try {
      const message = await this.appendMessage(tenant, sessionId, input.role, input.content);
      if (input.facts?.length) await this.appendConfirmedFacts(tenant, sessionId, input.facts.map(fact => ({ ...fact, sourceId: message.id })));
      session.status = 'generating'; session.pendingQuestions = []; session.version++;
      const now = new Date().toISOString(); const run: GenerationRun = { id: randomUUID(), sessionId, status: 'generating', operationId: input.operationId, requestHash, sourceMessageId: message.id, provider, model, createdAt: now, updatedAt: now };
      this.runs.set(run.id, run); this.runTenants.set(run.id, tenant); return { session, message, run, replay: false };
    } catch (error) { session.status = previous.status; session.pendingQuestions = previous.questions; this.confirmedFacts.set(sessionId, previous.facts); this.messages.set(sessionId, previous.messages); throw error; }
  }
  async completeTurn(tenant: string, sessionId: string, runId: string, outcome: TurnOutcomeInput): Promise<void> {
    const session = this.owns(tenant, sessionId) ? this.sessions.get(sessionId) : undefined; const run = this.runTenants.get(runId) === tenant ? this.runs.get(runId) : undefined;
    if (!session || !run || run.sessionId !== sessionId || run.status !== 'generating') throw new ConversationNotFound();
    const snapshot = { status: session.status, questions: session.pendingQuestions, revisions: [...(this.revisions.get(sessionId) || [])], revisionStatuses: (this.revisions.get(sessionId) || []).map(revision => revision.status), facts: [...(this.confirmedFacts.get(sessionId) || [])], messages: [...(this.messages.get(sessionId) || [])], run };
    try {
      let proposedRevision: StoredRevision | undefined;
      if (outcome.status === 'review-required' && outcome.proposal) {
        if (session.currentRevision !== outcome.proposal.baseRevision) throw new RevisionConflict();
        const items = this.revisions.get(sessionId) || [];
        proposedRevision = { id: randomUUID(), sessionId, revision: Math.max(0, ...items.map(item => item.revision)) + 1, baseRevision: outcome.proposal.baseRevision, status: 'proposed', processSpec: outcome.proposal.processSpec, artifacts: outcome.proposal.artifacts, summary: outcome.proposal.summary, metadata: outcome.proposal.metadata, createdAt: new Date().toISOString() };
        items.push(proposedRevision); this.revisions.set(sessionId, items);
        outcome.runPatch.result = { ...(outcome.runPatch.result as any), revision: proposedRevision.revision, baseRevision: outcome.proposal.baseRevision };
        outcome.assistantMessage ||= `${outcome.proposal.summary}\nProposta salva como revisão ${proposedRevision.revision}; aceite-a após revisão para torná-la atual.`;
      }
      session.status = outcome.status; session.pendingQuestions = outcome.questions || []; session.version++;
      if (outcome.assistantMessage) await this.appendMessage(tenant, sessionId, 'assistant', outcome.assistantMessage);
      this.runs.set(runId, { ...run, ...outcome.runPatch, status: outcome.runPatch.status || (outcome.status === 'review-required' ? 'validated' : outcome.status), updatedAt: new Date().toISOString() });
    } catch (error) {
      session.status = snapshot.status; session.pendingQuestions = snapshot.questions; this.revisions.set(sessionId, snapshot.revisions); snapshot.revisions.forEach((revision, index) => { revision.status = snapshot.revisionStatuses[index]; }); this.confirmedFacts.set(sessionId, snapshot.facts); this.messages.set(sessionId, snapshot.messages); this.runs.set(runId, snapshot.run); throw error;
    }
  }
  async reconcileInterruptedRuns(tenant: string, sessionId: string, olderThanMs = 5 * 60_000): Promise<number> {
    if (!this.owns(tenant, sessionId)) throw new ConversationNotFound();
    const active = [...this.runs.values()].filter(run => this.runTenants.get(run.id) === tenant && run.sessionId === sessionId && ['queued','generating'].includes(run.status) && Date.now() - Date.parse(run.updatedAt) >= olderThanMs);
    for (const run of active) this.runs.set(run.id, { ...run, status: 'failed', errorCode: 'GENERATION_INTERRUPTED', result: { error: { code: 'GENERATION_INTERRUPTED', message: 'A geração foi interrompida e pode ser retomada explicitamente' } }, updatedAt: new Date().toISOString() });
    const session = this.sessions.get(sessionId)!; if (session.status === 'generating' && active.length) { session.status = session.currentRevision > 0 ? 'review-required' : 'failed'; session.version++; }
    return active.length;
  }
  private owns(tenant: string, sessionId: string) { return this.sessionTenants.get(sessionId) === tenant; }
}
