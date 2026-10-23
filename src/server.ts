import { buildApp } from './app.js';
import { readEnvironment } from './config/env.js';
import { startTelemetry } from './modules/observability/otel.js';
const env = readEnvironment();
const stopTelemetry = await startTelemetry();
const app = await buildApp(env);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().finally(() => stopTelemetry()).finally(() => process.exit(0)); });
try { await app.listen({ host: env.host, port: env.port }); }
catch (error) { app.log.error(error); process.exitCode = 1; }
