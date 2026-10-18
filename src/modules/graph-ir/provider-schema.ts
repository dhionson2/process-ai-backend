import { graphIrV1Schema } from './graph-ir.js';

/**
 * Provider transport projection for GraphIR. The private GraphIR schema remains
 * the authority. This projection avoids recursive expressions and dynamic maps,
 * which some structured-output providers reject.
 */
export function graphIrProviderSchema(): Record<string, any> {
  const schema = structuredClone(graphIrV1Schema) as any;
  schema.properties.nodes.items.properties.type.enum = ['start', 'end', 'humanTask', 'exclusiveGateway'];
  // gatewayId is derivable from an edge's source when that source is a gateway.
  // Keep it in canonical GraphIR, but do not require the model to repeat it.
  delete schema.properties.edges.items.properties.gatewayId;
  // Integrations are intentionally left to the legacy capability-catalog path
  // until the projection can carry and verify catalog references end to end.
  delete schema.properties.nodes.items.properties.action;
  delete schema.$defs.action;
  const condition = { type: 'object', additionalProperties: false, required: ['op', 'variableId', 'value'], properties: {
    op: { enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] }, variableId: { $ref: '#/$defs/id' }, value: { type: ['string', 'number', 'boolean', 'null'] },
  } };
  schema.$defs.condition = condition;
  delete schema.$defs.expression;
  delete schema.properties.edges.items.properties.condition;
  schema.properties.edges.items.properties.condition = { $ref: '#/$defs/condition' };
  delete schema.properties.formRefs.items.properties.fields.items.properties.visibleWhen;
  delete schema.properties.formRefs.items.properties.fields.items.properties.requiredWhen;
  schema.properties.formRefs.items.properties.fields.items.properties.visibleWhen = { $ref: '#/$defs/condition' };
  schema.properties.formRefs.items.properties.fields.items.properties.requiredWhen = { $ref: '#/$defs/condition' };
  return schema;
}

/** Converts the flat provider condition projection into the internal typed AST. */
export function normalizeGraphIrProviderValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const graph = structuredClone(value) as any;
  const variables: any[] = Array.isArray(graph.variables) ? graph.variables : [];
  const resolveVariableId = (candidate: unknown): unknown => {
    if (typeof candidate !== 'string') return candidate;
    const idMatches = variables.filter(variable => variable.id === candidate);
    const matches = variables.filter(variable => variable.key === candidate);
    if (idMatches.length) {
      if (idMatches.length === 1 && (!matches.length || matches.length === 1 && matches[0].id === idMatches[0].id)) return candidate;
      let unresolved = `ambiguous_${candidate.slice(0, 110)}`;
      let suffix = 0;
      while (variables.some(variable => variable.id === unresolved)) unresolved = `ambiguous_${candidate.slice(0, 105)}_${++suffix}`;
      return unresolved;
    }
    return matches.length === 1 ? matches[0].id : candidate;
  };
  const normalizeCondition = (condition: any) => condition && typeof condition === 'object' && typeof condition.variableId === 'string'
    ? { op: condition.op, left: { var: resolveVariableId(condition.variableId) }, right: { literal: condition.value } }
    : condition;
  for (const edge of graph.edges || []) if (edge.condition && typeof edge.condition === 'object') edge.condition = normalizeCondition(edge.condition);
  for (const form of graph.formRefs || []) for (const field of form.fields || []) {
    field.bindTo = resolveVariableId(field.bindTo);
    if (field.visibleWhen && typeof field.visibleWhen === 'object') field.visibleWhen = normalizeCondition(field.visibleWhen);
    if (field.requiredWhen && typeof field.requiredWhen === 'object') field.requiredWhen = normalizeCondition(field.requiredWhen);
  }
  // The source node is the single authoritative gateway reference. Complete
  // only an omitted edge field; an explicit conflicting id remains an error.
  const nodesById = new Map<string, any>((Array.isArray(graph.nodes) ? graph.nodes : []).filter((node: any) => node && typeof node.id === 'string').map((node: any) => [node.id, node] as [string, any]));
  for (const edge of Array.isArray(graph.edges) ? graph.edges : []) {
    if (!edge || typeof edge !== 'object') continue;
    // Provider transport has no gatewayId. If a nonconforming provider adds it,
    // discard it and derive the canonical value only from a gateway source.
    const suppliedGatewayId = edge.gatewayId;
    delete edge.gatewayId;
    const source = nodesById.get(edge.source);
    if (source?.type === 'exclusiveGateway') edge.gatewayId = source.id;
    if (suppliedGatewayId !== undefined && suppliedGatewayId !== null && suppliedGatewayId !== edge.gatewayId) edge.gatewayId = suppliedGatewayId;
  }
  for (const requirement of Array.isArray(graph.requirements) ? graph.requirements : []) {
    if (typeof requirement.variableId === 'string') requirement.variableId = resolveVariableId(requirement.variableId);
  }
  const normalized = omitNullOptionalProperties(graph, graphIrV1Schema as any, graphIrV1Schema.$defs as any) as any;
  return normalized;
}

