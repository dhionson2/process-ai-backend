import type { Environment } from '../../config/env.js';
import type { ModelProvider } from '../providers/model-provider.js';
import type { ProviderDiagnostic } from '../providers/model-provider.js';
import { ConversationNotFound, OperationConflict, RevisionConflict, StaleQuestionSet, type ConfirmedFact, type ConversationRepository, type GenerationRun, type ProjectTarget, type StoredRevision } from '../projects/conversation.repository.js';
import { AiOrchestrator, OrchestrationFailure, type ConversationTurn, type GenerationOutcome } from './orchestrator.js';
import { reconstructMessageHistory } from './message-provenance.js';
import { recoveryGuidance, recoveryMessage } from './recovery-guidance.js';
import { projectUnderstanding } from './understanding.js';
import { sessionTelemetry } from './telemetry.js';
import { extractNumericThresholdFacts, identityForQuestion, latestSemanticFactEvents, reconcileExplicitNumericCorrection, semanticFactId, type SemanticFact } from './semantic-grounding.js';
import { createHash } from 'node:crypto';
import { configuredProvider } from './provider.factory.js';
import { validateProcessSpec } from '../validation/validation.service.js';
import { generateArtifacts } from '../generation/artifact-generator.js';

export class ConversationServiceFailure extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number, readonly retryAfterMs?: number, readonly generationRunId?: string, readonly providerDiagnostic?: ProviderDiagnostic) { super(message); this.name = 'ConversationServiceFailure'; }
}
export type ConversationDependencies = { repository: ConversationRepository; orchestrator?: AiOrchestrator };

export class ConversationService {
  private readonly orchestrator?: AiOrchestrator;
  private providerConfigurationError?: OrchestrationFailure;
  constructor(private readonly environment: Environment, private readonly repository: ConversationRepository | undefined, dependencies: { orchestrator?: AiOrchestrator; provider?: ModelProvider } = {}) {
    if (dependencies.orchestrator) this.orchestrator = dependencies.orchestrator;
    else if (dependencies.provider) {
      const model = environment.aiModel || 'test-model';
      this.orchestrator = new AiOrchestrator(dependencies.provider, model, environment);
    } else {
      try {
        const configured = configuredProvider(environment);
        if (configured) this.orchestrator = new AiOrchestrator(configured.provider, configured.model, environment);
      } catch (error) { if (error instanceof OrchestrationFailure) this.providerConfigurationError = error; else throw error; }
    }
  }
  get databaseConfigured(): boolean { return !!this.repository; }
  get aiConfigured(): boolean { return !!this.orchestrator; }
  get usesExternalProvider(): boolean { return this.orchestrator?.providerId === 'openai-compatible' || this.orchestrator?.providerId === 'claude-cli'; }
  get providerStatus() {
    const endpoint = this.environment.externalAiBaseUrl ? new URL(this.environment.externalAiBaseUrl) : undefined;
    return {
      enabled: this.aiConfigured,
      provider: this.orchestrator?.providerId || this.environment.aiProvider,
      model: this.orchestrator?.modelId || this.environment.aiModel || null,
      configurationErrorCode: this.providerConfigurationError?.code || null,
      apiKeyConfigured: Boolean(this.environment.externalAiApiKey),
      endpointOrigin: endpoint?.origin || null,
      structuredOutput: this.environment.externalAiStructuredOutput,
      graphIrMode: this.environment.aiGraphIrMode || 'off',
      localCallLimit: this.environment.aiMaxProviderCalls,
      localTokenLimit: this.environment.aiMaxProviderTokens,
      maxInputCharacters: this.environment.aiMaxInputChars,
      maxOutputTokens: this.environment.aiMaxOutputTokens,
      timeoutMs: this.environment.aiTimeoutMs,
      maxConcurrency: this.environment.aiMaxConcurrency,
    };
  }

