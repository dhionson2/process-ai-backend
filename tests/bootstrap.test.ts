import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { getExample } from '../src/modules/examples/example.repository.js';
import { validateProcessSpec } from '../src/modules/validation/validation.service.js';

test('endpoint de saúde', async () => {
  const app = await buildApp();
  try { const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200); assert.equal(response.json().status, 'ok');
  } finally { await app.close(); }
});
test('exemplos importados preservam contrato e nenhuma execução ocorre', async () => {
  const app = await buildApp();
  try { for (const id of ['ferias', 'http-db']) {
    const response = await app.inject({ method: 'GET', url: `/api/v1/examples/${id}` });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.match(body.bpmnXml, /isExecutable="false"/);
    assert.equal((await validateProcessSpec(body.spec)).valid, true);
  }} finally { await app.close(); }
});
test('rejeita objeto sem contrato, campos ausentes e referência quebrada', async () => {
  assert.equal((await validateProcessSpec({})).valid, false);
  const fixture = (await getExample('ferias')).spec;
  const broken = structuredClone(fixture) as any;
  broken.flows[0].target = 'nao_existe';
  const response = await validateProcessSpec(broken);
  assert.equal(response.valid, false);
  assert.ok(response.diagnostics.some(d => d.code === 'FLOW_TARGET_MISSING'));
});
test('404 para exemplo não permitido, impedindo path traversal', async () => {
  const app = await buildApp();
  try { const r = await app.inject({ method: 'GET', url: '/api/v1/examples/%2e%2e' });
    assert.equal(r.statusCode, 404);
  } finally { await app.close(); }
});
