import type { GenerationRun } from '../projects/conversation.repository.js';

type Json = any;

export type RunTelemetry = {
  id: string; status: string; provider?: string; model?: string; createdAt: string;
  latencyMs: number; calls: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; costUsd: number | null;
  repairAttempts: number; stages: Array<{ stage: string; status: string }>; errorCode?: string;
};

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Per-turn cost, token and pipeline view of a session, built only from persisted run metrics (no prompts). */
export function sessionTelemetry(runs: GenerationRun[]) {
  const items: RunTelemetry[] = runs.map(run => {
    const metrics: Json = run.metrics ?? {};
    const usage: Json = metrics.usage ?? {};
    const pipeline: Json[] = Array.isArray(metrics.pipeline) ? metrics.pipeline : [];
    const repairAttempts = finite(metrics.repairAttempts) ?? 0;
    const providerCalls = pipeline.filter(item => item?.stage === 'provider').length + pipeline.filter(item => /^(repair|recovery)-|^omission-repair$/.test(String(item?.status))).length;
    return {
      id: run.id, status: run.status, provider: run.provider, model: metrics.model ?? run.model, createdAt: run.createdAt,
      latencyMs: finite(metrics.latencyMs) ?? 0,
      calls: providerCalls || (run.providerStartedAt ? 1 + repairAttempts : 0),
      inputTokens: finite(usage.inputTokens) ?? 0,
      cachedInputTokens: finite(usage.cachedInputTokens) ?? 0,
      outputTokens: finite(usage.outputTokens) ?? 0,
      costUsd: finite(usage.costUsd) ?? null,
      repairAttempts,
      stages: pipeline.filter(item => item?.stage && item?.status).map(item => ({ stage: String(item.stage), status: String(item.status) })),
      ...(run.errorCode ? { errorCode: run.errorCode } : {}),
    };
  });
  const sum = (key: 'latencyMs' | 'calls' | 'inputTokens' | 'cachedInputTokens' | 'outputTokens') => items.reduce((total, item) => total + item[key], 0);
  const costs = items.map(item => item.costUsd).filter((cost): cost is number => cost !== null);
  const inputTokens = sum('inputTokens');
  return {
    runs: items,
    totals: {
      runs: items.length,
      validated: items.filter(item => item.status === 'validated').length,
      calls: sum('calls'), latencyMs: sum('latencyMs'),
      inputTokens, cachedInputTokens: sum('cachedInputTokens'), outputTokens: sum('outputTokens'),
      cacheHitRate: inputTokens ? sum('cachedInputTokens') / inputTokens : 0,
      costUsd: costs.length ? costs.reduce((total, cost) => total + cost, 0) : null,
    },
  };
}