  async createProject(name: string, targetProfile: ProjectTarget) {
    this.ensureRepository();
    if (typeof name !== 'string' || !name.trim() || name.length > 128) throw new ConversationServiceFailure('PROJECT_NAME_INVALID', 'Nome do projeto deve ter de 1 a 128 caracteres', 400);
    return { ...await this.repo().createProject(this.environment.localTenantId, name.trim(), targetProfile), status: 'draft', currentRevision: 0 };
  }
  async submitMessage(sessionId: string, text: string, baseRevision: number, dataClassification?: 'synthetic' | 'public', operationId?: string) {
    this.guardExternalData(dataClassification);
    return this.processTurn(sessionId, text, baseRevision, 'user', undefined, operationId, undefined, undefined, dataClassification);
  }
  async answerQuestions(sessionId: string, answers: string[], baseRevision: number, dataClassification?: 'synthetic' | 'public', questionSetId?: string, operationId?: string) {
    this.guardExternalData(dataClassification);
    this.ensureRepository();
    const requestHash = hashOperation({ kind: 'answers', baseRevision, answers: Array.isArray(answers) ? answers.map(answer => typeof answer === 'string' ? answer.trim() : answer) : answers, questionSetId: questionSetId || null });
    const replay = await this.replayOperation(sessionId, operationId, requestHash);
    if (replay) return replay;
    const session = await this.sessionOrThrow(sessionId);
    if (!Array.isArray(answers) || answers.length !== session.pendingQuestions.length || answers.some(answer => typeof answer !== 'string' || !answer.trim() || answer.length > 2000)) {
      throw new ConversationServiceFailure('ANSWERS_INVALID', 'Forneça uma resposta de até 2000 caracteres para cada pergunta pendente', 400);
    }
    const questions = session.pendingQuestions as Array<{ question: string; questionId?: string; requirementId?: string; semanticSlot?: string }>;
    if (!Number.isInteger(baseRevision) || baseRevision !== session.currentRevision) throw new RevisionConflict();
    const confirmedAt = new Date().toISOString();
    // Questions are model-authored context, not user evidence. Persist only the answers as a user turn.
    const text = answers.map(answer => answer.trim()).join('\n\n');
    const facts = questions.map((question, index): ConfirmedFact => {
        const identity = identityForQuestion(question.question, question.requirementId);
        const semanticSlot = question.semanticSlot || identity.semanticSlot;
        return { question: question.question, answer: answers[index].trim(), confirmedAt, answeredAt: confirmedAt, questionId: question.questionId || identity.questionId, requirementId: question.requirementId || identity.requirementId, semanticSlot, semanticFactId: semanticFactId(semanticSlot), questionStatus: 'answered', state: 'confirmed' };
      });
    return this.processTurn(sessionId, text, baseRevision, 'confirmed-answer', facts, operationId, questionSetId, requestHash, dataClassification);
  }
  async session(sessionId: string) { this.ensureRepository(); await this.repo().reconcileInterruptedRuns(this.environment.localTenantId, sessionId); const session = await this.sessionOrThrow(sessionId); return { ...session, questionSetId: stableQuestionSetId(session.pendingQuestions), pendingQuestions: publicQuestions(session.pendingQuestions) }; }
  /** "O que entendi / o que falta": confirmed facts, open questions and a business projection of the newest revision. */
  async understanding(sessionId: string) {
    this.ensureRepository();
    const tenantId = this.environment.localTenantId;
    const session = await this.sessionOrThrow(sessionId);
    const [facts, revisions] = await Promise.all([this.repo().listConfirmedFacts(tenantId, sessionId), this.repo().listRevisions(tenantId, sessionId)]);
    const latest = revisions.reduce<StoredRevision | undefined>((newest, item) => !newest || item.revision > newest.revision ? item : newest, undefined);
    return {
      sessionId, currentRevision: session.currentRevision,
      confirmedFacts: latestSemanticFactEvents(facts).map(fact => ({ question: fact.question, answer: fact.answer, state: fact.state || 'confirmed', confirmedAt: fact.confirmedAt })),
      pendingQuestions: (session.pendingQuestions as Array<{ question: string; blocking?: boolean }>).map(question => ({ question: question.question, blocking: question.blocking !== false })),
      proposal: latest ? projectUnderstanding(latest.processSpec, latest.revision, latest.status) : null,
    };
  }
  async history(sessionId: string) {
    this.ensureRepository(); await this.sessionOrThrow(sessionId);
    const [messages, facts] = await Promise.all([this.repo().listMessages(this.environment.localTenantId, sessionId, 100), this.repo().listConfirmedFacts(this.environment.localTenantId, sessionId)]);
    return reconstructMessageHistory(messages, facts);
  }
  async currentDraft(sessionId: string) {
    const session = await this.session(sessionId);
    const revisions = await this.repo().listRevisions(this.environment.localTenantId, sessionId);
    const current = revisions.find(item => item.status === 'accepted' && item.revision === session.currentRevision);
    return { session, revision: current || null, processSpec: current?.processSpec || null, artifacts: current?.artifacts || null };
  }
  async revisions(sessionId: string) {
    const items = await this.repo().listRevisions(this.environment.localTenantId, sessionId);
    return items.map(({ id, sessionId: itemSessionId, revision, baseRevision, status, summary, metadata, createdAt }) => ({ id, sessionId: itemSessionId, revision, baseRevision, status, summary, metadata, createdAt }));
  }
  async revision(sessionId: string, revision: number): Promise<StoredRevision> {
    this.ensureRepository();
    const items = await this.repo().listRevisions(this.environment.localTenantId, sessionId);
    const item = items.find(candidate => candidate.revision === revision);
    if (!item) throw new ConversationServiceFailure('REVISION_NOT_FOUND', 'Revisão não encontrada', 404);
    return item;
  }
  async acceptRevision(sessionId: string, revision: number, baseRevision: number) {
    this.ensureRepository();
    await this.sessionOrThrow(sessionId);
    return this.repo().acceptRevision(this.environment.localTenantId, sessionId, revision, baseRevision);
  }
  async proposeManualRevision(sessionId: string, baseRevision: number, value: unknown) {
    this.ensureRepository();
    const session = await this.sessionOrThrow(sessionId);
    if (!Number.isInteger(baseRevision) || baseRevision !== session.currentRevision) throw new ConversationServiceFailure('REVISION_CONFLICT', 'A revisão base não é mais a revisão atual', 409);
    const validation = await validateProcessSpec(value);
    if (!validation.valid) throw new ConversationServiceFailure('PROCESSSPEC_INVALID', JSON.stringify(validation.diagnostics), 422);
    const artifacts = await generateArtifacts(value);
    if (artifacts.diagnostics.some(diagnostic => diagnostic.severity === 'error')) throw new ConversationServiceFailure('ARTIFACT_GENERATION_FAILED', JSON.stringify(artifacts.diagnostics), 422);
    const processSpec = value as Record<string, unknown>;
    const artifactBundle = { bpmnXml: artifacts.bpmnXml, forms: artifacts.forms, manifest: artifacts.manifest, diagnostics: artifacts.diagnostics };
    const proposal = await this.repo().createProposal(this.environment.localTenantId, sessionId, baseRevision, processSpec, artifactBundle, 'Alterações manuais validadas no backend', { source: 'manual', generatorVersion: (artifacts.manifest as any).generatorVersion });
    return { revision: proposal.revision, baseRevision, status: proposal.status, validation, artifacts: artifactBundle };
  }
  async telemetry(sessionId: string) {
    this.ensureRepository();
    await this.sessionOrThrow(sessionId);
    return { sessionId, ...sessionTelemetry(await this.repo().listRuns(this.environment.localTenantId, sessionId)) };
  }
  async run(runId: string): Promise<GenerationRun> {
    this.ensureRepository();
    const result = await this.repo().getRun(this.environment.localTenantId, runId);
    if (!result) throw new ConversationServiceFailure('GENERATION_RUN_NOT_FOUND', 'Geração não encontrada', 404);
    return result;
  }

