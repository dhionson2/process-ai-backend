export interface Environment {
  host: string;
  port: number;
  corsOrigins: string[];
  logLevel: string;
}
export function readEnvironment(env: NodeJS.ProcessEnv = process.env): Environment {
  const port = Number(env.PORT ?? 3333);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida');
  return {
    host: env.HOST || '127.0.0.1',
    port,
    corsOrigins: (env.CORS_ORIGIN || 'http://localhost:5173').split(',').map(x => x.trim()).filter(Boolean),
    logLevel: env.LOG_LEVEL || 'info',
  };
}
