import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { JWTVerifyGetKey } from 'jose';
import { AuthFailure, createOidcAuthenticator } from './modules/security/auth.js';
import { requestContext, type RequestPrincipal } from './modules/security/request-context.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readEnvironment, type Environment } from './config/env.js';
import { getExample, listExamples } from './modules/examples/example.repository.js';
import { validateProcessSpec } from './modules/validation/validation.service.js';
import { readFoundationJson } from './shared/files.js';
import { readFoundationJson as readSchema } from './shared/files.js';
import { generateArtifacts } from './modules/generation/artifact-generator.js';
import { validateFormSubmission, validatePublicationReadiness } from './modules/validation/validation.service.js';
import { ConversationService, ConversationServiceFailure, type TurnHooks } from './modules/ai/conversation.service.js';
import { TurnEventBus, type TurnEvent } from './modules/ai/turn-events.js';
import { recoveryGuidance } from './modules/ai/recovery-guidance.js';
import { ConversationNotFound, OperationConflict, PostgresConversationRepository, RevisionConflict, StaleQuestionSet, type ConversationRepository } from './modules/projects/conversation.repository.js';
import type { ModelProvider } from './modules/providers/model-provider.js';

export type AppDependencies = { conversationRepository?: ConversationRepository; modelProvider?: ModelProvider; apiContract?: Record<string, any>; authKeys?: JWTVerifyGetKey };
declare module 'fastify' { interface FastifyRequest { principal?: RequestPrincipal } }
export async function buildApp(config: Environment = readEnvironment(), dependencies: AppDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel }, bodyLimit: 1024 * 1024 });
  const conversationRepository = dependencies.conversationRepository || (config.databaseUrl ? PostgresConversationRepository.fromConnectionString(config.databaseUrl) : undefined);
  const conversations = new ConversationService(config, conversationRepository, { provider: dependencies.modelProvider });
  const turnEvents = new TurnEventBus();
  await app.register(cors, { origin: config.corsOrigins, methods: ['GET', 'POST', 'PUT'] });
  await app.register(rateLimit, { global: false, hook: 'preHandler' });
  const turnLimit = { max: config.turnRateLimitPerMinute ?? 30, timeWindow: 60_000,
    keyGenerator: (request: FastifyRequest) => `${request.principal?.tenantId ?? ''}:${request.principal?.subject ?? request.ip}`,
    errorResponseBuilder: (_request: FastifyRequest, context: { max: number; ttl: number }) => ({ statusCode: 429, code: 'TURN_RATE_LIMITED', message: `Limite de ${context.max} gerações por minuto atingido`, retryAfterMs: context.ttl, recovery: recoveryGuidance('TURN_RATE_LIMITED', context.ttl) }) };

  // Identity: OIDC bearer token when configured; otherwise the local development tenant. The tenant always
  // comes from the server side (token claim or configuration), never from the browser.
  const authenticate = config.authMode === 'oidc' && config.oidc ? createOidcAuthenticator(config.oidc, dependencies.authKeys) : undefined;
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/') || request.method === 'OPTIONS') return;
    if (!authenticate) { request.principal = { tenantId: config.localTenantId, subject: 'local-dev', roles: [] }; return; }
    try { request.principal = await authenticate(request.headers.authorization); }
    catch (error) {
      const code = error instanceof AuthFailure ? error.code : 'AUTH_INVALID';
      return reply.code(401).send({ code, message: error instanceof AuthFailure ? error.message : 'Token inválido', recovery: recoveryGuidance(code) });
    }
    if (config.oidc?.writeRole && (request.method === 'POST' || request.method === 'PUT') && !request.principal.roles.includes(config.oidc.writeRole)) {
      return reply.code(403).send({ code: 'FORBIDDEN', message: 'Seu papel não permite alterar processos', recovery: recoveryGuidance('FORBIDDEN') });
    }
  });
  // Every API handler runs inside the caller's request context, which survives awaits and background turns.
  app.addHook('onRoute', route => {
    if (!route.url.startsWith('/api/v1/')) return;
    const handler = route.handler;
    route.handler = function (this: FastifyInstance, request, reply) {
      return request.principal ? requestContext.run(request.principal, () => handler.call(this, request, reply)) : handler.call(this, request, reply);
    } as typeof handler;
  });
  // Audit trail of state-changing calls: who, what, when and the outcome — never the request content.
  app.addHook('onResponse', async (request, reply) => {
    if (!conversationRepository || !request.principal || (request.method !== 'POST' && request.method !== 'PUT') || !request.url.startsWith('/api/v1/')) return;
    const params = (request.params ?? {}) as Record<string, string>;
    const sessionId = /^[0-9a-f-]{36}$/i.test(params.sessionId ?? '') ? params.sessionId : undefined;
    const details = Object.fromEntries(Object.entries({ revision: params.revision, requirementId: params.requirementId }).filter(([, value]) => value !== undefined));
    await conversationRepository.appendAudit({ tenantId: request.principal.tenantId, subject: request.principal.subject, action: `${request.method} ${request.routeOptions.url ?? request.url}`, ...(sessionId ? { sessionId } : {}), statusCode: reply.statusCode, details }).catch(() => { /* auditing never breaks a response */ });
  });
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
  app.post<{ Params: { sessionId: string }; Body: { text: string; baseRevision: number; operationId?: string; dataClassification?: 'synthetic' | 'public' } }>('/api/v1/design-sessions/:sessionId/messages', { config: { rateLimit: turnLimit } }, async (request, reply) => {
    return runTurn(turnEvents, request, reply, hooks => conversations.submitMessage(request.params.sessionId, request.body?.text, request.body?.baseRevision, request.body?.dataClassification, request.body?.operationId, hooks));
  });
  app.post<{ Params: { sessionId: string }; Body: { answers: string[]; baseRevision: number; questionSetId?: string; operationId?: string; dataClassification?: 'synthetic' | 'public' } }>('/api/v1/design-sessions/:sessionId/answers', { config: { rateLimit: turnLimit } }, async (request, reply) => {
    return runTurn(turnEvents, request, reply, hooks => conversations.answerQuestions(request.params.sessionId, request.body?.answers, request.body?.baseRevision, request.body?.dataClassification, request.body?.questionSetId, request.body?.operationId, hooks));
  });
  app.post<{ Params: { sessionId: string }; Body: { text: string; baseRevision: number; operationId?: string; dataClassification?: 'synthetic' | 'public' } }>('/api/v1/design-sessions/:sessionId/refinements', { config: { rateLimit: turnLimit } }, async (request, reply) => {
    try {
      const draft = await conversations.currentDraft(request.params.sessionId);
      if (!draft.processSpec) return reply.code(409).send({ code: 'DRAFT_NOT_FOUND', message: 'Aceite ou gere uma revisão inicial antes de refiná-la' });
    } catch (error) { return sendConversationError(reply, error); }
    return runTurn(turnEvents, request, reply, hooks => conversations.submitMessage(request.params.sessionId, request.body?.text, request.body?.baseRevision, request.body?.dataClassification, request.body?.operationId, hooks));
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
  app.put<{ Params: { sessionId: string; requirementId: string }; Body: { state: string } }>('/api/v1/design-sessions/:sessionId/requirements/:requirementId', async (request, reply) => {
    try { return await conversations.setRequirementState(request.params.sessionId, request.params.requirementId, request.body?.state); }
    catch (error) { return sendConversationError(reply, error); }
  });
  app.get<{ Params: { sessionId: string; revision: string }; Querystring: { against?: string } }>('/api/v1/design-sessions/:sessionId/revisions/:revision/diff', async (request, reply) => {
    try {
      const against = request.query.against === undefined ? undefined : Number(request.query.against);
      if (against !== undefined && (!Number.isInteger(against) || against < 0)) return reply.code(400).send({ code: 'REVISION_INVALID', message: 'against deve ser um número de revisão' });
      return await conversations.revisionDiff(request.params.sessionId, Number(request.params.revision), against);
    } catch (error) { return sendConversationError(reply, error); }
  });
  app.post<{ Params: { sessionId: string; revision: string }; Body: { baseRevision: number } }>('/api/v1/design-sessions/:sessionId/revisions/:revision/restore', async (request, reply) => {
    try { return await conversations.restoreRevision(request.params.sessionId, Number(request.params.revision), request.body?.baseRevision); }
    catch (error) { return sendConversationError(reply, error); }
  });
  app.get<{ Params: { runId: string } }>('/api/v1/generation-runs/:runId/events', async (request, reply) => {
    let persisted: Awaited<ReturnType<typeof conversations.run>>;
    try { persisted = await conversations.run(request.params.runId); }
    catch (error) { return sendConversationError(reply, error); }
    reply.hijack();
    const headers = Object.fromEntries(Object.entries(reply.getHeaders()).filter(([, value]) => value !== undefined)) as Record<string, string>;
    reply.raw.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const write = (event: TurnEvent | { type: 'status'; status: string }) => reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const finish = () => { clearInterval(heartbeat); unsubscribe(); if (!reply.raw.writableEnded) reply.raw.end(); };
    const heartbeat = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15000);
    let unsubscribe = () => {};
    request.raw.on('close', finish);
    if (turnEvents.has(persisted.id)) {
      unsubscribe = turnEvents.subscribe(persisted.id, event => { write(event); if (event.type !== 'stage') finish(); });
      return;
    }
    // No live stream (synchronous turn, finished long ago or another instance): answer from the persisted run.
    if (['validated', 'needs-input', 'validation-failed'].includes(persisted.status)) write({ type: 'result', result: { ...(persisted.result as Record<string, unknown> || {}), generationRunId: persisted.id, status: persisted.status } });
    else if (persisted.status === 'failed') { const code = persisted.errorCode || 'GENERATION_FAILED'; write({ type: 'error', error: { code, message: 'A geração terminou com falha; a revisão atual foi preservada', generationRunId: persisted.id, recovery: recoveryGuidance(code) } }); }
    else write({ type: 'status', status: persisted.status });
    finish();
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
    const requestError = error as Error & { statusCode?: number; code?: string };
    if (requestError.code === 'TURN_RATE_LIMITED') return reply.code(429).send(requestError);
    const code = requestError.statusCode && requestError.statusCode < 500 ? requestError.statusCode : 500;
    return reply.code(code).send({ code: code === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST', message: code === 500 ? 'Erro interno' : requestError.message });
  });
  return app;
}

/**
 * Synchronous by default (contract v1). With `Prefer: respond-async` the route answers 202 as soon as the
 * generation run exists and the turn continues in the background, published on the event bus for
 * GET /generation-runs/:id/events. Errors before the run exists (validation, conflicts) keep their status;
 * an idempotent replay returns its stored result directly.
 */
async function runTurn(turnEvents: TurnEventBus, request: { headers: Record<string, string | string[] | undefined> }, reply: FastifyReply, start: (hooks?: TurnHooks) => Promise<unknown>) {
  if (!/respond-async/i.test(String(request.headers.prefer ?? ''))) {
    try { return await start(); } catch (error) { return sendConversationError(reply, error); }
  }
  let runId: string | undefined;
  let created!: () => void;
  const runCreated = new Promise<'created'>(resolve => { created = () => resolve('created'); });
  const work = start({
    onRunCreated: id => { runId = id; turnEvents.open(id); created(); },
    onStage: diagnostic => { if (runId) turnEvents.publish(runId, { type: 'stage', stage: diagnostic.stage, status: diagnostic.status }); },
  });
  work.then(
    result => { if (runId) turnEvents.publish(runId, { type: 'result', result }); },
    error => {
      if (!runId) return;
      const { body } = conversationErrorBody(error);
      turnEvents.publish(runId, { type: 'error', error: { ...body, code: String(body.code), message: String(body.message), generationRunId: runId } });
    },
  );
  const first = await Promise.race([runCreated, work.then(() => 'settled' as const, () => 'settled' as const)]);
  if (first === 'created') return reply.code(202).send({ generationRunId: runId, status: 'generating' });
  try { return await work; } catch (error) { return sendConversationError(reply, error); }
}

/** Status and body of a conversation error; shared by JSON responses and SSE `error` events. */
function conversationErrorBody(error: unknown): { status: number; body: Record<string, unknown> } {
  const conflict = (code: string, message: string) => ({ status: 409, body: { code, message, recovery: recoveryGuidance(code) } });
  if (error instanceof RevisionConflict) return conflict('REVISION_CONFLICT', error.message);
  if (error instanceof OperationConflict) return conflict('OPERATION_ID_CONFLICT', error.message);
  if (error instanceof StaleQuestionSet) return conflict('QUESTION_SET_STALE', error.message);
  if (error instanceof ConversationNotFound) return { status: 404, body: { code: 'SESSION_NOT_FOUND', message: error.message } };
  if (error instanceof ConversationServiceFailure) return { status: error.statusCode, body: { code: error.code, message: error.message, recovery: recoveryGuidance(error.code, error.retryAfterMs), ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}), ...(error.generationRunId ? { generationRunId: error.generationRunId } : {}), ...(error.providerDiagnostic ? { providerDiagnostic: { category: error.providerDiagnostic.category, ...(error.providerDiagnostic.httpStatus !== undefined ? { httpStatus: error.providerDiagnostic.httpStatus } : {}), ...(error.providerDiagnostic.providerCode ? { providerCode: error.providerDiagnostic.providerCode } : {}), ...(error.providerDiagnostic.providerType ? { providerType: error.providerDiagnostic.providerType } : {}), ...(error.providerDiagnostic.providerParam ? { providerParam: error.providerDiagnostic.providerParam } : {}), ...(error.providerDiagnostic.requestId ? { requestId: error.providerDiagnostic.requestId } : {}), ...(error.providerDiagnostic.summary ? { summary: error.providerDiagnostic.summary } : {}) } } : {}) } };
  return { status: 503, body: { code: 'PERSISTENCE_UNAVAILABLE', message: 'Não foi possível acessar a persistência configurada' } };
}
function sendConversationError(reply: { code: (status: number) => { send: (payload: unknown) => unknown } }, error: unknown) {
  const { status, body } = conversationErrorBody(error);
  return reply.code(status).send(body);
}
