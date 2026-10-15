import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { readEnvironment } from '../../src/config/env.js';
import { buildApp } from '../../src/app.js';
import { runMigrations } from '../../src/modules/projects/migration.runner.js';
import { PostgresConversationRepository } from '../../src/modules/projects/conversation.repository.js';
import type { ModelProvider, StructuredRequest, StructuredResponse } from '../../src/modules/providers/model-provider.js';

const environment = readEnvironment(process.env);
if (!environment.databaseUrl) throw new Error('DATABASE_URL deve apontar para o PostgreSQL descartável da demonstração.');
const database = new URL(environment.databaseUrl);
if (database.hostname !== '127.0.0.1' || database.port !== '55432' || database.pathname !== '/processai_v2c1') {
  throw new Error('Servidor fixture exige o banco descartável local processai_v2c1 em 127.0.0.1:55432.');
}
if (environment.port !== 3334) throw new Error('Servidor fixture da demonstração usa a porta local 3334.');
const fixture = JSON.parse(await readFile(new URL('./graph-ir-approval.fixture.json', import.meta.url), 'utf8'));
const provider: ModelProvider = {
  id: 'simulated-graph-ir-fixture',
  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    return { value: structuredClone(fixture), usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 1, model: `${request.model}-fixture` };
  },
};
const migrationPool = new Pool({ connectionString: environment.databaseUrl, max: 1 });
await runMigrations(migrationPool);
await migrationPool.end();
const repository = PostgresConversationRepository.fromConnectionString(environment.databaseUrl);
const app = await buildApp({ ...environment, aiGraphIrMode: 'controlled' }, { conversationRepository: repository, modelProvider: provider });
await app.listen({ host: '127.0.0.1', port: 3334 });
process.stdout.write('Fixture GraphIR server ready at http://127.0.0.1:3334 (simulated provider; disposable PostgreSQL only).\n');
const shutdown = async () => { await app.close(); process.exit(0); };
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
