import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeNumericXor } from '../src/modules/validation/numeric-xor.js';
import { validateProcessSpec } from '../src/modules/validation/validation.service.js';
import { generateArtifacts } from '../src/modules/generation/artifact-generator.js';

const v = (key = 'amount') => ({ var: key });
const n = (literal: number) => ({ literal });
const cmp = (op: string, value: number, key = 'amount') => ({ op, left: v(key), right: n(value) });
const routes = (...conditions: any[]) => conditions.map((condition, index) => ({ id: `flow${index}`, condition }));
const codes = (items: ReturnType<typeof analyzeNumericXor>) => items.map(item => item.code);

test('numeric XOR partitions distinguish inclusive boundaries, integer adjacency, default, and equality complements', () => {
  const decimal = [{ key: 'amount', type: 'decimal' }];
  const integer = [{ key: 'amount', type: 'integer' }];
  assert.deepEqual(codes(analyzeNumericXor(routes(cmp('lte', 5000), cmp('gt', 5000)), decimal)), []);
  assert.deepEqual(codes(analyzeNumericXor(routes(cmp('lte', 5000), cmp('gte', 5000)), decimal)), ['GATEWAY_CONDITION_OVERLAP']);
  assert.deepEqual(codes(analyzeNumericXor(routes(cmp('lt', 5000), cmp('gt', 5000)), decimal)), ['GATEWAY_CONDITION_GAP']);
  assert.deepEqual(codes(analyzeNumericXor([...routes(cmp('lt', 5000), cmp('gt', 5000)), { id: 'default', isDefault: true }], decimal)), []);
  assert.deepEqual(codes(analyzeNumericXor(routes(cmp('lte', 4999), cmp('gte', 5000)), integer)), []);
  assert.deepEqual(codes(analyzeNumericXor(routes(cmp('lte', 4999), cmp('gte', 5000)), decimal)), ['GATEWAY_CONDITION_GAP']);
  assert.deepEqual(codes(analyzeNumericXor(routes(cmp('eq', 5000), cmp('ne', 5000)), decimal)), []);
  assert.deepEqual(codes(analyzeNumericXor(routes(cmp('gte', 0), cmp('lt', 0)), decimal)), []);
});

test('numeric XOR reports empty and inconclusive branches without coercion or fabricated proof', () => {
  const vars = [{ key: 'amount', type: 'decimal' }, { key: 'other', type: 'decimal' }, { key: 'text', type: 'string' }];
  const contradictory = { op: 'and', args: [cmp('gt', 10), cmp('lt', 5)] };
  assert.deepEqual(codes(analyzeNumericXor(routes(contradictory, cmp('lte', 10)), vars)), ['GATEWAY_CONDITION_EMPTY']);
  assert.deepEqual(codes(analyzeNumericXor([{ id: 'empty', condition: contradictory }, { id: 'default', isDefault: true }], vars)), ['GATEWAY_CONDITION_EMPTY']);
  assert.deepEqual(codes(analyzeNumericXor(routes(cmp('lte', 5), cmp('gt', 5, 'other')), vars)), ['GATEWAY_CONDITION_UNPROVABLE']);
  assert.deepEqual(codes(analyzeNumericXor(routes({ op: 'eq', left: v('text'), right: n(5) }, cmp('ne', 5, 'text')), vars)), ['GATEWAY_CONDITION_UNPROVABLE']);
  assert.deepEqual(codes(analyzeNumericXor(routes({ op: 'gt', left: v(), right: { literal: '5000' } }, cmp('lte', 5000)), vars)), ['GATEWAY_CONDITION_UNPROVABLE']);
});

