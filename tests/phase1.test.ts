import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { validateFormSubmission, validateProcessSpec } from '../src/modules/validation/validation.service.js';
import { generateArtifacts } from '../src/modules/generation/artifact-generator.js';

async function fixture(name: string): Promise<any> { return JSON.parse(await readFile(`specs/foundation/examples/${name}.json`, 'utf8')); }

test('ProcessSpecs férias e HTTP/banco validam e geram artefatos determinísticos', async () => {
  for (const name of ['ferias', 'http-db']) {
    const spec = await fixture(name);
    assert.equal((await validateProcessSpec(spec)).valid, true, name);
    if (name === 'ferias') {
      const preview = await generateArtifacts(spec);
      assert.deepEqual(await generateArtifacts(spec), preview);
      assert.match(preview.bpmnXml, /BPMNDiagram/);
      assert.equal(preview.forms.length, spec.forms.length);
      assert.equal((preview.manifest as any).artifactStatus, 'valid-for-preview');
      assert.equal((preview.manifest as any).validation.externalValidationRequired, true);
      assert.equal((preview.manifest as any).publication.eligible, false);
      assert.deepEqual((preview.manifest as any).delegatedRules, [{ formId: 'form_gestor', fieldKey: 'reason', rule: 'requiredWhen', validator: 'ProcessSpec submission validation' }]);
      assert.ok(preview.diagnostics.some(item => item.code === 'EXTERNAL_FORM_VALIDATION_REQUIRED' && item.severity === 'warning'));
      const reasonForm = preview.forms.find(form => form.id === 'form_gestor')!.json as any;
      const reasonComponent = reasonForm.components.find((component: any) => component.key === 'reason');
      assert.equal(reasonComponent.validate?.required, undefined);
      assert.ok(reasonComponent.conditional.hide);
      const approved = await validateFormSubmission(spec, 'form_gestor', { decision: 'approved', reason: '' });
      const rejectedEmpty = await validateFormSubmission(spec, 'form_gestor', { decision: 'rejected', reason: '' });
      const rejectedFilled = await validateFormSubmission(spec, 'form_gestor', { decision: 'rejected', reason: 'Motivo válido' });
      assert.equal(approved.valid, true);
      assert.equal(rejectedEmpty.valid, false);
      assert.equal(rejectedEmpty.diagnostics[0].code, 'FORM_FIELD_REQUIRED');
      assert.equal(rejectedFilled.valid, true);
      const alternated = await validateFormSubmission(spec, 'form_gestor', { decision: 'approved', reason: '' });
      assert.equal(alternated.valid, true);
      assert.equal((await validateFormSubmission(spec, 'form_gestor', { decision: 'rejected', reason: '' })).valid, false);
      continue;
    }
    const first = await generateArtifacts(spec);
    const second = await generateArtifacts(spec);
    assert.deepEqual(second, first);
    assert.equal(first.forms.length, spec.forms.length);
    assert.match(first.bpmnXml, /BPMNDiagram/);
    assert.match(first.bpmnXml, /isExecutable="false"/);
    assert.deepEqual(first.manifest && (first.manifest as any).uncompiledRules, []);
    assert.ok(Object.keys((first.manifest as any).checksums).length === spec.forms.length + 1);
  }
});

test('validador rejeita falhas críticas de expressão, formulário, conector e roteamento', async () => {
  const cases: Array<[string, (spec: any) => void, string]> = [
    ['referência de fluxo', s => { s.flows[0].target = 'missing'; }, 'FLOW_TARGET_MISSING'],
    ['variável em condição', s => { s.flows[2].condition.left.var = 'missing'; }, 'CONDITION_VAR_UNDEFINED'],
    ['tipo incompatível em condição', s => { s.flows[2].condition = { op: 'gt', left: { var: 'decision' }, right: { literal: 3 } }; }, 'CONDITION_TYPE_MISMATCH'],
    ['vínculo de campo', s => { s.forms[0].fields[0].bindTo = 'notes'; }, 'FIELD_TYPE_MISMATCH'],
    ['operação fora do catálogo', s => { s.nodes.find((n: any) => n.id === 'update').action.operationId = 'arbitrary_sql'; }, 'CONNECTOR_NOT_APPROVED'],
    ['write sem idempotência', s => { delete s.nodes.find((n: any) => n.id === 'update').action.idempotencyKey; }, 'SIDE_EFFECT_UNSAFE'],
    ['gateway sem rota condicional/default', s => { delete s.flows[3].condition; }, 'GATEWAY_ROUTE_MISSING'],
    ['form órfão', s => { s.forms.push({ ...s.forms[0], id: 'unused_form' }); }, 'FORM_ORPHANED'],
  ];
  for (const [label, mutate, code] of cases) {
    const spec = await fixture(['operação fora do catálogo', 'write sem idempotência', 'gateway sem rota condicional/default'].includes(label) ? 'http-db' : 'ferias');
    mutate(spec);
    const result = await validateProcessSpec(spec);
    assert.equal(result.valid, false, label);
    assert.ok(result.diagnostics.some(item => item.code === code), `${label}: ${JSON.stringify(result.diagnostics)}`);
  }
});

