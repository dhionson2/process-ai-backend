import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  graphIrV1Schema, validateGraphIR, validateGraphIRCoverage, validateGraphIRSemantics, validateGraphIRStructure,
  type GraphIRV1,
} from '../src/modules/graph-ir/graph-ir.js';

function linear(): GraphIRV1 {
  return {
    schemaVersion: '1.0.0', process: { id: 'leave_process', name: 'Solicitação de férias', locale: 'pt-BR', targetProfile: 'generic-bpmn2' },
    roles: [{ id: 'role_requester', label: 'Solicitante', resolution: 'requester' }],
    variables: [{ id: 'var_days', key: 'days', type: 'integer', source: { kind: 'constant', value: 1 } }],
    requirements: [{ id: 'req_submit', kind: 'activity', mandatory: true, nodeId: 'submit' }],
    nodes: [
      { id: 'start', type: 'start', name: 'Início', requirementRefs: [] },
      { id: 'submit', type: 'humanTask', name: 'Enviar solicitação', roleId: 'role_requester', requirementRefs: ['req_submit'] },
      { id: 'end', type: 'end', name: 'Fim', requirementRefs: [] },
    ],
    edges: [
      { id: 'edge_start_submit', source: 'start', target: 'submit', kind: 'sequence', requirementRefs: [] },
      { id: 'edge_submit_end', source: 'submit', target: 'end', kind: 'sequence', requirementRefs: [] },
    ],
    formRefs: [], metadata: { provenance: [] },
  };
}

function approval(operator: 'gt' | 'lte' | 'gte' = 'gt'): GraphIRV1 {
  const graph = linear();
  graph.variables[0] = { id: 'var_amount', key: 'amount', type: 'decimal', source: { kind: 'constant', value: 0 } };
  graph.requirements[0].nodeId = 'approve';
  graph.requirements.push(
    { id: 'req_gateway', kind: 'structure', mandatory: true, nodeId: 'gateway' },
    { id: 'req_high', kind: 'condition', mandatory: true, variableId: 'var_amount', operator, value: 100 },
    { id: 'req_low', kind: 'condition', mandatory: true, variableId: 'var_amount', operator: operator === 'gt' ? 'lte' : 'gt', value: 100 },
  );
  graph.nodes = [
    { id: 'start', type: 'start', name: 'Início', requirementRefs: [] },
    { id: 'approve', type: 'humanTask', name: 'Analisar', roleId: 'role_requester', requirementRefs: ['req_submit'] },
    { id: 'gateway', type: 'exclusiveGateway', name: 'Valor', defaultEdgeId: undefined, requirementRefs: ['req_gateway'] },
    { id: 'high', type: 'end', name: 'Valor alto', requirementRefs: [] },
    { id: 'low', type: 'end', name: 'Valor baixo', requirementRefs: [] },
  ];
  graph.edges = [
    { id: 'start_approve', source: 'start', target: 'approve', kind: 'sequence', requirementRefs: [] },
    { id: 'approve_gateway', source: 'approve', target: 'gateway', kind: 'sequence', requirementRefs: [] },
    { id: 'route_high', source: 'gateway', target: 'high', kind: 'sequence', gatewayId: 'gateway', condition: { op: operator, left: { var: 'var_amount' }, right: { literal: 100 } }, requirementRefs: ['req_high'] },
    { id: 'route_low', source: 'gateway', target: 'low', kind: 'sequence', gatewayId: 'gateway', condition: { op: operator === 'gt' ? 'lte' : 'gt', left: { var: 'var_amount' }, right: { literal: 100 } }, requirementRefs: ['req_low'] },
  ];
  return graph;
}

