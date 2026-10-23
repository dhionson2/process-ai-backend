import { ProviderConcurrencyLimit, ProviderFailure, type ModelProvider, type ProviderUsage, type StructuredRequest, type StructuredResponse } from '../../providers/model-provider.js';
import { OrchestrationFailure, type PipelineDiagnostic } from './types.js';

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
    /** Receives `model-call: started` before each call, so progress shows the model is working. */
    private readonly trace?: PipelineDiagnostic[],
    /** Model cascade: corrective calls escalate to this model when set. */
    private readonly repairModel?: string,
  ) { this.lastModel = request.model; }
  get providerId(): string { return this.provider.id; }

  async call(prompt: string, purpose: 'primary' | 'repair' = 'primary'): Promise<StructuredResponse> {
    const model = purpose === 'repair' && this.repairModel ? this.repairModel : this.request.model;
    await this.onProviderCallStart?.();
    this.trace?.push({ stage: 'model-call', status: 'started', details: { call: this.calls + 1, purpose, model } });
    let completion: StructuredResponse;
    try { completion = await this.concurrency.run(() => this.provider.generateStructured(prompt === this.request.prompt && model === this.request.model ? this.request : { ...this.request, prompt, model })); }
    catch (error) { throw mapProviderError(error); }
    this.calls += 1;
    this.latencyMs += completion.latencyMs;
    accumulateUsage(this.usage, completion.usage);
    this.lastModel = completion.model;
    return completion;
  }
}
