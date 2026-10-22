import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderFailure, type ModelProvider, type ProviderUsage, type StructuredRequest, type StructuredResponse } from './model-provider.js';

export type ClaudeCliOptions = {
  /** Executable name or absolute path; defaults to `claude` on PATH. */
  binary?: string;
  /** `--bare` skips OAuth/keychain and requires ANTHROPIC_API_KEY (pilot path with a corporate key). */
  bare?: boolean;
  /** Optional per-call ceiling forwarded as `--max-budget-usd`. */
  maxBudgetUsd?: number;
  budget?: { maxCalls?: number; maxTokens?: number };
  /** Test seam: replaces process spawning. */
  run?: (binary: string, args: string[], input: string, options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string; exitCode: number | null; timedOut: boolean }>;
};

/** Server-side secrets that the CLI never needs; the child process inherits everything else (auth, PATH, HOME). */
const withheldEnvironment = /^(DATABASE_URL|TEST_DATABASE_URL|POSTGRES_PASSWORD|EXTERNAL_AI_API_KEY)$/;

function runProcess(binary: string, args: string[], input: string, options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }) {
  return new Promise<{ stdout: string; exitCode: number | null; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, options.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    // stderr may echo prompt fragments; it is drained and intentionally not retained.
    child.stderr.resume();
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', exitCode => { clearTimeout(timer); resolve({ stdout, exitCode, timedOut }); });
    child.stdin.end(input);
  });
}

/**
 * Local Claude Code CLI as a structured-output provider. Each call runs in an empty temporary
 * directory with tools, MCP servers and setting sources disabled, so workspace CLAUDE.md files,
 * hooks and memories never reach the prompt. The CLI validates `structured_output` against the schema.
 */
export class ClaudeCliProvider implements ModelProvider {
  readonly id = 'claude-cli';
  private calls = 0;
  private tokens = 0;
  constructor(private readonly options: ClaudeCliOptions = {}) {}

  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    const { maxCalls = 0, maxTokens = 0 } = this.options.budget ?? {};
    if (maxCalls > 0 && this.calls >= maxCalls) throw new ProviderFailure('PROVIDER_REJECTED', 'Orçamento local de chamadas ao provedor esgotado', undefined, { category: 'budget' });
    if (maxTokens > 0 && this.tokens >= maxTokens) throw new ProviderFailure('PROVIDER_REJECTED', 'Orçamento local de tokens do provedor esgotado', undefined, { category: 'budget' });
    this.calls += 1;
    const args = ['-p', '--output-format', 'json', '--model', request.model, '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
      '--system-prompt', request.system, '--json-schema', JSON.stringify(cliSchemaEnvelope(request.outputSchema))];
    if (this.options.bare) args.push('--bare');
    if (this.options.maxBudgetUsd && this.options.maxBudgetUsd > 0) args.push('--max-budget-usd', String(this.options.maxBudgetUsd));
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !withheldEnvironment.test(name)));
    const workdir = await mkdtemp(join(tmpdir(), 'process-ai-claude-'));
    const started = Date.now();
    let completed: { stdout: string; exitCode: number | null; timedOut: boolean };
    try {
      completed = await (this.options.run ?? runProcess)(this.options.binary || 'claude', args, request.prompt, { cwd: workdir, timeoutMs: request.timeoutMs, env });
    } catch {
      throw new ProviderFailure('PROVIDER_UNAVAILABLE', 'Não foi possível iniciar o Claude Code CLI configurado', undefined, { category: 'network', latencyMs: Date.now() - started });
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
    const latencyMs = Date.now() - started;
    if (completed.timedOut) throw new ProviderFailure('PROVIDER_TIMEOUT', 'Tempo limite do provedor excedido', undefined, { category: 'timeout', latencyMs });
    let body: any;
    try { body = JSON.parse(completed.stdout); }
    catch { throw new ProviderFailure('PROVIDER_INVALID_RESPONSE', 'O Claude Code CLI não retornou JSON válido', undefined, { category: 'invalid_response', latencyMs, summary: `exit ${completed.exitCode}` }); }
    if (body?.is_error || body?.subtype !== 'success') {
      const status = Number(body?.api_error_status);
      const diagnostic = { category: status === 429 ? 'rate_limit' : status >= 500 ? 'upstream' : 'rejected', latencyMs, ...(Number.isInteger(status) ? { httpStatus: status } : {}), summary: `claude-cli ${typeof body?.subtype === 'string' ? body.subtype : 'error'}` };
      if (status === 429) throw new ProviderFailure('PROVIDER_RATE_LIMITED', 'Limite do provedor atingido', undefined, diagnostic);
      if (status >= 500) throw new ProviderFailure('PROVIDER_UNAVAILABLE', 'Provedor temporariamente indisponível', undefined, diagnostic);
      throw new ProviderFailure('PROVIDER_REJECTED', 'Provedor recusou a solicitação configurada', undefined, diagnostic);
    }
    const value = body.structured_output?.[envelopeKey];
    if (value === undefined || value === null) throw new ProviderFailure('PROVIDER_INVALID_RESPONSE', 'Conteúdo estruturado ausente na resposta do Claude Code CLI', undefined, { category: 'structured_output_mismatch', latencyMs });
    const usage = claudeUsage(body);
    this.tokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    return { value, usage, latencyMs, model: primaryModel(body) ?? request.model };
  }
}

const envelopeKey = 'response';

/**
 * The CLI sends `--json-schema` as a tool input schema: the root must be `type: object` without
 * oneOf/anyOf/allOf, and its validator does not load the draft 2020-12 meta-schema. The contract is
 * wrapped unchanged under one property; `$defs` move to the root so `#/$defs/...` references still resolve.
 */
export function cliSchemaEnvelope(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _metaSchema, $id: _id, $defs, ...contract } = structuredClone(schema) as Record<string, any>;
  return { type: 'object', properties: { [envelopeKey]: contract }, required: [envelopeKey], additionalProperties: false, ...($defs ? { $defs } : {}) };
}

function finite(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }

function claudeUsage(body: any): ProviderUsage {
  const usage = body.usage ?? {};
  const fresh = finite(usage.input_tokens) ?? 0;
  const cacheRead = finite(usage.cache_read_input_tokens) ?? 0;
  const cacheWrite = finite(usage.cache_creation_input_tokens) ?? 0;
  return {
    inputTokens: fresh + cacheRead + cacheWrite,
    outputTokens: finite(usage.output_tokens),
    cachedInputTokens: cacheRead,
    ...(finite(body.total_cost_usd) !== undefined ? { costUsd: finite(body.total_cost_usd) } : {}),
  };
}

/** The CLI may use a small helper model internally; report the one that produced most output. */
function primaryModel(body: any): string | undefined {
  const entries = Object.entries(body.modelUsage ?? {}) as Array<[string, any]>;
  entries.sort((left, right) => (finite(right[1]?.outputTokens) ?? 0) - (finite(left[1]?.outputTokens) ?? 0));
  return entries[0]?.[0];
}
