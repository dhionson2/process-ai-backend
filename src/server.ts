import { buildApp } from './app.js';
import { readEnvironment } from './config/env.js';
const env = readEnvironment();
const app = await buildApp(env);
try { await app.listen({ host: env.host, port: env.port }); }
catch (error) { app.log.error(error); process.exitCode = 1; }