  private async processTurn(sessionId: string, text: string, baseRevision: number, sourceMessageType: 'user' | 'confirmed-answer' = 'user', facts?: ConfirmedFact[], operationId?: string, expectedQuestionSetId?: string, suppliedRequestHash?: string, dataClassification?: 'synthetic' | 'public') {
    this.ensureRepository();
    if (operationId !== undefined && (typeof operationId !== 'string' || operationId.length < 8 || operationId.length > 128)) throw new ConversationServiceFailure('OPERATION_ID_INVALID', 'operationId deve conter de 8 a 128 caracteres', 400);
    if (expectedQuestionSetId !== undefined && (typeof expectedQuestionSetId !== 'string' || expectedQuestionSetId.length > 64)) throw new ConversationServiceFailure('QUESTION_SET_INVALID', 'questionSetId inválido', 400);
    if (typeof text !== 'string' || !text.trim() || text.length > 6000) throw new ConversationServiceFailure('MESSAGE_SIZE_INVALID', 'A mensagem deve conter de 1 a 6000 caracteres', 400);
    const requestHash = suppliedRequestHash || hashOperation({ kind: sourceMessageType, baseRevision, text: text.trim(), expectedQuestionSetId: expectedQuestionSetId || null });
    const replay = await this.replayOperation(sessionId, operationId, requestHash);
    if (replay) return replay;
    const session = await this.sessionOrThrow(sessionId);
    if (!Number.isInteger(baseRevision) || baseRevision !== session.currentRevision) throw new RevisionConflict();
    if (!this.orchestrator) {
      const reason = this.providerConfigurationError;
      throw new ConversationServiceFailure(reason?.code || 'AI_NOT_CONFIGURED', reason?.message || 'Configure AI_PROVIDER e AI_MODEL no backend antes de iniciar uma conversa', 503);
    }
    const tenantId = this.environment.localTenantId;
    const turn = await this.repo().beginTurn(tenantId, sessionId, { operationId, requestHash, baseRevision, role: 'user', content: text.trim(), facts, expectedQuestionSetId }, this.orchestratorProvider(), this.orchestratorModel());
    const submittedMessage = turn.message; const run = turn.run;
    if (turn.replay) return { ...(run.result as Record<string, unknown> || {}), generationRunId: run.id, status: run.status, replayed: true };
    let providerCallStarted = Boolean(run.providerStartedAt);
    try {
      const [storedMessages, currentSpec, confirmedFacts] = await Promise.all([this.repo().listMessages(tenantId, sessionId, 100), this.repo().getCurrentSpec(tenantId, sessionId), this.repo().listConfirmedFacts(tenantId, sessionId)]);
      if (this.environment.aiSemanticGroundingMode === 'controlled') await this.persistNumericSemanticCorrection(sessionId, submittedMessage, confirmedFacts);
      const history: ConversationTurn[] = reconstructMessageHistory(storedMessages, confirmedFacts).map(message => ({ role: message.role, content: message.content }));
      let outcome: GenerationOutcome;
      const confirmedAnswerText = new Set(confirmedFacts.map(fact => fact.answer.trim()));
      const authoritativeUserMessages = storedMessages.filter(message => message.role === 'user' && !confirmedAnswerText.has(message.content.trim())).map(message => ({ id: message.id, text: message.content }));
      const original = authoritativeUserMessages[0];
      try { outcome = await this.orchestrator.generate({ text: text.trim(), sourceMessageId: submittedMessage.id, sourceMessageType, originalSource: original, authoritativeUserMessages, dataClassification, history, currentSpec, targetProfile: session.targetProfile, confirmedFacts: confirmedFacts.slice(-40), onProviderCallStart: async () => { await this.repo().markProviderStarted(tenantId, run.id); providerCallStarted = true; } }); }
      catch (error) {
        const mapped = mapServiceError(error);
        if (this.environment.logLevel !== 'silent' && process.env.NODE_ENV !== 'production' && error instanceof OrchestrationFailure && error.graphIrSchemaDiagnostics) {
          console.warn(JSON.stringify({ event: 'graph-ir-schema-invalid', runId: run.id, diagnosticSet: error.graphIrSchemaDiagnostics }));
        }
        await this.repo().completeTurn(tenantId, sessionId, run.id, { status: 'failed', assistantMessage: providerCallStarted ? recoveryMessage(recoveryGuidance(mapped.code, mapped.retryAfterMs)) : undefined, runPatch: { status: 'failed', errorCode: mapped.code, result: { error: { code: mapped.code, message: mapped.message } }, metrics: { runId: run.id, provider: run.provider, model: run.model, latencyMs: Date.now() - Date.parse(run.createdAt), errorCode: mapped.code, providerCallStarted, providerDiagnostic: error instanceof OrchestrationFailure ? error.providerDiagnostic : undefined, pipeline: error instanceof OrchestrationFailure ? error.diagnostics : undefined } } });
        throw new ConversationServiceFailure(mapped.code, mapped.message, mapped.statusCode, mapped.retryAfterMs, run.id, mapped.providerDiagnostic);
      }
      return await this.persistOutcome(sessionId, run, baseRevision, outcome);
    } catch (error) {
      if (error instanceof ConversationServiceFailure) throw error;
      throw mapServiceError(error);
    }
  }