function resolveLocalSchema(schema: any, defs: Record<string, any>): any {
  let current = schema;
  const seen = new Set<string>();
  while (typeof current?.$ref === 'string' && current.$ref.startsWith('#/$defs/')) {
    const name = current.$ref.slice('#/$defs/'.length);
    if (seen.has(name) || !defs[name]) break;
    seen.add(name);
    current = defs[name];
  }
  return current;
}

function selectObjectSchema(schema: any, value: Record<string, unknown>, defs: Record<string, any>): any {
  const resolved = resolveLocalSchema(schema, defs);
  const branches = resolved?.oneOf || resolved?.anyOf;
  if (!Array.isArray(branches)) return resolved;
  const matches = branches.filter((candidate: any) => {
    const branch = resolveLocalSchema(candidate, defs);
    if (Array.isArray(branch.required) && !branch.required.every((key: string) => Object.hasOwn(value, key))) return false;
    for (const [key, propertySchema] of Object.entries(branch.properties || {}) as Array<[string, any]>) {
      if (Object.hasOwn(value, key) && (propertySchema.const !== undefined && value[key] !== propertySchema.const
        || Array.isArray(propertySchema.enum) && !propertySchema.enum.includes(value[key]))) return false;
    }
    return true;
  });
  return matches.length === 1 ? resolveLocalSchema(matches[0], defs) : resolved;
}

function schemaAllowsNull(schema: any, defs: Record<string, any>): boolean {
  const resolved = resolveLocalSchema(schema, defs);
  if (resolved?.const === null || resolved?.enum?.includes(null) || resolved?.type === 'null' || Array.isArray(resolved?.type) && resolved.type.includes('null')) return true;
  const branches = resolved?.oneOf || resolved?.anyOf;
  return Array.isArray(branches) && branches.some((branch: any) => schemaAllowsNull(branch, defs));
}

/** Omit only null values for optional, non-nullable contract properties; never supplies values or removes invalid extras. */
function omitNullOptionalProperties(value: any, rawSchema: any, defs: Record<string, any>): any {
  const schema = resolveLocalSchema(rawSchema, defs);
  if (Array.isArray(value)) return value.map(item => omitNullOptionalProperties(item, schema?.items, defs));
  if (!value || typeof value !== 'object') return value;
  const objectSchema = selectObjectSchema(schema, value, defs);
  const properties = objectSchema?.properties || {};
  const required = new Set<string>(Array.isArray(objectSchema?.required) ? objectSchema.required : []);
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const childSchema = properties[key] || (objectSchema?.additionalProperties && typeof objectSchema.additionalProperties === 'object' ? objectSchema.additionalProperties : undefined);
    if (child === null && !required.has(key) && childSchema && !schemaAllowsNull(childSchema, defs)) continue;
    normalized[key] = childSchema ? omitNullOptionalProperties(child, childSchema, defs) : child;
  }
  return normalized;
}
