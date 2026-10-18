import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Diagnostic, ValidationResult } from '../../domain/contracts.js';
import { analyzeNumericXor } from '../validation/numeric-xor.js';

/** Internal, provider-neutral graph contract. It is intentionally separate from ProcessSpec v1. */
export const graphIrV1Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://example.invalid/contracts/graph-ir.v1.schema.json',
  title: 'GraphIR v1', type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'process', 'roles', 'variables', 'requirements', 'nodes', 'edges', 'formRefs', 'metadata'],
  properties: {
    schemaVersion: { const: '1.0.0' },
    process: { type: 'object', additionalProperties: false, required: ['id', 'name', 'locale', 'targetProfile'], properties: {
      id: { $ref: '#/$defs/id' }, name: { $ref: '#/$defs/label' }, description: { type: 'string', maxLength: 20000 },
      locale: { type: 'string', minLength: 2, maxLength: 20 }, targetProfile: { enum: ['generic-bpmn2', 'flowable-oss', 'unique-future'] },
    } },
    roles: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['id', 'label', 'resolution'], properties: {
      id: { $ref: '#/$defs/id' }, label: { $ref: '#/$defs/label' }, resolution: { enum: ['requester', 'manual', 'group', 'manager-of-requester', 'system', 'unresolved'] }, groupKey: { $ref: '#/$defs/id' },
    } } },
    variables: { type: 'array', maxItems: 1000, items: { type: 'object', additionalProperties: false, required: ['id', 'key', 'type', 'source'], properties: {
      id: { $ref: '#/$defs/id' }, key: { $ref: '#/$defs/id' }, type: { enum: ['string', 'integer', 'decimal', 'boolean', 'date', 'datetime', 'object', 'array'] },
      required: { type: 'boolean' }, sensitive: { type: 'boolean' }, scope: { enum: ['process', 'task'] },
      enumValues: { type: 'array', uniqueItems: true, items: { type: ['string', 'number', 'boolean'] } },
      source: { oneOf: [
        { type: 'object', additionalProperties: false, required: ['kind', 'formRef', 'fieldKey'], properties: { kind: { const: 'form' }, formRef: { $ref: '#/$defs/id' }, fieldKey: { $ref: '#/$defs/id' } } },
        { type: 'object', additionalProperties: false, required: ['kind', 'nodeId', 'outputKey'], properties: { kind: { const: 'action' }, nodeId: { $ref: '#/$defs/id' }, outputKey: { $ref: '#/$defs/id' } } },
        { type: 'object', additionalProperties: false, required: ['kind', 'value'], properties: { kind: { const: 'constant' }, value: { type: ['string', 'number', 'boolean', 'null'] } } },
        { type: 'object', additionalProperties: false, required: ['kind', 'systemKey'], properties: { kind: { const: 'system' }, systemKey: { $ref: '#/$defs/id' } } },
      ] },
    } } },
    requirements: { type: 'array', maxItems: 2000, items: { type: 'object', additionalProperties: false, required: ['id', 'kind', 'mandatory'], properties: {
      id: { $ref: '#/$defs/id' }, kind: { enum: ['activity', 'condition', 'consequence', 'loop', 'actor', 'form-field', 'structure'] }, mandatory: { type: 'boolean' },
      nodeId: { $ref: '#/$defs/id' }, sourceNodeId: { $ref: '#/$defs/id' }, targetNodeId: { $ref: '#/$defs/id' }, roleId: { $ref: '#/$defs/id' }, variableId: { $ref: '#/$defs/id' }, formRef: { $ref: '#/$defs/id' }, fieldKey: { $ref: '#/$defs/id' },
      operator: { enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] }, value: { type: ['string', 'number', 'boolean', 'null'] },
    } } },
    nodes: { type: 'array', minItems: 2, maxItems: 1000, items: { type: 'object', additionalProperties: false, required: ['id', 'type', 'name', 'requirementRefs'], properties: {
      id: { $ref: '#/$defs/id' }, type: { enum: ['start', 'end', 'humanTask', 'serviceTask', 'exclusiveGateway'] }, name: { $ref: '#/$defs/label' },
      roleId: { $ref: '#/$defs/id' }, formRef: { $ref: '#/$defs/id' }, defaultEdgeId: { $ref: '#/$defs/id' }, action: { $ref: '#/$defs/action' },
      requirementRefs: { $ref: '#/$defs/refs' }, provenance: { $ref: '#/$defs/provenance' },
    } } },
    edges: { type: 'array', minItems: 1, maxItems: 2000, items: { type: 'object', additionalProperties: false, required: ['id', 'source', 'target', 'kind', 'requirementRefs'], properties: {
      id: { $ref: '#/$defs/id' }, source: { $ref: '#/$defs/id' }, target: { $ref: '#/$defs/id' }, kind: { enum: ['sequence', 'loop-back'] },
      gatewayId: { $ref: '#/$defs/id' }, condition: { $ref: '#/$defs/expression' }, isDefault: { type: 'boolean' }, label: { type: 'string', maxLength: 255 },
      requirementRefs: { $ref: '#/$defs/refs' }, provenance: { $ref: '#/$defs/provenance' },
    } } },
    formRefs: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['id', 'name', 'usage', 'fields'], properties: {
      id: { $ref: '#/$defs/id' }, name: { $ref: '#/$defs/label' }, usage: { enum: ['start', 'task'] },
      fields: { type: 'array', maxItems: 300, items: { type: 'object', additionalProperties: false, required: ['key', 'label', 'type', 'bindTo', 'required'], properties: {
        key: { $ref: '#/$defs/id' }, label: { $ref: '#/$defs/label' }, type: { enum: ['text', 'textarea', 'integer', 'decimal', 'boolean', 'select', 'date', 'datetime', 'email', 'attachment'] },
        bindTo: { $ref: '#/$defs/id' }, required: { type: 'boolean' }, sensitive: { type: 'boolean' }, options: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: { $ref: '#/$defs/label' }, value: { type: 'string', maxLength: 100 } } } },
        visibleWhen: { $ref: '#/$defs/expression' }, requiredWhen: { $ref: '#/$defs/expression' }, requirementRefs: { $ref: '#/$defs/refs' },
      } } },
    } } },
    metadata: { type: 'object', additionalProperties: false, required: ['provenance'], properties: {
      provenance: { type: 'array', maxItems: 1000, items: { $ref: '#/$defs/provenance' } }, sourceVersion: { type: 'string', maxLength: 128 },
    } },
  },
  $defs: {
    id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,127}$' },
    label: { type: 'string', minLength: 1, maxLength: 255 },
    refs: { type: 'array', uniqueItems: true, items: { $ref: '#/$defs/id' } },
    provenance: { type: 'object', additionalProperties: false, required: ['source', 'confirmed'], properties: {
      source: { enum: ['user', 'confirmed-answer', 'catalog', 'knowledge', 'inference'] }, confirmed: { type: 'boolean' },
      sourceRef: { type: 'string', maxLength: 128 }, evidenceSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    } },
    expression: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['var'], properties: { var: { $ref: '#/$defs/id' } } },
      { type: 'object', additionalProperties: false, required: ['literal'], properties: { literal: { type: ['string', 'number', 'boolean', 'null'] } } },
      { type: 'object', additionalProperties: false, required: ['op', 'left', 'right'], properties: { op: { enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] }, left: { $ref: '#/$defs/expression' }, right: { $ref: '#/$defs/expression' } } },
      { type: 'object', additionalProperties: false, required: ['op', 'args'], properties: { op: { enum: ['and', 'or'] }, args: { type: 'array', minItems: 2, items: { $ref: '#/$defs/expression' } } } },
      { type: 'object', additionalProperties: false, required: ['op', 'arg'], properties: { op: { const: 'not' }, arg: { $ref: '#/$defs/expression' } } },
      { type: 'object', additionalProperties: false, required: ['op', 'arg'], properties: { op: { const: 'isSet' }, arg: { $ref: '#/$defs/expression' } } },
    ] },
    action: { type: 'object', additionalProperties: false, required: ['capability', 'connectorId', 'operationId', 'inputMapping', 'outputMapping', 'timeoutMs', 'retryPolicy', 'sideEffectLevel'], properties: {
      capability: { enum: ['http.request', 'database.record.read', 'database.record.create', 'database.record.update', 'database.record.delete', 'notification.send', 'document.generate', 'document.sign.request', 'queue.publish', 'data.transform', 'process.call', 'rules.evaluate', 'file.store'] },
      connectorId: { $ref: '#/$defs/id' }, operationId: { $ref: '#/$defs/id' }, inputMapping: { type: 'object', additionalProperties: { $ref: '#/$defs/expression' } }, outputMapping: { type: 'object', additionalProperties: { $ref: '#/$defs/id' } },
      timeoutMs: { type: 'integer', minimum: 100, maximum: 300000 }, retryPolicy: { type: 'object', additionalProperties: false, required: ['maxAttempts', 'backoffMs'], properties: { maxAttempts: { type: 'integer', minimum: 0, maximum: 12 }, backoffMs: { type: 'integer', minimum: 0, maximum: 3600000 } } },
      idempotencyKey: { $ref: '#/$defs/expression' }, sideEffectLevel: { enum: ['read', 'write', 'irreversible'] }, approvalRequired: { type: 'boolean' },
    } },
  },
} as const;

