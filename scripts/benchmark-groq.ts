import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';
import { buildApp } from '../src/app.js';
import { readEnvironment } from '../src/config/env.js';
import { OpenAICompatibleProvider, ProviderFailure } from '../src/modules/providers/model-provider.js';
import type { StructuredRequest } from '../src/modules/providers/model-provider.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

if (!process.argv.includes('--rotation-confirmed')) throw new Error('A confirmação de rotação da credencial exposta é obrigatória. Use --rotation-confirmed somente depois de confirmar com o operador.');
const apiKey = process.env.EXTERNAL_AI_API_KEY;
if (!apiKey?.trim()) throw new Error('Configuração local ausente: EXTERNAL_AI_API_KEY');
const model = 'openai/gpt-oss-120b';
const baseUrl = 'https://api.groq.com/openai/v1';
const evidenceDirectory = resolve('reports/marco2-recovery-2026-10-14');
await mkdir(evidenceDirectory, { recursive: true });
const priorLedger = await readFile(resolve(evidenceDirectory, 'ledger.json'), 'utf8').then(JSON.parse).catch(() => ({ calls: 0, tokens: 0 }));
const callsAlreadySpent = priorLedger.calls;
const tokensAlreadySpent = priorLedger.tokens;
const apiPort = await new Promise<number>((resolve, reject) => {
  const listener = createNetServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const address = listener.address();
    if (!address || typeof address === 'string') { listener.close(); reject(new Error('Não foi possível reservar porta local')); return; }
    listener.close(error => error ? reject(error) : resolve(address.port));
  });
});
const maxCalls = 5;
const maxTokens = 50000;
const remainingCalls = maxCalls - callsAlreadySpent;
const remainingTokens = maxTokens - tokensAlreadySpent;
if (!Number.isInteger(callsAlreadySpent) || callsAlreadySpent < 0 || callsAlreadySpent >= maxCalls || !Number.isInteger(tokensAlreadySpent) || tokensAlreadySpent < 0 || tokensAlreadySpent >= maxTokens) throw new Error('Orçamento global restante inválido; configure GROQ_BENCHMARK_CALLS_ALREADY_SPENT e GROQ_BENCHMARK_TOKENS_ALREADY_SPENT somente para continuar uma avaliação parcial.');
const environment = readEnvironment({
  ...process.env,
  AI_PROVIDER: 'openai-compatible',
  AI_MODEL: model,
  EXTERNAL_AI_BASE_URL: baseUrl,
  EXTERNAL_AI_APPROVED: 'true',
  EXTERNAL_AI_STRUCTURED_OUTPUT: 'json-schema-strict',
  AI_MAX_PROVIDER_CALLS: String(remainingCalls),
  AI_MAX_PROVIDER_TOKENS: String(remainingTokens),
  AI_MAX_CONCURRENCY: '1',
  AI_MAX_OUTPUT_TOKENS: '3000',
  AI_TIMEOUT_MS: '120000',
  HOST: '127.0.0.1',
  PORT: String(apiPort),
  LOG_LEVEL: 'silent',
  LOCAL_TENANT_ID: `groq-benchmark-${Date.now()}`,
});
assert.ok(environment.databaseUrl, 'DATABASE_URL precisa apontar para PostgreSQL local');
let currentSnapshot: Record<string, any> | undefined;
const gateway = new OpenAICompatibleProvider(baseUrl, apiKey, 'json-schema-strict', { maxCalls: remainingCalls, maxTokens: remainingTokens }, 0, raw => { if (currentSnapshot) currentSnapshot.rawStructured = raw; });
let lastCallStartedAt = 0;
let quotaBlocked = false;
const provider = {
  id: gateway.id,
  get usageTotals() { return gateway.usageTotals; },
  async generateStructured(request: StructuredRequest) {
    if (quotaBlocked || gateway.usageTotals.calls >= remainingCalls) throw new ProviderFailure('PROVIDER_RATE_LIMITED', 'Cota ou orçamento de cinco chamadas HTTP desta rodada esgotado');
    while (Date.now() - lastCallStartedAt < 65000) await new Promise(resolve => setTimeout(resolve, Math.min(30000, 65000 - (Date.now() - lastCallStartedAt))));
    currentSnapshot = {
      classification: 'synthetic',
      requestSummary: {
        model: request.model,
        systemChars: request.system.length,
        promptChars: request.prompt.length,
        schemaChars: JSON.stringify(request.outputSchema).length,
        promptSha256: createHash('sha256').update(request.prompt).digest('hex'),
        maxOutputTokens: request.maxOutputTokens,
      },
      startedAt: new Date().toISOString(),
    };
    await writeEvidence('ledger.json', { calls: callsAlreadySpent + gateway.usageTotals.calls + 1, tokens: tokensAlreadySpent + gateway.usageTotals.tokens });
    lastCallStartedAt = Date.now();
    process.stdout.write(`Chamada Groq ${callsAlreadySpent + gateway.usageTotals.calls + 1}/${maxCalls}\n`);
    try {
      const response = await gateway.generateStructured(request);
      currentSnapshot.normalizedResponse = response;
      process.stdout.write(`Resposta: ${(response.value as any)?.kind}; ${response.latencyMs} ms\n`);
      return response;
    } catch (error) { quotaBlocked ||= error instanceof ProviderFailure && error.code === 'PROVIDER_RATE_LIMITED'; currentSnapshot.error = { code: (error as any).code || 'UNKNOWN', retryAfterMs: (error as any).retryAfterMs }; throw error; }
    finally {
      await writeEvidence(`call-${callsAlreadySpent + gateway.usageTotals.calls}.json`, currentSnapshot);
      await writeEvidence('ledger.json', { calls: callsAlreadySpent + gateway.usageTotals.calls, tokens: tokensAlreadySpent + gateway.usageTotals.tokens });
      currentSnapshot = undefined;
    }
  },
};
const app = await buildApp(environment, { modelProvider: provider });
let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const report: Record<string, any> = { provider: 'Groq OpenAI-compatible', model, structuredOutput: 'json_schema strict', budget: { maxCalls, maxTokens }, scenarios: {} };