function dualLoops(): GraphIRV1 {
  const graph = approval();
  graph.requirements = [];
  graph.requirements.push(
    { id: 'req_review_a', kind: 'activity', mandatory: true, nodeId: 'review_a' }, { id: 'req_review_b', kind: 'activity', mandatory: true, nodeId: 'review_b' },
    { id: 'req_decision_a', kind: 'structure', mandatory: true, nodeId: 'decision_a' }, { id: 'req_decision_b', kind: 'structure', mandatory: true, nodeId: 'decision_b' },
    { id: 'req_loop_a', kind: 'loop', mandatory: true, sourceNodeId: 'decision_a', targetNodeId: 'review_a' },
    { id: 'req_loop_b', kind: 'loop', mandatory: true, sourceNodeId: 'decision_b', targetNodeId: 'review_b' },
    { id: 'req_continue_a', kind: 'condition', mandatory: true, variableId: 'var_a', operator: 'eq', value: true },
    { id: 'req_continue_b', kind: 'condition', mandatory: true, variableId: 'var_b', operator: 'eq', value: true },
  );
  graph.variables = [
    { id: 'var_a', key: 'decision_a', type: 'boolean', source: { kind: 'constant', value: false } },
    { id: 'var_b', key: 'decision_b', type: 'boolean', source: { kind: 'constant', value: false } },
  ];
  graph.nodes = [
    { id: 'start', type: 'start', name: 'Início', requirementRefs: [] },
    { id: 'review_a', type: 'humanTask', name: 'Corrigir dados', roleId: 'role_requester', requirementRefs: ['req_review_a'] },
    { id: 'decision_a', type: 'exclusiveGateway', name: 'Correção A', requirementRefs: ['req_decision_a'] },
    { id: 'review_b', type: 'humanTask', name: 'Corrigir anexos', roleId: 'role_requester', requirementRefs: ['req_review_b'] },
    { id: 'decision_b', type: 'exclusiveGateway', name: 'Correção B', requirementRefs: ['req_decision_b'] },
    { id: 'end', type: 'end', name: 'Fim', requirementRefs: [] },
  ];
  graph.edges = [
    { id: 's_a', source: 'start', target: 'review_a', kind: 'sequence', requirementRefs: [] },
    { id: 'a_g', source: 'review_a', target: 'decision_a', kind: 'sequence', requirementRefs: [] },
    { id: 'a_retry', source: 'decision_a', target: 'review_a', kind: 'loop-back', gatewayId: 'decision_a', condition: { op: 'eq', left: { var: 'var_a' }, right: { literal: false } }, requirementRefs: ['req_loop_a'] },
    { id: 'a_continue', source: 'decision_a', target: 'review_b', kind: 'sequence', gatewayId: 'decision_a', condition: { op: 'eq', left: { var: 'var_a' }, right: { literal: true } }, requirementRefs: ['req_continue_a'] },
    { id: 'b_g', source: 'review_b', target: 'decision_b', kind: 'sequence', requirementRefs: [] },
    { id: 'b_retry', source: 'decision_b', target: 'review_b', kind: 'loop-back', gatewayId: 'decision_b', condition: { op: 'eq', left: { var: 'var_b' }, right: { literal: false } }, requirementRefs: ['req_loop_b'] },
    { id: 'b_end', source: 'decision_b', target: 'end', kind: 'sequence', gatewayId: 'decision_b', condition: { op: 'eq', left: { var: 'var_b' }, right: { literal: true } }, requirementRefs: ['req_continue_b'] },
  ];
  return graph;
}

function codes(graph: unknown): string[] { return validateGraphIR(graph).diagnostics.map(item => item.code); }

test('GraphIR V1 aceita processo linear e aprovação simples como grafo plano', () => {
  assert.deepEqual(validateGraphIR(linear()), { valid: true, diagnostics: [] });
  assert.deepEqual(validateGraphIR(approval()), { valid: true, diagnostics: [] });
});

test('GraphIR schema declara draft 2020-12 e compila diretamente com Ajv2020', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(graphIrV1Schema);
  assert.equal(validate(linear()), true);
  assert.equal(validate({ ...linear(), unsupported: true }), false);
});

