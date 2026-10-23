import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp } from '../src/app.js';
import { readEnvironment } from '../src/config/env.js';
import { FORM_SCHEMA_VERSION, generateArtifacts } from '../src/modules/generation/artifact-generator.js';
import { assessBpmnImportability, assessFormImportability, assessModelerImportability, MAX_FORM_DEPTH } from '../src/modules/generation/modeler-compat.js';
import { InMemoryConversationRepository } from '../src/modules/projects/conversation.repository.js';

const example = async (id: string) => JSON.parse(await readFile(resolve('specs/foundation/examples', `${id}.json`), 'utf8'));

test('artefatos gerados são importáveis no Modeler: BPMN pela porta «Abrir», formulário pelas regras remotas', async () => {
  for (const id of ['ferias', 'http-db']) {
    const artifacts = await generateArtifacts(await example(id));
    assert.equal(artifacts.diagnostics.filter(item => item.severity === 'error').length, 0, id);
    const report = await assessModelerImportability(artifacts);
    assert.deepEqual(report, { importable: true, problems: [] }, id);
    assert.match(artifacts.bpmnXml, /targetNamespace="http:\/\/bpmn\.io\/schema\/bpmn"/);
    assert.doesNotMatch(artifacts.bpmnXml, /xmlns:process-ai/, 'namespace de prévia não vai mais ao Modeler');
    assert.match(artifacts.bpmnXml, /xmlns:flowable="http:\/\/flowable\.org\/bpmn"/, 'flowable atravessa a validação do Modeler intacto');
    for (const form of artifacts.forms) {
      const schema = form.json as { type: string; id: string; schemaVersion: number };
      assert.equal(schema.type, 'default'); assert.equal(schema.schemaVersion, FORM_SCHEMA_VERSION); assert.equal(schema.id, `Form_${form.id}`);
    }
  }
});

test('regras do Modeler recusam o que o Modeler recusaria', async () => {
  assert.deepEqual(await assessBpmnImportability(''), ['BPMN vazio']);
  assert.match((await assessBpmnImportability('<!DOCTYPE x [<!ENTITY a "b">]><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"/>'))[0], /DTD/);
  assert.match((await assessBpmnImportability('<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"><bpmn:process>'))[0], /inválido|moddle/);
  assert.match((await assessBpmnImportability('<svg xmlns="http://www.w3.org/2000/svg"/>'))[0], /definitions|inválido|moddle/);
  assert.deepEqual(await assessBpmnImportability('<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D"><bpmn:process id="P"/></bpmn:definitions>'), []);

  assert.match(assessFormImportability({ components: [] })[0], /raiz/);
  assert.match(assessFormImportability({ type: 'default', components: [{ type: 'filepicker', key: 'a' }] })[0], /filepicker.*allowlist/);
  assert.match(assessFormImportability({ type: 'default', components: [{ type: 'group', components: [{ type: 'iframe' }] }] })[0], /iframe/, 'allowlist é recursiva');
  let nested: Record<string, unknown> = { type: 'textfield', key: 'x' };
  for (let depth = 0; depth < MAX_FORM_DEPTH + 1; depth += 1) nested = { type: 'group', components: [nested] };
  assert.ok(assessFormImportability({ type: 'default', components: [nested] }).some(problem => /profundidade/.test(problem)));
  assert.deepEqual(assessFormImportability({ type: 'default', schemaVersion: 19, components: [{ type: 'textfield', key: 'a' }, { type: 'button', action: 'submit' }] }), []);
});

test('CORS: a origem fixa da extensão do Chrome é liberada quando listada em CORS_ORIGIN, inclusive no preflight com Prefer', async () => {
  const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const app = await buildApp(readEnvironment({ LOG_LEVEL: 'silent', CORS_ORIGIN: `http://localhost:5173,${origin}` }), { conversationRepository: new InMemoryConversationRepository() });
  try {
    const preflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/projects', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,prefer,authorization' } });
    assert.equal(preflight.statusCode, 204, preflight.body);
    assert.equal(preflight.headers['access-control-allow-origin'], origin);
    assert.match(String(preflight.headers['access-control-allow-headers']), /prefer/i);
    const health = await app.inject({ method: 'GET', url: '/health', headers: { origin } });
    assert.equal(health.headers['access-control-allow-origin'], origin);
    const stranger = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'chrome-extension://outra' } });
    assert.equal(stranger.headers['access-control-allow-origin'], undefined, 'outra extensão não é liberada');
  } finally { await app.close(); }
});