async function writeEvidence(name: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value, null, 2).replace(/gsk_[A-Za-z0-9]+/g, '[REDACTED]').replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [REDACTED]');
  await writeFile(resolve(evidenceDirectory, name), json + '\n', 'utf8');
}

async function saveBundle(label: string, spec: any, artifacts: any): Promise<void> {
  await writeEvidence(`${label}.process-spec.json`, spec);
  await writeFile(resolve(evidenceDirectory, `${label}.bpmn`), artifacts.bpmnXml, 'utf8');
  await writeEvidence(`${label}.manifest.json`, artifacts.manifest);
  for (const form of artifacts.forms) await writeEvidence(`${label}.${form.id}.form.json`, form.json);
}

async function callApi(path: string, method = 'GET', payload?: unknown): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
    method,
    headers: payload === undefined ? {} : { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = new Error(`REST ${method} ${path} respondeu HTTP ${response.status} (${body.code || 'sem código'})`);
    Object.assign(failure, { statusCode: response.status, code: body.code, retryAfterMs: body.retryAfterMs });
    throw failure;
  }
  return body;
}

function safeAnswer(question: string, scenario: 'A' | 'B' | 'C'): string {
  if (scenario === 'C') return 'O diretor fará a segunda aprovação. Se reprovar, o servidor recebe o motivo, como na primeira aprovação. Preserve as demais etapas e deixe a identidade técnica do diretor pendente.';
  if (/motivo|reprov|rejei/i.test(question)) return 'Na reprovação, informe ao solicitante o motivo e encerre o processo; não há outras regras informadas.';
  if (/per[ií]odo|data|in[ií]cio|fim/i.test(question) && scenario === 'A') return 'Capture a data inicial e a data final do período solicitado, sem acrescentar regras de prazo ou saldo.';
  return 'Não há informação adicional. Preserve a etapa e o ramo descritos e mantenha configuração operacional não informada como pendente, sem inventar regras, pessoas ou grupos.';
}

