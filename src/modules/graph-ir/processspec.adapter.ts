import type { Diagnostic } from '../../domain/contracts.js';
import { validateProcessSpec } from '../validation/validation.service.js';
import { validateGraphIR, type GraphIRV1 } from './graph-ir.js';

type Json = Record<string, any>;
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export type GraphIRLoweringResult = { valid: boolean; processSpec: Json | null; diagnostics: Diagnostic[] };

/** Deterministically lowers a validated GraphIR V1 into the existing ProcessSpec V1 contract. */
export async function lowerGraphIRToProcessSpec(value: unknown): Promise<GraphIRLoweringResult> {
  const graphValidation = validateGraphIR(value);
  if (!graphValidation.valid) return { valid: false, processSpec: null, diagnostics: graphValidation.diagnostics };
  const graph = value as GraphIRV1;
  if (graph.process.targetProfile !== 'generic-bpmn2') return {
    valid: false, processSpec: null,
    diagnostics: [{ code: 'GRAPHIR_TARGET_PROFILE_UNSUPPORTED', path: '/process/targetProfile', message: 'O adapter e os geradores atuais só certificam generic-bpmn2.', severity: 'error' }],
  };
  if (graph.metadata.sourceVersion !== undefined) return {
    valid: false, processSpec: null,
    diagnostics: [{ code: 'GRAPHIR_METADATA_UNSUPPORTED', path: '/metadata/sourceVersion', message: 'ProcessSpec v1 não possui campo equivalente para sourceVersion; o adapter não descarta essa informação.', severity: 'error' }],
  };
  const variableById = new Map(graph.variables.map(variable => [variable.id, variable]));
  const toProcessExpression = (expression: any): any => {
    if (Object.hasOwn(expression, 'var')) {
      const variable = variableById.get(expression.var);
      return variable ? { var: variable.key } : { var: expression.var };
    }
    if (Object.hasOwn(expression, 'literal')) return { literal: expression.literal };
    if (expression.op === 'and' || expression.op === 'or') return { op: expression.op, args: expression.args.map(toProcessExpression) };
    if (expression.op === 'not' || expression.op === 'isSet') return { op: expression.op, arg: toProcessExpression(expression.arg) };
    return { op: expression.op, left: toProcessExpression(expression.left), right: toProcessExpression(expression.right) };
  };
  const roles = [...graph.roles].sort((a, b) => lexical(a.id, b.id)).map(role => ({
    id: role.id, label: role.label, resolution: role.resolution, ...(role.groupKey ? { groupKey: role.groupKey } : {}),
  }));
  const variables = [...graph.variables].sort((a, b) => lexical(a.key, b.key)).map(variable => ({
    key: variable.key, type: variable.type, required: variable.required ?? false, sensitive: variable.sensitive ?? false, scope: variable.scope ?? 'process',
    ...(variable.enumValues ? { enumValues: [...variable.enumValues] } : {}),
    source: variable.source?.kind === 'form' ? { kind: 'form', formId: variable.source.formRef, fieldKey: variable.source.fieldKey }
      : variable.source?.kind === 'action' ? { kind: 'action', nodeId: variable.source.nodeId, outputKey: variable.source.outputKey }
        : variable.source,
  }));
  const forms = [...graph.formRefs].sort((a, b) => lexical(a.id, b.id)).map(form => ({
    id: form.id, name: form.name, usage: form.usage,
    fields: form.fields.map(field => ({
      key: field.key, label: field.label, type: field.type, required: field.required, bindTo: variableById.get(String(field.bindTo))?.key || field.bindTo,
      ...(field.sensitive !== undefined ? { sensitive: field.sensitive } : {}),
      ...(field.options ? { options: field.options } : {}),
      ...(field.visibleWhen ? { visibleWhen: toProcessExpression(field.visibleWhen) } : {}),
      ...(field.requiredWhen ? { requiredWhen: toProcessExpression(field.requiredWhen) } : {}),
    })),
  }));
  const nodeType: Record<string, string> = { start: 'startEvent', end: 'endEvent', humanTask: 'userTask', serviceTask: 'serviceTask', exclusiveGateway: 'exclusiveGateway' };
  const nodes = [...graph.nodes].sort((a, b) => lexical(a.id, b.id)).map(node => ({
    id: node.id, type: nodeType[node.type], name: node.name,
    ...(node.roleId ? { roleId: node.roleId } : {}),
    ...(node.formRef ? { formId: node.formRef } : {}),
    ...(node.defaultEdgeId ? { defaultFlowId: node.defaultEdgeId } : {}),
    ...(node.action ? { action: lowerAction(node.action, variableById) } : {}),
  }));
  const flows = [...graph.edges].sort((a, b) => lexical(a.id, b.id)).map(edge => ({
    id: edge.id, source: edge.source, target: edge.target, ...(edge.label ? { label: edge.label } : {}),
    ...(edge.condition ? { condition: toProcessExpression(edge.condition) } : {}), ...(edge.isDefault ? { isDefault: true } : {}),
  }));
  const unresolvedRoles = new Set(graph.roles.filter(role => role.resolution === 'unresolved').map(role => role.id));
  const pendingQuestions = nodes.filter((node: Json) => node.type === 'userTask' && unresolvedRoles.has(node.roleId)).map((node: Json) => {
    const role = graph.roles.find(item => item.id === node.roleId)!;
    return { id: `resolve_${role.id}_${node.id}`.slice(0, 128), question: `Como o papel “${role.label}” deve ser associado à tarefa “${node.name}” no runtime?`, blocking: true, relatedNodeId: node.id };
  });
  const provenance = graphProvenance(graph);
  const processSpec: Json = {
    schemaVersion: '1.0.0', id: graph.process.id, name: graph.process.name,
    ...(graph.process.description !== undefined ? { description: graph.process.description } : {}),
    locale: graph.process.locale, targetProfile: graph.process.targetProfile, status: pendingQuestions.length ? 'needs-input' : 'draft', roles, variables, forms, nodes, flows,
    pendingQuestions, assumptions: [], policies: { manualApprovalRequired: true, allowExecution: false },
    metadata: { revision: 0, ...(provenance.length ? { requirementProvenance: provenance } : {}) },
  };
  const loweredValidation = await validateProcessSpec(processSpec);
  const diagnostics = [...graphValidation.diagnostics, ...loweredValidation.diagnostics];
  return { valid: loweredValidation.valid, processSpec: loweredValidation.valid ? processSpec : null, diagnostics };
}