  private async persistOutcome(sessionId: string, run: GenerationRun, baseRevision: number, outcome: GenerationOutcome) {
    const tenantId = this.environment.localTenantId;
    if (outcome.kind === 'need_clarification') {
      const summary = outcome.summary || 'Preciso esclarecer alguns pontos antes de propor um fluxo correto.';
      const questionSetId = stableQuestionSetId(outcome.questions);
      const result = { kind: outcome.kind, questions: publicQuestions(outcome.questions), questionSetId, summary, knowledgeVersion: outcome.knowledgeVersion, knowledgeModules: outcome.knowledgeModules };
      await this.repo().completeTurn(tenantId, sessionId, run.id, { status: 'needs-input', questions: outcome.questions, assistantMessage: `${summary}\n${outcome.questions.map((question, index) => `${index + 1}. ${question.question}`).join('\n')}`, runPatch: { status: 'needs-input', result, metrics: metrics(outcome) } });
      return { generationRunId: run.id, status: 'needs-input', ...result };
    }
    if (!outcome.validation.valid || !outcome.artifacts) {
      const recovery = recoveryGuidance('PROCESSSPEC_INVALID');
      const result = { kind: outcome.kind, changeSummary: outcome.changeSummary, validation: outcome.validation, repairAttempts: outcome.repairAttempts, recovery };
      await this.repo().completeTurn(tenantId, sessionId, run.id, { status: 'validation-failed', assistantMessage: `${recoveryMessage(recovery)} (diagnósticos: ${outcome.validation.diagnostics.map(d => d.code).join(', ')})`, runPatch: { status: 'validation-failed', result, metrics: metrics(outcome) } });
      return { generationRunId: run.id, status: 'validation-failed', ...result };
    }
    const artifactBundle = { bpmnXml: outcome.artifacts.bpmnXml, forms: outcome.artifacts.forms, manifest: outcome.artifacts.manifest, diagnostics: outcome.artifacts.diagnostics };
    const metadata = { provider: outcome.provider, model: outcome.model, latencyMs: outcome.latencyMs, usage: outcome.usage, repairAttempts: outcome.repairAttempts, knowledgeVersion: outcome.knowledgeVersion, knowledgeModules: outcome.knowledgeModules };
    const result = { kind: outcome.kind, baseRevision, processSpec: outcome.spec, changeSummary: outcome.changeSummary, validation: outcome.validation, artifacts: artifactBundle, metadata };
    await this.repo().completeTurn(tenantId, sessionId, run.id, { status: 'review-required', proposal: { processSpec: outcome.spec, artifacts: artifactBundle, summary: outcome.changeSummary, metadata, baseRevision }, assistantMessage: `${outcome.changeSummary}\nProposta salva para revisão; aceite-a após revisão para torná-la atual.`, runPatch: { status: 'validated', result: { kind: outcome.kind, baseRevision, changeSummary: outcome.changeSummary, validation: outcome.validation, artifacts: artifactBundle, metadata }, metrics: metrics(outcome) } });
    const savedRun = await this.repo().getRun(tenantId, run.id); const publicResult = (savedRun?.result || {}) as any;
    return { generationRunId: run.id, status: 'validated', ...publicResult };
  }