export interface GraphIRV1 {
  schemaVersion: '1.0.0';
  process: { id: string; name: string; description?: string; locale: string; targetProfile: 'generic-bpmn2' | 'flowable-oss' | 'unique-future' };
  roles: Array<{ id: string; label: string; resolution: string; groupKey?: string }>;
  variables: Array<{ id: string; key: string; type: string; required?: boolean; sensitive?: boolean; scope?: string; enumValues?: Array<string | number | boolean>; source: Record<string, unknown> }>;
  requirements: Array<{ id: string; kind: string; mandatory: boolean; nodeId?: string; sourceNodeId?: string; targetNodeId?: string; roleId?: string; variableId?: string; formRef?: string; fieldKey?: string; operator?: string; value?: unknown }>;
  nodes: Array<{ id: string; type: string; name: string; roleId?: string; formRef?: string; defaultEdgeId?: string; action?: Record<string, unknown>; requirementRefs: string[]; provenance?: Record<string, unknown> }>;
  edges: Array<{ id: string; source: string; target: string; kind: 'sequence' | 'loop-back'; gatewayId?: string; condition?: Record<string, unknown>; isDefault?: boolean; label?: string; requirementRefs: string[]; provenance?: Record<string, unknown> }>;
  formRefs: Array<{ id: string; name: string; usage: 'start' | 'task'; fields: Array<Record<string, unknown>> }>;
  metadata: { provenance: Array<Record<string, unknown>>; sourceVersion?: string };
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const checkSchema = ajv.compile(graphIrV1Schema);
const MAX_GRAPHIR_SCHEMA_ERRORS = 25;

export type GraphIRSchemaViolation = {
  code: 'GRAPHIR_SCHEMA_INVALID';
  stage: 'graph-ir-schema';
  path: string;
  keyword: string;
  schemaPath: string;
  missingProperty?: string;
  additionalProperty?: string;
  expectedType?: string | string[];
  receivedType?: 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean' | 'undefined';
  expectedValues?: Array<string | number | boolean | null>;
  arrayIndex?: number;
  arrayPath?: string;
  arrayIndices?: Array<{ arrayPath: string; index: number }>;
};
export type GraphIRSchemaDiagnosticSet = { stage: 'graph-ir-schema'; totalErrors: number; truncated: number; errors: GraphIRSchemaViolation[] };

/** Bounded, value-free diagnostics suitable for generation-run telemetry. */
export function sanitizeGraphIrDiagnostics(diagnostics: Diagnostic[], limit = 25): Array<{ stage: 'graph-ir-schema' | 'graph-ir-semantic' | 'graph-ir-coverage'; code: string; path: string; type: 'schema' | 'semantic' | 'coverage'; requirementId?: string }> {
  return diagnostics.slice(0, Math.max(0, Math.min(25, limit))).map(item => {
    const requirementSegment = item.path.split('/').slice(1).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    const requirementIndex = requirementSegment.indexOf('requirements');
    const rawRequirementId = item.requirementId || (requirementIndex >= 0 ? requirementSegment[requirementIndex + 1] : undefined);
    const requirementId = rawRequirementId && /^req_[A-Za-z0-9_-]{1,60}$/.test(rawRequirementId) && safeSchemaProperty(rawRequirementId) ? rawRequirementId : undefined;
    const schema = item.code === 'GRAPHIR_SCHEMA_INVALID';
    const coverage = item.code.includes('REQUIREMENT_UNCOVERED') || item.code.includes('REQUIREMENT_DIVERGENCE') || item.code.includes('ELEMENT_UNGROUNDED') || item.code.includes('BINDING_INVALID') || item.code === 'GRAPHIR_ELEMENT_REQUIREMENT_KIND_INVALID' || item.code === 'GRAPHIR_LOOP_DESTINATION_DIVERGENCE' || item.code === 'GRAPHIR_ROLE_REQUIREMENT_DIVERGENCE' || item.code === 'GRAPHIR_CONSEQUENCE_DIVERGENCE' || item.code === 'GRAPHIR_CONDITION_REQUIREMENT_DIVERGENCE' || item.code === 'GRAPHIR_FORM_REQUIREMENT_DIVERGENCE' || item.code === 'GRAPHIR_REQUIREMENT_REFERENCE_MISSING' && item.path.endsWith('/requirementRefs');
    const type = schema ? 'schema' as const : coverage ? 'coverage' as const : 'semantic' as const;
    const path = `/${requirementSegment.map((part, index) => {
      if (['nodes', 'edges', 'roles', 'variables', 'formRefs', 'requirements'].includes(requirementSegment[index - 1]) && !/^\d{1,6}$/.test(part)) return '[id]';
      if (index > 0 && requirementSegment[index - 1] === 'fields' && !/^\d{1,6}$/.test(part)) return '[key]';
      return /^\d{1,6}$/.test(part) ? part : safeSchemaProperty(part) || '[redacted]';
    }).map(part => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
    return {
      stage: type === 'schema' ? 'graph-ir-schema' as const : type === 'coverage' ? 'graph-ir-coverage' as const : 'graph-ir-semantic' as const,
      code: /^[A-Z0-9_]{1,80}$/.test(item.code) ? item.code : 'GRAPHIR_DIAGNOSTIC',
      path,
      type,
      ...(requirementId ? { requirementId } : {}),
    };
  });
}

function safeSchemaProperty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) return '[redacted]';
  if (/(?:secret|password|token|credential|authorization|email|phone|customer|client)/i.test(value)) return '[redacted]';
  return value;
}

function safeJsonPointer(pointer: string): string {
  if (!pointer || pointer === '/') return '/';
  const parts = pointer.split('/').slice(1).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  return `/${parts.map(part => /^\d{1,6}$/.test(part) ? part : safeSchemaProperty(part) || '[redacted]').map(part => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

/** Returns bounded schema-only diagnostics. Instance values are never included. */
export function diagnoseGraphIRSchema(value: unknown): GraphIRSchemaDiagnosticSet | undefined {
  const valid = checkSchema(value);
  if (valid) return undefined;
  const ajvErrors = checkSchema.errors || [];
  const receivedTypeAt = (pointer: string): GraphIRSchemaViolation['receivedType'] => {
    let current: any = value;
    for (const raw of pointer.split('/').slice(1)) {
      const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
      if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return 'undefined';
      current = current[key];
    }
    if (current === null) return 'null';
    if (Array.isArray(current)) return 'array';
    if (typeof current === 'object') return 'object';
    if (typeof current === 'string') return 'string';
    if (typeof current === 'boolean') return 'boolean';
    if (typeof current === 'number') return 'number';
    return 'undefined';
  };
  const errors: GraphIRSchemaViolation[] = ajvErrors.slice(0, MAX_GRAPHIR_SCHEMA_ERRORS).map(item => {
    const params = item.params as Record<string, unknown>;
    const rawPath = item.instancePath || '/';
    const path = safeJsonPointer(rawPath);
    const rawSegments = rawPath.split('/').slice(1).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    const arrayIndices: Array<{ arrayPath: string; index: number }> = [];
    const schemaSegments: string[] = [];
    for (const segment of rawSegments) {
      if (/^\d{1,6}$/.test(segment)) arrayIndices.push({ arrayPath: safeJsonPointer(`/${schemaSegments.join('/')}`), index: Number(segment) });
      schemaSegments.push(segment);
    }
    const expectedValues = Array.isArray(params.allowedValues)
      ? params.allowedValues.filter((entry): entry is string | number | boolean | null => entry === null || ['string', 'number', 'boolean'].includes(typeof entry)).slice(0, 20)
      : undefined;
    const expectedType = typeof params.type === 'string' ? params.type
      : Array.isArray(params.type) ? params.type.filter((entry): entry is string => typeof entry === 'string').slice(0, 8) : undefined;
    return {
      code: 'GRAPHIR_SCHEMA_INVALID', stage: 'graph-ir-schema', path,
      keyword: /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.keyword) ? item.keyword : 'unknown',
      schemaPath: /^[#/$A-Za-z0-9_.-]{1,256}$/.test(item.schemaPath) ? item.schemaPath : '#',
      ...(typeof params.missingProperty === 'string' ? { missingProperty: safeSchemaProperty(params.missingProperty) } : {}),
      ...(typeof params.additionalProperty === 'string' ? { additionalProperty: safeSchemaProperty(params.additionalProperty) } : {}),
      ...(expectedType ? { expectedType } : {}),
      ...(item.keyword === 'type' ? { receivedType: receivedTypeAt(rawPath) } : {}),
      ...(expectedValues?.length ? { expectedValues } : {}),
      ...(arrayIndices.length ? { arrayIndex: arrayIndices[arrayIndices.length - 1].index, arrayPath: arrayIndices[arrayIndices.length - 1].arrayPath, arrayIndices } : {}),
    };
  });
  return { stage: 'graph-ir-schema', totalErrors: ajvErrors.length, truncated: Math.max(0, ajvErrors.length - errors.length), errors };
}
const error = (code: string, path: string, message: string): Diagnostic => ({ code, path, message, severity: 'error' });
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const stable = (diagnostics: Diagnostic[]): Diagnostic[] => diagnostics.sort((a, b) => lexical(a.path, b.path) || lexical(a.code, b.code) || lexical(a.message, b.message));
const result = (diagnostics: Diagnostic[]): ValidationResult => ({ valid: !diagnostics.some(item => item.severity === 'error'), diagnostics: stable(diagnostics) });
function valueMatchesType(value: unknown, type: string): boolean {
  if (type === 'string' || type === 'date' || type === 'datetime') return typeof value === 'string';
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'decimal') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  return false;
}
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => lexical(a, b)).map(([key, child]) => [key, canonicalJson(child)]));
}

export function validateGraphIRStructure(value: unknown): ValidationResult {
  const diagnosticSet = diagnoseGraphIRSchema(value);
  if (!diagnosticSet) return { valid: true, diagnostics: [] };
  return result(diagnosticSet.errors.map(item => error(item.code, item.path, `${item.keyword}: JSON Schema violation`)));
}

export function validateGraphIRSemantics(value: unknown): ValidationResult {
  const shape = validateGraphIRStructure(value);
  if (!shape.valid) return shape;
  const graph = value as GraphIRV1;
  const diagnostics: Diagnostic[] = [];
  const add = (code: string, path: string, message: string) => diagnostics.push(error(code, path, message));
  const unique = (items: Array<{ id: string }>, path: string) => {
    const seen = new Set<string>();
    items.forEach(item => { if (seen.has(item.id)) add('GRAPHIR_DUPLICATE_ID', `/${path}`, `Identidade duplicada: ${item.id}`); seen.add(item.id); });
  };
  unique(graph.nodes, 'nodes'); unique(graph.edges, 'edges'); unique(graph.roles, 'roles'); unique(graph.formRefs, 'formRefs'); unique(graph.requirements, 'requirements');
  unique(graph.variables.map(item => ({ id: item.id })), 'variables');
  const uniqueKeys = new Set<string>();
  graph.variables.forEach(item => { if (uniqueKeys.has(item.key)) add('GRAPHIR_DUPLICATE_VARIABLE_KEY', '/variables', `Chave de variável duplicada: ${item.key}`); uniqueKeys.add(item.key); });
  const nodes = new Map(graph.nodes.map(item => [item.id, item]));
  const roles = new Map(graph.roles.map(item => [item.id, item]));
  const variables = new Map(graph.variables.map(item => [item.id, item]));
  const forms = new Map(graph.formRefs.map(item => [item.id, item]));
  const requirements = new Map(graph.requirements.map(item => [item.id, item]));
  const starts = graph.nodes.filter(item => item.type === 'start');
  const ends = graph.nodes.filter(item => item.type === 'end');
  if (starts.length !== 1) add('GRAPHIR_START_COUNT_INVALID', '/nodes', `Esperado exatamente um início; encontrado ${starts.length}`);
  if (!ends.length) add('GRAPHIR_END_MISSING', '/nodes', 'Pelo menos um nó final é obrigatório');
  const outgoing = new Map<string, typeof graph.edges>();
  const incoming = new Map<string, typeof graph.edges>();
  const pairs = new Set<string>();
  for (const [index, edge] of graph.edges.entries()) {
    const path = `/edges/${edge.id}`;
    if (!nodes.has(edge.source)) add('GRAPHIR_NODE_REFERENCE_MISSING', `${path}/source`, `Nó inexistente: ${edge.source}`);
    if (!nodes.has(edge.target)) add('GRAPHIR_NODE_REFERENCE_MISSING', `${path}/target`, `Nó inexistente: ${edge.target}`);
    const pair = `${edge.source}\0${edge.target}\0${edge.gatewayId || ''}\0${JSON.stringify(canonicalJson(edge.condition || null))}\0${edge.isDefault === true}`;
    if (pairs.has(pair)) add('GRAPHIR_DUPLICATE_EDGE', path, 'Conexão duplicada com a mesma origem, destino e regra');
    pairs.add(pair);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) || []), edge]);
    incoming.set(edge.target, [...(incoming.get(edge.target) || []), edge]);
    const source = nodes.get(edge.source);
    if (edge.gatewayId && (source?.type !== 'exclusiveGateway' || edge.gatewayId !== edge.source)) add('GRAPHIR_GATEWAY_ASSOCIATION_INVALID', `${path}/gatewayId`, 'gatewayId deve apontar para o gateway XOR de origem');
    if (source?.type === 'exclusiveGateway' && edge.gatewayId && edge.gatewayId !== source.id) add('GRAPHIR_GATEWAY_ASSOCIATION_INVALID', `${path}/gatewayId`, 'Associação de gateway divergente da origem');
    if (edge.condition && source?.type !== 'exclusiveGateway') add('GRAPHIR_CONDITION_ON_NON_GATEWAY', `${path}/condition`, 'Condições de roteamento só podem sair de gateway XOR');
    if (source?.type === 'exclusiveGateway' && edge.gatewayId !== source.id) add('GRAPHIR_GATEWAY_ASSOCIATION_INVALID', `${path}/gatewayId`, 'Toda saída de gateway deve declarar sua associação');
    if (edge.isDefault && source?.type !== 'exclusiveGateway') add('GRAPHIR_DEFAULT_ON_NON_GATEWAY', path, 'Aresta default só pode sair de gateway XOR');
    if (edge.isDefault && edge.condition) add('GRAPHIR_DEFAULT_WITH_CONDITION', path, 'Aresta default não pode conter condição');
    if (edge.kind === 'loop-back') {
      if (source?.type === 'start' || nodes.get(edge.target)?.type === 'end') add('GRAPHIR_LOOP_ENDPOINT_INVALID', path, 'Retorno não pode sair do início nem apontar para um nó final');
    }
  }
  const visitExpression = (expr: any, path: string): string => {
    if (Object.hasOwn(expr, 'var')) {
      const variable = variables.get(expr.var);
      if (!variable) { add('GRAPHIR_VARIABLE_REFERENCE_MISSING', path, `Variável inexistente: ${expr.var}`); return 'unknown'; }
      return variable.type;
    }
    if (Object.hasOwn(expr, 'literal')) {
      const value = expr.literal;
      return value === null ? 'null' : typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? Number.isInteger(value) ? 'integer' : 'decimal' : 'string';
    }
    if (expr.op === 'not') { if (visitExpression(expr.arg, `${path}/arg`) !== 'boolean') add('GRAPHIR_CONDITION_TYPE_INVALID', path, 'not exige expressão booleana'); return 'boolean'; }
    if (expr.op === 'isSet') { visitExpression(expr.arg, `${path}/arg`); return 'boolean'; }
    if (expr.op === 'and' || expr.op === 'or') {
      expr.args.forEach((arg: unknown, i: number) => { if (visitExpression(arg, `${path}/args/${i}`) !== 'boolean') add('GRAPHIR_CONDITION_TYPE_INVALID', `${path}/args/${i}`, `${expr.op} exige expressões booleanas`); }); return 'boolean';
    }
    const left = visitExpression(expr.left, `${path}/left`); const right = visitExpression(expr.right, `${path}/right`);
    const compatible = left === right || left === 'unknown' || right === 'unknown' || [left, right].every(type => ['integer', 'decimal'].includes(type));
    if (!compatible || (['gt', 'gte', 'lt', 'lte'].includes(expr.op) && ['boolean', 'object', 'array', 'null'].includes(left))) add('GRAPHIR_CONDITION_TYPE_INVALID', path, `Operador ${expr.op} incompatível com ${left} e ${right}`);
    return 'boolean';
  };
  for (const edge of graph.edges) if (edge.condition && visitExpression(edge.condition, `/edges/${edge.id}/condition`) !== 'boolean') add('GRAPHIR_CONDITION_TYPE_INVALID', `/edges/${edge.id}/condition`, 'Condição de roteamento deve resultar em booleano');
  for (const form of graph.formRefs) {
    const fieldKeys = new Set<string>();
    for (const field of form.fields) {
      const fieldPath = `/formRefs/${form.id}/fields/${String(field.key)}`;
      if (fieldKeys.has(String(field.key))) add('GRAPHIR_DUPLICATE_FORM_FIELD', `${fieldPath}/key`, `Campo duplicado: ${String(field.key)}`);
      fieldKeys.add(String(field.key));
      const variable = variables.get(String(field.bindTo));
      if (!variable) add('GRAPHIR_VARIABLE_REFERENCE_MISSING', `${fieldPath}/bindTo`, `Variável inexistente: ${String(field.bindTo)}`);
      else {
        const compatibleTypes: Record<string, string[]> = { text: ['string'], textarea: ['string'], email: ['string'], integer: ['integer'], decimal: ['decimal', 'integer'], boolean: ['boolean'], select: ['string'], date: ['date'], datetime: ['datetime'], attachment: ['string', 'array'] };
        if (!compatibleTypes[String(field.type)]?.includes(variable.type)) add('GRAPHIR_FIELD_TYPE_MISMATCH', `${fieldPath}/type`, `Campo ${String(field.type)} incompatível com variável ${variable.type}`);
        if (field.type === 'select') {
          const optionValues = new Set(((field.options as Array<{ value: string }> | undefined) || []).map(option => option.value));
          if (!optionValues.size) add('GRAPHIR_SELECT_OPTIONS_REQUIRED', fieldPath, 'Campo select exige opções explícitas');
          if (variable.enumValues && (variable.enumValues.length !== optionValues.size || variable.enumValues.some(item => !optionValues.has(item as string)))) add('GRAPHIR_SELECT_DOMAIN_MISMATCH', fieldPath, 'Opções devem corresponder ao domínio string da variável');
        }
      }
      for (const key of ['visibleWhen', 'requiredWhen']) if (field[key] && visitExpression(field[key], `${fieldPath}/${key}`) !== 'boolean') add('GRAPHIR_FORM_CONDITION_TYPE_INVALID', `${fieldPath}/${key}`, 'Condição de campo deve resultar em booleano');
    }
  }
  for (const node of graph.nodes) {
    const path = `/nodes/${node.id}`;
    const outs = outgoing.get(node.id) || [];
    const ins = incoming.get(node.id) || [];
    if (node.type === 'start' && ins.length) add('GRAPHIR_START_HAS_INCOMING', path, 'Nó inicial não pode ter arestas de entrada');
    if (node.type === 'end' && outs.length) add('GRAPHIR_END_HAS_OUTGOING', path, 'Nó final não pode ter arestas de saída');
    if (node.type !== 'end' && !outs.length) add('GRAPHIR_NODE_DEAD_END', path, 'Nó sem aresta de saída');
    if (node.defaultEdgeId && node.type !== 'exclusiveGateway') add('GRAPHIR_GATEWAY_DEFAULT_REFERENCE_INVALID', `${path}/defaultEdgeId`, 'defaultEdgeId só pode ser usado por gateway XOR');
    if (node.type === 'humanTask' && !node.roleId) add('GRAPHIR_ROLE_REQUIRED', `${path}/roleId`, 'Tarefa humana exige papel explícito');
    if (node.roleId && !roles.has(node.roleId)) add('GRAPHIR_ROLE_REFERENCE_MISSING', `${path}/roleId`, `Papel inexistente: ${node.roleId}`);
    if (node.roleId && node.type !== 'humanTask') add('GRAPHIR_ROLE_ON_UNSUPPORTED_NODE', `${path}/roleId`, 'Papel só pode ser atribuído a tarefa humana no GraphIR v1');
    if (node.formRef) {
      const form = forms.get(node.formRef);
      if (!form) add('GRAPHIR_FORM_REFERENCE_MISSING', `${path}/formRef`, `Formulário inexistente: ${node.formRef}`);
      else if ((node.type === 'start' && form.usage !== 'start') || (node.type === 'humanTask' && form.usage !== 'task') || !['start', 'humanTask'].includes(node.type)) add('GRAPHIR_FORM_USAGE_INVALID', `${path}/formRef`, 'Formulário incompatível com o tipo de nó');
    }
    if (node.type === 'serviceTask' && !node.action) add('GRAPHIR_SERVICE_ACTION_REQUIRED', `${path}/action`, 'Tarefa declarativa exige uma ação tipada');
    if (node.type !== 'serviceTask' && node.action) add('GRAPHIR_ACTION_ON_UNSUPPORTED_NODE', `${path}/action`, 'Ação declarativa só é aceita em serviceTask');
    if (node.action) {
      for (const [key, expression] of Object.entries(node.action.inputMapping || {})) visitExpression(expression, `${path}/action/inputMapping/${key}`);
      for (const [key, variableId] of Object.entries(node.action.outputMapping || {})) if (!variables.has(String(variableId))) add('GRAPHIR_VARIABLE_REFERENCE_MISSING', `${path}/action/outputMapping/${key}`, `Variável inexistente: ${String(variableId)}`);
      if (node.action.idempotencyKey) visitExpression(node.action.idempotencyKey, `${path}/action/idempotencyKey`);
      if (node.action.sideEffectLevel !== 'read' && (!node.action.idempotencyKey || node.action.approvalRequired !== true)) add('GRAPHIR_SIDE_EFFECT_UNSAFE', `${path}/action`, 'Ação de escrita exige chave de idempotência e aprovação declarada');
      for (const variable of graph.variables.filter(item => item.source?.kind === 'action' && item.source.nodeId === node.id)) {
        if (!Object.hasOwn(node.action.outputMapping || {}, String(variable.source?.outputKey))) add('GRAPHIR_ACTION_OUTPUT_SOURCE_INVALID', `${path}/action/outputMapping`, `Saída ${String(variable.source?.outputKey)} não está mapeada`);
      }
    }
    if (node.type === 'exclusiveGateway') {
      if (outs.length < 2) add('GRAPHIR_GATEWAY_OUTPUTS_INSUFFICIENT', path, 'Gateway XOR exige pelo menos duas saídas');
      if (outs.some(edge => !edge.condition && !edge.isDefault)) add('GRAPHIR_GATEWAY_ROUTE_UNCONDITIONED', path, 'Cada saída do gateway exige condição ou default');
      if (outs.filter(edge => edge.isDefault).length > 1) add('GRAPHIR_GATEWAY_DEFAULT_AMBIGUOUS', path, 'Gateway admite no máximo uma saída default');
      if (node.defaultEdgeId && outs.find(edge => edge.isDefault)?.id !== node.defaultEdgeId) add('GRAPHIR_GATEWAY_DEFAULT_REFERENCE_INVALID', `${path}/defaultEdgeId`, 'defaultEdgeId deve identificar a única saída marcada como default');
      if (outs.some(edge => edge.isDefault) && outs.find(edge => edge.isDefault)?.id !== node.defaultEdgeId) add('GRAPHIR_GATEWAY_DEFAULT_REFERENCE_INVALID', path, 'A saída default deve corresponder a defaultEdgeId');
      const numericCondition = outs.some(edge => {
        const expression = edge.condition as any;
        if (!expression || !['gt', 'gte', 'lt', 'lte', 'eq', 'ne'].includes(expression.op)) return false;
        const variableId = expression.left?.var || expression.right?.var;
        return ['integer', 'decimal'].includes(variables.get(variableId)?.type || '');
      });
      if (numericCondition) {
        const numeric = analyzeNumericXor(outs.map(edge => ({ id: edge.id, condition: edge.condition && graphExpressionToProcess(edge.condition, graph.variables), isDefault: edge.isDefault })), graph.variables.map(variable => ({ key: variable.key, type: variable.type })));
        numeric.forEach(issue => diagnostics.push({ ...error(issue.code, `/nodes/${node.id}`, issue.message), severity: issue.severity }));
      }
    }
  }
  for (const requirement of graph.requirements) {
    const path = `/requirements/${requirement.id}`;
    if (requirement.nodeId && !nodes.has(requirement.nodeId)) add('GRAPHIR_REQUIREMENT_REFERENCE_MISSING', `${path}/nodeId`, `Nó inexistente: ${requirement.nodeId}`);
    if (requirement.sourceNodeId && !nodes.has(requirement.sourceNodeId)) add('GRAPHIR_REQUIREMENT_REFERENCE_MISSING', `${path}/sourceNodeId`, `Nó inexistente: ${requirement.sourceNodeId}`);
    if (requirement.targetNodeId && !nodes.has(requirement.targetNodeId)) add('GRAPHIR_REQUIREMENT_REFERENCE_MISSING', `${path}/targetNodeId`, `Nó inexistente: ${requirement.targetNodeId}`);
    if (requirement.roleId && !roles.has(requirement.roleId)) add('GRAPHIR_REQUIREMENT_REFERENCE_MISSING', `${path}/roleId`, `Papel inexistente: ${requirement.roleId}`);
    if (requirement.variableId && !variables.has(requirement.variableId)) add('GRAPHIR_REQUIREMENT_REFERENCE_MISSING', `${path}/variableId`, `Variável inexistente: ${requirement.variableId}`);
    if (requirement.formRef && !forms.has(requirement.formRef)) add('GRAPHIR_REQUIREMENT_REFERENCE_MISSING', `${path}/formRef`, `Formulário inexistente: ${requirement.formRef}`);
    if (requirement.kind === 'loop' && (!requirement.sourceNodeId || !requirement.targetNodeId)) add('GRAPHIR_LOOP_REQUIREMENT_INCOMPLETE', path, 'Requisito de ciclo precisa declarar origem e destino');
    if (requirement.kind === 'activity' && !requirement.nodeId) add('GRAPHIR_ACTIVITY_REQUIREMENT_INCOMPLETE', path, 'Requisito de atividade precisa declarar nodeId');
    if (requirement.kind === 'actor' && (!requirement.nodeId || !requirement.roleId)) add('GRAPHIR_ACTOR_REQUIREMENT_INCOMPLETE', path, 'Requisito de ator precisa declarar nodeId e roleId');
    if (requirement.kind === 'structure' && !requirement.nodeId) add('GRAPHIR_STRUCTURE_REQUIREMENT_INCOMPLETE', path, 'Requisito estrutural precisa declarar nodeId');
    if (requirement.kind === 'condition' && (!requirement.variableId || !requirement.operator || !Object.hasOwn(requirement, 'value'))) add('GRAPHIR_CONDITION_REQUIREMENT_INCOMPLETE', path, 'Requisito de condição precisa declarar variável, operador e valor');
    if (requirement.kind === 'consequence' && (!requirement.sourceNodeId || !requirement.targetNodeId)) add('GRAPHIR_CONSEQUENCE_REQUIREMENT_INCOMPLETE', path, 'Requisito de consequência precisa declarar origem e destino');
    if (requirement.kind === 'form-field' && (!requirement.formRef || !requirement.fieldKey)) add('GRAPHIR_FORM_REQUIREMENT_INCOMPLETE', path, 'Requisito de formulário precisa declarar formRef e fieldKey');
    if (requirement.kind === 'form-field' && requirement.formRef && requirement.fieldKey && !forms.get(requirement.formRef)?.fields.some(field => field.key === requirement.fieldKey)) add('GRAPHIR_REQUIREMENT_REFERENCE_MISSING', path, 'Campo de formulário inexistente');
  }
  for (const variable of graph.variables) {
    const source = variable.source;
    if (source?.kind === 'constant' && !valueMatchesType(source.value, variable.type)) add('GRAPHIR_VARIABLE_SOURCE_TYPE_INVALID', `/variables/${variable.id}/source/value`, `Constante incompatível com variável ${variable.type}`);
    if (variable.enumValues?.some(value => !valueMatchesType(value, variable.type))) add('GRAPHIR_VARIABLE_ENUM_TYPE_INVALID', `/variables/${variable.id}/enumValues`, `Valores enumerados incompatíveis com variável ${variable.type}`);
    if (source?.kind === 'form') {
      const form = forms.get(String(source.formRef));
      if (!form) add('GRAPHIR_FORM_REFERENCE_MISSING', `/variables/${variable.id}/source/formRef`, `Formulário inexistente: ${String(source.formRef)}`);
      else if (!form.fields.some(field => field.key === source.fieldKey && field.bindTo === variable.id)) add('GRAPHIR_FORM_VARIABLE_SOURCE_INVALID', `/variables/${variable.id}/source`, 'Campo de origem deve referenciar esta variável');
    }
    if (source?.kind === 'action') {
      const actionNode = nodes.get(String(source.nodeId));
      if (actionNode?.type !== 'serviceTask') add('GRAPHIR_ACTION_SOURCE_INVALID', `/variables/${variable.id}/source/nodeId`, 'Origem deve referenciar serviceTask existente');
      else if ((actionNode.action?.outputMapping as Record<string, string> | undefined)?.[String(source.outputKey)] !== variable.id) add('GRAPHIR_ACTION_SOURCE_INVALID', `/variables/${variable.id}/source`, 'Saída da ação deve mapear para esta variável');
    }
  }
  if (starts.length === 1) {
    const reachable = new Set<string>([starts[0].id]); const queue = [starts[0].id];
    while (queue.length) for (const edge of outgoing.get(queue.shift()!) || []) if (nodes.has(edge.target) && !reachable.has(edge.target)) { reachable.add(edge.target); queue.push(edge.target); }
    graph.nodes.forEach(node => { if (!reachable.has(node.id)) add('GRAPHIR_NODE_UNREACHABLE', `/nodes/${node.id}`, `Nó desconectado do início: ${node.id}`); });
    const canReachEnd = new Set<string>(ends.map(node => node.id));
    const reverseQueue = [...canReachEnd];
    while (reverseQueue.length) for (const edge of incoming.get(reverseQueue.shift()!) || []) if (nodes.has(edge.source) && !canReachEnd.has(edge.source)) { canReachEnd.add(edge.source); reverseQueue.push(edge.source); }
    graph.nodes.forEach(node => { if (!canReachEnd.has(node.id)) add('GRAPHIR_NO_PATH_TO_END', `/nodes/${node.id}`, `Nó não alcança nenhum final: ${node.id}`); });
  }
  return result(diagnostics);
}

