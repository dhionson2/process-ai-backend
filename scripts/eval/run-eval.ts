/**
 * Evaluation scoreboard: runs the synthetic corpus through the real Fastify API (in-memory repository),
 * answers clarification questions from scripted answers and scores the resulting ProcessSpec.
 *
 *   node --env-file-if-exists=.env --import tsx scripts/eval/run-eval.ts --provider claude-cli --model sonnet --approve-external
 *   node --import tsx scripts/eval/run-eval.ts --provider ollama --model qwen2.5:3b-instruct
 *   node --import tsx scripts/eval/run-eval.ts --rebuild   (only regenerates the scoreboard from saved runs)
 *
 * External providers require --approve-external and receive only synthetic text (dataClassification=synthetic).
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildApp } from '../../src/app.js';
import { readEnvironment } from '../../src/config/env.js';
import { configuredProvider } from '../../src/modules/ai/provider.factory.js';
import { InMemoryConversationRepository } from '../../src/modules/projects/conversation.repository.js';
import type { ModelProvider, StructuredRequest, StructuredResponse } from '../../src/modules/providers/model-provider.js';
import { scenarios, type EvalScenario } from './scenarios.js';

type CallRecord = { latencyMs: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; costUsd?: number; failed?: string };
type ScenarioResult = {
  id: string; title: string; outcome: string; pass: boolean; failureReasons: string[];
  clarificationRounds: number; questionsAsked: number; repeatedQuestions: number; askedFirst: boolean;
  coverage: { activities: string; roles: string; decisions: string; ratio: number };
  forbiddenHits: string[]; unexpectedTasks: string[];
  calls: number; latencyMs: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; costUsd: number | null;
  errorCode?: string;
  /** Kept so the scoreboard can be re-scored offline. Synthetic content only. */
  spec?: unknown;
};

const argv = process.argv.slice(2);
const option = (name: string) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined; };
const flag = (name: string) => argv.includes(`--${name}`);
const evalDirectory = resolve('reports/eval');
const runsDirectory = resolve(evalDirectory, 'runs');

class RecordingProvider implements ModelProvider {
  readonly calls: CallRecord[] = [];
  constructor(private readonly inner: ModelProvider, private readonly maxCalls: number) {}
  get id() { return this.inner.id; }
  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    if (this.calls.length >= this.maxCalls) throw new Error(`Limite de ${this.maxCalls} chamadas da avaliação atingido`);
    const started = Date.now();
    try {
      const response = await this.inner.generateStructured(request);
      this.calls.push({ latencyMs: response.latencyMs, inputTokens: response.usage.inputTokens ?? 0, cachedInputTokens: response.usage.cachedInputTokens ?? 0, outputTokens: response.usage.outputTokens ?? 0, costUsd: response.usage.costUsd });
      return response;
    } catch (error) {
      this.calls.push({ latencyMs: Date.now() - started, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, failed: (error as any)?.code || 'ERROR' });
      throw error;
    }
  }
}

