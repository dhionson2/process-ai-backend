import type { Environment } from '../../config/env.js';
import type { ModelProvider } from '../providers/model-provider.js';
import { ConversationNotFound, RevisionConflict, type ConfirmedFact, type ConversationRepository, type GenerationRun, type ProjectTarget, type StoredRevision } from '../projects/conversation.repository.js';
import { AiOrchestrator, OrchestrationFailure, type ConversationTurn, type GenerationOutcome } from './orchestrator.js';
import { reconstructMessageHistory } from './message-provenance.js';
import { configuredProvider } from './provider.factory.js';
import { validateProcessSpec } from '../validation/validation.service.js';
import { generateArtifacts } from '../generation/artifact-generator.js';

export class ConversationServiceFailure extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number, readonly retryAfterMs?: number) { super(message); this.name = 'ConversationServiceFailure'; }
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
  get usesExternalProvider(): boolean { return this.orchestrator?.providerId === 'openai-compatible'; }

  async createProject(name: string, targetProfile: ProjectTarget) {
    this.ensureRepository();
    if (typeof name !== 'string' || !name.trim() || name.length > 128) throw new ConversationServiceFailure('PROJECT_NAME_INVALID', 'Nome do projeto deve ter de 1 a 128 caracteres', 400);
    return { ...await this.repo().createProject(this.environment.localTenantId, name.trim(), targetProfile), status: 'draft', currentRevision: 0 };
  }
  async submitMessage(sessionId: string, text: string, baseRevision: number, dataClassification?: 'synthetic' | 'public') {
    this.guardExternalData(dataClassification);
    return this.processTurn(sessionId, text, baseRevision);
  }
  async answerQuestions(sessionId: string, answers: string[], baseRevision: number, dataClassification?: 'synthetic' | 'public') {
    this.guardExternalData(dataClassification);
    this.ensureRepository();
    const session = await this.sessionOrThrow(sessionId);
    if (!Array.isArray(answers) || answers.length !== session.pendingQuestions.length || answers.some(answer => typeof answer !== 'string' || !answer.trim() || answer.length > 2000)) {
      throw new ConversationServiceFailure('ANSWERS_INVALID', 'Forneça uma resposta de até 2000 caracteres para cada pergunta pendente', 400);
    }
    const questions = session.pendingQuestions as Array<{ question: string }>;
    if (!Number.isInteger(baseRevision) || baseRevision !== session.currentRevision) throw new RevisionConflict();
    const confirmedAt = new Date().toISOString();
    await this.repo().appendConfirmedFacts(this.environment.localTenantId, sessionId, questions.map((question, index): ConfirmedFact => ({ question: question.question, answer: answers[index].trim(), confirmedAt })));
    // Questions are model-authored context, not user evidence. Persist only the answers as a user turn.
    const text = answers.map(answer => answer.trim()).join('\n\n');
    return this.processTurn(sessionId, text, baseRevision, 'confirmed-answer');
  }
  async session(sessionId: string) { this.ensureRepository(); return this.sessionOrThrow(sessionId); }
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
  async run(runId: string): Promise<GenerationRun> {
    this.ensureRepository();
    const result = await this.repo().getRun(this.environment.localTenantId, runId);
    if (!result) throw new ConversationServiceFailure('GENERATION_RUN_NOT_FOUND', 'Geração não encontrada', 404);
    return result;
  }

  private async processTurn(sessionId: string, text: string, baseRevision: number, sourceMessageType: 'user' | 'confirmed-answer' = 'user') {
    this.ensureRepository();
    const session = await this.sessionOrThrow(sessionId);
    if (!Number.isInteger(baseRevision) || baseRevision !== session.currentRevision) throw new RevisionConflict();
    if (!this.orchestrator) {
      const reason = this.providerConfigurationError;
      throw new ConversationServiceFailure(reason?.code || 'AI_NOT_CONFIGURED', reason?.message || 'Configure AI_PROVIDER e AI_MODEL no backend antes de iniciar uma conversa', 503);
    }
    if (typeof text !== 'string' || !text.trim() || text.length > 6000) throw new ConversationServiceFailure('MESSAGE_SIZE_INVALID', 'A mensagem deve conter de 1 a 6000 caracteres', 400);
    const tenantId = this.environment.localTenantId;
    const submittedMessage = await this.repo().appendMessage(tenantId, sessionId, 'user', text.trim());
    // Once a user turn is submitted, prior questions have either been answered or
    // superseded. Keep stale prompts out of the session while this run is in flight.
    await this.repo().setPendingQuestions(tenantId, sessionId, []);
    const run = await this.repo().createRun(tenantId, sessionId, this.orchestratorProvider(), this.orchestratorModel());
    await this.repo().updateRun(tenantId, run.id, { status: 'generating' });
    try {
      const [storedMessages, currentSpec, confirmedFacts] = await Promise.all([this.repo().listMessages(tenantId, sessionId, 8), this.repo().getCurrentSpec(tenantId, sessionId), this.repo().listConfirmedFacts(tenantId, sessionId)]);
      await this.repo().setSessionStatus(tenantId, sessionId, 'generating');
      const history: ConversationTurn[] = reconstructMessageHistory(storedMessages, confirmedFacts).map(message => ({ role: message.role, content: message.content }));
      const outcome = await this.orchestrator.generate({ text: text.trim(), sourceMessageId: submittedMessage.id, sourceMessageType, history, currentSpec, targetProfile: session.targetProfile, confirmedFacts: confirmedFacts.slice(-40) });
      return await this.persistOutcome(sessionId, run, baseRevision, outcome);
    } catch (error) {
      const mapped = mapServiceError(error);
      await Promise.all([
        this.repo().updateRun(tenantId, run.id, { status: 'failed', errorCode: mapped.code, result: { error: { code: mapped.code, message: mapped.message } }, metrics: { runId: run.id, provider: run.provider, model: run.model, latencyMs: Date.now() - Date.parse(run.createdAt), errorCode: mapped.code, providerDiagnostic: error instanceof OrchestrationFailure ? error.providerDiagnostic : undefined, pipeline: error instanceof OrchestrationFailure ? error.diagnostics : undefined } }),
        this.repo().setSessionStatus(tenantId, sessionId, 'failed'),
        this.repo().setPendingQuestions(tenantId, sessionId, []),
      ]);
      await this.repo().appendMessage(tenantId, sessionId, 'assistant', `Não foi possível concluir a geração (${mapped.code}). Você pode tentar novamente; a revisão atual foi mantida.`);
      throw mapped;
    }
  }

  private async persistOutcome(sessionId: string, run: GenerationRun, baseRevision: number, outcome: GenerationOutcome) {
    const tenantId = this.environment.localTenantId;
    if (outcome.kind === 'need_clarification') {
      await this.repo().setPendingQuestions(tenantId, sessionId, outcome.questions);
      await this.repo().setSessionStatus(tenantId, sessionId, 'needs-input');
      const summary = outcome.summary || 'Preciso esclarecer alguns pontos antes de propor um fluxo correto.';
      await this.repo().appendMessage(tenantId, sessionId, 'assistant', `${summary}\n${outcome.questions.map((question, index) => `${index + 1}. ${question.question}`).join('\n')}`);
      const result = { kind: outcome.kind, questions: outcome.questions, summary, knowledgeVersion: outcome.knowledgeVersion, knowledgeModules: outcome.knowledgeModules };
      await this.repo().updateRun(tenantId, run.id, { status: 'needs-input', result, metrics: metrics(outcome) });
      return { generationRunId: run.id, status: 'needs-input', ...result };
    }
    if (!outcome.validation.valid || !outcome.artifacts) {
      await this.repo().setSessionStatus(tenantId, sessionId, 'validation-failed');
      const result = { kind: outcome.kind, changeSummary: outcome.changeSummary, validation: outcome.validation, repairAttempts: outcome.repairAttempts };
      await this.repo().updateRun(tenantId, run.id, { status: 'validation-failed', result, metrics: metrics(outcome) });
      await this.repo().appendMessage(tenantId, sessionId, 'assistant', `A proposta não passou na validação determinística: ${outcome.validation.diagnostics.map(d => d.code).join(', ')}`);
      return { generationRunId: run.id, status: 'validation-failed', ...result };
    }
    const artifactBundle = { bpmnXml: outcome.artifacts.bpmnXml, forms: outcome.artifacts.forms, manifest: outcome.artifacts.manifest, diagnostics: outcome.artifacts.diagnostics };
    const metadata = { provider: outcome.provider, model: outcome.model, latencyMs: outcome.latencyMs, usage: outcome.usage, repairAttempts: outcome.repairAttempts, knowledgeVersion: outcome.knowledgeVersion, knowledgeModules: outcome.knowledgeModules };
    const proposal = await this.repo().createProposal(tenantId, sessionId, baseRevision, outcome.spec, artifactBundle, outcome.changeSummary, metadata);
    await this.repo().setSessionStatus(tenantId, sessionId, 'review-required');
    await this.repo().setPendingQuestions(tenantId, sessionId, []);
    await this.repo().appendMessage(tenantId, sessionId, 'assistant', `${outcome.changeSummary}\nProposta salva como revisão ${proposal.revision}; aceite-a após revisão para torná-la atual.`);
    const result = { kind: outcome.kind, revision: proposal.revision, baseRevision, changeSummary: outcome.changeSummary, validation: outcome.validation, artifacts: artifactBundle, metadata };
    await this.repo().updateRun(tenantId, run.id, { status: 'validated', result, metrics: metrics(outcome) });
    return { generationRunId: run.id, status: 'validated', ...result };
  }

  private async sessionOrThrow(sessionId: string) {
    const session = await this.repo().getSession(this.environment.localTenantId, sessionId);
    if (!session) throw new ConversationServiceFailure('SESSION_NOT_FOUND', 'Sessão não encontrada', 404);
    return session;
  }
  private ensureRepository() { if (!this.repository) throw new ConversationServiceFailure('PERSISTENCE_NOT_CONFIGURED', 'Configure DATABASE_URL para persistir projetos e conversas no PostgreSQL', 503); }
  private guardExternalData(classification?: string) {
    if (this.usesExternalProvider && !['synthetic', 'public'].includes(classification || '')) throw new ConversationServiceFailure('EXTERNAL_DATA_CLASSIFICATION_REQUIRED', 'Com provedor externo, declare dados synthetic ou public; dados reais ou sigilosos não podem ser enviados', 400);
  }
  private repo(): ConversationRepository { this.ensureRepository(); return this.repository!; }
  private orchestratorProvider() { return this.orchestrator!.providerId; }
  private orchestratorModel() { return this.orchestrator!.modelId; }
}