export function validateGraphIRCoverage(value: unknown): ValidationResult {
  const shape = validateGraphIRStructure(value);
  if (!shape.valid) return shape;
  const graph = value as GraphIRV1;
  const diagnostics: Diagnostic[] = [];
  const covered = new Set<string>();
  const refs = [
    ...graph.nodes.flatMap(node => node.requirementRefs.map(id => ({ id, path: `/nodes/${node.id}/requirementRefs`, ownerType: 'node' as const, owner: node }))),
    ...graph.edges.flatMap(edge => edge.requirementRefs.map(id => ({ id, path: `/edges/${edge.id}/requirementRefs`, ownerType: 'edge' as const, owner: edge }))),
    ...graph.formRefs.flatMap(form => form.fields.flatMap(field => ((field.requirementRefs as string[] | undefined) || []).map(id => ({ id, path: `/formRefs/${form.id}/fields/${String(field.key)}/requirementRefs`, ownerType: 'form-field' as const, owner: { form, field } })))),
  ];
  for (const ref of refs) {
    const requirement = graph.requirements.find(item => item.id === ref.id);
    if (!requirement) {
      diagnostics.push(error('GRAPHIR_REQUIREMENT_REFERENCE_MISSING', ref.path, `Requisito inexistente: ${ref.id}`));
      continue;
    }
    covered.add(ref.id);
    let bindingIsValid = false;
    if (ref.ownerType === 'node') {
      const node = ref.owner as GraphIRV1['nodes'][number];
      bindingIsValid = requirement.kind === 'activity' && requirement.nodeId === node.id && ['humanTask', 'serviceTask'].includes(node.type)
        || requirement.kind === 'structure' && requirement.nodeId === node.id && node.type === 'exclusiveGateway'
        || requirement.kind === 'actor' && requirement.nodeId === node.id && requirement.roleId === node.roleId && node.type === 'humanTask'
        || requirement.kind === 'loop' && requirement.sourceNodeId === node.id && node.type === 'exclusiveGateway';
    } else if (ref.ownerType === 'edge') {
      const edge = ref.owner as GraphIRV1['edges'][number];
      bindingIsValid = requirement.kind === 'loop' && edge.kind === 'loop-back' && requirement.sourceNodeId === edge.source && requirement.targetNodeId === edge.target
        || requirement.kind === 'condition' && conditionMatches(edge.condition, requirement, graph.variables)
        || requirement.kind === 'consequence' && edge.kind === 'sequence' && requirement.sourceNodeId === edge.source && requirement.targetNodeId === edge.target;
    } else {
      const { form, field } = ref.owner as { form: GraphIRV1['formRefs'][number]; field: GraphIRV1['formRefs'][number]['fields'][number] };
      bindingIsValid = requirement.kind === 'form-field' && requirement.formRef === form.id && requirement.fieldKey === field.key;
    }
    if (!bindingIsValid) diagnostics.push({ ...error('GRAPHIR_REQUIREMENT_BINDING_INVALID', ref.path, 'Requisito não corresponde ao tipo e à identidade deste elemento'), requirementId: ref.id });
  }
  for (const node of graph.nodes.filter(item => ['humanTask', 'serviceTask', 'exclusiveGateway'].includes(item.type))) {
    if (!node.requirementRefs.length) diagnostics.push(error('GRAPHIR_ELEMENT_UNGROUNDED', `/nodes/${node.id}`, 'Elemento de negócio sem requisito rastreável'));
  }
  for (const edge of graph.edges.filter(item => item.condition || item.kind === 'loop-back')) {
    if (!edge.requirementRefs.length) diagnostics.push(error('GRAPHIR_ELEMENT_UNGROUNDED', `/edges/${edge.id}`, 'Rota condicional ou ciclo sem requisito rastreável'));
  }
  for (const requirement of graph.requirements) {
    if (requirement.mandatory && !covered.has(requirement.id)) diagnostics.push(error('GRAPHIR_REQUIREMENT_UNCOVERED', `/requirements/${requirement.id}`, `Requisito obrigatório sem cobertura: ${requirement.id}`));
    if (requirement.kind === 'loop' && requirement.sourceNodeId && requirement.targetNodeId) {
      const exact = graph.edges.some(edge => edge.kind === 'loop-back' && edge.source === requirement.sourceNodeId && edge.target === requirement.targetNodeId && edge.requirementRefs.includes(requirement.id));
      if (!exact) diagnostics.push(error('GRAPHIR_LOOP_DESTINATION_DIVERGENCE', `/requirements/${requirement.id}`, 'Ciclo não corresponde à origem e destino exigidos'));
    }
    if (requirement.kind === 'actor' && requirement.roleId) {
      const exact = graph.nodes.some(node => node.id === requirement.nodeId && node.type === 'humanTask' && node.roleId === requirement.roleId && node.requirementRefs.includes(requirement.id));
      if (!exact) diagnostics.push(error('GRAPHIR_ROLE_REQUIREMENT_DIVERGENCE', `/requirements/${requirement.id}`, 'Tarefa coberta não usa o papel exigido'));
    }
    if (requirement.kind === 'activity' && requirement.nodeId) {
      const exact = graph.nodes.some(node => node.id === requirement.nodeId && ['humanTask', 'serviceTask'].includes(node.type) && node.requirementRefs.includes(requirement.id));
      if (!exact) diagnostics.push(error('GRAPHIR_NODE_REQUIREMENT_DIVERGENCE', `/requirements/${requirement.id}`, 'Requisito de atividade precisa cobrir uma tarefa no nodeId declarado'));
    }
    if (requirement.kind === 'structure' && requirement.nodeId) {
      const exact = graph.nodes.some(node => node.id === requirement.nodeId && node.type === 'exclusiveGateway' && node.requirementRefs.includes(requirement.id));
      if (!exact) diagnostics.push(error('GRAPHIR_NODE_REQUIREMENT_DIVERGENCE', `/requirements/${requirement.id}`, 'Requisito estrutural precisa cobrir um gateway XOR no nodeId declarado'));
    }
    if (requirement.kind === 'consequence' && requirement.sourceNodeId && requirement.targetNodeId) {
      const exact = graph.edges.some(edge => edge.source === requirement.sourceNodeId && edge.target === requirement.targetNodeId && edge.requirementRefs.includes(requirement.id));
      if (!exact) diagnostics.push(error('GRAPHIR_CONSEQUENCE_DIVERGENCE', `/requirements/${requirement.id}`, 'Consequência não termina no destino exigido'));
    }
    if (requirement.kind === 'form-field' && requirement.formRef && requirement.fieldKey) {
      const exact = graph.formRefs.find(form => form.id === requirement.formRef)?.fields.some(field => field.key === requirement.fieldKey && ((field.requirementRefs as string[] | undefined) || []).includes(requirement.id));
      if (!exact) diagnostics.push(error('GRAPHIR_FORM_REQUIREMENT_DIVERGENCE', `/requirements/${requirement.id}`, 'Campo não corresponde ao requisito de formulário'));
    }
    if (requirement.kind === 'condition' && requirement.variableId && requirement.operator) {
      const exact = graph.edges.some(edge => edge.requirementRefs.includes(requirement.id) && conditionMatches(edge.condition, requirement, graph.variables));
      if (!exact) diagnostics.push(error('GRAPHIR_CONDITION_REQUIREMENT_DIVERGENCE', `/requirements/${requirement.id}`, 'Condição não corresponde à variável, operador e valor exigidos'));
    }
  }
  for (const node of graph.nodes) {
    const refs = node.requirementRefs.map(id => graph.requirements.find(item => item.id === id)).filter(Boolean);
    if (['humanTask', 'serviceTask'].includes(node.type) && !refs.some(item => item?.kind === 'activity' && item.nodeId === node.id)) {
      diagnostics.push(error('GRAPHIR_ELEMENT_REQUIREMENT_KIND_INVALID', `/nodes/${node.id}/requirementRefs`, 'Tarefa exige requisito de atividade vinculado ao próprio nodeId'));
    }
    if (node.type === 'exclusiveGateway' && !refs.some(item => item?.kind === 'structure' && item.nodeId === node.id)) {
      diagnostics.push(error('GRAPHIR_ELEMENT_REQUIREMENT_KIND_INVALID', `/nodes/${node.id}/requirementRefs`, 'Gateway exige requisito estrutural vinculado ao próprio nodeId'));
    }
  }
  return result(diagnostics);
}