export function normalize(value: string): string { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
/** Stems match at the start of a word, so 'licitacao' does not match inside 'solicitacao'. Stems are plain [a-z ] text. */
const hasStem = (text: string, stem: string) => new RegExp(`(^|[^a-z0-9])${stem}`).test(text);

export function scoreSpec(scenario: EvalScenario, spec: any) {
  const tasks: string[] = (spec?.nodes ?? []).filter((node: any) => node.type === 'userTask' || node.type === 'serviceTask').map((node: any) => String(node.name ?? ''));
  const roles: string[] = (spec?.roles ?? []).map((role: any) => String(role.label ?? role.id ?? ''));
  const decisions = (spec?.nodes ?? []).filter((node: any) => node.type === 'exclusiveGateway' && (spec.flows ?? []).filter((flow: any) => flow.source === node.id).length > 1).length;
  const taskText = tasks.map(normalize);
  const roleText = roles.map(normalize);
  const activitiesMet = scenario.expect.activities.filter(stems => taskText.some(name => stems.some(stem => hasStem(name, stem)))).length;
  const rolesMet = scenario.expect.roles.filter(stems => roleText.some(label => stems.some(stem => hasStem(label, stem)))).length;
  const decisionsOk = decisions >= scenario.expect.minDecisions && (scenario.expect.minDecisions > 0 || decisions === 0);
  const expectedStems = scenario.expect.activities.flat();
  const forbiddenHits = (scenario.expect.forbidden ?? []).filter(stem => taskText.some(name => hasStem(name, stem)));
  const unexpectedTasks = tasks.filter((_, index) => !expectedStems.some(stem => hasStem(taskText[index], stem)));
  const total = scenario.expect.activities.length + scenario.expect.roles.length + 1;
  const ratio = (activitiesMet + rolesMet + (decisionsOk ? 1 : 0)) / total;
  return {
    coverage: { activities: `${activitiesMet}/${scenario.expect.activities.length}`, roles: `${rolesMet}/${scenario.expect.roles.length}`, decisions: `${decisions}/${scenario.expect.minDecisions}${scenario.expect.minDecisions === 0 ? ' (nenhuma)' : '+'}`, ratio },
    complete: activitiesMet === scenario.expect.activities.length && rolesMet === scenario.expect.roles.length && decisionsOk,
    forbiddenHits, unexpectedTasks,
  };
}

function answerFor(scenario: EvalScenario, question: string): string {
  return scenario.answers?.find(candidate => candidate.when.test(question))?.answer ?? scenario.fallback ?? 'Não há regra adicional além do que já foi descrito.';
}

async function runScenario(app: Awaited<ReturnType<typeof buildApp>>, recorder: RecordingProvider, scenario: EvalScenario): Promise<ScenarioResult> {
  const callStart = recorder.calls.length;
  const asked: string[] = [];
  let repeatedQuestions = 0;
  let rounds = 0;
  let askedFirst = false;
  let body: any;
  const project = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: `Eval ${scenario.id}`, targetProfile: 'generic-bpmn2' } });
  const sessionId = project.json().sessionId;
  let response = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text: scenario.text, baseRevision: 0, dataClassification: 'synthetic' } });
  body = response.json();
  askedFirst = body.status === 'needs-input';
  while (body.status === 'needs-input' && rounds < 2) {
    rounds += 1;
    const questions: string[] = (body.questions ?? []).map((question: any) => String(question.question ?? question));
    for (const question of questions) { if (asked.some(previous => normalize(previous) === normalize(question))) repeatedQuestions += 1; asked.push(question); }
    response = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/answers`, payload: { answers: questions.map(question => answerFor(scenario, question)), baseRevision: 0, questionSetId: body.questionSetId, dataClassification: 'synthetic' } });
    body = response.json();
  }
  const calls = recorder.calls.slice(callStart);
  const usage = {
    calls: calls.length,
    latencyMs: calls.reduce((sum, call) => sum + call.latencyMs, 0),
    inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0),
    cachedInputTokens: calls.reduce((sum, call) => sum + call.cachedInputTokens, 0),
    outputTokens: calls.reduce((sum, call) => sum + call.outputTokens, 0),
    costUsd: calls.some(call => call.costUsd !== undefined) ? calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0) : null,
  };
  const outcome = body.status ?? (body.code ? `error:${body.code}` : `http-${response.statusCode}`);
  let spec: unknown;
  if (outcome === 'validated') {
    // The public turn result omits the ProcessSpec; it lives in the newest proposed revision.
    const { revisions } = (await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}/revisions` })).json() as { revisions: Array<{ revision: number }> };
    const latest = Math.max(...revisions.map(item => item.revision));
    spec = (await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}/revisions/${latest}` })).json().processSpec;
  }
  return scoreResult(scenario, { id: scenario.id, title: scenario.title, outcome, clarificationRounds: rounds, questionsAsked: asked.length, repeatedQuestions, askedFirst, ...usage, ...(body.code ? { errorCode: body.code } : {}), spec });
}

type RawResult = Omit<ScenarioResult, 'pass' | 'failureReasons' | 'coverage' | 'forbiddenHits' | 'unexpectedTasks'>;

/** Pure scoring step; `--rebuild` re-applies it to saved specs without calling any model. */
export function scoreResult(scenario: EvalScenario, raw: RawResult): ScenarioResult {
  const score = raw.outcome === 'validated' ? scoreSpec(scenario, raw.spec) : undefined;
  const failureReasons: string[] = [];
  if (raw.outcome !== 'validated') failureReasons.push(`resultado ${raw.outcome}`);
  if (score && !score.complete) failureReasons.push('cobertura incompleta');
  if (score?.forbiddenHits.length) failureReasons.push(`inventou: ${score.forbiddenHits.join(', ')}`);
  if (scenario.expectsClarification && !raw.askedFirst) failureReasons.push('não perguntou antes de gerar');
  if (raw.repeatedQuestions > 0) failureReasons.push(`${raw.repeatedQuestions} pergunta(s) repetida(s)`);
  return {
    ...raw, pass: failureReasons.length === 0, failureReasons,
    coverage: score?.coverage ?? { activities: '-', roles: '-', decisions: '-', ratio: 0 },
    forbiddenHits: score?.forbiddenHits ?? [], unexpectedTasks: score?.unexpectedTasks ?? [],
  };
}

export function summarize(results: ScenarioResult[]) {
  const valid = results.filter(result => result.outcome === 'validated');
  const costs = results.map(result => result.costUsd).filter((cost): cost is number => cost !== null);
  const totalCost = costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null;
  const sum = (key: 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'latencyMs' | 'calls') => results.reduce((total, result) => total + result[key], 0);
  return {
    scenarios: results.length,
    passed: results.filter(result => result.pass).length,
    passRate: results.length ? results.filter(result => result.pass).length / results.length : 0,
    validRate: results.length ? valid.length / results.length : 0,
    meanCoverage: results.length ? results.reduce((total, result) => total + result.coverage.ratio, 0) / results.length : 0,
    inventedElements: results.reduce((total, result) => total + result.forbiddenHits.length, 0),
    repeatedQuestions: results.reduce((total, result) => total + result.repeatedQuestions, 0),
    calls: sum('calls'), inputTokens: sum('inputTokens'), cachedInputTokens: sum('cachedInputTokens'), outputTokens: sum('outputTokens'),
    meanLatencyMs: results.length ? Math.round(sum('latencyMs') / results.length) : 0,
    totalCostUsd: totalCost,
    costPerValidProcessUsd: totalCost !== null && valid.length ? totalCost / valid.length : null,
    tokensPerScenario: results.length ? Math.round((sum('inputTokens') + sum('outputTokens')) / results.length) : 0,
  };
}

const percent = (value: number) => `${Math.round(value * 100)}%`;
const usd = (value: number | null) => value === null ? 'n/d' : `US$ ${value.toFixed(4)}`;

async function rebuildScoreboard() {
  await mkdir(runsDirectory, { recursive: true });
  const files = (await readdir(runsDirectory)).filter(name => name.endsWith('.json')).sort();
  const latest = new Map<string, any>();
  for (const file of files) {
    const run = JSON.parse(await readFile(resolve(runsDirectory, file), 'utf8'));
    // Partial runs (--only) are smoke checks; the scoreboard compares full-corpus runs only.
    if (scenarios.some(scenario => !run.scenarioIds?.includes(scenario.id))) continue;
    run.results = run.results.map((result: ScenarioResult) => { const scenario = scenarios.find(item => item.id === result.id); return scenario ? scoreResult(scenario, result) : result; });
    run.summary = summarize(run.results);
    latest.set(`${run.provider}|${run.model}|${run.label ?? ''}`, run);
  }
  const runs = [...latest.values()].sort((left, right) => right.summary.passRate - left.summary.passRate || (left.summary.totalCostUsd ?? Infinity) - (right.summary.totalCostUsd ?? Infinity));
  const scoreboard = { generatedAt: new Date().toISOString(), corpus: scenarios.map(({ id, title, expectsClarification }) => ({ id, title, expectsClarification: !!expectsClarification })), runs };
  await writeFile(resolve(evalDirectory, 'scoreboard.json'), `${JSON.stringify(scoreboard, null, 2)}\n`);
  const lines = [
    '# Placar de avaliação — Process AI Studio', '',
    `Gerado em ${scoreboard.generatedAt}. Corpus sintético de ${scenarios.length} cenários (\`scripts/eval/scenarios.ts\`). Cada linha é a execução mais recente de um provider/modelo.`, '',
    '| Provider | Modelo | Rótulo | Aprovados | Válidos | Cobertura média | Invenções | Perguntas repetidas | Latência média | Tokens/cenário | Custo total | Custo por processo válido |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...runs.map(run => `| ${run.provider} | ${run.model} | ${run.label ?? '—'} | ${run.summary.passed}/${run.summary.scenarios} (${percent(run.summary.passRate)}) | ${percent(run.summary.validRate)} | ${percent(run.summary.meanCoverage)} | ${run.summary.inventedElements} | ${run.summary.repeatedQuestions} | ${(run.summary.meanLatencyMs / 1000).toFixed(1)} s | ${run.summary.tokensPerScenario} | ${usd(run.summary.totalCostUsd)} | ${usd(run.summary.costPerValidProcessUsd)} |`),
    '', '## Detalhe por cenário', '',
    ...runs.flatMap(run => [`### ${run.provider} / ${run.model}${run.label ? ` (${run.label})` : ''} — ${run.startedAt}`, '', '| Cenário | Resultado | Atividades | Papéis | Decisões | Perguntas | Chamadas | Latência | Falhas |', '|---|---|---|---|---|---|---|---|---|',
      ...run.results.map((result: ScenarioResult) => `| ${result.id} | ${result.pass ? '✅' : '❌'} ${result.outcome} | ${result.coverage.activities} | ${result.coverage.roles} | ${result.coverage.decisions} | ${result.questionsAsked} | ${result.calls} | ${(result.latencyMs / 1000).toFixed(1)} s | ${result.failureReasons.join('; ') || '—'} |`), '']),
  ];
  await writeFile(resolve(evalDirectory, 'SCOREBOARD.md'), `${lines.join('\n')}\n`);
  return scoreboard;
}