test('GraphIR rejeita versão, campos, IDs, arestas e referências inválidas', () => {
  const schema = linear() as any; schema.schemaVersion = '2.0.0';
  assert.ok(validateGraphIRStructure(schema).diagnostics.some(item => item.code === 'GRAPHIR_SCHEMA_INVALID'));
  const duplicateNode = linear(); duplicateNode.nodes.push(structuredClone(duplicateNode.nodes[1]));
  assert.ok(codes(duplicateNode).includes('GRAPHIR_DUPLICATE_ID'));
  const dangling = linear(); dangling.edges[0].target = 'missing';
  assert.ok(codes(dangling).includes('GRAPHIR_NODE_REFERENCE_MISSING'));
  const deadEnd = linear(); deadEnd.edges[1].target = 'submit';
  assert.ok(codes(deadEnd).includes('GRAPHIR_NO_PATH_TO_END'));
  const duplicateEdge = linear(); duplicateEdge.edges.push({ ...duplicateEdge.edges[0], id: 'another_edge' });
  assert.ok(codes(duplicateEdge).includes('GRAPHIR_DUPLICATE_EDGE'));
  const reorderedCondition = approval();
  reorderedCondition.edges.push({ ...reorderedCondition.edges[2], id: 'same_route_reordered_condition', condition: { right: { literal: 100 }, left: { var: 'var_amount' }, op: 'gt' } });
  assert.ok(codes(reorderedCondition).includes('GRAPHIR_DUPLICATE_EDGE'));
});

test('GraphIR verifica XOR numérico > / <= e rejeita fronteira >= / <= sobreposta', () => {
  assert.equal(validateGraphIR(approval()).valid, true);
  const boundary = approval();
  assert.deepEqual(boundary.edges.filter(edge => edge.condition).map(edge => [edge.id, edge.condition?.op, (edge.condition as any).right.literal]), [
    ['route_high', 'gt', 100], ['route_low', 'lte', 100],
  ], 'o valor exatamente igual ao limite pertence somente ao ramo <=');
  const inclusiveOverlap = approval('gte');
  inclusiveOverlap.edges[3].condition = { op: 'lte', left: { var: 'var_amount' }, right: { literal: 100 } };
  assert.ok(codes(inclusiveOverlap).includes('GATEWAY_CONDITION_OVERLAP'));
});

test('GraphIR aceita pares complementares >, >=, < e <= no mesmo limite', () => {
  for (const [high, low] of [['gt', 'lte'], ['gte', 'lt'], ['lt', 'gte'], ['lte', 'gt']] as const) {
    const graph = approval();
    const highRequirement = graph.requirements.find(item => item.id === 'req_high')!;
    const lowRequirement = graph.requirements.find(item => item.id === 'req_low')!;
    highRequirement.operator = high; lowRequirement.operator = low;
    graph.edges.find(edge => edge.id === 'route_high')!.condition = { op: high, left: { var: 'var_amount' }, right: { literal: 100 } };
    graph.edges.find(edge => edge.id === 'route_low')!.condition = { op: low, left: { var: 'var_amount' }, right: { literal: 100 } };
    assert.equal(validateGraphIR(graph).valid, true, `${high}/${low}: ${JSON.stringify(validateGraphIR(graph).diagnostics)}`);
  }
});

test('GraphIR preserva ramo default explícito e recusa referência default divergente', () => {
  const graph = approval();
  graph.requirements = graph.requirements.filter(item => item.id !== 'req_low');
  const fallback = graph.edges.find(edge => edge.id === 'route_low')!;
  fallback.condition = undefined; fallback.isDefault = true; fallback.requirementRefs = [];
  graph.nodes.find(node => node.id === 'gateway')!.defaultEdgeId = fallback.id;
  assert.equal(validateGraphIR(graph).valid, true);
  graph.nodes.find(node => node.id === 'gateway')!.defaultEdgeId = 'route_high';
  assert.ok(codes(graph).includes('GRAPHIR_GATEWAY_DEFAULT_REFERENCE_INVALID'));
});

test('GraphIR representa dois loops independentes e encontra destino diferente do requisito', () => {
  const graph = dualLoops();
  assert.deepEqual(validateGraphIR(graph), { valid: true, diagnostics: [] });
  const wrongTarget = structuredClone(graph); wrongTarget.edges.find(edge => edge.id === 'b_retry')!.target = 'review_a';
  assert.ok(codes(wrongTarget).includes('GRAPHIR_LOOP_DESTINATION_DIVERGENCE'));
});

test('GraphIR recusa papel ausente ou inexistente e variável de condição inexistente', () => {
  const missingRole = linear(); delete missingRole.nodes[1].roleId;
  assert.ok(codes(missingRole).includes('GRAPHIR_ROLE_REQUIRED'));
  const badRole = linear(); badRole.nodes[1].roleId = 'invented_role';
  assert.ok(codes(badRole).includes('GRAPHIR_ROLE_REFERENCE_MISSING'));
  const badVariable = approval(); badVariable.edges[2].condition = { op: 'gt', left: { var: 'ghost' }, right: { literal: 100 } };
  assert.ok(codes(badVariable).includes('GRAPHIR_VARIABLE_REFERENCE_MISSING'));
});

