import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trace } from '@opentelemetry/api';
import { tracing } from '@opentelemetry/sdk-node';
import { readEnvironment } from '../src/config/env.js';
import { AiOrchestrator } from '../src/modules/ai/orchestrator.js';
import { startTelemetry } from '../src/modules/observability/otel.js';
import type { ModelProvider, StructuredRequest, StructuredResponse } from '../src/modules/providers/model-provider.js';

const exporter = new tracing.InMemorySpanExporter();
trace.setGlobalTracerProvider(new tracing.BasicTracerProvider({ spanProcessors: [new tracing.SimpleSpanProcessor(exporter)] }));

class Scripted implements ModelProvider {
  readonly id = 'scripted-otel';
  constructor(private readonly responses: unknown[]) {}
  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    return { value: this.responses.shift(), usage: { inputTokens: 900, outputTokens: 80, cachedInputTokens: 600, costUsd: 0.004 }, latencyMs: 7, model: request.model };
  }
}
const secret = 'Texto do solicitante com dado sensível 123.456.789-00';

test('cada turno vira um span com etapas, tokens, custo e modelo, sem texto do usuário', async () => {
  exporter.reset();
  const clarification = { kind: 'need_clarification', questions: [{ question: 'Quem aprova?', blocking: true }], summary: 'Falta o aprovador.' };
  await new AiOrchestrator(new Scripted([clarification]), 'modelo-x', readEnvironment({ LOG_LEVEL: 'silent' })).generate({ text: secret, history: [] });
  const [span] = exporter.getFinishedSpans();
  assert.equal(span.name, 'process_ai.turn');
  assert.equal(span.attributes['ai.provider'], 'scripted-otel');
  assert.equal(span.attributes['ai.outcome'], 'need_clarification');
  assert.equal(span.attributes['ai.tokens.cached'], 600);
  assert.equal(span.attributes['ai.cost_usd'], 0.004);
  assert.equal(span.attributes['ai.questions'], 1);
  assert.ok(span.events.some(event => event.name === 'model-call:started'));
  assert.ok(span.events.some(event => event.name === 'provider:received'));
  assert.doesNotMatch(JSON.stringify({ attributes: span.attributes, events: span.events }), /sensível|123\.456/, 'nenhum texto do usuário no span');
});

test('falha do turno marca o span com erro e o código', async () => {
  exporter.reset();
  await assert.rejects(() => new AiOrchestrator(new Scripted([{ kind: 'x' }, { kind: 'y' }]), 'modelo-x', readEnvironment({ LOG_LEVEL: 'silent' })).generate({ text: 'Pedido.', history: [] }));
  const [span] = exporter.getFinishedSpans();
  assert.equal(span.status.code, 2);
  assert.equal(span.attributes['ai.error_code'], 'MODEL_PLAN_INVALID');
});

test('sem OTEL_EXPORTER_OTLP_ENDPOINT a telemetria não inicia nada', async () => {
  const stop = await startTelemetry({});
  await stop();
});
