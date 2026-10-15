import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { readFile as readAsset } from 'node:fs/promises';
import { extname } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { applySemanticRefinement, compileBusinessIntent, compileProcessIntent } from '../src/modules/ai/semantic-process.js';
import { generateArtifacts } from '../src/modules/generation/artifact-generator.js';
import { complexPurchaseIntent, complexPurchaseText } from './fixtures/complex-purchase.js';

const generated = resolve(process.cwd(), 'specs/foundation/examples/generated');
const compiledVacation = await compileProcessIntent({ kind: 'process_intent', name: 'Solicitação de férias compilada', purpose: 'Aprovação de férias, registro no RH e motivo em caso de rejeição.',
  actors: [{ name: 'Servidor', resolution: 'requester' }, { name: 'Gestor', resolution: 'manager-of-requester' }, { name: 'RH', resolution: 'group', groupName: 'RH' }],
  startFields: [{ name: 'Data inicial', type: 'date', required: true }],
  steps: [{ kind: 'approval', name: 'Analisar solicitação', actor: 'Gestor', requiresRejectionReason: true,
    onApproved: [{ kind: 'task', name: 'Registrar férias', actor: 'RH' }], onRejected: [] }],
}, { targetProfile: 'generic-bpmn2', knowledgeVersion: '1.0.0', model: 'chromium-regression' });
const refinedVacation = applySemanticRefinement(compiledVacation, { kind: 'refinement', changeSummary: 'Segunda aprovação', operations: [{ kind: 'insertApprovalBefore', beforeActivity: 'Registrar férias', rejectedTargetActivity: 'Processo encerrado', approval: { name: 'Segunda aprovação', actor: { name: 'Diretor', resolution: 'manual' } } }] });
const previewVacation = await compileBusinessIntent({ kind: 'business_intent', name: 'Solicitação de férias prévia', purpose: 'Solicitar férias, aprovar ou reprovar, registrar no RH e informar motivo na reprovação.',
  actors: [{ name: 'Servidor', evidence: 'O servidor faz a solicitação', resolution: 'requester', resolutionEvidence: 'O servidor faz a solicitação' }, { name: 'Gestor', evidence: 'O gestor aprova ou reprova' }, { name: 'RH', evidence: 'o RH registra as férias' }],
  startFields: [], activities: [{ kind: 'approval', name: 'Aprovar ou reprovar férias', actor: 'Gestor', evidence: 'O gestor aprova ou reprova', requiresRejectionReason: true, onApproved: [{ kind: 'task', name: 'Registrar as férias', actor: 'RH', evidence: 'o RH registra as férias' }], onRejected: [{ kind: 'task', name: 'Receber motivo', actor: 'Servidor', evidence: 'o Servidor recebe motivo na reprovação' }] }],
  rules: [{ text: 'Motivo obrigatório em caso de reprovação', evidence: 'Se reprovado, o Servidor recebe motivo na reprovação' }], suggestions: [], pendingConfiguration: [] },
{ targetProfile: 'generic-bpmn2', knowledgeVersion: '1.0.0', model: 'chromium-business-intent', sourceText: 'O servidor faz a solicitação. O gestor aprova ou reprova. Se aprovado, o RH registra as férias. Se reprovado, o Servidor recebe motivo na reprovação.', activitySourceText: 'O servidor faz a solicitação. O gestor aprova ou reprova. Se aprovado, o RH registra as férias. Se reprovado, o Servidor recebe motivo na reprovação.' });
const purchasePreview = await compileBusinessIntent(complexPurchaseIntent(), { targetProfile: 'generic-bpmn2', knowledgeVersion: '1.0.0', model: 'chromium-complex-business-intent', sourceText: complexPurchaseText, activitySourceText: complexPurchaseText });

async function startStaticServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname);
    if (pathname === '/tests/editor-import.html') { response.setHeader('content-type', 'text/html'); response.end('<html><body><div id="canvas" style="width:1200px;height:900px"></div></body></html>'); return; }
    const path = resolve(process.cwd(), `.${pathname}`);
    if (!path.startsWith(process.cwd())) { response.writeHead(403).end(); return; }
    try {
      const data = await readAsset(path);
      response.setHeader('content-type', extname(path) === '.css' ? 'text/css' : extname(path) === '.js' ? 'text/javascript' : 'text/html');
      response.end(data);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Servidor de teste não iniciou');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise(resolvePromise => server.close(() => resolvePromise())) };
}