test('GraphIR valida origem de variável, tipo de campo e saída declarativa', () => {
  const graph = linear();
  graph.formRefs = [{ id: 'form_request', name: 'Solicitação', usage: 'start', fields: [{ key: 'days', label: 'Dias', type: 'text', bindTo: 'var_days', required: true }] }];
  graph.nodes[0].formRef = 'form_request';
  graph.variables[0].source = { kind: 'form', formRef: 'form_request', fieldKey: 'days' };
  assert.ok(codes(graph).includes('GRAPHIR_FIELD_TYPE_MISMATCH'));
});

test('GraphIR separa cobertura, recusa elemento sem requisito e requisito obrigatório omitido', () => {
  const graph = linear();
  graph.nodes[1].requirementRefs = [];
  const coverage = validateGraphIRCoverage(graph);
  assert.ok(coverage.diagnostics.some(item => item.code === 'GRAPHIR_ELEMENT_UNGROUNDED'));
  assert.ok(coverage.diagnostics.some(item => item.code === 'GRAPHIR_REQUIREMENT_UNCOVERED'));
  assert.equal(validateGraphIRSemantics(graph).valid, true, 'validade semântica não é confundida com cobertura');
});

test('Coverage Gate rejeita requisito de atividade ligado a nó estrutural ou referência no elemento errado', () => {
  const structuralSubstitution = linear();
  structuralSubstitution.nodes[1].requirementRefs = [];
  structuralSubstitution.nodes[0].requirementRefs = ['req_submit'];
  structuralSubstitution.requirements[0].nodeId = 'start';
  const structuralResult = validateGraphIR(structuralSubstitution);
  assert.equal(structuralResult.valid, false);
  assert.ok(structuralResult.diagnostics.some(item => item.code === 'GRAPHIR_NODE_REQUIREMENT_DIVERGENCE'));
  assert.ok(structuralResult.diagnostics.some(item => item.code === 'GRAPHIR_ELEMENT_REQUIREMENT_KIND_INVALID'));

  const wrongReference = linear();
  wrongReference.edges[0].requirementRefs = ['req_submit'];
  const edgeResult = validateGraphIR(wrongReference);
  assert.equal(edgeResult.valid, false);
  assert.ok(edgeResult.diagnostics.some(item => item.code === 'GRAPHIR_REQUIREMENT_BINDING_INVALID'));
});

test('GraphIR rejeita defaultEdgeId em tarefa e mantém papéis semelhantes separados por identidade', () => {
  const wrongDefault = linear();
  wrongDefault.nodes[1].defaultEdgeId = 'edge_submit_end';
  assert.ok(codes(wrongDefault).includes('GRAPHIR_GATEWAY_DEFAULT_REFERENCE_INVALID'));

  const distinctRoles = linear();
  distinctRoles.roles = [
    { id: 'role_finance', label: 'Revisor', resolution: 'group', groupKey: 'finance' },
    { id: 'role_compliance', label: 'Revisor', resolution: 'group', groupKey: 'compliance' },
  ];
  distinctRoles.nodes[1].roleId = 'role_finance';
  assert.equal(validateGraphIR(distinctRoles).valid, true);
  distinctRoles.nodes[1].roleId = 'role_compliance';
  assert.equal(validateGraphIR(distinctRoles).valid, true);
});

