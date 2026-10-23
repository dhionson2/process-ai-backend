import { trace } from '@opentelemetry/api';

/**
 * OpenTelemetry is opt-in: without OTEL_EXPORTER_OTLP_ENDPOINT the API stays a no-op and nothing is exported.
 * With it, spans go over OTLP/HTTP (the Datadog agent and any OpenTelemetry collector accept it). Only manual
 * spans are produced — no auto-instrumentation — and they carry stage names, counts, models and codes, never
 * prompts, user text or model output.
 */
export async function startTelemetry(env: NodeJS.ProcessEnv = process.env): Promise<() => Promise<void>> {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) return async () => {};
  const [{ NodeSDK }, { OTLPTraceExporter }] = await Promise.all([import('@opentelemetry/sdk-node'), import('@opentelemetry/exporter-trace-otlp-http')]);
  const sdk = new NodeSDK({ serviceName: env.OTEL_SERVICE_NAME || 'process-ai-backend', traceExporter: new OTLPTraceExporter() });
  sdk.start();
  return () => sdk.shutdown();
}

export const tracer = () => trace.getTracer('process-ai-backend', '0.1.0');
