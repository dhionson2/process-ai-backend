export interface Environment {
  host: string;
  port: number;
  corsOrigins: string[];
  logLevel: string;
  databaseUrl?: string;
  localTenantId: string;
  aiProvider: 'disabled' | 'ollama' | 'openai-compatible' | 'claude-cli' | 'anthropic';
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
  /** Opt-in semantic grounding/reconciliation; legacy remains the default for comparison. */
  aiSemanticGroundingMode?: 'legacy' | 'controlled';
  aiGraphIrMode?: 'off' | 'shadow' | 'controlled';
  /** Deterministic readiness gate before a first proposal; `off` restores the previous generate-at-once behaviour. */
  aiReadinessGate?: 'on' | 'off';
  /** Scoreboard JSON served read-only to the UI (written by scripts/eval/run-eval.ts). */
  evaluationScoreboardPath?: string;
  /** Claude Code CLI provider (external): executable, `--bare` with ANTHROPIC_API_KEY, per-call USD ceiling. */
  claudeCliBinary?: string;
  claudeCliBare?: boolean;
  claudeCliMaxBudgetUsd?: number;
  /** Anthropic Messages API provider: thinking effort, server-side refusal fallback, SDK retries (429/5xx). */
  anthropicEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  anthropicFallbacks?: boolean;
  anthropicMaxRetries?: number;
  /** Model cascade: corrective calls (structural, omission, validation, repeated question) use this model. */
  aiRepairModel?: string;
  /** Flywheel: same-tenant accepted examples similar to the request enter the prompt as patterns (opt-in). */
  aiFewShot?: 'on' | 'off';
  /** Security for a pilot: OIDC bearer tokens (off = local development tenant), PII masking, per-user turn limit. */
  authMode?: 'off' | 'oidc';
  oidc?: { issuer: string; audience: string; jwksUrl?: string; tenantClaim: string; rolesClaim: string; writeRole?: string };
  piiMasking?: 'on' | 'off';
  turnRateLimitPerMinute?: number;
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
  if (!['disabled', 'ollama', 'openai-compatible', 'claude-cli', 'anthropic'].includes(aiProvider)) throw new Error('AI_PROVIDER inválido');
  const externalAiStructuredOutput = env.EXTERNAL_AI_STRUCTURED_OUTPUT || 'json-object';
  if (!['json-object', 'json-schema-strict'].includes(externalAiStructuredOutput)) throw new Error('EXTERNAL_AI_STRUCTURED_OUTPUT inválido');
  const aiSemanticGroundingMode = env.AI_SEMANTIC_GROUNDING_MODE || 'legacy';
  if (!['legacy', 'controlled'].includes(aiSemanticGroundingMode)) throw new Error('AI_SEMANTIC_GROUNDING_MODE inválido');
  const aiGraphIrMode = env.AI_GRAPH_IR_MODE || 'off';
  if (!['off', 'shadow', 'controlled'].includes(aiGraphIrMode)) throw new Error('AI_GRAPH_IR_MODE inválido');
  const anthropicEffort = env.ANTHROPIC_EFFORT || undefined;
  if (anthropicEffort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(anthropicEffort)) throw new Error('ANTHROPIC_EFFORT inválido');
  const authMode = env.AUTH_MODE || 'off';
  if (!['off', 'oidc'].includes(authMode)) throw new Error('AUTH_MODE inválido');
  if (authMode === 'oidc' && (!env.OIDC_ISSUER || !env.OIDC_AUDIENCE)) throw new Error('AUTH_MODE=oidc exige OIDC_ISSUER e OIDC_AUDIENCE');
  const piiMasking = env.PII_MASKING || 'on';
  if (!['on', 'off'].includes(piiMasking)) throw new Error('PII_MASKING inválido');
  const aiFewShot = env.AI_FEW_SHOT || 'off';
  if (!['on', 'off'].includes(aiFewShot)) throw new Error('AI_FEW_SHOT inválido');
  const aiReadinessGate = env.AI_READINESS_GATE || 'on';
  if (!['on', 'off'].includes(aiReadinessGate)) throw new Error('AI_READINESS_GATE inválido');
  const claudeCliMaxBudgetUsd = Number(env.CLAUDE_CLI_MAX_BUDGET_USD ?? 0);
  if (!Number.isFinite(claudeCliMaxBudgetUsd) || claudeCliMaxBudgetUsd < 0 || claudeCliMaxBudgetUsd > 10) throw new Error('CLAUDE_CLI_MAX_BUDGET_USD inválido');
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
    aiSemanticGroundingMode: aiSemanticGroundingMode as Environment['aiSemanticGroundingMode'],
    aiGraphIrMode: aiGraphIrMode as Environment['aiGraphIrMode'],
    aiReadinessGate: aiReadinessGate as Environment['aiReadinessGate'],
    evaluationScoreboardPath: env.EVALUATION_SCOREBOARD_PATH || 'reports/eval/scoreboard.json',
    anthropicEffort: anthropicEffort as Environment['anthropicEffort'],
    anthropicFallbacks: env.ANTHROPIC_FALLBACKS !== 'off',
    anthropicMaxRetries: boundedInteger(env.ANTHROPIC_MAX_RETRIES, 2, 0, 5, 'ANTHROPIC_MAX_RETRIES'),
    aiRepairModel: env.AI_REPAIR_MODEL || undefined,
    aiFewShot: aiFewShot as Environment['aiFewShot'],
    authMode: authMode as Environment['authMode'],
    ...(authMode === 'oidc' ? { oidc: { issuer: env.OIDC_ISSUER!, audience: env.OIDC_AUDIENCE!, jwksUrl: env.OIDC_JWKS_URL || undefined, tenantClaim: env.OIDC_TENANT_CLAIM || 'tenant', rolesClaim: env.OIDC_ROLES_CLAIM || 'roles', writeRole: env.OIDC_WRITE_ROLE || undefined } } : {}),
    piiMasking: piiMasking as Environment['piiMasking'],
    turnRateLimitPerMinute: boundedInteger(env.TURN_RATE_LIMIT_PER_MINUTE, 30, 1, 1000, 'TURN_RATE_LIMIT_PER_MINUTE'),
    claudeCliBinary: env.CLAUDE_CLI_BINARY || undefined,
    claudeCliBare: env.CLAUDE_CLI_BARE === 'true',
    claudeCliMaxBudgetUsd: claudeCliMaxBudgetUsd || undefined,
  };
}