test('numeric XOR diagnostics are integrated into ProcessSpec semantic validation', async () => {
  const spec = JSON.parse(await readFile('specs/foundation/examples/ferias.json', 'utf8'));
  const gateway = spec.nodes.find((node: any) => node.type === 'exclusiveGateway');
  const outgoing = spec.flows.filter((flow: any) => flow.source === gateway.id);
  assert.equal(outgoing.length, 2);
  spec.variables.push({ key: 'amount', type: 'decimal', required: true, sensitive: false, scope: 'process', source: { kind: 'constant', value: 1 } });
  outgoing[0].condition = cmp('lte', 5000);
  outgoing[1].condition = cmp('gte', 5000);
  let result = await validateProcessSpec(spec);
  assert.ok(result.diagnostics.some(item => item.code === 'GATEWAY_CONDITION_OVERLAP' && item.path === gateway.id));
  outgoing[1].condition = cmp('gt', 5000);
  result = await validateProcessSpec(spec);
  assert.ok(!result.diagnostics.some(item => item.code === 'GATEWAY_CONDITION_OVERLAP' || item.code === 'GATEWAY_CONDITION_GAP'));
});

test('golden G05-G07 validate threshold routes, two sequential XORs, and three disjoint bands', async () => {
  const decimal = [{ key: 'amount', type: 'decimal' }];
  assert.deepEqual(codes(analyzeNumericXor(routes(cmp('lte', 2000), cmp('gt', 2000)), decimal)), []);
  const bands = [
    cmp('lte', 5000),
    { op: 'and', args: [cmp('gt', 5000), cmp('lte', 20000)] },
    cmp('gt', 20000),
  ];
  assert.deepEqual(codes(analyzeNumericXor(routes(...bands), decimal)), []);

  const spec = {
    schemaVersion: '1.0.0', id: 'two_xors', name: 'Dois XOR em sequência', locale: 'pt-BR', targetProfile: 'generic-bpmn2', status: 'ready-for-review',
    roles: [{ id: 'requester', label: 'Solicitante', resolution: 'requester' }],
    variables: [
      { key: 'amount', type: 'integer', required: true, sensitive: false, scope: 'process', source: { kind: 'constant', value: 1 } },
      { key: 'score', type: 'decimal', required: true, sensitive: false, scope: 'process', source: { kind: 'constant', value: 1 } },
    ], forms: [], pendingQuestions: [], assumptions: [], policies: { manualApprovalRequired: true, allowExecution: false },
    nodes: [
      { id: 'start', name: 'Início', type: 'startEvent' }, { id: 'first', name: 'Primeira decisão', type: 'exclusiveGateway' },
      { id: 'a', name: 'Ramo A', type: 'userTask', roleId: 'requester' }, { id: 'b', name: 'Ramo B', type: 'userTask', roleId: 'requester' },
      { id: 'second', name: 'Segunda decisão', type: 'exclusiveGateway' }, { id: 'end_a', name: 'Fim A', type: 'endEvent' }, { id: 'end_b', name: 'Fim B', type: 'endEvent' },
    ],
    flows: [
      { id: 'f0', source: 'start', target: 'first' },
      { id: 'f1', source: 'first', target: 'a', condition: cmp('lte', 5000) },
      { id: 'f2', source: 'first', target: 'b', condition: cmp('gt', 5000) },
      { id: 'f3', source: 'a', target: 'second' }, { id: 'f4', source: 'b', target: 'second' },
      { id: 'f5', source: 'second', target: 'end_a', condition: cmp('eq', 20000, 'score') },
      { id: 'f6', source: 'second', target: 'end_b', condition: cmp('ne', 20000, 'score') },
    ],
  };
  const validation = await validateProcessSpec(spec);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  const artifact = await generateArtifacts(spec);
  assert.match(artifact.bpmnXml, /id="f1"/);
  assert.match(artifact.bpmnXml, /id="f6"/);
  const combinations = spec.flows.filter(flow => flow.source === 'first').flatMap(first => spec.flows.filter(flow => flow.source === 'second').map(second => `${first.id}/${second.id}`));
  assert.equal(combinations.length, 4);
});

