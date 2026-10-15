import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lowerGraphIRToProcessSpec } from '../src/modules/graph-ir/processspec.adapter.js';
import { validateGraphIR, type GraphIRV1 } from '../src/modules/graph-ir/graph-ir.js';
import { generateArtifacts } from '../src/modules/generation/artifact-generator.js';
import { g03ReimbursementProcessSpec } from './fixtures/g03-reimbursement.js';

function toGraphIR(spec: any): GraphIRV1 {
  const variableId = (key: string) => `var_${key}`;
  const convertExpression = (expression: any): any => {
    if (Object.hasOwn(expression, 'var')) return { var: variableId(expression.var) };
    if (Object.hasOwn(expression, 'literal')) return { literal: expression.literal };
    if (expression.op === 'and' || expression.op === 'or') return { op: expression.op, args: expression.args.map(convertExpression) };
    if (expression.op === 'not' || expression.op === 'isSet') return { op: expression.op, arg: convertExpression(expression.arg) };
    return { op: expression.op, left: convertExpression(expression.left), right: convertExpression(expression.right) };
  };
  const requirements: GraphIRV1['requirements'] = [];
  const nodes = spec.nodes.map((node: any) => {
    const refs: string[] = [];
    if (node.type === 'userTask' || node.type === 'exclusiveGateway') {
      const id = `req_node_${node.id}`; refs.push(id);
      requirements.push({ id, kind: node.type === 'userTask' ? 'activity' : 'structure', mandatory: true, nodeId: node.id });
    }
    return { id: node.id, type: ({ startEvent: 'start', endEvent: 'end', userTask: 'humanTask', serviceTask: 'serviceTask', exclusiveGateway: 'exclusiveGateway' } as Record<string, string>)[node.type], name: node.name, ...(node.roleId ? { roleId: node.roleId } : {}), ...(node.formId ? { formRef: node.formId } : {}), requirementRefs: refs };
  });
  const loops = new Set(['f_adjust_return', 'f_docs_return']);
  const consequences = new Set(['f_manager_rejected', 'f_director_rejected', 'f_not_reimbursable']);
  const edges = spec.flows.map((flow: any) => {
    const refs: string[] = [];
    if (loops.has(flow.id)) {
      const id = `req_loop_${flow.id}`; refs.push(id);
      requirements.push({ id, kind: 'loop', mandatory: true, sourceNodeId: flow.source, targetNodeId: flow.target });
    }
    if (consequences.has(flow.id)) {
      const id = `req_consequence_${flow.id}`; refs.push(id);
      requirements.push({ id, kind: 'consequence', mandatory: true, sourceNodeId: flow.source, targetNodeId: flow.target });
    }
    if (flow.condition) {
      const id = `req_condition_${flow.id}`; refs.push(id);
      const variableKey = flow.condition.left?.var;
      requirements.push({ id, kind: 'condition', mandatory: true, ...(variableKey ? { variableId: variableId(variableKey) } : {}), operator: flow.condition.op, value: flow.condition.right?.literal });
    }
    const source = spec.nodes.find((node: any) => node.id === flow.source);
    return { id: flow.id, source: flow.source, target: flow.target, kind: loops.has(flow.id) ? 'loop-back' as const : 'sequence' as const,
      ...(source?.type === 'exclusiveGateway' ? { gatewayId: source.id } : {}), ...(flow.condition ? { condition: convertExpression(flow.condition) } : {}), ...(flow.label ? { label: flow.label } : {}), requirementRefs: refs };
  });
  return {
    schemaVersion: '1.0.0', process: { id: spec.id, name: spec.name, description: spec.description, locale: spec.locale, targetProfile: spec.targetProfile },
    roles: spec.roles.map((role: any) => ({ ...role })),
    variables: spec.variables.map((variable: any) => ({ id: variableId(variable.key), key: variable.key, type: variable.type, required: variable.required, sensitive: variable.sensitive, scope: variable.scope,
      source: variable.source.kind === 'form' ? { kind: 'form', formRef: variable.source.formId, fieldKey: variable.source.fieldKey } : structuredClone(variable.source) })),
    requirements,
    nodes,
    edges,
    formRefs: spec.forms.map((form: any) => ({ id: form.id, name: form.name, usage: form.usage, fields: form.fields.map((field: any) => ({ ...field, bindTo: variableId(field.bindTo), ...(field.visibleWhen ? { visibleWhen: convertExpression(field.visibleWhen) } : {}), ...(field.requiredWhen ? { requiredWhen: convertExpression(field.requiredWhen) } : {}), requirementRefs: [] })) })),
    metadata: { provenance: [] },
  };
}

