import { ProviderConcurrencyLimit, ProviderFailure, type ModelProvider, type ProviderUsage, type StructuredRequest, type StructuredResponse } from '../../providers/model-provider.js';
import { OrchestrationFailure } from './types.js';

export function mapProviderError(error: unknown): OrchestrationFailure {
  if (error instanceof ProviderFailure) return new OrchestrationFailure(error.code, error.message, ['PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_RATE_LIMITED'].includes(error.code), error.retryAfterMs, error.diagnostic);
  return new OrchestrationFailure('PROVIDER_UNAVAILABLE', 'Falha no provedor configurado', true);
}

function addUsage(a?: number, b?: number): number | undefined { return a === undefined && b === undefined ? undefined : (a || 0) + (b || 0); }
/** Sums every usage counter a provider reports; counters absent from both sides stay absent. */
export function accumulateUsage(target: ProviderUsage, next: ProviderUsage): void {
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'costUsd'] as const) {
    const sum = addUsage(target[key], next[key]);
    if (sum !== undefined) target[key] = sum;
  }
}

/**
 * Every model call of a turn goes through here: concurrency limit, the persistence hook that marks the
 * provider boundary, error mapping, and the running totals of latency and usage reported by the outcome.
 */
export class ModelCalls {
  readonly usage: ProviderUsage = {};
  latencyMs = 0;
  calls = 0;
  lastModel: string;
  constructor(
    private readonly provider: ModelProvider,
    private readonly concurrency: ProviderConcurrencyLimit,
    private readonly request: StructuredRequest,
    private readonly onProviderCallStart?: () => Promise<void> | void,
  ) { this.lastModel = request.model; }
  get providerId(): string { return this.provider.id; }

  async call(prompt: string): Promise<StructuredResponse> {
    await this.onProviderCallStart?.();
    let completion: StructuredResponse;
    try { completion = await this.concurrency.run(() => this.provider.generateStructured(prompt === this.request.prompt ? this.request : { ...this.request, prompt })); }
    catch (error) { throw mapProviderError(error); }
    this.calls += 1;
    this.latencyMs += completion.latencyMs;
    accumulateUsage(this.usage, completion.usage);
    this.lastModel = completion.model;
    return completion;
  }
}