function metrics(outcome: GenerationOutcome) {
  return { provider: outcome.provider, model: outcome.model, latencyMs: outcome.latencyMs, usage: outcome.usage, repairAttempts: outcome.kind === 'proposed_spec' ? outcome.repairAttempts : 0, knowledgeVersion: outcome.knowledgeVersion, knowledgeModules: outcome.knowledgeModules, pipeline: outcome.diagnostics?.filter(item => item.stage !== 'requirement-coverage-shadow') };
}
function mapServiceError(error: unknown): ConversationServiceFailure {
  if (error instanceof ConversationServiceFailure) return error;
  if (error instanceof RevisionConflict) return new ConversationServiceFailure('REVISION_CONFLICT', error.message, 409);
  if (error instanceof ConversationNotFound) return new ConversationServiceFailure('SESSION_NOT_FOUND', error.message, 404);
  if (error instanceof OrchestrationFailure) {
    const status = error.code === 'PROVIDER_TIMEOUT' ? 504 : error.code === 'PROVIDER_UNAVAILABLE' ? 503 : error.code === 'PROVIDER_RATE_LIMITED' ? 429 : error.code.startsWith('PROVIDER_') || error.code === 'MODEL_RESULT_INVALID' ? 502 : error.code.endsWith('_LIMIT_EXCEEDED') ? 413 : 422;
    return new ConversationServiceFailure(error.code, error.message, status, error.retryAfterMs);
  }
  return new ConversationServiceFailure('GENERATION_FAILED', 'Falha ao gerar a proposta; revisão atual preservada', 500);
}
