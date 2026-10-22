import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { checkGate, ReplayProvider, replayEnvironment, runCorpus, type Cassette, type GateThresholds } from '../scripts/eval/run-eval.js';
import { scenarios } from '../scripts/eval/scenarios.js';

const cassettePath = 'reports/eval/cassettes/claude-cli_sonnet.json';

test('gate de qualidade: o corpus completo reexecutado contra a cassete gravada cumpre os limites', { skip: !existsSync(cassettePath) && 'Sem cassete gravada; rode npm run eval:claude.' }, async () => {
  const cassette = JSON.parse(await readFile(cassettePath, 'utf8')) as Cassette;
  const gate = JSON.parse(await readFile('scripts/eval/gate.json', 'utf8')) as GateThresholds;
  const replay = new ReplayProvider(cassette);
  const { summary, results } = await runCorpus({ provider: replay, environment: replayEnvironment(), selected: scenarios, maxCalls: scenarios.length * 4, replay });
  const failures = checkGate(summary, gate, replay.stalePrompts);
  assert.deepEqual(failures, [], `Gate reprovado. Cenários: ${results.filter(item => !item.pass).map(item => `${item.id}: ${item.failureReasons.join('; ')}`).join(' | ')}`);
});

test('replay acusa prompt alterado e cassete esgotada em vez de passar em silêncio', async () => {
  const scenario = scenarios.find(item => item.id === 'S09-sem-decisao')!;
  const cassette: Cassette = { recordedAt: 'x', provider: 'p', model: 'm', scenarios: { [scenario.id]: [{ promptSha256: 'prompt-antigo', value: { kind: 'need_clarification', questions: [{ question: 'Quem registra?', blocking: true }] }, model: 'm', usage: {}, latencyMs: 1 }] } };
  const replay = new ReplayProvider(cassette);
  const { results } = await runCorpus({ provider: replay, environment: replayEnvironment(), selected: [scenario], maxCalls: 4, replay });
  assert.equal(replay.stalePrompts, 1, 'hash de prompt divergente é contado');
  assert.match(results[0].outcome, /PROVIDER_INVALID_RESPONSE/, 'chamada além do gravado falha explicitamente');
  const perfect = { scenarios: 1, passed: 1, passRate: 1, validRate: 1, meanCoverage: 1, inventedElements: 0, repeatedQuestions: 0, calls: 1, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, meanLatencyMs: 0, totalCostUsd: null, costPerValidProcessUsd: null, tokensPerScenario: 0 };
  const failures = checkGate(perfect, { minPassed: 1, minValidRate: 1, maxInvented: 0, maxRepeatedQuestions: 0 }, replay.stalePrompts);
  assert.match(failures[0], /prompt\(s\) mudaram/);
});