  private async persistNumericSemanticCorrection(sessionId: string, message: { id: string; content: string }, facts: ConfirmedFact[]) {
    const effectiveFacts = latestSemanticFactEvents(facts);
    const storedThresholdFacts = effectiveFacts.flatMap(fact => fact.state === 'confirmed' && fact.semanticFact?.attribute === 'numeric-threshold' && fact.semanticFact.state === 'confirmed' ? [fact.semanticFact] : []);
    let previous: SemanticFact[] = storedThresholdFacts;
    if (!previous.length) {
      const tenantId = this.environment.localTenantId;
      const messages = await this.repo().listMessages(tenantId, sessionId, 100);
      previous = extractNumericThresholdFacts(messages.filter(item => item.role === 'user' && item.id !== message.id).map(item => ({ sourceId: item.id, text: item.content })));
    }
    const result = reconcileExplicitNumericCorrection(previous, message.content, message.id);
    if (result.status !== 'reconciled') return;
    const existingEvents = new Set(effectiveFacts.filter(fact => fact.semanticFact).map(fact => `${fact.semanticFact!.id}:${fact.semanticFact!.state}`));
    const events = result.facts.filter(fact => fact.state === 'superseded' || (fact.state === 'confirmed' && fact.source.sourceId === message.id));
    const confirmedAt = new Date().toISOString();
    const records = events.filter(fact => !existingEvents.has(`${fact.id}:${fact.state}`)).map((fact): ConfirmedFact => ({
      question: 'Condição numérica do processo', answer: fact.value, confirmedAt,
      questionId: `q_${fact.requirementId}`, requirementId: fact.requirementId,
      semanticSlot: `slot:condition-value:${fact.requirementId}`, semanticFactId: fact.id,
      sourceId: fact.source.sourceId, state: fact.state as 'confirmed' | 'superseded',
      supersedesFactId: fact.relations.find(item => item.type === 'supersedes')?.factId,
      semanticFact: fact,
    }));
    if (records.length) await this.repo().appendConfirmedFacts(this.environment.localTenantId, sessionId, records);
  }