async function runScenario(name: string, description: string, scenario: 'A' | 'B', baseRevision = 0): Promise<any> {
  const project = await callApi('/api/v1/projects', 'POST', { name: `${name} ${new Date().toISOString()}`, targetProfile: 'generic-bpmn2' });
  const sessionId = project.sessionId as string;
  let result: any;
  try { result = await callApi(`/api/v1/design-sessions/${sessionId}/messages`, 'POST', { text: description, baseRevision, dataClassification: 'synthetic' }); }
  catch (error) {
    const session = await callApi(`/api/v1/design-sessions/${sessionId}`);
    const partial = { projectId: project.projectId, sessionId, status: 'provider-limited', kind: null, questions: [], validation: null, artifacts: null, spec: null, runs: [] };
    report.scenarios[name] = { ...partial, sessionStatusAfterFailure: session.status, providerFailureCode: (error as any)?.code, retryAfterMs: (error as any)?.retryAfterMs, providerUsageAtStop: provider.usageTotals };
    return partial;
  }
  const runs = [result.generationRunId];
  let clarifications: string[] = [];
  if (result.status === 'needs-input') {
    clarifications = (result.questions || []).map((item: any) => item.question);
    try {
      result = await callApi(`/api/v1/design-sessions/${sessionId}/answers`, 'POST', {
        answers: clarifications.map(question => safeAnswer(question, scenario)), baseRevision, dataClassification: 'synthetic',
      });
    } catch (error) {
      const session = await callApi(`/api/v1/design-sessions/${sessionId}`);
      const firstRun = await callApi(`/api/v1/generation-runs/${runs[0]}`);
      const partial = { projectId: project.projectId, sessionId, status: 'provider-limited', kind: 'needs-input', questions: clarifications, validation: null, artifacts: null, spec: null, runs: [{ status: firstRun.status, metrics: firstRun.metrics }] };
      report.scenarios[name] = { ...partial, sessionStatusAfterFailure: session.status, retryAfterMs: (error as any)?.retryAfterMs, providerUsageAtStop: provider.usageTotals };
      return partial;
    }
    runs.push(result.generationRunId);
  }
  const runRecords = await Promise.all(runs.map((id: string) => callApi(`/api/v1/generation-runs/${id}`)));
  const item = { projectId: project.projectId, sessionId, status: result.status, kind: result.kind, questions: clarifications, revision: result.revision, validation: result.validation, spec: result.status === 'validated' ? result.artifacts ? (await callApi(`/api/v1/design-sessions/${sessionId}/revisions/${result.revision}`)).processSpec : null : null, artifacts: result.artifacts, runs: runRecords.map(run => ({ status: run.status, metrics: run.metrics })) };
  if (item.spec && item.artifacts) {
    await saveBundle(scenario, item.spec, item.artifacts);
    assert.equal((await callApi('/api/v1/validate', 'POST', item.spec)).valid, true);
    assert.deepEqual(await callApi('/api/v1/generate', 'POST', item.spec), item.artifacts);
  }
  report.scenarios[name] = {
    projectId: item.projectId, sessionId: item.sessionId, status: item.status, kind: item.kind, questions: item.questions,
    revision: item.revision, validation: item.validation, process: item.spec ? specSummary(item.spec) : null,
    artifactSummary: item.artifacts ? { bpmnBytes: item.artifacts.bpmnXml.length, formIds: item.artifacts.forms.map((form: any) => form.id), publishable: item.artifacts.manifest.publication.eligible } : null,
    runs: item.runs,
  };
  return item;
}

