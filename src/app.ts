import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readEnvironment, type Environment } from './config/env.js';
import { getExample, listExamples } from './modules/examples/example.repository.js';
import { validateProcessSpec } from './modules/validation/validation.service.js';
import { readFoundationJson } from './shared/files.js';
import { readFoundationJson as readSchema } from './shared/files.js';
import { generateArtifacts } from './modules/generation/artifact-generator.js';
import { validateFormSubmission, validatePublicationReadiness } from './modules/validation/validation.service.js';
import { ConversationService, ConversationServiceFailure } from './modules/ai/conversation.service.js';
import { recoveryGuidance } from './modules/ai/recovery-guidance.js';
import { ConversationNotFound, OperationConflict, PostgresConversationRepository, RevisionConflict, StaleQuestionSet, type ConversationRepository } from './modules/projects/conversation.repository.js';
import type { ModelProvider } from './modules/providers/model-provider.js';

export type AppDependencies = { conversationRepository?: ConversationRepository; modelProvider?: ModelProvider; apiContract?: Record<string, any> };
export async function buildApp(config: Environment = readEnvironment(), dependencies: AppDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel }, bodyLimit: 1024 * 1024 });
  const conversationRepository = dependencies.conversationRepository || (config.databaseUrl ? PostgresConversationRepository.fromConnectionString(config.databaseUrl) : undefined);
  const conversations = new ConversationService(config, conversationRepository, { provider: dependencies.modelProvider });
  await app.register(cors, { origin: config.corsOrigins, methods: ['GET', 'POST', 'PUT'] });
  app.addHook('onClose', async () => { if (conversationRepository instanceof PostgresConversationRepository) await conversationRepository.close(); });
  app.get('/health', async () => ({ status: 'ok', service: 'process-ai-backend', version: '0.1.0' }));
  app.get('/api/v1/capabilities', async () => ({
    targetProfile: 'generic-bpmn2',
    mode: 'preview-only',
    aiEnabled: conversations.aiConfigured,
    executionEnabled: false,
    conversationalAiEnabled: conversations.aiConfigured,
    persistentProjectsEnabled: conversations.databaseConfigured,
    supportedNodes: ['startEvent', 'endEvent', 'userTask', 'serviceTask', 'exclusiveGateway'],
    catalog: await readFoundationJson('contracts/mock-capability-catalog.json'),
  }));
  app.get('/api/v1/providers/status', async () => ({ provider: conversations.providerStatus }));
  app.get('/api/v1/examples', async () => listExamples());
  app.get<{ Params: { id: string } }>('/api/v1/examples/:id', async (request, reply) => {
    if (!['ferias', 'http-db'].includes(request.params.id)) return reply.code(404).send({ code: 'EXAMPLE_NOT_FOUND', message: 'Exemplo não encontrado' });
    return getExample(request.params.id as 'ferias' | 'http-db');
  });
  app.post<{ Body: unknown }>('/api/v1/validate', async (request) => validateProcessSpec(request.body));

  app.post<{ Body: { name: string; targetProfile?: 'generic-bpmn2' | 'flowable-oss' | 'unique-future' } }>('/api/v1/projects', async (request, reply) => {
    const profile = request.body?.targetProfile || 'generic-bpmn2';
    if (!['generic-bpmn2', 'flowable-oss', 'unique-future'].includes(profile)) return reply.code(400).send({ code: 'TARGET_PROFILE_INVALID', message: 'targetProfile inválido' });
    try { return reply.code(201).send(await conversations.createProject(request.body?.name, profile)); }
    catch (error) { return sendConversationError(reply, error); }
  });
  app.get<{ Params: { sessionId: string } }>('/api/v1/design-sessions/:sessionId', async (request, reply) => {
    try { return await conversations.session(request.params.sessionId); }
    catch (error) { return sendConversationError(reply, error); }
  });
  app.post<{ Params: { sessionId: string }; Body: { text: string; baseRevision: number; operationId?: string; dataClassification?: 'synthetic' | 'public' } }>('/api/v1/design-sessions/:sessionId/messages', async (request, reply) => {
    try { return await conversations.submitMessage(request.params.sessionId, request.body?.text, request.body?.baseRevision, request.body?.dataClassification, request.body?.operationId); }
    catch (error) { return sendConversationError(reply, error); }
  });
  app.post<{ Params: { sessionId: string }; Body: { answers: string[]; baseRevision: number; questionSetId?: string; operationId?: string; dataClassification?: 'synthetic' | 'public' } }>('/api/v1/design-sessions/:sessionId/answers', async (request, reply) => {
    try { return await conversations.answerQuestions(request.params.sessionId, request.body?.answers, request.body?.baseRevision, request.body?.dataClassification, request.body?.questionSetId, request.body?.operationId); }
    catch (error) { return sendConversationError(reply, error); }
  });
  app.post<{ Params: { sessionId: string }; Body: { text: string; baseRevision: number; operationId?: string; dataClassification?: 'synthetic' | 'public' } }>('/api/v1/design-sessions/:sessionId/refinements', async (request, reply) => {
    try {
      const draft = await conversations.currentDraft(request.params.sessionId);
      if (!draft.processSpec) return reply.code(409).send({ code: 'DRAFT_NOT_FOUND', message: 'Aceite ou gere uma revisão inicial antes de refiná-la' });
      return await conversations.submitMessage(request.params.sessionId, request.body?.text, request.body?.baseRevision, request.body?.dataClassification, request.body?.operationId);
    } catch (error) { return sendConversationError(reply, error); }
  });
  app.get<{ Params: { sessionId: string } }>('/api/v1/design-sessions/:sessionId/history', async (request, reply) => {
    try { return { messages: await conversations.history(request.params.sessionId) }; }
    catch (error) { return sendConversationError(reply, error); }
  });
  app.get<{ Params: { sessionId: string } }>('/api/v1/design-sessions/:sessionId/draft', async (request, reply) => {
    try { return await conversations.currentDraft(request.params.sessionId); }
    catch (error) { return sendConversationError(reply, error); }
  });
  app.get<{ Params: { sessionId: string } }>('/api/v1/design-sessions/:sessionId/understanding', async (request, reply) => {
    try { return await conversations.understanding(request.params.sessionId); }
    catch (error) { return sendConversationError(reply, error); }
  });
  app.put<{ Params: { sessionId: string }; Body: { baseRevision: number; processSpec: unknown } }>('/api/v1/design-sessions/:sessionId/draft', async (request, reply) => {
    try { return await conversations.proposeManualRevision(request.params.sessionId, request.body?.baseRevision, request.body?.processSpec); }
    catch (error) { return sendConversationError(reply, error); }
  });
  app.get<{ Params: { sessionId: string } }>('/api/v1/design-sessions/:sessionId/revisions', async (request, reply) => {
    try { return { revisions: await conversations.revisions(request.params.sessionId) }; }
    catch (error) { return sendConversationError(reply, error); }
  });
  app.get<{ Params: { sessionId: string; revision: string } }>('/api/v1/design-sessions/:sessionId/revisions/:revision', async (request, reply) => {
    try { const revision = Number(request.params.revision); if (!Number.isInteger(revision) || revision < 1) return reply.code(400).send({ code: 'REVISION_INVALID', message: 'Número de revisão inválido' }); return await conversations.revision(request.params.sessionId, revision); }
    catch (error) { return sendConversationError(reply, error); }
  });
  app.post<{ Params: { sessionId: string; revision: string }; Body: { baseRevision: number } }>('/api/v1/design-sessions/:sessionId/revisions/:revision/accept', async (request, reply) => {
    try { const revision = Number(request.params.revision); if (!Number.isInteger(revision) || revision < 1) return reply.code(400).send({ code: 'REVISION_INVALID', message: 'Número de revisão inválido' }); return await conversations.acceptRevision(request.params.sessionId, revision, request.body?.baseRevision); }
    catch (error) { return sendConversationError(reply, error); }
  });
  app.get<{ Params: { sessionId: string } }>('/api/v1/design-sessions/:sessionId/telemetry', async (request, reply) => {
    try { return await conversations.telemetry(request.params.sessionId); }
    catch (error) { return sendConversationError(reply, error); }
  });
  // Offline evaluation results produced by `npm run eval`; synthetic corpus only, specs omitted from the payload.
  app.get('/api/v1/evaluation/scoreboard', async (_request, reply) => {
    try {
      const scoreboard = JSON.parse(await readFile(resolve(config.evaluationScoreboardPath ?? 'reports/eval/scoreboard.json'), 'utf8'));
      for (const run of scoreboard.runs ?? []) for (const result of run.results ?? []) delete result.spec;
      return scoreboard;
    } catch {
      return reply.code(404).send({ code: 'SCOREBOARD_NOT_FOUND', message: 'Nenhuma avaliação registrada; execute npm run eval' });
    }
  });
  app.get<{ Params: { runId: string } }>('/api/v1/generation-runs/:runId', async (request, reply) => {
    try { return await conversations.run(request.params.runId); }
    catch (error) { return sendConversationError(reply, error); }
  });
  app.post<{ Body: { spec: unknown; formId: string; data: Record<string, unknown> } }>('/api/v1/validate-form', async (request) =>
    validateFormSubmission(request.body.spec, request.body.formId, request.body.data));
  app.post<{ Body: { spec: unknown; runtimeCapabilities: { conditionalFormValidation: boolean } } }>('/api/v1/publication/validate', async (request, reply) => {
    const readiness = await validatePublicationReadiness(request.body.spec, request.body.runtimeCapabilities?.conditionalFormValidation === true);
    if (readiness.blockers.some(item => item.severity === 'error' && item.code !== 'PUBLICATION_DISABLED_IN_PHASE1')) return reply.code(422).send(readiness);
    return readiness;
  });
  app.post<{ Body: unknown }>('/api/v1/generate', async (request, reply) => {
    const result = await generateArtifacts(request.body);
    if (result.diagnostics.some(item => item.severity === 'error')) return reply.code(422).send(result);
    return result;
  });
  app.get('/openapi.json', async () => {
    const contract = dependencies.apiContract || JSON.parse(await readFile(resolve(process.cwd(), 'specs/contracts/process-ai-api.v1.openapi.json'), 'utf8')) as Record<string, any>;
    contract.components.schemas.ProcessSpec = await readSchema('contracts/process-spec.v1.schema.json');
    return contract;
  });
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'Falha na requisição');
    const requestError = error as Error & { statusCode?: number };
    const code = requestError.statusCode && requestError.statusCode < 500 ? requestError.statusCode : 500;
    return reply.code(code).send({ code: code === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST', message: code === 500 ? 'Erro interno' : requestError.message });
  });
  return app;
}