async function main() {
  if (flag('rebuild')) { await rebuildScoreboard(); console.log('Placar regenerado em reports/eval/SCOREBOARD.md'); return; }
  const providerName = option('provider');
  const model = option('model');
  if (!providerName || !model) throw new Error('Informe --provider <claude-cli|openai-compatible|ollama> e --model <modelo>');
  const external = providerName !== 'ollama';
  if (external && !flag('approve-external')) throw new Error('Provider externo exige --approve-external (somente texto sintético é enviado)');
  const only = option('only')?.split(',').map(id => id.trim()).filter(Boolean);
  const selected = only ? scenarios.filter(scenario => only.some(id => scenario.id.startsWith(id))) : scenarios;
  if (!selected.length) throw new Error('Nenhum cenário selecionado');
  const maxCalls = Number(option('max-calls') ?? selected.length * 4);
  const environment = readEnvironment({ ...process.env, AI_PROVIDER: providerName, AI_MODEL: model, EXTERNAL_AI_APPROVED: external ? 'true' : 'false', AI_MAX_PROVIDER_CALLS: '0', LOG_LEVEL: 'silent' });
  const configured = configuredProvider(environment);
  if (!configured) throw new Error('Provider não configurado');
  const recorder = new RecordingProvider(configured.provider, maxCalls);
  const app = await buildApp(environment, { conversationRepository: new InMemoryConversationRepository(), modelProvider: recorder });
  const startedAt = new Date().toISOString();
  const results: ScenarioResult[] = [];
  try {
    for (const scenario of selected) {
      process.stdout.write(`${scenario.id} … `);
      const result = await runScenario(app, recorder, scenario);
      results.push(result);
      console.log(`${result.pass ? 'OK' : 'FALHOU'} (${result.outcome}, ${(result.latencyMs / 1000).toFixed(1)} s${result.failureReasons.length ? `; ${result.failureReasons.join('; ')}` : ''})`);
    }
  } finally { await app.close(); }
  const label = option('label');
  const run = { provider: configured.provider.id, model, ...(label ? { label } : {}), startedAt, finishedAt: new Date().toISOString(), scenarioIds: selected.map(scenario => scenario.id), summary: summarize(results), results };
  await mkdir(runsDirectory, { recursive: true });
  const file = resolve(runsDirectory, `${startedAt.replace(/[:.]/g, '-')}_${run.provider}_${label ? `${label}_` : ''}${model.replace(/[^a-zA-Z0-9.-]/g, '_')}.json`);
  await writeFile(file, `${JSON.stringify(run, null, 2)}\n`);
  await rebuildScoreboard();
  console.log(`\nAprovados ${run.summary.passed}/${run.summary.scenarios} · válidos ${percent(run.summary.validRate)} · cobertura ${percent(run.summary.meanCoverage)} · custo ${usd(run.summary.totalCostUsd)}\nPlacar: reports/eval/SCOREBOARD.md`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