function specSummary(spec: any) {
  const roles = (spec.roles || []).map((role: any) => ({ id: role.id, label: role.label, resolution: role.resolution }));
  const forms = (spec.forms || []).map((form: any) => ({ id: form.id, name: form.name, fields: (form.fields || []).map((field: any) => ({ key: field.key, label: field.label, required: field.required, requiredWhen: field.requiredWhen ? true : false })) }));
  const nodes = (spec.nodes || []).map((node: any) => ({ id: node.id, type: node.type, name: node.name, role: roles.find((role: any) => role.id === node.roleId)?.label }));
  const branchValues = (spec.flows || []).flatMap((flow: any) => {
    const value = flow.condition?.right?.literal;
    return value === undefined ? [] : [value];
  });
  return { id: spec.id, name: spec.name, roles, nodes, forms, branchValues, pendingQuestions: spec.pendingQuestions || [] };
}

async function chromiumImport(bundles: Array<{ label: string; artifacts: any }>) {
  vite = await createViteServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 0 }, appType: 'spa' });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Servidor Vite do teste Chromium não iniciou');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  // tsx may add this helper when serializing async callbacks passed to evaluate.
  await page.addInitScript('window.__name = window.__name || ((target) => target);');
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const browserReport: any[] = [];
  for (const { label, artifacts } of bundles) {
    await page.goto(`http://127.0.0.1:${address.port}/tests/editor-import.html`);
    await page.addScriptTag({ url: `http://127.0.0.1:${address.port}/node_modules/bpmn-js/dist/bpmn-modeler.development.js` });
    const bpmn = await page.evaluate(async xml => {
      const modeler = new (window as any).BpmnJS({ container: document.querySelector('#canvas') });
      const imported = await modeler.importXML(xml);
      const saved = await modeler.saveXML({ format: true });
      const elements = modeler.get('elementRegistry').getAll().length;
      modeler.destroy();
      return { warnings: imported.warnings.length, hasDiagram: /BPMNDiagram/.test(saved.xml || ''), elements };
    }, artifacts.bpmnXml);
    assert.equal(bpmn.warnings, 0, `${label}: warnings de importação BPMN`);
    assert.equal(bpmn.hasDiagram, true, `${label}: diagrama BPMN não serializado`);
    await page.goto(`http://127.0.0.1:${address.port}/tests/form-import.html`);
    await page.waitForFunction(() => Boolean((window as any).Form && (window as any).FormEditor), { timeout: 20000 });
    const forms = [];
    for (const { id, json } of artifacts.forms || []) {
      const outcome = await page.evaluate(async formSchema => {
        const viewer = new (window as any).Form({ container: document.querySelector('#viewer') });
        const viewerImport = await viewer.importSchema(formSchema);
        const editor = new (window as any).FormEditor({ container: document.querySelector('#editor') });
        const editorImport = await editor.importSchema(formSchema);
        const serialized = editor.saveSchema();
        const reimport = new (window as any).Form({ container: document.createElement('div') });
        const reimportResult = await reimport.importSchema(serialized);
        const summaries = (schema: any) => schema.components.map((component: any) => ({ key: component.key, label: component.label, required: component.validate?.required === true, conditional: component.conditional || null }));
        const stable = JSON.stringify(summaries(formSchema)) === JSON.stringify(summaries(serialized));
        viewer.destroy(); editor.destroy(); reimport.destroy();
        return { viewerWarnings: viewerImport.warnings.length, editorWarnings: editorImport.warnings.length, reimportWarnings: reimportResult.warnings.length, stable, fields: serialized.components.length };
      }, json);
      assert.deepEqual(outcome, { viewerWarnings: 0, editorWarnings: 0, reimportWarnings: 0, stable: true, fields: json.components.length }, `${label}/${id}: serialização de formulário`);
      forms.push({ id, ...outcome });
    }
    browserReport.push({ label, bpmn, forms });
  }
  assert.deepEqual(pageErrors, [], 'Chromium reportou erros de página');
  report.chromium = browserReport;
}