  private async sessionOrThrow(sessionId: string) {
    const session = await this.repo().getSession(this.environment.localTenantId, sessionId);
    if (!session) throw new ConversationServiceFailure('SESSION_NOT_FOUND', 'Sessão não encontrada', 404);
    return session;
  }
  private async replayOperation(sessionId: string, operationId: string | undefined, requestHash: string) {
    if (operationId === undefined) return undefined;
    if (typeof operationId !== 'string' || operationId.length < 8 || operationId.length > 128) throw new ConversationServiceFailure('OPERATION_ID_INVALID', 'operationId deve conter de 8 a 128 caracteres', 400);
    const run = await this.repo().getOperation(this.environment.localTenantId, sessionId, operationId, requestHash);
    if (!run) return undefined;
    return { ...(run.result as Record<string, unknown> || {}), generationRunId: run.id, status: run.status, replayed: true };
  }
  private ensureRepository() { if (!this.repository) throw new ConversationServiceFailure('PERSISTENCE_NOT_CONFIGURED', 'Configure DATABASE_URL para persistir projetos e conversas no PostgreSQL', 503); }
  private guardExternalData(classification?: string) {
    if (this.usesExternalProvider && !['synthetic', 'public'].includes(classification || '')) throw new ConversationServiceFailure('EXTERNAL_DATA_CLASSIFICATION_REQUIRED', 'Com provedor externo, declare dados synthetic ou public; dados reais ou sigilosos não podem ser enviados', 400);
  }
  private repo(): ConversationRepository { this.ensureRepository(); return this.repository!; }
  private orchestratorProvider() { return this.orchestrator!.providerId; }
  private orchestratorModel() { return this.orchestrator!.modelId; }
}

function publicQuestions(value: unknown): Array<{ question: string; blocking: boolean }> {
  if (!Array.isArray(value)) return [];
  return value.filter((item: any) => item && typeof item.question === 'string').map((item: any) => ({ question: item.question, blocking: item.blocking === true }));
}

function stableQuestionSetId(value: unknown): string {
  const questions = Array.isArray(value) ? value.map((item: any) => ({ questionId: item?.questionId || item?.id || null, requirementId: item?.requirementId || null, semanticSlot: item?.semanticSlot || null, question: item?.question || null })) : [];
  return `qs_${createHash('sha256').update(JSON.stringify(questions)).digest('hex').slice(0, 24)}`;
}

function metrics(outcome: GenerationOutcome) {
  return { provider: outcome.provider, model: outcome.model, latencyMs: outcome.latencyMs, usage: outcome.usage, repairAttempts: outcome.kind === 'proposed_spec' ? outcome.repairAttempts : 0, knowledgeVersion: outcome.knowledgeVersion, knowledgeModules: outcome.knowledgeModules, pipeline: outcome.diagnostics?.filter(item => item.stage !== 'requirement-coverage-shadow') };
}
function hashOperation(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function mapServiceError(error: unknown): ConversationServiceFailure {
  if (error instanceof ConversationServiceFailure) return error;
  if (error instanceof RevisionConflict) return new ConversationServiceFailure('REVISION_CONFLICT', error.message, 409);
  if (error instanceof OperationConflict) return new ConversationServiceFailure('OPERATION_ID_CONFLICT', error.message, 409);
  if (error instanceof ConversationNotFound) return new ConversationServiceFailure('SESSION_NOT_FOUND', error.message, 404);
  if (error instanceof OrchestrationFailure) {
    const status = error.code === 'PROVIDER_TIMEOUT' ? 504 : error.code === 'PROVIDER_UNAVAILABLE' ? 503 : error.code === 'PROVIDER_RATE_LIMITED' ? 429 : error.code.startsWith('PROVIDER_') || error.code === 'MODEL_RESULT_INVALID' ? 502 : error.code.endsWith('_LIMIT_EXCEEDED') ? 413 : 422;
    return new ConversationServiceFailure(error.code, error.message, status, error.retryAfterMs, undefined, error.providerDiagnostic);
  }
  return new ConversationServiceFailure('GENERATION_FAILED', 'Falha ao gerar a proposta; revisão atual preservada', 500);
}