test('golden G28 preserves visually equivalent activities by distinct IDs', async () => {
  const spec = JSON.parse(await readFile('specs/foundation/examples/ferias.json', 'utf8'));
  const tasks = spec.nodes.filter((node: any) => node.type === 'userTask');
  assert.ok(tasks.length >= 2);
  tasks[1].name = tasks[0].name;
  const validation = await validateProcessSpec(spec);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  const artifacts = await generateArtifacts(spec);
  assert.ok(artifacts.bpmnXml.includes(`id="${tasks[0].id}"`));
  assert.ok(artifacts.bpmnXml.includes(`id="${tasks[1].id}"`));
});

test('golden corpus includes the full G01-G33 matrix and separates future claims', async () => {
  const corpus = JSON.parse(await readFile('tests/golden/corpus.json', 'utf8')) as Array<{ id: string; class: string; observed: string; expected: any }>;
  assert.equal(corpus.length, 33);
  assert.deepEqual(corpus.map(item => item.id), Array.from({ length: 33 }, (_, index) => `G${String(index + 1).padStart(2, '0')}`));
  assert.ok(corpus.filter(item => (item.class === 'supported-positive' || item.class === 'supported-negative') && item.id !== 'G03').every(item => item.observed === 'PASS'));
  assert.equal(corpus.find(item => item.id === 'G03')?.observed, 'NOT-YET-EVALUATED', 'the new exact reimbursement target is tracked but not claimed as passing');
  assert.ok(corpus.filter(item => item.class === 'future-capability' || item.class === 'semantic-future').every(item => item.observed === 'UNSUPPORTED' && item.expected.valid === null));
});

test('golden negative cases G11-G18 are rejected by the actual ProcessSpec validator', async () => {
  const source = JSON.parse(await readFile('specs/foundation/examples/ferias.json', 'utf8'));
  const mutations: Array<{ id: string; mutate: (spec: any) => void; code: string }> = [
    { id: 'G11', mutate: spec => { spec.flows[0].target = 'missing_target'; }, code: 'FLOW_TARGET_MISSING' },
    { id: 'G12', mutate: spec => { spec.nodes.push({ id: 'orphan', name: 'Nó órfão', type: 'manualTask' }); }, code: 'UNREACHABLE_NODE' },
    { id: 'G13', mutate: spec => { const task = spec.nodes.find((node: any) => node.type === 'userTask'); spec.flows = spec.flows.filter((flow: any) => flow.source !== task.id); }, code: 'DEAD_END' },
    { id: 'G14', mutate: spec => { spec.nodes[1].id = spec.nodes[0].id; }, code: 'DUPLICATE_ID' },
    { id: 'G15', mutate: spec => { const start = spec.nodes.find((node: any) => node.type === 'startEvent'); start.formId = 'missing_form'; }, code: 'FORM_UNDEFINED' },
    { id: 'G16', mutate: spec => { const flow = spec.flows.find((item: any) => item.condition); flow.condition.left.var = 'missing_variable'; }, code: 'CONDITION_VAR_UNDEFINED' },
    { id: 'G17', mutate: spec => { const gateway = spec.nodes.find((node: any) => node.type === 'exclusiveGateway'); const routes = spec.flows.filter((flow: any) => flow.source === gateway.id); routes[0].isDefault = true; routes[1].isDefault = true; }, code: 'GATEWAY_DEFAULT_INVALID' },
    { id: 'G18', mutate: spec => { const flow = spec.flows.find((item: any) => item.condition); delete flow.condition; }, code: 'GATEWAY_ROUTE_MISSING' },
  ];
  for (const item of mutations) {
    const spec = structuredClone(source);
    item.mutate(spec);
    const result = await validateProcessSpec(spec);
    assert.equal(result.valid, false, item.id);
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === item.code), `${item.id}: ${JSON.stringify(result.diagnostics)}`);
  }
});
