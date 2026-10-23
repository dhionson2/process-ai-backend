import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { ClaudeCliProvider, cliSchemaEnvelope, type ClaudeCliOptions } from '../src/modules/providers/claude-cli-provider.js';
import { ProviderFailure, type StructuredRequest } from '../src/modules/providers/model-provider.js';
import { interpretationSchema, normalizeInterpretation } from '../src/modules/ai/interpretation-context.js';
import { readEnvironment } from '../src/config/env.js';
import { configuredProvider } from '../src/modules/ai/provider.factory.js';
import { scenarios } from '../scripts/eval/scenarios.js';
import { scoreResult, scoreSpec, summarize } from '../scripts/eval/run-eval.js';

const request: StructuredRequest = { model: 'sonnet', system: 'Sistema sintético', prompt: 'Texto sintético', outputSchema: interpretationSchema(false), timeoutMs: 5000, contextTokens: 8192, maxOutputTokens: 2048 };
type Invocation = { binary: string; args: string[]; input: string; cwd: string; env: NodeJS.ProcessEnv };

function fakeCli(stdout: unknown, extra: Partial<{ exitCode: number; timedOut: boolean }> = {}) {
  const invocations: Invocation[] = [];
  const run: ClaudeCliOptions['run'] = async (binary, args, input, options) => {
    invocations.push({ binary, args, input, cwd: options.cwd, env: options.env });
    return { stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), exitCode: extra.exitCode ?? 0, timedOut: extra.timedOut ?? false };
  };
  return { run, invocations };
}

const success = (value: unknown) => ({ type: 'result', subtype: 'success', is_error: false, structured_output: { response: value }, total_cost_usd: 0.012,
  usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 300 },
  modelUsage: { 'claude-haiku-helper': { outputTokens: 20 }, 'claude-sonnet-x': { outputTokens: 300 } } });

test('Claude CLI recebe prompt por stdin, sem ferramentas, MCP, settings ou sessão, em diretório temporário isolado', async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://secret@localhost/db';
  const { run, invocations } = fakeCli(success({ kind: 'need_clarification', questions: [], summary: 'ok' }));
  await new ClaudeCliProvider({ run }).generateStructured(request);
  const [call] = invocations;
  assert.equal(call.binary, 'claude');
  assert.equal(call.input, 'Texto sintético');
  assert.ok(!call.args.includes('Texto sintético'), 'prompt não vai para a linha de comando');
  for (const flag of ['-p', '--no-session-persistence', '--strict-mcp-config']) assert.ok(call.args.includes(flag), flag);
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  assert.equal(call.args[call.args.indexOf('--setting-sources') + 1], '');
  assert.equal(call.args[call.args.indexOf('--system-prompt') + 1], 'Sistema sintético');
  assert.match(call.cwd, /process-ai-claude-/);
  assert.equal(call.env.DATABASE_URL, undefined, 'segredos do servidor não chegam ao processo filho');
  assert.ok(!call.args.includes('--bare'));
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabaseUrl;
});

test('Claude CLI desembrulha o envelope e reporta tokens com cache, custo e modelo principal', async () => {
  const { run } = fakeCli(success({ kind: 'need_clarification', questions: [], summary: 'ok' }));
  const response = await new ClaudeCliProvider({ run }).generateStructured(request);
  assert.deepEqual(response.value, { kind: 'need_clarification', questions: [], summary: 'ok' });
  assert.deepEqual(response.usage, { inputTokens: 1210, outputTokens: 300, cachedInputTokens: 1000, costUsd: 0.012 });
  assert.equal(response.model, 'claude-sonnet-x');
});

test('envelope do schema cumpre as restrições do CLI e preserva o contrato original', () => {
  const envelope = cliSchemaEnvelope(interpretationSchema(false)) as any;
  assert.equal(envelope.type, 'object');
  assert.equal(envelope.$schema, undefined);
  assert.equal(envelope.oneOf, undefined);
  assert.deepEqual(envelope.required, ['response']);
  assert.ok(envelope.$defs, '$defs ficam na raiz para as referências #/$defs/...');
  const validate = new Ajv2020({ strict: false }).compile(envelope);
  assert.equal(validate({ response: { kind: 'need_clarification', questions: [{ question: 'Quem aprova?', blocking: true }], summary: 'Falta o aprovador.' } }), true);
  assert.equal(validate({ response: { kind: 'inventado' } }), false);
});

