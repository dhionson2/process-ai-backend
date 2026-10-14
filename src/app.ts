import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import { readEnvironment, type Environment } from './config/env.js';
import { getExample, listExamples } from './modules/examples/example.repository.js';
import { validateProcessSpec } from './modules/validation/validation.service.js';
import { readFoundationJson } from './shared/files.js';

export async function buildApp(config: Environment = readEnvironment()): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel }, bodyLimit: 1024 * 1024 });
  await app.register(cors, { origin: config.corsOrigins, methods: ['GET', 'POST'] });
  app.get('/health', async () => ({ status: 'ok', service: 'process-ai-backend', version: '0.1.0' }));
  app.get('/api/v1/capabilities', async () => ({
    targetProfile: 'generic-bpmn2',
    mode: 'preview-only',
    aiEnabled: false,
    executionEnabled: false,
    supportedNodes: ['startEvent', 'endEvent', 'userTask', 'serviceTask', 'exclusiveGateway'],
    catalog: await readFoundationJson('contracts/mock-capability-catalog.json'),
  }));
  app.get('/api/v1/examples', async () => listExamples());
  app.get<{ Params: { id: string } }>('/api/v1/examples/:id', async (request, reply) => {
    if (!['ferias', 'http-db'].includes(request.params.id)) return reply.code(404).send({ code: 'EXAMPLE_NOT_FOUND', message: 'Exemplo não encontrado' });
    return getExample(request.params.id as 'ferias' | 'http-db');
  });
  app.post<{ Body: unknown }>('/api/v1/validate', async (request) => validateProcessSpec(request.body));
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'Falha na requisição');
    const code = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    return reply.code(code).send({ code: code === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST', message: code === 500 ? 'Erro interno' : error.message });
  });
  return app;
}
