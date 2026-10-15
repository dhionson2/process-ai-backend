import type { Diagnostic } from '../../domain/contracts.js';

type JsonMap = Record<string, any>;
type List = JsonMap[];
type ValueType = string | 'null' | 'unknown';
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
  const variableMap = new Map(vars.map(v => [v.key, v]));
  for (const role of roles.filter((item: JsonMap) => item.resolution === 'unresolved')) {
    const taskNodes = nodes.filter(node => node.type === 'userTask' && node.roleId === role.id);
    if (!taskNodes.length) continue;
    const configured = taskNodes.some(node => spec.pendingQuestions.some((question: JsonMap) => question.blocking && question.relatedNodeId === node.id));
    if (!configured) add('ROLE_ASSIGNMENT_PENDING', role.id, 'Papel sem resolução exige pergunta de configuração vinculada à tarefa');
    if (spec.status !== 'needs-input') add('PROCESS_STATUS_MISMATCH', role.id, 'Processo com papel não resolvido deve permanecer em needs-input');
  }
  const fieldTypes: Record<string, string[]> = { text: ['string'], textarea: ['string'], email: ['string'], integer: ['integer'], decimal: ['decimal', 'integer'], boolean: ['boolean'], select: ['string'], date: ['date'], datetime: ['datetime'], attachment: ['string', 'array'] };
  const expressionType = (expr: JsonMap, path: string): ValueType => {
    if (expr.var) {
      const variable = variableMap.get(expr.var);
      return variable ? variable.type : 'unknown';
    }
    if (Object.hasOwn(expr, 'literal')) {
      const value = expr.literal;
      if (value === null) return 'null';
      if (typeof value === 'boolean') return 'boolean';
      if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'decimal';
      return 'string';
    }
    const op = expr.op as string;
    if (op === 'and' || op === 'or') {
      for (const [index, child] of expr.args.entries()) if (expressionType(child, `${path}/args/${index}`) !== 'boolean') add('CONDITION_TYPE_MISMATCH', `${path}/args/${index}`, 'Operando lógico deve ser booleano');
      return 'boolean';
    }
    if (op === 'not') {
      if (expressionType(expr.arg, `${path}/arg`) !== 'boolean') add('CONDITION_TYPE_MISMATCH', `${path}/arg`, 'Operando de not deve ser booleano');
      return 'boolean';
    }
    if (op === 'isSet') { expressionType(expr.arg, `${path}/arg`); return 'boolean'; }
    if (['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].includes(op)) {
      const left = expressionType(expr.left, `${path}/left`);
      const right = expressionType(expr.right, `${path}/right`);
      const compatible = left === 'unknown' || right === 'unknown' || left === right || ([left, right].every(t => ['integer', 'decimal'].includes(t)));
      if (!compatible) add('CONDITION_TYPE_MISMATCH', path, `Tipos incompatíveis: ${left} e ${right}`);
      if (['gt', 'gte', 'lt', 'lte'].includes(op) && ['boolean', 'object', 'array', 'null'].includes(left)) add('CONDITION_TYPE_MISMATCH', path, `Operador ${op} não é permitido para ${left}`);
      return 'boolean';
    }
    return 'unknown';
  };
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
    if (flow.condition) expressionType(flow.condition, `/flows/${flow.id}/condition`);
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
    if (node.formId && mapForms.has(node.formId)) {
      const form = mapForms.get(node.formId)!;
      if (node.type === 'startEvent' && form.usage !== 'start') add('FORM_USAGE_MISMATCH', node.id, 'O startEvent requer formulário de uso start');
      if (node.type === 'userTask' && form.usage !== 'task') add('FORM_USAGE_MISMATCH', node.id, 'A userTask requer formulário de uso task');
      if (!['startEvent', 'userTask'].includes(node.type)) add('FORM_NODE_UNSUPPORTED', node.id, 'Formulários só podem ser ligados a startEvent ou userTask');
    }
    if (node.roleId && !mapRoles.has(node.roleId)) add('ROLE_UNRESOLVED', node.id, node.roleId);
    if (node.type === 'exclusiveGateway') {
      const routes = outgoing.get(node.id) || [];
      if (routes.length < 2 || routes.some(f => !f.condition && !f.isDefault)) add('GATEWAY_ROUTE_MISSING', node.id, 'Gateway XOR deve possuir rotas com condição ou default');
      if (routes.filter(f => f.isDefault).length > 1) add('GATEWAY_DEFAULT_INVALID', node.id, 'Gateway XOR aceita no máximo uma rota default');
      for (const route of routes) if (route.isDefault && route.condition) add('GATEWAY_DEFAULT_INVALID', route.id, 'Rota default não pode possuir condição');
    }
    if (node.type === 'serviceTask') {
      if (!node.action) { add('CAPABILITY_NOT_SUPPORTED', node.id, 'Ação declarativa ausente'); continue; }
      const a = node.action;
      const available = (catalog.connectors as List).flatMap(c => (c.operations as List).map((o): JsonMap => ({ ...o, connectorId: c.connectorId })))
        .find(o => o.connectorId === a.connectorId && o.operationId === a.operationId);
      if (!available || available.capability !== a.capability || available.sideEffectLevel !== a.sideEffectLevel)
        add('CONNECTOR_NOT_APPROVED', node.id, `${a.connectorId}/${a.operationId}`);
      if (a.sideEffectLevel !== 'read' && (!a.idempotencyKey || !a.approvalRequired))
        add('SIDE_EFFECT_UNSAFE', node.id, 'Escrita requer aprovação e idempotência');
      for (const [inputKey, v] of Object.entries(a.inputMapping || {})) {
        for (const key of varsOf(v)) if (!mapVars.has(key)) add('CONDITION_VAR_UNDEFINED', node.id, key);
        expressionType(v as JsonMap, `/nodes/${node.id}/action/inputMapping/${inputKey}`);
      }
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
      if (mapVars.has(field.bindTo) && !fieldTypes[field.type]?.includes(variableMap.get(field.bindTo)?.type)) add('FIELD_TYPE_MISMATCH', `${form.id}.${field.key}`, `Campo ${field.type} incompatível com variável ${variableMap.get(field.bindTo)?.type}`);
      if (field.type === 'select') {
        if (!field.options?.length) add('FORM_OPTIONS_REQUIRED', `${form.id}.${field.key}`, 'Campo select deve possuir opções');
        const values = new Set((field.options || []).map((option: JsonMap) => option.value));
        const domain = variableMap.get(field.bindTo)?.enumValues;
        if (domain && (domain.length !== values.size || domain.some((value: unknown) => !values.has(value)))) add('FORM_OPTIONS_DOMAIN_MISMATCH', `${form.id}.${field.key}`, 'As opções devem corresponder ao enum da variável');
      } else if (field.options) add('FORM_OPTIONS_UNSUPPORTED', `${form.id}.${field.key}`, 'Opções só são permitidas em campos select');
      for (const type of ['visibleWhen', 'requiredWhen']) {
        for (const key of varsOf(field[type])) if (!mapVars.has(key)) add('CONDITION_VAR_UNDEFINED', `${form.id}.${field.key}`, key);
        if (field[type] && expressionType(field[type], `/forms/${form.id}/fields/${field.key}/${type}`) !== 'boolean') add('CONDITION_TYPE_MISMATCH', `${form.id}.${field.key}/${type}`, 'Regra do formulário deve produzir boolean');
      }
      for (const expr of [field.visibleWhen, field.requiredWhen].filter(Boolean)) {
        const refs = varsOf(expr);
        for (const key of refs) {
          const producer = variableMap.get(key)?.source;
          if (producer?.kind === 'form' && producer.formId === form.id) {
            const dependency = form.fields.find((candidate: JsonMap) => candidate.key === producer.fieldKey);
            if (dependency && form.fields.indexOf(dependency) >= form.fields.indexOf(field)) add('FORM_FIELD_DEPENDENCY_ORDER', `${form.id}.${field.key}`, `A regra depende do campo posterior ${producer.fieldKey}`);
          }
        }
      }
    }
  }
  const linkedForms = new Set(nodes.map(node => node.formId).filter(Boolean));
  for (const form of forms) if (!linkedForms.has(form.id)) add('FORM_ORPHANED', form.id, 'Formulário não está associado a startEvent ou userTask');
  for (const v of vars) {
    const source = v.source;
    if (source.kind === 'form') {
      const f = mapForms.get(source.formId);
      if (!f || !(f.fields as List).some(field => field.key === source.fieldKey)) add('VARIABLE_SOURCE_INVALID', v.key, 'Campo da origem não encontrado');
      const sourceField = f?.fields.find((field: JsonMap) => field.key === source.fieldKey);
      if (sourceField && sourceField.bindTo !== v.key) add('VARIABLE_SOURCE_INVALID', v.key, 'O campo de origem deve estar vinculado a esta variável');
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
  for (const node of nodes) {
    if (node.defaultFlowId && !(outgoing.get(node.id) || []).some(f => f.id === node.defaultFlowId)) add('GATEWAY_DEFAULT_INVALID', node.id, 'defaultFlowId deve referenciar uma saída do gateway');
    if (node.defaultFlowId && (outgoing.get(node.id) || []).some(f => f.id === node.defaultFlowId && f.condition)) add('GATEWAY_DEFAULT_INVALID', node.id, 'Rota default não pode possuir condição');
    if ((node.type === 'userTask' || node.type === 'serviceTask') && !node.roleId && node.type === 'userTask') add('ROLE_UNRESOLVED', node.id, 'userTask exige roleId explícito');
  }
  const canReachEnd = new Set(nodes.filter(n => n.type === 'endEvent').map(n => n.id));
  let changed = true;
  while (changed) { changed = false; for (const flow of flows) if (canReachEnd.has(flow.target) && !canReachEnd.has(flow.source)) { canReachEnd.add(flow.source); changed = true; } }
  for (const node of nodes) if (!canReachEnd.has(node.id)) add('NO_PATH_TO_END', node.id, 'Não há caminho do nó até um endEvent');
  return d;
}