test('BPMN examples import and serialize through bpmn-js Modeler in Chromium', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const server = await startStaticServer();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${server.url}/tests/editor-import.html`);
    await page.addScriptTag({ url: `${server.url}/node_modules/bpmn-js/dist/bpmn-modeler.development.js` });
    const compiledArtifacts = await generateArtifacts(compiledVacation);
    const examples = await Promise.all(['ferias', 'http-db'].map(async id => ({ id, xml: await readFile(resolve(generated, `${id}.bpmn`), 'utf8') })));
    examples.push({ id: 'compiled-vacation', xml: compiledArtifacts.bpmnXml });
    examples.push({ id: 'business-intent-vacation-preview', xml: (await generateArtifacts(previewVacation.spec)).bpmnXml });
    examples.push({ id: 'business-intent-complex-purchase', xml: (await generateArtifacts(purchasePreview.spec)).bpmnXml });
    examples.push({ id: 'refined-vacation', xml: (await generateArtifacts(refinedVacation)).bpmnXml });
    for (const { id, xml } of examples) {
      const imported = await page.evaluate(async source => {
        const modeler = new (window as any).BpmnJS({ container: document.querySelector('#canvas') });
        const result = await modeler.importXML(source);
        const saved = await modeler.saveXML({ format: true });
        const count = modeler.get('elementRegistry').getAll().length;
        modeler.destroy();
        return { warnings: result.warnings, saved: saved.xml, count };
      }, xml);
      assert.equal(imported.warnings.length, 0, `${id}: ${JSON.stringify(imported.warnings)}`);
      assert.match(imported.saved, /BPMNDiagram/);
      assert.ok(imported.count > 1);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});

test('generated forms import and serialize in form-js Viewer/Editor without proprietary rules', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const vite = await createViteServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 0 }, appType: 'spa' });
  try {
    await vite.listen();
    const address = vite.httpServer!.address() as { port: number };
    await page.goto(`http://127.0.0.1:${address.port}/tests/form-import.html`);
    await page.waitForFunction(() => Boolean((window as any).Form && (window as any).FormEditor), { timeout: 20000 });
    const formExamples = await Promise.all(['ferias', 'http-db'].map(async id => ({ id, spec: JSON.parse(await readFile(resolve(process.cwd(), `specs/foundation/examples/${id}.json`), 'utf8')) })));
    formExamples.push({ id: 'compiled-vacation', spec: compiledVacation });
    formExamples.push({ id: 'business-intent-vacation-preview', spec: previewVacation.spec });
    formExamples.push({ id: 'business-intent-complex-purchase', spec: purchasePreview.spec });
    formExamples.push({ id: 'refined-vacation', spec: refinedVacation });
    for (const { id, spec } of formExamples) {
      const artifacts = await generateArtifacts(spec);
      for (const { id: formId, json: schema } of artifacts.forms) {
        const result = await page.evaluate(async (formSchema) => {
          const viewer = new (window as any).Form({ container: document.querySelector('#viewer') });
          const viewerResult = await viewer.importSchema(formSchema);
          const editor = new (window as any).FormEditor({ container: document.querySelector('#editor') });
          const editorResult = await editor.importSchema(formSchema);
          const saved = editor.saveSchema();
          let conditionalSemantics: any = null;
          if (formSchema.components.some((component: any) => component.conditional?.hide)) {
            viewer.attachTo(document.querySelector('#viewer'));
            const reasonComponent = formSchema.components.find(component => component.conditional?.hide);
            const decisionComponent = formSchema.components.find(component => component.label === 'Decisão');
            const submission = { [decisionComponent.key]: 'approved', [reasonComponent.key]: '' };
            const reimportContainer = document.createElement('div');
            document.body.appendChild(reimportContainer);
            const reimportedViewer = new (window as any).Form({ container: reimportContainer });
            const reimportResult = await reimportedViewer.importSchema(saved, submission);
            const approvalErrors = reimportedViewer.validate();
            const approvalLabel = Array.from(reimportContainer.querySelectorAll('label')).find(item => item.textContent?.includes('Motivo da rejeição'));
            const approvalVisible = Boolean(approvalLabel);
            submission[decisionComponent.key] = 'rejected';
            await reimportedViewer.importSchema(saved, submission);
            const rejectionErrors = reimportedViewer.validate();
            const rejectionLabel = Array.from(reimportContainer.querySelectorAll('label')).find(item => item.textContent?.includes('Motivo da rejeição'));
            const rejectionVisible = Boolean(rejectionLabel);
            conditionalSemantics = { reasonKey: reasonComponent.key, optionalInFormJs: reasonComponent.validate?.required !== true, hiddenConditionPreserved: Boolean(reasonComponent.conditional?.hide), editorSavedCondition: Boolean(saved.components.find(component => component.key === reasonComponent.key)?.conditional?.hide), reimportWarnings: reimportResult.warnings, approvalErrors, rejectionErrors, approvalVisible, rejectionVisible };
            reimportedViewer.destroy();
          }
          viewer.destroy(); editor.destroy();
          return { viewerWarnings: viewerResult.warnings, editorWarnings: editorResult.warnings, saved, conditionalSemantics };
        }, schema);
        assert.deepEqual(result.viewerWarnings, [], `${id}-${formId} viewer warnings`);
        assert.deepEqual(result.editorWarnings, [], `${id}-${formId} editor warnings`);
        assert.equal(result.saved.components.length, schema.components.length);
        if ((id === 'ferias' && formId === 'form_gestor') || (id === 'compiled-vacation' && result.conditionalSemantics)) {
          assert.equal(result.conditionalSemantics.optionalInFormJs, true);
          assert.equal(result.conditionalSemantics.hiddenConditionPreserved, true);
          assert.equal(result.conditionalSemantics.editorSavedCondition, true);
          assert.deepEqual(result.conditionalSemantics.reimportWarnings, []);
          assert.deepEqual(result.conditionalSemantics.approvalErrors, {});
          assert.equal(result.conditionalSemantics.approvalVisible, false);
          // form-js does not enforce requiredWhen; the ProcessSpec submission validator rejects this case.
          assert.deepEqual(result.conditionalSemantics.rejectionErrors, {});
          assert.equal(result.conditionalSemantics.rejectionVisible, true);
          const reasonComponent = result.saved.components.find((component: any) => component.key === result.conditionalSemantics.reasonKey);
          assert.notEqual(reasonComponent.validate?.required, true);
          assert.ok(reasonComponent.conditional.hide);
        }
      }
    }
    assert.deepEqual(pageErrors, []);
  } finally { await browser.close(); await vite.close(); }
});
