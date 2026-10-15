export interface Environment {
  host: string;
  port: number;
  corsOrigins: string[];
  logLevel: string;
  databaseUrl?: string;
  localTenantId: string;
  aiProvider: 'disabled' | 'ollama' | 'openai-compatible';
  aiModel?: string;
  ollamaBaseUrl: string;
  externalAiBaseUrl?: string;
  externalAiApiKey?: string;
  externalAiApproved: boolean;
  aiTimeoutMs: number;
  aiContextTokens: number;
  aiMaxOutputTokens: number;
  aiMaxInputChars: number;
  aiMaxConcurrency: number;
  externalAiStructuredOutput: 'json-object' | 'json-schema-strict';
  aiMaxProviderCalls: number;
  aiMaxProviderTokens: number;
}
function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} inválido`);
  return value;
}
export function readEnvironment(env: NodeJS.ProcessEnv = process.env): Environment {
  const port = Number(env.PORT ?? 3333);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida');
  const aiProvider = env.AI_PROVIDER || 'disabled';
  if (!['disabled', 'ollama', 'openai-compatible'].includes(aiProvider)) throw new Error('AI_PROVIDER inválido');
  const externalAiStructuredOutput = env.EXTERNAL_AI_STRUCTURED_OUTPUT || 'json-object';
  if (!['json-object', 'json-schema-strict'].includes(externalAiStructuredOutput)) throw new Error('EXTERNAL_AI_STRUCTURED_OUTPUT inválido');
  const ollamaBaseUrl = env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  const externalAiBaseUrl = env.EXTERNAL_AI_BASE_URL;
  for (const candidate of [ollamaBaseUrl, externalAiBaseUrl].filter(Boolean) as string[]) {
    const endpoint = new URL(candidate);
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('URL de provider deve usar HTTP(S)');
  }
  return {
    host: env.HOST || '127.0.0.1',
    port,
    corsOrigins: (env.CORS_ORIGIN || 'http://localhost:5173').split(',').map(x => x.trim()).filter(Boolean),
    logLevel: env.LOG_LEVEL || 'info',
    databaseUrl: env.DATABASE_URL || undefined,
    localTenantId: env.LOCAL_TENANT_ID || 'local-dev',
    aiProvider: aiProvider as Environment['aiProvider'],
    aiModel: env.AI_MODEL || undefined,
    ollamaBaseUrl,
    externalAiBaseUrl,
    externalAiApiKey: env.EXTERNAL_AI_API_KEY || undefined,
    externalAiApproved: env.EXTERNAL_AI_APPROVED === 'true',
    aiTimeoutMs: boundedInteger(env.AI_TIMEOUT_MS, 60000, 1000, 180000, 'AI_TIMEOUT_MS'),
    aiContextTokens: boundedInteger(env.AI_CONTEXT_TOKENS, 8192, 4096, 32768, 'AI_CONTEXT_TOKENS'),
    aiMaxOutputTokens: boundedInteger(env.AI_MAX_OUTPUT_TOKENS, 4096, 128, 16384, 'AI_MAX_OUTPUT_TOKENS'),
    aiMaxInputChars: boundedInteger(env.AI_MAX_INPUT_CHARS, 40000, 1000, 40000, 'AI_MAX_INPUT_CHARS'),
    aiMaxConcurrency: boundedInteger(env.AI_MAX_CONCURRENCY, 2, 1, 16, 'AI_MAX_CONCURRENCY'),
    externalAiStructuredOutput: externalAiStructuredOutput as Environment['externalAiStructuredOutput'],
    aiMaxProviderCalls: boundedInteger(env.AI_MAX_PROVIDER_CALLS, 0, 0, 100, 'AI_MAX_PROVIDER_CALLS'),
    aiMaxProviderTokens: boundedInteger(env.AI_MAX_PROVIDER_TOKENS, 0, 0, 1000000, 'AI_MAX_PROVIDER_TOKENS'),
  };
}
