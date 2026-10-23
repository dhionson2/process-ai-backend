import Anthropic from '@anthropic-ai/sdk';
import { anthropicOutputSchema, ENVELOPE_KEY } from './schema-projection.js';
import { ProviderFailure, type ModelProvider, type ProviderDiagnostic, type ProviderUsage, type StructuredRequest, type StructuredResponse } from './model-provider.js';

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type MessagesClient = Pick<Anthropic['beta']['messages'], 'create'>;
export type AnthropicProviderOptions = {
  /** Omit to let the SDK resolve credentials (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile). */
  apiKey?: string;
  baseURL?: string;
  maxRetries?: number;
  /** Thinking depth; unset keeps the model default (medium on Opus 5.5 / Haiku 5.5, high on Sonnet 5.5). */
  effort?: AnthropicEffort;
  /** Server-side refusal fallback (`fallbacks: "default"`) on the models that support it; on by default. */
  fallbacks?: boolean;
  /** Test seam. */
  client?: { beta: { messages: MessagesClient } };
};

/** Models that accept `fallbacks: "default"` on the Claude API. */
const fallbackModels = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

/** List prices in USD per million tokens (platform pricing, Oct 2026); used only for the run's cost estimate. */
const pricing: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};
const CACHE_WRITE_MULTIPLIER = 1.25; // 5-minute ephemeral cache writes

export function estimateCostUsd(model: string, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number | undefined {
  const price = pricing[model] ?? pricing[Object.keys(pricing).find(id => model.startsWith(id)) ?? ''];
  if (!price) return undefined;
  const perToken = (rate: number, tokens: number) => rate * tokens / 1_000_000;
  return perToken(price.input, usage.input_tokens) + perToken(price.output, usage.output_tokens)
    + perToken(price.cacheRead, usage.cache_read_input_tokens ?? 0) + perToken(price.input * CACHE_WRITE_MULTIPLIER, usage.cache_creation_input_tokens ?? 0);
}

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const value = headers?.get?.('retry-after');
  const seconds = value === null || value === undefined ? NaN : Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : undefined;
}

function mapError(error: unknown, latencyMs: number): ProviderFailure {
  const diagnostic = (category: string, extra: Partial<ProviderDiagnostic> = {}): ProviderDiagnostic => ({ category, latencyMs, ...extra });
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ProviderFailure('PROVIDER_TIMEOUT', 'Tempo limite do provedor excedido', undefined, diagnostic('timeout'));
  if (error instanceof Anthropic.APIConnectionError) return new ProviderFailure('PROVIDER_UNAVAILABLE', 'Não foi possível conectar ao provedor configurado', undefined, diagnostic('network'));
  if (error instanceof Anthropic.APIError) {
    const requestId = typeof error.requestID === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(error.requestID) ? error.requestID : undefined;
    const base = { httpStatus: error.status, ...(requestId ? { requestId } : {}) };
    if (error instanceof Anthropic.RateLimitError) { const wait = retryAfterMs(error.headers); return new ProviderFailure('PROVIDER_RATE_LIMITED', 'Limite do provedor atingido', wait, diagnostic('rate_limit', { ...base, ...(wait !== undefined ? { retryAfterMs: wait } : {}) })); }
    if (error instanceof Anthropic.InternalServerError) return new ProviderFailure('PROVIDER_UNAVAILABLE', 'Provedor temporariamente indisponível', retryAfterMs(error.headers), diagnostic(error.status === 529 ? 'overloaded' : 'upstream', base));
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return new ProviderFailure('PROVIDER_REJECTED', 'Credencial do provedor recusada', undefined, diagnostic('authentication', base));
    if (error instanceof Anthropic.BadRequestError) return new ProviderFailure('PROVIDER_REJECTED', 'Provedor recusou a solicitação configurada', undefined, diagnostic(/schema/i.test(error.message) ? 'schema_rejected' : 'bad_request', base));
    return new ProviderFailure('PROVIDER_REJECTED', 'Provedor recusou a solicitação configurada', undefined, diagnostic('rejected', base));
  }
  return new ProviderFailure('PROVIDER_UNAVAILABLE', 'Falha inesperada no provedor configurado', undefined, diagnostic('unexpected'));
}

/**
 * Claude via the Anthropic Messages API with structured outputs (output_config.format). The system prompt
 * and the prompt's stable prefix (profile + knowledge) are cached; repairs reuse the same prefix. Sampling
 * parameters are never sent (current models reject them); depth is controlled by `effort`.
 */
export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic';
  private readonly messages: MessagesClient;
  constructor(private readonly options: AnthropicProviderOptions = {}) {
    this.messages = options.client?.beta.messages ?? new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL, maxRetries: options.maxRetries ?? 2 }).beta.messages;
  }

  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    const split = request.cacheablePrefixChars && request.cacheablePrefixChars > 0 && request.cacheablePrefixChars < request.prompt.length ? request.cacheablePrefixChars : 0;
    const content: Anthropic.Beta.BetaTextBlockParam[] = split
      ? [{ type: 'text', text: request.prompt.slice(0, split), cache_control: { type: 'ephemeral' } }, { type: 'text', text: request.prompt.slice(split) }]
      : [{ type: 'text', text: request.prompt }];
    const withFallback = this.options.fallbacks !== false && fallbackModels.has(request.model);
    const started = Date.now();
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.messages.create({
        model: request.model,
        max_tokens: request.maxOutputTokens,
        system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content }],
        output_config: { format: { type: 'json_schema', schema: anthropicOutputSchema(request.outputSchema) }, ...(this.options.effort ? { effort: this.options.effort } : {}) },
        ...(withFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      }, { timeout: request.timeoutMs }) as Anthropic.Beta.BetaMessage;
    } catch (error) { throw mapError(error, Date.now() - started); }
    const latencyMs = Date.now() - started;
    if (response.stop_reason === 'refusal') {
      const category = typeof response.stop_details?.category === 'string' ? response.stop_details.category : 'unspecified';
      throw new ProviderFailure('PROVIDER_REJECTED', 'O modelo recusou a solicitação', undefined, { category: 'refusal', latencyMs, summary: `refusal (${category.slice(0, 40)})` });
    }
    if (response.stop_reason === 'max_tokens') throw new ProviderFailure('PROVIDER_INVALID_RESPONSE', 'A resposta estruturada foi truncada pelo limite de tokens de saída', undefined, { category: 'token_limit', latencyMs });
    const text = response.content.filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text').map(block => block.text).join('');
    let parsed: any;
    try { parsed = JSON.parse(text); }
    catch { throw new ProviderFailure('PROVIDER_INVALID_RESPONSE', 'O provedor não retornou JSON válido', undefined, { category: 'invalid_response', latencyMs }); }
    const value = parsed?.[ENVELOPE_KEY];
    if (value === undefined || value === null) throw new ProviderFailure('PROVIDER_INVALID_RESPONSE', 'Conteúdo estruturado ausente na resposta do provedor', undefined, { category: 'structured_output_mismatch', latencyMs });
    const cacheRead = response.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = response.usage.cache_creation_input_tokens ?? 0;
    const costUsd = estimateCostUsd(response.model, response.usage);
    const usage: ProviderUsage = { inputTokens: response.usage.input_tokens + cacheRead + cacheWrite, outputTokens: response.usage.output_tokens, cachedInputTokens: cacheRead, ...(costUsd !== undefined ? { costUsd } : {}) };
    return { value, usage, latencyMs, model: response.model };
  }
}
