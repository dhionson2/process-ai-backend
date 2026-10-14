import type { Diagnostic } from '../../domain/contracts.js';

type JsonMap = Record<string, any>;
type List = JsonMap[];
const varsOf = (value: unknown): string[] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const x = value as JsonMap;
  const found: string[] = typeof x.var === 'string' ? [x.var] : [];
  for (const key of ['left', 'right', 'arg']) found.push(...varsOf(x[key]));
  if (Array.isArray(x.args)) for (const arg of x.args) found.push(...varsOf(arg));
  return found;
};
export function validateSemantics(spec: JsonMap, catalog: JsonMap): Diagnostic[] {
  const d: Diagnostic[] = [];
  const add = (code: string, path: string, message: string): void => { d.push({ code, path, message, severity: 'error' }); };
  const nodes: List = spec.nodes;
  const flows: List = spec.flows;
  const forms: List = spec.forms;
  const roles: List = spec.roles;
  const vars: List = spec.variables;
  const mapNodes = new Map(nodes.map(n => [n.id, n]));
  const mapForms = new Map(forms.map(f => [f.id, f]));
  const mapRoles = new Set(roles.map(r => r.id));
  const mapVars = new Set(vars.map(v => v.key));
  for (const [label, list, key] of [['nodes', nodes, 'id'], ['flows', flows, 'id'], ['forms', forms, 'id'], ['roles', roles, 'id'], ['variables', vars, 'key']] as const) {
    const seen = new Set<string>();
    for (const x of list) {
      if (seen.has(x[key])) add('DUPLICATE_ID', label, `${x[key]} duplicado`);
      seen.add(x[key]);
    }
  }
  const starts = nodes.filter(n => n.type === 'startEvent');
  if (starts.length !== 1) add('START_COUNT_INVALID', 'nodes', `Esperado 1 start; atual ${starts.length}`);
  if (!nodes.some(n => n.type === 'endEvent')) add('END_MISSING', 'nodes', 'Pelo menos um endEvent é necessário');
  const adj = new Map<string, string[]>();
  const outgoing = new Map<string, List>();
  for (const flow of flows) {
    if (!mapNodes.has(flow.source)) add('FLOW_SOURCE_MISSING', flow.id, String(flow.source));
    if (!mapNodes.has(flow.target)) add('FLOW_TARGET_MISSING', flow.id, String(flow.target));
    if (mapNodes.has(flow.source) && mapNodes.has(flow.target)) {
      adj.set(flow.source, [...(adj.get(flow.source) || []), flow.target]);
      outgoing.set(flow.source, [...(outgoing.get(flow.source) || []), flow]);
    }
    for (const key of varsOf(flow.condition)) if (!mapVars.has(key)) add('CONDITION_VAR_UNDEFINED', flow.id, key);
  }
  const reachable = new Set<string>(starts.map(n => n.id));
  const queue = [...reachable];
  while (queue.length) {
    const next = queue.shift()!;
    for (const dst of adj.get(next) || []) if (!reachable.has(dst)) { reachable.add(dst); queue.push(dst); }
  }
  for (const node of nodes) {
    if (!reachable.has(node.id)) add('UNREACHABLE_NODE', node.id, 'Nó não alcançável do início');
    if (node.type !== 'endEvent' && !outgoing.get(node.id)?.length && !['boundaryEvent','intermediateCatchEvent'].includes(node.type)) add('DEAD_END', node.id, 'Nó sem saída');
    if (node.formId && !mapForms.has(node.formId)) add('FORM_UNDEFINED', node.id, node.formId);
    if (node.roleId && !mapRoles.has(node.roleId)) add('ROLE_UNRESOLVED', node.id, node.roleId);
    if (node.type === 'exclusiveGateway') {
      const routes = outgoing.get(node.id) || [];
      if (routes.length < 2 || routes.some(f => !f.condition && !f.isDefault)) add('GATEWAY_ROUTE_MISSING', node.id, 'Gateway XOR deve possuir rotas com condição ou default');
    }
    if (node.type === 'serviceTask') {
      if (!node.action) { add('CAPABILITY_NOT_SUPPORTED', node.id, 'Ação declarativa ausente'); continue; }
      const a = node.action;
      const available = (catalog.connectors as List).flatMap(c => (c.operations as List).map(o => ({ ...o, connectorId: c.connectorId })))
        .find(o => o.connectorId === a.connectorId && o.operationId === a.operationId);
      if (!available || available.capability !== a.capability || available.sideEffectLevel !== a.sideEffectLevel)
        add('CONNECTOR_NOT_APPROVED', node.id, `${a.connectorId}/${a.operationId}`);
      if (a.sideEffectLevel !== 'read' && (!a.idempotencyKey || !a.approvalRequired))
        add('SIDE_EFFECT_UNSAFE', node.id, 'Escrita requer aprovação e idempotência');
      for (const v of Object.values(a.inputMapping || {})) for (const key of varsOf(v)) if (!mapVars.has(key)) add('CONDITION_VAR_UNDEFINED', node.id, key);
      for (const key of varsOf(a.idempotencyKey)) if (!mapVars.has(key)) add('CONDITION_VAR_UNDEFINED', node.id, key);
      for (const key of Object.values(a.outputMapping || {})) if (!mapVars.has(key as string)) add('OUTPUT_VAR_UNDEFINED', node.id, String(key));
    }
  }
  for (const form of forms) {
    const keys = new Set<string>();
    for (const field of form.fields) {
      if (keys.has(field.key)) add('DUPLICATE_ID', form.id, `Campo ${field.key} repetido`);
      keys.add(field.key);
      if (!mapVars.has(field.bindTo)) add('FIELD_VAR_UNDEFINED', form.id, field.bindTo);
      for (const type of ['visibleWhen', 'requiredWhen']) for (const key of varsOf(field[type])) if (!mapVars.has(key)) add('CONDITION_VAR_UNDEFINED', `${form.id}.${field.key}`, key);
    }
  }
  for (const v of vars) {
    const source = v.source;
    if (source.kind === 'form') {
      const f = mapForms.get(source.formId);
      if (!f || !(f.fields as List).some(field => field.key === source.fieldKey)) add('VARIABLE_SOURCE_INVALID', v.key, 'Campo da origem não encontrado');
    }
    if (source.kind === 'action') {
      const n = mapNodes.get(source.nodeId);
      if (!n || n.type !== 'serviceTask' || n.action?.outputMapping?.[source.outputKey] !== v.key) add('VARIABLE_SOURCE_INVALID', v.key, 'Saída de ação não encontrada');
    }
  }
  if (spec.pendingQuestions.some((q: JsonMap) => q.blocking) && ['approved', 'ready-for-review'].includes(spec.status))
    add('BLOCKING_QUESTION', 'pendingQuestions', 'Há pergunta crítica não resolvida');
  if (spec.targetProfile !== 'generic-bpmn2') add('CAPABILITY_NOT_SUPPORTED', 'targetProfile', 'Perfil exige homologação adicional; POC valida apenas generic-bpmn2');
  const supported = new Set(['startEvent', 'endEvent', 'userTask', 'serviceTask', 'exclusiveGateway']);
  if (nodes.some(n => !supported.has(n.type))) add('CAPABILITY_NOT_SUPPORTED', 'nodes', 'Tipo fora do subconjunto inicial da POC');
  return d;
}