test('GraphIR → ProcessSpec V1 executa fronteira explícita e mantém estrutura de G03', async () => {
  const graph = toGraphIR(g03ReimbursementProcessSpec);
  assert.equal(validateGraphIR(graph).valid, true, JSON.stringify(validateGraphIR(graph).diagnostics));
  const lowered = await lowerGraphIRToProcessSpec(graph);
  assert.equal(lowered.valid, true, JSON.stringify(lowered.diagnostics));
  assert.ok(lowered.processSpec);
  const source = g03ReimbursementProcessSpec as any;
  const target = lowered.processSpec!;
  const artifacts = await generateArtifacts(target);
  assert.ok(artifacts.bpmnXml.includes('<bpmn:definitions'));
  assert.equal(artifacts.forms.length, source.forms.length);
  assert.deepEqual(target.nodes.map((item: any) => item.id).sort(), source.nodes.map((item: any) => item.id).sort());
  assert.deepEqual(target.nodes.map((item: any) => ({ id: item.id, type: item.type, name: item.name, roleId: item.roleId, formId: item.formId })).sort((a: any, b: any) => a.id.localeCompare(b.id)), source.nodes.map((item: any) => ({ id: item.id, type: item.type, name: item.name, roleId: item.roleId, formId: item.formId })).sort((a: any, b: any) => a.id.localeCompare(b.id)));
  assert.deepEqual(target.roles, [...source.roles].sort((a: any, b: any) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  assert.deepEqual(target.variables.map((item: any) => ({ key: item.key, type: item.type, required: item.required, sensitive: item.sensitive, scope: item.scope, source: item.source })), source.variables.map((item: any) => ({ key: item.key, type: item.type, required: item.required, sensitive: item.sensitive, scope: item.scope, source: item.source })).sort((a: any, b: any) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const sourceForms = new Map(source.forms.map((form: any) => [form.id, form]));
  for (const form of target.forms) assert.deepEqual(form.fields.map((field: any) => ({ key: field.key, label: field.label, type: field.type, required: field.required, bindTo: field.bindTo, options: field.options, visibleWhen: field.visibleWhen, requiredWhen: field.requiredWhen })), sourceForms.get(form.id).fields.map((field: any) => ({ key: field.key, label: field.label, type: field.type, required: field.required, bindTo: field.bindTo, options: field.options, visibleWhen: field.visibleWhen, requiredWhen: field.requiredWhen })));
  const sourceFlows = new Map(source.flows.map((flow: any) => [flow.id, flow]));
  const targetFlows = new Map(target.flows.map((flow: any) => [flow.id, flow]));
  assert.equal(target.flows.length, source.flows.length);
  for (const flow of source.flows) assert.deepEqual(targetFlows.get(flow.id), flow);
  const loopRequirements = graph.requirements.filter(item => item.kind === 'loop');
  assert.deepEqual(loopRequirements.map(item => [item.id, item.sourceNodeId, item.targetNodeId]).sort(), [
    ['req_loop_f_adjust_return', 'employee_adjust', 'manager_check'],
    ['req_loop_f_docs_return', 'employee_correct_docs', 'finance_check'],
  ].sort());
  const loweredRequirementRefs = new Set((target.metadata.requirementProvenance || []).map((item: any) => item.name));
  assert.deepEqual([...graph.requirements.map(item => item.id).filter(id => !loweredRequirementRefs.has(id))], [], 'RequirementRefs de nó, aresta e formulário permanecem ligados no metadata do ProcessSpec');
  assert.ok(target.forms.find((form: any) => form.id === 'form_manager_approval').fields.find((field: any) => field.key === 'manager_rejection_reason').requiredWhen);
  assert.equal(target.policies.allowExecution, false);
});

test('GraphIR lowering é determinístico para reordenação de nós, arestas, papéis, variáveis e requisitos', async () => {
  const graph = toGraphIR(g03ReimbursementProcessSpec);
  const shuffled = structuredClone(graph);
  shuffled.nodes.reverse(); shuffled.edges.reverse(); shuffled.roles.reverse(); shuffled.variables.reverse(); shuffled.requirements.reverse(); shuffled.formRefs.reverse();
  const a = await lowerGraphIRToProcessSpec(graph); const b = await lowerGraphIRToProcessSpec(shuffled);
  assert.equal(a.valid, true); assert.equal(b.valid, true);
  assert.deepEqual(a.processSpec, b.processSpec);
});

test('GraphIR lowering conserva IDs e proveniência de requisito no metadata compatível', async () => {
  const graph = toGraphIR(g03ReimbursementProcessSpec);
  graph.nodes.find(node => node.id === 'manager_approval')!.provenance = { source: 'user', confirmed: true, sourceRef: 'turn-8', evidenceSha256: 'a'.repeat(64) };
  const lowered = await lowerGraphIRToProcessSpec(graph);
  assert.equal(lowered.valid, true);
  const provenance = lowered.processSpec!.metadata.requirementProvenance;
  assert.ok(provenance.some((item: any) => item.path === '/graph/nodes/manager_approval/requirements/req_node_manager_approval' && item.source === 'user' && item.confirmed && item.evidenceSha256 === 'a'.repeat(64)));
  assert.equal(JSON.stringify(lowered.processSpec).includes('turn-8'), false, 'diagnóstico/proveniência não guarda texto de conversa');
});

test('GraphIR lowering conserva proveniência global segura e recusa metadata sem campo equivalente', async () => {
  const graph = toGraphIR(g03ReimbursementProcessSpec);
  graph.metadata.provenance.push({ source: 'confirmed-answer', confirmed: true, evidenceSha256: 'b'.repeat(64) });
  const lowered = await lowerGraphIRToProcessSpec(graph);
  assert.equal(lowered.valid, true, JSON.stringify(lowered.diagnostics));
  assert.ok(lowered.processSpec!.metadata.requirementProvenance.some((item: any) => item.path === '/graph/metadata/provenance/0' && item.source === 'confirmed-answer' && item.confirmed && item.evidenceSha256 === 'b'.repeat(64)));
  assert.equal(JSON.stringify(lowered.processSpec).includes('sourceRef'), false, 'referências opacas não são serializadas no ProcessSpec');

  graph.metadata.sourceVersion = 'upstream-v2';
  const unsupported = await lowerGraphIRToProcessSpec(graph);
  assert.equal(unsupported.valid, false);
  assert.equal(unsupported.processSpec, null);
  assert.ok(unsupported.diagnostics.some(item => item.code === 'GRAPHIR_METADATA_UNSUPPORTED'));
});

test('GraphIR lowering falha explicitamente para papel unresolved sem pergunta de configuração', async () => {
  const graph = toGraphIR(g03ReimbursementProcessSpec);
  graph.roles[0].resolution = 'unresolved';
  const lowered = await lowerGraphIRToProcessSpec(graph);
  assert.equal(lowered.valid, false);
  assert.equal(lowered.processSpec, null);
  assert.ok(lowered.diagnostics.some(item => item.code === 'GRAPHIR_UNSUPPORTED_UNRESOLVED_ROLE'));
});

test('GraphIR lowering recusa targetProfile ainda não certificado pelos geradores', async () => {
  const graph = toGraphIR(g03ReimbursementProcessSpec);
  graph.process.targetProfile = 'flowable-oss';
  const lowered = await lowerGraphIRToProcessSpec(graph);
  assert.equal(lowered.valid, false);
  assert.equal(lowered.processSpec, null);
  assert.ok(lowered.diagnostics.some(item => item.code === 'GRAPHIR_TARGET_PROFILE_UNSUPPORTED'));
});

test('GraphIR lowering recusa requisito loop redirecionado e não oculta rota inválida', async () => {
  const graph = toGraphIR(g03ReimbursementProcessSpec);
  graph.edges.find(edge => edge.id === 'f_docs_return')!.target = 'manager_check';
  const lowered = await lowerGraphIRToProcessSpec(graph);
  assert.equal(lowered.valid, false);
  assert.equal(lowered.processSpec, null);
  assert.ok(lowered.diagnostics.some(item => item.code === 'GRAPHIR_LOOP_DESTINATION_DIVERGENCE'));
});

test('GraphIR lowering não inventa saída de gateway para uma condição numérica divergente', async () => {
  const graph = toGraphIR(g03ReimbursementProcessSpec);
  graph.edges.find(edge => edge.id === 'f_amount_high')!.condition = { op: 'gte', left: { var: 'var_requested_amount' }, right: { literal: 2000 } };
  const lowered = await lowerGraphIRToProcessSpec(graph);
  assert.equal(lowered.valid, false);
  assert.equal(lowered.processSpec, null);
  assert.ok(lowered.diagnostics.some(item => item.code === 'GATEWAY_CONDITION_OVERLAP'));
});

test('GraphIR lowering mantém serviço declarativo e converte referências de variáveis estáveis para ProcessSpec', async () => {
  const graph: GraphIRV1 = {
    schemaVersion: '1.0.0', process: { id: 'lookup_process', name: 'Consultar solicitação', locale: 'pt-BR', targetProfile: 'generic-bpmn2' },
    roles: [],
    variables: [
      { id: 'var_request', key: 'requestId', type: 'integer', source: { kind: 'constant', value: 1 } },
      { id: 'var_person', key: 'personName', type: 'string', source: { kind: 'action', nodeId: 'lookup', outputKey: 'person' } },
    ],
    requirements: [{ id: 'req_lookup', kind: 'activity', mandatory: true, nodeId: 'lookup' }],
    nodes: [
      { id: 'start', type: 'start', name: 'Início', requirementRefs: [] },
      { id: 'lookup', type: 'serviceTask', name: 'Consultar solicitante', requirementRefs: ['req_lookup'], action: {
        capability: 'http.request', connectorId: 'people_api', operationId: 'lookup_request',
        inputMapping: { id: { var: 'var_request' } }, outputMapping: { person: 'var_person' }, timeoutMs: 10000,
        retryPolicy: { maxAttempts: 1, backoffMs: 0 }, sideEffectLevel: 'read',
      } },
      { id: 'end', type: 'end', name: 'Fim', requirementRefs: [] },
    ],
    edges: [
      { id: 'start_lookup', source: 'start', target: 'lookup', kind: 'sequence', requirementRefs: [] },
      { id: 'lookup_end', source: 'lookup', target: 'end', kind: 'sequence', requirementRefs: [] },
    ], formRefs: [], metadata: { provenance: [] },
  };
  const lowered = await lowerGraphIRToProcessSpec(graph);
  assert.equal(lowered.valid, true, JSON.stringify(lowered.diagnostics));
  assert.deepEqual(lowered.processSpec?.nodes.find((node: any) => node.id === 'lookup').action.inputMapping, { id: { var: 'requestId' } });
  assert.deepEqual(lowered.processSpec?.nodes.find((node: any) => node.id === 'lookup').action.outputMapping, { person: 'personName' });
});