async function main() {
  await app.listen({ host: '127.0.0.1', port: apiPort });
  const health = await callApi('/health');
  report.api = health;
  const vacationDescription = 'Crie um processo de férias. O servidor informa o período solicitado, o gestor aprova ou reprova. Se aprovar, o RH registra as férias. Se reprovar, o servidor recebe o motivo.';
  const vacation = await runScenario('Groq cenário A férias', vacationDescription, 'A');
  const vacationValid = vacation.status === 'validated' && vacation.validation?.valid === true && Boolean(vacation.spec && vacation.artifacts);
  const aRevision = vacationValid ? Number(vacation.revision) : 0;
  if (vacationValid) await callApi(`/api/v1/design-sessions/${vacation.sessionId}/revisions/${aRevision}/accept`, 'POST', { baseRevision: 0 });

  const approval = await runScenario('Groq cenário B aprovação administrativa', 'Um funcionário solicita a compra de um equipamento. O gestor aprova ou reprova. Se aprovado, o setor de compras recebe a solicitação. Se reprovado, o funcionário recebe a justificativa.', 'B');
  const bundles: Array<{ label: string; artifacts: any }> = [];
  if (vacationValid) bundles.push({ label: 'A férias gerada por IA', artifacts: vacation.artifacts });
  if (approval.status === 'validated' && approval.artifacts) bundles.push({ label: 'B aprovação administrativa gerada por IA', artifacts: approval.artifacts });

  if (vacationValid) {
    const refinementText = 'Adicione uma segunda aprovação antes de encaminhar ao RH.';
    let refinement: any;
    try { refinement = await callApi(`/api/v1/design-sessions/${vacation.sessionId}/refinements`, 'POST', { text: refinementText, baseRevision: aRevision, dataClassification: 'synthetic' }); }
    catch (error) {
      const session = await callApi(`/api/v1/design-sessions/${vacation.sessionId}`);
      report.scenarios.C = { status: 'provider-limited', sessionStatusAfterFailure: session.status, baseRevision: aRevision, providerFailureCode: (error as any)?.code, retryAfterMs: (error as any)?.retryAfterMs, providerUsageAtStop: provider.usageTotals };
      refinement = null;
    }
    if (!refinement) {
      // No more provider requests are made after the bounded rate-limit recovery fails.
    } else {
    const refinementRunIds = [refinement.generationRunId];
    let refinementQuestions: string[] = [];
    if (refinement.status === 'needs-input') {
      refinementQuestions = (refinement.questions || []).map((question: any) => question.question);
      refinement = await callApi(`/api/v1/design-sessions/${vacation.sessionId}/answers`, 'POST', {
        answers: refinementQuestions.map((question: string) => safeAnswer(question, 'C')),
        baseRevision: aRevision,
        dataClassification: 'synthetic',
      });
      refinementRunIds.push(refinement.generationRunId);
    }
    const refinementRuns = await Promise.all(refinementRunIds.map((id: string) => callApi(`/api/v1/generation-runs/${id}`)));
    if (refinement.status === 'validated' && refinement.validation?.valid === true) {
      const cSpec = (await callApi(`/api/v1/design-sessions/${vacation.sessionId}/revisions/${refinement.revision}`)).processSpec;
      await saveBundle('C', cSpec, refinement.artifacts);
      for (const node of vacation.spec.nodes) assert.deepEqual(cSpec.nodes.find((item: any) => item.id === node.id), node);
      for (const form of vacation.spec.forms) assert.deepEqual(cSpec.forms.find((item: any) => item.id === form.id), form);
      const previousNodeIds = new Set((vacation.spec.nodes || []).map((node: any) => node.id));
      const candidateNodeIds = new Set((cSpec.nodes || []).map((node: any) => node.id));
      const preservedNodeIds = [...previousNodeIds].filter(id => candidateNodeIds.has(id)).length;
      report.scenarios.C = {
        status: refinement.status, questions: refinementQuestions, revision: refinement.revision, baseRevision: refinement.baseRevision,
        validation: refinement.validation, priorNodesPreserved: preservedNodeIds, priorNodeCount: previousNodeIds.size,
        addedNodes: (cSpec.nodes || []).filter((node: any) => !previousNodeIds.has(node.id)).map((node: any) => ({ id: node.id, type: node.type, name: node.name })),
        process: specSummary(cSpec), runs: refinementRuns.map(run => ({ status: run.status, metrics: run.metrics })), sessionId: vacation.sessionId,
      };
      const revisions = await callApi(`/api/v1/design-sessions/${vacation.sessionId}/revisions`);
      report.scenarios.C.previousRevisionRetained = revisions.revisions.some((item: any) => item.revision === aRevision && item.status === 'accepted');
      await callApi(`/api/v1/design-sessions/${vacation.sessionId}/revisions/${refinement.revision}/accept`, 'POST', { baseRevision: aRevision });
      if (refinement.artifacts) bundles.push({ label: 'C refinamento gerado por IA', artifacts: refinement.artifacts });
    } else {
      report.scenarios.C = { status: refinement.status, questions: refinementQuestions, validation: refinement.validation, runs: refinementRuns.map(run => ({ status: run.status, metrics: run.metrics })), sessionId: vacation.sessionId };
    }
    }
  } else report.scenarios.C = { status: 'blocked-by-A-invalid', reason: 'Refinamento exige uma revisão válida de férias como base.' };

  if (bundles.length) await chromiumImport(bundles);
  await app.close();
  const recoveryApp = await buildApp(environment, { modelProvider: provider });
  await recoveryApp.listen({ host: '127.0.0.1', port: apiPort });
  try {
    const recoveredDraft = await callApi(`/api/v1/design-sessions/${vacation.sessionId}/draft`);
    const recoveredHistory = await callApi(`/api/v1/design-sessions/${vacation.sessionId}/history`);
    const recoveredRevisions = await callApi(`/api/v1/design-sessions/${vacation.sessionId}/revisions`);
    report.persistence = {
      recoveredCurrentRevision: recoveredDraft.session.currentRevision,
      processSpecRecovered: Boolean(recoveredDraft.processSpec),
      bpmnRecovered: Boolean(recoveredDraft.artifacts?.bpmnXml),
      formCountRecovered: recoveredDraft.artifacts?.forms?.length || 0,
      messageCountRecovered: recoveredHistory.messages?.length || 0,
      revisionsRecovered: recoveredRevisions.revisions?.map((item: any) => ({ revision: item.revision, baseRevision: item.baseRevision, status: item.status })),
      totalCalls: callsAlreadySpent + provider.usageTotals.calls,
      totalTokens: tokensAlreadySpent + provider.usageTotals.tokens,
    };
  } finally { await recoveryApp.close(); }
  if (callsAlreadySpent + provider.usageTotals.calls > maxCalls || tokensAlreadySpent + provider.usageTotals.tokens > maxTokens) throw new Error('Orçamento local excedido');
  report.usageTotals = { ...provider.usageTotals, calls: callsAlreadySpent + provider.usageTotals.calls, tokens: tokensAlreadySpent + provider.usageTotals.tokens, priorFailedAttemptCalls: callsAlreadySpent, priorReportedTokens: tokensAlreadySpent };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try { await main(); }
catch (error) {
  report.failure = error instanceof Error ? error.message : 'Falha não classificada';
  report.usageTotals = { ...provider.usageTotals, calls: callsAlreadySpent + provider.usageTotals.calls, tokens: tokensAlreadySpent + provider.usageTotals.tokens, priorFailedAttemptCalls: callsAlreadySpent, priorReportedTokens: tokensAlreadySpent };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  report.usageTotals ||= { ...provider.usageTotals, calls: callsAlreadySpent + provider.usageTotals.calls, tokens: tokensAlreadySpent + provider.usageTotals.tokens };
  await writeEvidence('report.json', report);
  await app.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  if (vite) await vite.close().catch(() => undefined);
}
