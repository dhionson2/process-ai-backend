import { graphIrV1Schema } from './graph-ir.js';

/**
 * Provider transport projection for GraphIR. The private GraphIR schema remains
 * the authority. This projection avoids recursive expressions and dynamic maps,
 * which some structured-output providers reject.
 */
export function graphIrProviderSchema(): Record<string, any> {
  const schema = structuredClone(graphIrV1Schema) as any;
  schema.properties.nodes.items.properties.type.enum = ['start', 'end', 'humanTask', 'exclusiveGateway'];
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
  const normalizeCondition = (condition: any) => condition && typeof condition === 'object' && typeof condition.variableId === 'string'
    ? { op: condition.op, left: { var: condition.variableId }, right: { literal: condition.value } }
    : condition;
  for (const edge of graph.edges || []) edge.condition = normalizeCondition(edge.condition);
  for (const form of graph.formRefs || []) for (const field of form.fields || []) {
    field.visibleWhen = normalizeCondition(field.visibleWhen);
    field.requiredWhen = normalizeCondition(field.requiredWhen);
  }
  return graph;
}