test('backend aplica requiredWhen condicional nos dados submetidos de férias', async () => {
  const spec = await fixture('ferias');
  assert.equal((await validateFormSubmission(spec, 'form_gestor', { decision: 'approved' })).valid, true);
  assert.equal((await validateFormSubmission(spec, 'form_gestor', { decision: 'rejected', reason: '   ' })).valid, false);
  assert.equal((await validateFormSubmission(spec, 'form_gestor', { decision: 'rejected', reason: 'Motivo válido' })).valid, true);
});

test('rotas validate/generate/publication e OpenAPI refletem contrato v1', async () => {
  const app = await buildApp();
  try {
    for (const id of ['ferias', 'http-db']) {
      const spec = await fixture(id);
      assert.equal((await app.inject({ method: 'POST', url: '/api/v1/validate', payload: spec })).statusCode, 200);
      if (id === 'ferias') {
        const validApproval = await app.inject({ method: 'POST', url: '/api/v1/validate-form', payload: { spec, formId: 'form_gestor', data: { decision: 'approved' } } });
        const invalidRejection = await app.inject({ method: 'POST', url: '/api/v1/validate-form', payload: { spec, formId: 'form_gestor', data: { decision: 'rejected', reason: '' } } });
        const validRejection = await app.inject({ method: 'POST', url: '/api/v1/validate-form', payload: { spec, formId: 'form_gestor', data: { decision: 'rejected', reason: 'Justificativa' } } });
        assert.equal(validApproval.json().valid, true);
        assert.equal(invalidRejection.json().valid, false);
        assert.equal(validRejection.json().valid, true);
      }
      const generated = await app.inject({ method: 'POST', url: '/api/v1/generate', payload: spec });
      assert.equal(generated.statusCode, 200);
      assert.equal(generated.json().forms.length, spec.forms.length);
      if (id === 'ferias') {
        assert.equal(generated.json().manifest.artifactStatus, 'valid-for-preview');
        assert.equal(generated.json().manifest.validation.externalValidationRequired, true);
        assert.equal(generated.json().manifest.publication.eligible, false);
        assert.ok(generated.json().diagnostics.some((item: any) => item.code === 'EXTERNAL_FORM_VALIDATION_REQUIRED'));
        const publication = await app.inject({ method: 'POST', url: '/api/v1/publication/validate', payload: { spec, runtimeCapabilities: { conditionalFormValidation: false } } });
        assert.equal(publication.statusCode, 422);
        assert.equal(publication.json().publishable, false);
        assert.ok(publication.json().blockers.some((item: any) => item.code === 'RUNTIME_CONDITIONAL_VALIDATION_UNGUARANTEED'));
        const guarded = await app.inject({ method: 'POST', url: '/api/v1/publication/validate', payload: { spec, runtimeCapabilities: { conditionalFormValidation: true } } });
        assert.equal(guarded.statusCode, 422);
        assert.equal(guarded.json().publishable, false);
        assert.ok(guarded.json().blockers.some((item: any) => item.code === 'PROCESS_CONFIGURATION_PENDING'));
        assert.ok(guarded.json().blockers.some((item: any) => item.code === 'PUBLICATION_DISABLED_IN_PHASE1'));
      }
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/generate', payload: {} })).statusCode, 422);
    const openapi = await app.inject({ method: 'GET', url: '/openapi.json' });
    assert.equal(openapi.statusCode, 200);
    assert.equal(openapi.json().openapi, '3.1.0');
    assert.ok(openapi.json().paths['/api/v1/generate']);
    assert.ok(openapi.json().paths['/api/v1/validate-form']);
    assert.ok(openapi.json().paths['/api/v1/publication/validate']);
    assert.ok(openapi.json().paths['/api/v1/projects']);
    assert.ok(openapi.json().paths['/api/v1/design-sessions/{sessionId}/messages']);
    assert.ok(openapi.json().paths['/api/v1/design-sessions/{sessionId}/revisions/{revision}/accept']);
    assert.equal(openapi.json().info.version, '1.5.0');
    assert.ok(openapi.json().components.schemas.PublicationReadiness);
    assert.ok(openapi.json().components.schemas.GeneratedArtifacts.properties.manifest.properties.delegatedRules);
    assert.equal(openapi.json().components.schemas.ProcessSpec.properties.schemaVersion.const, '1.0.0');
    const spec = openapi.json();
    for (const [path, operations] of Object.entries(spec.paths) as Array<[string, Record<string, unknown>]>) {
      for (const method of Object.keys(operations)) {
        assert.equal(app.hasRoute({ method: method.toUpperCase() as any, url: path.replace(/\{([^}]+)\}/g, ':$1') }), true, `${method.toUpperCase()} ${path}`);
      }
    }
    const preflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/projects', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' } });
    assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:5173');
  } finally { await app.close(); }
});