export function validateGraphIR(value: unknown): ValidationResult {
  const shape = validateGraphIRStructure(value);
  if (!shape.valid) return shape;
  return result([...validateGraphIRSemantics(value).diagnostics, ...validateGraphIRCoverage(value).diagnostics]);
}

function graphExpressionToProcess(expr: any, variables: GraphIRV1['variables']): any {
  if (Object.hasOwn(expr, 'var')) return { var: variables.find(variable => variable.id === expr.var)?.key || expr.var };
  if (Object.hasOwn(expr, 'literal')) return { literal: expr.literal };
  if (expr.op === 'and' || expr.op === 'or') return { op: expr.op, args: expr.args.map((arg: any) => graphExpressionToProcess(arg, variables)) };
  if (expr.op === 'not' || expr.op === 'isSet') return { op: expr.op, arg: graphExpressionToProcess(expr.arg, variables) };
  return { op: expr.op, left: graphExpressionToProcess(expr.left, variables), right: graphExpressionToProcess(expr.right, variables) };
}

function conditionMatches(condition: any, requirement: GraphIRV1['requirements'][number], variables: GraphIRV1['variables']): boolean {
  if (!condition) return false;
  if (condition.op === requirement.operator && condition.left?.var === requirement.variableId && Object.hasOwn(condition.right || {}, 'literal') && Object.is(condition.right.literal, requirement.value)) return true;
  if (condition.op === 'and' || condition.op === 'or') return condition.args.some((item: any) => conditionMatches(item, requirement, variables));
  if (condition.op === 'not' || condition.op === 'isSet') return conditionMatches(condition.arg, requirement, variables);
  const variable = variables.find(item => item.id === condition.left?.var);
  return Boolean(variable && condition.op === requirement.operator && variable.id === requirement.variableId && Object.hasOwn(condition.right || {}, 'literal') && Object.is(condition.right.literal, requirement.value));
}