function lowerAction(action: Record<string, any>, variableById: Map<string, GraphIRV1['variables'][number]>): Json {
  const expression = (value: any): any => {
    if (Object.hasOwn(value, 'var')) return { var: variableById.get(value.var)?.key || value.var };
    if (Object.hasOwn(value, 'literal')) return { literal: value.literal };
    if (value.op === 'and' || value.op === 'or') return { op: value.op, args: value.args.map(expression) };
    if (value.op === 'not' || value.op === 'isSet') return { op: value.op, arg: expression(value.arg) };
    return { op: value.op, left: expression(value.left), right: expression(value.right) };
  };
  return {
    ...action,
    inputMapping: Object.fromEntries(Object.entries(action.inputMapping || {}).map(([key, value]) => [key, expression(value)])),
    outputMapping: Object.fromEntries(Object.entries(action.outputMapping || {}).map(([key, id]) => [key, variableById.get(String(id))?.key || id])),
    ...(action.idempotencyKey ? { idempotencyKey: expression(action.idempotencyKey) } : {}),
  };
}

function graphProvenance(graph: GraphIRV1): Json[] {
  const entries: Json[] = [];
  const append = (path: string, refs: string[], provenance: Record<string, unknown> | undefined) => {
    for (const id of refs) entries.push({
      path: `${path}/requirements/${id}`, name: id,
      source: provenance?.source || 'inference', confirmed: provenance?.confirmed === true,
      ...(typeof provenance?.evidenceSha256 === 'string' ? { evidenceSha256: provenance.evidenceSha256 } : {}),
    });
  };
  for (const node of graph.nodes) append(`/graph/nodes/${node.id}`, node.requirementRefs, node.provenance);
  for (const edge of graph.edges) append(`/graph/edges/${edge.id}/${edge.kind}`, edge.requirementRefs, edge.provenance);
  for (const form of graph.formRefs) for (const field of form.fields) append(`/graph/forms/${form.id}/fields/${String(field.key)}`, (field.requirementRefs as string[] | undefined) || [], undefined);
  for (const [index, provenance] of graph.metadata.provenance.entries()) entries.push({
    path: `/graph/metadata/provenance/${index}`, name: `global-${index}`,
    source: provenance.source || 'inference', confirmed: provenance.confirmed === true,
    ...(typeof provenance.evidenceSha256 === 'string' ? { evidenceSha256: provenance.evidenceSha256 } : {}),
  });
  return entries.sort((a, b) => lexical(a.path, b.path));
}