function sendConversationError(reply: { code: (status: number) => { send: (payload: unknown) => unknown } }, error: unknown) {
  if (error instanceof RevisionConflict) return reply.code(409).send({ code: 'REVISION_CONFLICT', message: error.message });
  if (error instanceof OperationConflict) return reply.code(409).send({ code: 'OPERATION_ID_CONFLICT', message: error.message });
  if (error instanceof StaleQuestionSet) return reply.code(409).send({ code: 'QUESTION_SET_STALE', message: error.message });
  if (error instanceof ConversationNotFound) return reply.code(404).send({ code: 'SESSION_NOT_FOUND', message: error.message });
  if (error instanceof ConversationServiceFailure) return reply.code(error.statusCode).send({ code: error.code, message: error.message, recovery: recoveryGuidance(error.code, error.retryAfterMs), ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}), ...(error.generationRunId ? { generationRunId: error.generationRunId } : {}), ...(error.providerDiagnostic ? { providerDiagnostic: { category: error.providerDiagnostic.category, ...(error.providerDiagnostic.httpStatus !== undefined ? { httpStatus: error.providerDiagnostic.httpStatus } : {}), ...(error.providerDiagnostic.providerCode ? { providerCode: error.providerDiagnostic.providerCode } : {}), ...(error.providerDiagnostic.providerType ? { providerType: error.providerDiagnostic.providerType } : {}), ...(error.providerDiagnostic.providerParam ? { providerParam: error.providerDiagnostic.providerParam } : {}), ...(error.providerDiagnostic.requestId ? { requestId: error.providerDiagnostic.requestId } : {}), ...(error.providerDiagnostic.summary ? { summary: error.providerDiagnostic.summary } : {}) } } : {}) });
  return reply.code(503).send({ code: 'PERSISTENCE_UNAVAILABLE', message: 'Não foi possível acessar a persistência configurada' });
}