test('falhas do CLI viram ProviderFailure tipada sem vazar conteúdo', async () => {
  const cases: Array<[unknown, Partial<{ timedOut: boolean }>, string]> = [
    ['não é json', {}, 'PROVIDER_INVALID_RESPONSE'],
    [{ type: 'result', subtype: 'success', is_error: true, api_error_status: 429 }, {}, 'PROVIDER_RATE_LIMITED'],
    [{ type: 'result', subtype: 'success', is_error: true, api_error_status: 503 }, {}, 'PROVIDER_UNAVAILABLE'],
    [{ type: 'result', subtype: 'error_max_budget_usd', is_error: false }, {}, 'PROVIDER_REJECTED'],
    [{ type: 'result', subtype: 'success', is_error: false, structured_output: null }, {}, 'PROVIDER_INVALID_RESPONSE'],
    ['', { timedOut: true }, 'PROVIDER_TIMEOUT'],
  ];
  for (const [stdout, extra, code] of cases) {
    const { run } = fakeCli(stdout, extra);
    await assert.rejects(() => new ClaudeCliProvider({ run }).generateStructured(request), (error: unknown) => error instanceof ProviderFailure && error.code === code);
  }
  const missingBinary = new ClaudeCliProvider({ run: async () => { throw new Error('spawn ENOENT'); } });
  await assert.rejects(() => missingBinary.generateStructured(request), (error: unknown) => error instanceof ProviderFailure && error.code === 'PROVIDER_UNAVAILABLE');
});

test('orçamento local de chamadas, --bare e teto em USD são respeitados', async () => {
  const { run, invocations } = fakeCli(success({ kind: 'need_clarification', questions: [], summary: 'ok' }));
  const provider = new ClaudeCliProvider({ run, bare: true, maxBudgetUsd: 0.5, budget: { maxCalls: 1 } });
  await provider.generateStructured(request);
  assert.ok(invocations[0].args.includes('--bare'));
  assert.equal(invocations[0].args[invocations[0].args.indexOf('--max-budget-usd') + 1], '0.5');
  await assert.rejects(() => provider.generateStructured(request), (error: unknown) => error instanceof ProviderFailure && error.diagnostic?.category === 'budget');
});

test('claude-cli é provedor externo: exige aprovação explícita do servidor', () => {
  const blocked = readEnvironment({ AI_PROVIDER: 'claude-cli', AI_MODEL: 'sonnet' });
  assert.throws(() => configuredProvider(blocked), (error: any) => error.code === 'AI_PROVIDER_NOT_APPROVED');
  const approved = readEnvironment({ AI_PROVIDER: 'claude-cli', AI_MODEL: 'sonnet', EXTERNAL_AI_APPROVED: 'true', CLAUDE_CLI_MAX_BUDGET_USD: '0.25' });
  assert.equal(configuredProvider(approved)?.provider.id, 'claude-cli');
  assert.equal(approved.claudeCliMaxBudgetUsd, 0.25);
  assert.throws(() => readEnvironment({ CLAUDE_CLI_MAX_BUDGET_USD: '-1' }), /CLAUDE_CLI_MAX_BUDGET_USD/);
});

test('normalização descarta bindings de papel emitidos pelo modelo em vez de reprovar a resposta inteira', () => {
  const normalized = normalizeInterpretation({ kind: 'business_intent', actors: [{ name: 'Gestor', evidence: 'o gestor aprova', resolution: 'group', groupName: 'G', resolutionEvidence: 'x' }] }) as any;
  assert.deepEqual(normalized.actors, [{ name: 'Gestor', evidence: 'o gestor aprova' }]);
  assert.deepEqual(normalized.pendingConfiguration, []);
});

test('placar casa radicais no início da palavra e mede cobertura, invenções e pedido vago', () => {
  const purchase = scenarios.find(item => item.id === 'S02-compra')!;
  const spec = {
    roles: [{ id: 'r1', label: 'Funcionário' }, { id: 'r2', label: 'Gestor' }, { id: 'r3', label: 'Setor de compras' }],
    nodes: [{ id: 't1', type: 'userTask', name: 'Analisar solicitação de compra' }, { id: 't2', type: 'userTask', name: 'Providenciar compra' }, { id: 'g', type: 'exclusiveGateway', name: 'Aprovado?' }],
    flows: [{ id: 'f1', source: 'g', target: 't2' }, { id: 'f2', source: 'g', target: 'end' }],
  };
  const score = scoreSpec(purchase, spec);
  assert.equal(score.complete, true);
  assert.deepEqual(score.forbiddenHits, [], '"solicitação" não conta como "licitação"');
  const invented = scoreSpec(purchase, { ...spec, nodes: [...spec.nodes, { id: 't3', type: 'userTask', name: 'Abrir licitação' }] });
  assert.deepEqual(invented.forbiddenHits, ['licitacao']);
  const vague = scenarios.find(item => item.expectsClarification)!;
  const base = { id: vague.id, title: vague.title, outcome: 'validated', clarificationRounds: 0, questionsAsked: 0, repeatedQuestions: 0, askedFirst: false, calls: 1, latencyMs: 1000, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, costUsd: 0.01, spec };
  const result = scoreResult(vague, base);
  assert.equal(result.pass, false);
  assert.ok(result.failureReasons.includes('não perguntou antes de gerar'));
  const summary = summarize([result, scoreResult(purchase, { ...base, id: purchase.id, askedFirst: false })]);
  assert.equal(summary.passed, 1);
  assert.equal(summary.costPerValidProcessUsd, 0.01);
});