test('GraphIR distingue atividades com nomes semelhantes por nodeId e papel estável', () => {
  const graph = linear();
  graph.roles.push({ id: 'role_reviewer', label: 'Solicitante', resolution: 'group', groupKey: 'review_team' });
  graph.requirements.push(
    { id: 'req_review', kind: 'activity', mandatory: true, nodeId: 'review' },
    { id: 'req_review_actor', kind: 'actor', mandatory: true, nodeId: 'review', roleId: 'role_reviewer' },
  );
  graph.nodes[1].name = 'Analisar solicitação';
  graph.nodes.splice(2, 0, { id: 'review', type: 'humanTask', name: 'Analisar solicitação pela equipe', roleId: 'role_reviewer', requirementRefs: ['req_review', 'req_review_actor'] });
  graph.edges[1].target = 'review';
  graph.edges.push({ id: 'review_end', source: 'review', target: 'end', kind: 'sequence', requirementRefs: [] });
  assert.equal(validateGraphIR(graph).valid, true, JSON.stringify(validateGraphIR(graph).diagnostics));
  graph.nodes.find(node => node.id === 'review')!.roleId = 'role_requester';
  assert.ok(codes(graph).includes('GRAPHIR_ROLE_REQUIREMENT_DIVERGENCE'));
});

test('GraphIR recusa valores constantes e enums incompatíveis com o tipo declarado', () => {
  const constant = linear();
  constant.variables[0].source = { kind: 'constant', value: '1' };
  assert.ok(codes(constant).includes('GRAPHIR_VARIABLE_SOURCE_TYPE_INVALID'));
  const enumValue = linear();
  enumValue.variables[0].enumValues = ['1'];
  assert.ok(codes(enumValue).includes('GRAPHIR_VARIABLE_ENUM_TYPE_INVALID'));
});

test('Coverage Gate confere destino de consequência e identidade de campo obrigatório', () => {
  const graph = approval();
  graph.requirements.push({ id: 'req_consequence', kind: 'consequence', mandatory: true, sourceNodeId: 'gateway', targetNodeId: 'high' });
  graph.edges.find(edge => edge.id === 'route_high')!.requirementRefs.push('req_consequence');
  assert.equal(validateGraphIR(graph).valid, true);
  const wrong = structuredClone(graph); wrong.requirements.find(item => item.id === 'req_consequence')!.targetNodeId = 'low';
  assert.ok(validateGraphIR(wrong).diagnostics.some(item => item.code === 'GRAPHIR_CONSEQUENCE_DIVERGENCE'));

  const formGraph = linear();
  formGraph.requirements.push({ id: 'req_days_field', kind: 'form-field', mandatory: true, formRef: 'form_request', fieldKey: 'days' });
  formGraph.formRefs = [{ id: 'form_request', name: 'Solicitação', usage: 'start', fields: [{ key: 'days', label: 'Dias', type: 'integer', bindTo: 'var_days', required: true, requirementRefs: ['req_days_field'] }] }];
  formGraph.nodes[0].formRef = 'form_request';
  formGraph.variables[0].source = { kind: 'form', formRef: 'form_request', fieldKey: 'days' };
  assert.equal(validateGraphIR(formGraph).valid, true);
  const wrongField = structuredClone(formGraph); wrongField.formRefs[0].fields[0].key = 'other';
  assert.ok(codes(wrongField).includes('GRAPHIR_REQUIREMENT_REFERENCE_MISSING'));
});

test('reordenar arrays não muda a validade nem a identidade semântica do grafo', () => {
  const original = dualLoops();
  const reordered = structuredClone(original);
  reordered.nodes.reverse(); reordered.edges.reverse(); reordered.roles.reverse(); reordered.variables.reverse(); reordered.requirements.reverse();
  assert.deepEqual(validateGraphIR(original), validateGraphIR(reordered));
});

test('diagnósticos semânticos são estáveis sob reordenação e validação não normaliza a entrada', () => {
  const invalid = dualLoops();
  invalid.edges.find(edge => edge.id === 'b_retry')!.target = 'missing_target';
  const before = JSON.stringify(invalid);
  const first = validateGraphIR(invalid).diagnostics;
  const reordered = structuredClone(invalid);
  reordered.nodes.reverse(); reordered.edges.reverse(); reordered.requirements.reverse(); reordered.variables.reverse();
  const second = validateGraphIR(reordered).diagnostics;
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(invalid), before, 'validator não corrige nem normaliza o grafo recebido');
});

test('GraphIR não aceita tipo BPMN fora do subconjunto explicitamente suportado', () => {
  const unsupported = linear() as any; unsupported.nodes[1].type = 'parallelGateway';
  assert.ok(validateGraphIRStructure(unsupported).diagnostics.some(item => item.code === 'GRAPHIR_SCHEMA_INVALID'));
});
