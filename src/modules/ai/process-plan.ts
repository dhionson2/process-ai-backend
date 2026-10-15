import type { ProjectTarget } from '../projects/conversation.repository.js';

type Json = Record<string, any>;

/** Small, provider-neutral planning contract. It intentionally is not ProcessSpec. */
export function processPlanSchema(): Json {
  const id = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,127}$' };
  const text = { type: 'string', minLength: 1, maxLength: 255 };
  const predicate = {
    type: 'object', additionalProperties: false,
    required: ['variable', 'operator', 'value'],
    properties: {
      variable: id,
      operator: { enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] },
      value: { type: ['string', 'number', 'boolean', 'null'] },
    },
  };
  const expr = { oneOf: [
    { type: 'object', additionalProperties: false, required: ['var'], properties: { var: id } },
    { type: 'object', additionalProperties: false, required: ['literal'], properties: { literal: { type: ['string', 'number', 'boolean', 'null'] } } },
    predicate,
  ] };
  const source = {
    type: 'object', additionalProperties: false, required: ['kind'],
    properties: {
      kind: { enum: ['form', 'action', 'constant', 'system'] }, formId: id,
      fieldKey: id, nodeId: id, outputKey: id, systemKey: id,
      value: { type: ['string', 'number', 'boolean', 'null'] },
    },
  };
  const role = { type: 'object', additionalProperties: false, required: ['id', 'label', 'resolution'], properties: {
    id, label: text, resolution: { enum: ['requester', 'manual', 'group', 'manager-of-requester', 'system'] }, groupKey: id,
  } };
  const variable = { type: 'object', additionalProperties: false, required: ['key', 'type', 'source'], properties: {
    key: id, type: { enum: ['string', 'integer', 'decimal', 'boolean', 'date', 'datetime', 'object', 'array'] },
    required: { type: 'boolean' }, sensitive: { type: 'boolean' }, scope: { enum: ['process', 'task'] },
    enumValues: { type: 'array', uniqueItems: true, items: { type: ['string', 'number', 'boolean'] } }, source,
  } };
  const field = { type: 'object', additionalProperties: false, required: ['key', 'label', 'type', 'bindTo'], properties: {
    key: id, label: text, description: { type: 'string', maxLength: 500 },
    type: { enum: ['text', 'textarea', 'integer', 'decimal', 'boolean', 'select', 'date', 'datetime', 'email', 'attachment'] },
    required: { type: 'boolean' }, bindTo: id, sensitive: { type: 'boolean' },
    options: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: text, value: { type: 'string', maxLength: 100 } } } },
    visibleWhen: expr, requiredWhen: expr, min: { type: 'number' }, max: { type: 'number' }, pattern: { type: 'string', maxLength: 150 },
  } };
  const form = { type: 'object', additionalProperties: false, required: ['id', 'name', 'usage', 'fields'], properties: {
    id, name: text, usage: { enum: ['start', 'task'] }, fields: { type: 'array', maxItems: 300, items: field },
  } };
  const retryPolicy = { type: 'object', additionalProperties: false, required: ['maxAttempts', 'backoffMs'], properties: {
    maxAttempts: { type: 'integer', minimum: 0, maximum: 12 }, backoffMs: { type: 'integer', minimum: 0, maximum: 3600000 },
  } };
  const action = { type: 'object', additionalProperties: false, required: ['capability', 'connectorId', 'operationId', 'inputMapping', 'outputMapping', 'timeoutMs', 'retryPolicy', 'sideEffectLevel'], properties: {
    capability: { enum: ['http.request', 'database.record.read', 'database.record.create', 'database.record.update', 'database.record.delete', 'notification.send', 'document.generate', 'document.sign.request', 'queue.publish', 'data.transform', 'process.call', 'rules.evaluate', 'file.store'] },
    connectorId: id, operationId: id, inputMapping: { type: 'object', additionalProperties: expr },
    outputMapping: { type: 'object', additionalProperties: id }, timeoutMs: { type: 'integer', minimum: 100, maximum: 300000 },
    retryPolicy, idempotencyKey: expr, sideEffectLevel: { enum: ['read', 'write', 'irreversible'] }, approvalRequired: { type: 'boolean' },
  } };
  const node = { type: 'object', additionalProperties: false, required: ['id', 'name', 'type'], properties: {
    id, name: text, type: { enum: ['startEvent', 'endEvent', 'userTask', 'serviceTask', 'manualTask', 'businessRuleTask', 'sendTask', 'receiveTask', 'scriptTask', 'exclusiveGateway', 'parallelGateway', 'inclusiveGateway', 'eventBasedGateway', 'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent', 'subProcess', 'callActivity'] },
    documentation: { type: 'string', maxLength: 10000 }, roleId: id, formId: id, action,
    defaultFlowId: id, eventDefinition: { enum: ['none', 'message', 'timer', 'signal', 'error', 'escalation', 'terminate', 'compensation', 'link'] },
    attachedToNodeId: id, calledProcessId: id,
  } };
  const flow = { type: 'object', additionalProperties: false, required: ['id', 'source', 'target'], properties: {
    id, source: id, target: id, label: { type: 'string', maxLength: 255 }, condition: predicate, isDefault: { type: 'boolean' },
  } };
  const question = { type: 'object', additionalProperties: false, required: ['question', 'blocking'], properties: { question: text, blocking: { type: 'boolean' } } };
  const plan = { type: 'object', additionalProperties: false, required: ['kind', 'id', 'name', 'changeSummary', 'description', 'roles', 'variables', 'forms', 'nodes', 'flows', 'pendingQuestions'], properties: {
    kind: { const: 'process_plan' }, id, name: text, changeSummary: { type: 'string', minLength: 1, maxLength: 1000 }, description: { type: 'string', maxLength: 20000 },
    roles: { type: 'array', maxItems: 100, items: role }, variables: { type: 'array', maxItems: 1000, items: variable },
    forms: { type: 'array', maxItems: 100, items: form }, nodes: { type: 'array', minItems: 2, maxItems: 1000, items: node },
    flows: { type: 'array', minItems: 1, maxItems: 2000, items: flow }, pendingQuestions: { type: 'array', maxItems: 100, items: question },
  } };
  const clarification = { type: 'object', additionalProperties: false, required: ['kind', 'questions'], properties: {
    kind: { const: 'need_clarification' }, summary: { type: 'string', maxLength: 1000 },
    questions: { type: 'array', minItems: 1, maxItems: 8, items: question },
  } };
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', oneOf: [clarification, plan] };
}

export function refinementSchema(): Json {
  const id = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,127}$' };
  const text = { type: 'string', minLength: 1, maxLength: 255 };
  const question = { type: 'object', additionalProperties: false, required: ['question', 'blocking'], properties: { question: text, blocking: { type: 'boolean' } } };
  const renameProcess = { type: 'object', additionalProperties: false, required: ['op', 'name'], properties: { op: { const: 'renameProcess' }, name: text } };
  const renameNode = { type: 'object', additionalProperties: false, required: ['op', 'nodeId', 'name'], properties: { op: { const: 'renameNode' }, nodeId: id, name: text } };
  const addRole = { type: 'object', additionalProperties: false, required: ['op', 'id', 'label', 'resolution'], properties: {
    op: { const: 'addRole' }, id, label: text, resolution: { enum: ['requester', 'manual', 'group', 'manager-of-requester', 'system'] }, groupKey: id,
  } };
  const simpleRule = { type: 'object', additionalProperties: false, required: ['variable', 'operator', 'value'], properties: {
    variable: id, operator: { enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] }, value: { type: ['string', 'number', 'boolean', 'null'] },
  } };
  const field = { type: 'object', additionalProperties: false, required: ['key', 'label', 'type', 'bindTo'], properties: {
    key: id, label: text, type: { enum: ['text', 'textarea', 'integer', 'decimal', 'boolean', 'select', 'date', 'datetime', 'email', 'attachment'] },
    bindTo: id, required: { type: 'boolean' }, options: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: text, value: { type: 'string', maxLength: 100 } } } },
    visibleWhen: simpleRule, requiredWhen: simpleRule,
  } };
  const form = { type: 'object', additionalProperties: false, required: ['id', 'name', 'fields'], properties: { id, name: text, fields: { type: 'array', items: field } } };
  const addUserTask = { type: 'object', additionalProperties: false, required: ['op', 'afterNodeId', 'nodeId', 'name', 'roleId'], properties: {
    op: { const: 'addUserTask' }, afterNodeId: id, nodeId: id, name: text, roleId: id, form,
  } };
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', oneOf: [
    { type: 'object', additionalProperties: false, required: ['kind', 'questions'], properties: { kind: { const: 'need_clarification' }, summary: { type: 'string', maxLength: 1000 }, questions: { type: 'array', minItems: 1, maxItems: 8, items: question } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'changeSummary', 'operations'], properties: { kind: { const: 'refinement' }, changeSummary: { type: 'string', minLength: 1, maxLength: 1000 }, operations: { type: 'array', minItems: 1, maxItems: 20, items: { oneOf: [renameProcess, renameNode, addRole, addUserTask] } } } },
  ] };
}

export function applyRefinement(currentSpec: Json, patch: Json): Json {
  const next = structuredClone(currentSpec);
  const operations = patch.operations as Json[];
  for (const operation of operations.filter((candidate: Json) => candidate.op === 'addRole')) {
    if (next.roles.some((role: Json) => role.id === operation.id)) throw new Error(`ID de papel já utilizado: ${operation.id}`);
    next.roles.push({ id: operation.id, label: operation.label, resolution: operation.resolution, ...(operation.groupKey ? { groupKey: operation.groupKey } : {}) });
  }
  const fieldTypes: Record<string, string> = { text: 'string', textarea: 'string', email: 'string', integer: 'integer', decimal: 'decimal', boolean: 'boolean', select: 'string', date: 'date', datetime: 'datetime', attachment: 'string' };
  const toExpression = (rule: Json) => rule ? (Object.hasOwn(rule, 'variable') ? { op: rule.operator, left: { var: rule.variable }, right: { literal: rule.value } } : rule) : undefined;
  for (const operation of operations.filter((candidate: Json) => candidate.op !== 'addRole')) {
    if (operation.op === 'renameProcess') {
      next.name = operation.name;
      continue;
    }
    if (operation.op === 'renameNode') {
      const node = next.nodes.find((candidate: Json) => candidate.id === operation.nodeId);
      if (!node) throw new Error(`Nó de refinamento inexistente: ${operation.nodeId}`);
      node.name = operation.name;
      continue;
    }
    if (operation.op === 'addUserTask') {
      if (next.nodes.some((candidate: Json) => candidate.id === operation.nodeId)) throw new Error(`ID de nó já utilizado: ${operation.nodeId}`);
      if (operation.form && next.forms.some((form: Json) => form.id === operation.form.id)) throw new Error(`ID de formulário já utilizado: ${operation.form.id}`);
      if (!next.roles.some((role: Json) => role.id === operation.roleId)) throw new Error(`Papel de refinamento inexistente: ${operation.roleId}`);
      const outgoing = next.flows.filter((flow: Json) => flow.source === operation.afterNodeId);
      if (outgoing.length !== 1) throw new Error('Inserção pontual requer exatamente uma saída no nó de referência; esclareça o ponto da alteração');
      const downstreamNode = next.nodes.find((candidate: Json) => candidate.id === outgoing[0].target);
      if (downstreamNode?.type === 'exclusiveGateway' && next.flows.some((flow: Json) => flow.source === downstreamNode.id && flow.condition))
        throw new Error('A inserção altera a ordem de uma aprovação ligada a um gateway condicionado; esclareça como combinar decisões e motivos de reprovação');
      const createdNode = { id: operation.nodeId, name: operation.name, type: 'userTask', roleId: operation.roleId, ...(operation.form ? { formId: operation.form.id } : {}) };
      if (operation.form) {
        const fields = operation.form.fields.map((field: Json) => ({
          key: field.key, label: field.label, type: field.type, required: field.required ?? false, bindTo: field.bindTo,
          ...(field.options ? { options: field.options } : {}),
          ...(field.visibleWhen ? { visibleWhen: toExpression(field.visibleWhen) } : {}),
          ...(field.requiredWhen ? { requiredWhen: toExpression(field.requiredWhen) } : {}),
        }));
        next.forms.push({ id: operation.form.id, name: operation.form.name, usage: 'task', fields });
        for (const field of fields as Json[]) {
          if (next.variables.some((variable: Json) => variable.key === field.bindTo)) throw new Error(`A variável ${field.bindTo} já existe; o refinamento precisa esclarecer se ela deve ser reutilizada`);
          next.variables.push({ key: field.bindTo, type: fieldTypes[field.type], required: field.required, sensitive: false, scope: 'task', ...(field.options ? { enumValues: field.options.map((option: Json) => option.value) } : {}), source: { kind: 'form', formId: operation.form.id, fieldKey: field.key } });
        }
      }
      next.nodes.push(createdNode);
      outgoing[0].source = operation.nodeId;
      let flowId = `flow_${operation.nodeId}`;
      let suffix = 2;
      while (next.flows.some((flow: Json) => flow.id === flowId)) flowId = `flow_${operation.nodeId}_${suffix++}`;
      next.flows.push({ id: flowId, source: operation.afterNodeId, target: operation.nodeId });
      continue;
    }
    throw new Error('Operação de refinamento não permitida');
  }
  return next;
}

/** Composes the compact plan into ProcessSpec v1; semantic checks remain authoritative. */
export function composeProcessSpec(plan: Json, args: { targetProfile: ProjectTarget; knowledgeVersion: string; model: string }): Json {
  const expression = (value: Json | undefined): Json | undefined => value ? (Object.hasOwn(value, 'variable') ? {
    op: value.operator,
    left: { var: value.variable },
    right: { literal: value.value },
  } : value) : undefined;
  const forms = structuredClone(plan.forms) as Json[];
  const variables = structuredClone(plan.variables) as Json[];
  const variableByKey = new Map(variables.map((variable: Json) => [variable.key, variable]));
  const typeForField: Record<string, string> = { text: 'string', textarea: 'string', email: 'string', integer: 'integer', decimal: 'decimal', boolean: 'boolean', select: 'string', date: 'date', datetime: 'datetime', attachment: 'string' };
  for (const form of forms) for (const field of form.fields as Json[]) {
    const referencedVariable = (key: string): string => {
      if (variableByKey.has(key)) return key;
      const matchingFields = forms.flatMap(candidate => (candidate.fields as Json[]).filter(item => item.key === key));
      if (matchingFields.length === 1 && variableByKey.has(matchingFields[0].bindTo)) return matchingFields[0].bindTo;
      return key;
    };
    for (const ruleKey of ['visibleWhen', 'requiredWhen']) if (field[ruleKey]?.variable) field[ruleKey].variable = referencedVariable(field[ruleKey].variable);
    if (!variableByKey.has(field.bindTo)) {
      const variable = { key: field.bindTo, type: typeForField[field.type], required: field.required ?? false, sensitive: field.sensitive ?? false, scope: 'task', source: { kind: 'form', formId: form.id, fieldKey: field.key }, ...(field.type === 'select' && field.options ? { enumValues: field.options.map((option: Json) => option.value) } : {}) };
      variables.push(variable);
      variableByKey.set(variable.key, variable);
    } else {
      const variable = variableByKey.get(field.bindTo)!;
      const source = variable.source;
      if (source?.kind === 'form' && (!forms.some(candidate => candidate.id === source.formId && candidate.fields.some((item: Json) => item.key === source.fieldKey && item.bindTo === variable.key))))
        variable.source = { kind: 'form', formId: form.id, fieldKey: field.key };
    }
  }
  for (const flow of plan.flows as Json[]) if (flow.condition?.variable) {
    if (!variableByKey.has(flow.condition.variable)) {
      const matchingFields = forms.flatMap(form => (form.fields as Json[]).filter(field => field.key === flow.condition.variable));
      if (matchingFields.length === 1 && variableByKey.has(matchingFields[0].bindTo)) flow.condition.variable = matchingFields[0].bindTo;
    }
  }
  const flows = plan.flows.map((flow: Json) => ({
    id: flow.id, source: flow.source, target: flow.target,
    ...(flow.label !== undefined ? { label: flow.label } : {}),
    ...(flow.condition ? { condition: expression(flow.condition) } : {}),
    ...(flow.isDefault !== undefined ? { isDefault: flow.isDefault } : {}),
  }));
  const nodes = plan.nodes.map((node: Json) => ({
    ...node,
    ...(node.action ? { action: {
      ...node.action,
      inputMapping: Object.fromEntries(Object.entries(node.action.inputMapping || {}).map(([key, value]) => [key, expression(value as Json)])),
      ...(node.action.idempotencyKey ? { idempotencyKey: expression(node.action.idempotencyKey) } : {}),
    } } : {}),
  }));
  for (const node of nodes) {
    if (node.formId && !forms.some(form => form.id === node.formId)) {
      const usage = node.type === 'startEvent' ? 'start' : node.type === 'userTask' ? 'task' : undefined;
      const matches = usage ? forms.filter(form => form.usage === usage) : [];
      if (matches.length === 1) node.formId = matches[0].id;
    }
    if (node.type === 'exclusiveGateway') {
      const defaults = flows.filter((flow: Json) => flow.source === node.id && flow.isDefault === true);
      if (defaults.length === 1) node.defaultFlowId = defaults[0].id;
    }
  }
  return {
    schemaVersion: '1.0.0', id: plan.id, name: plan.name,
    description: plan.description, locale: 'pt-BR', targetProfile: args.targetProfile, status: 'draft',
    roles: plan.roles,
    variables: variables.map((variable: Json) => ({
      key: variable.key, type: variable.type, required: variable.required ?? false, sensitive: variable.sensitive ?? false,
      scope: variable.scope ?? 'process', ...(variable.enumValues ? { enumValues: variable.enumValues } : {}), source: variable.source,
    })),
    forms: forms.map((form: Json) => ({
      ...form,
      fields: form.fields.map((field: Json) => ({
        key: field.key, label: field.label, type: field.type, required: field.required ?? false, bindTo: field.bindTo,
        ...(field.description !== undefined ? { description: field.description } : {}),
        ...(field.sensitive !== undefined ? { sensitive: field.sensitive } : {}),
        ...(field.options ? { options: field.options } : {}),
        ...(field.visibleWhen ? { visibleWhen: expression(field.visibleWhen) } : {}),
        ...(field.requiredWhen ? { requiredWhen: expression(field.requiredWhen) } : {}),
        ...(field.min !== undefined ? { min: field.min } : {}), ...(field.max !== undefined ? { max: field.max } : {}),
        ...(field.pattern !== undefined ? { pattern: field.pattern } : {}),
      })),
    })),
    nodes, flows, pendingQuestions: plan.pendingQuestions.map((question: Json, index: number) => ({
      id: `pq_${index + 1}`, question: question.question, blocking: question.blocking,
    })), assumptions: [], policies: { manualApprovalRequired: true, allowExecution: false },
    metadata: { knowledgeVersion: args.knowledgeVersion, modelId: args.model, revision: 0 },
  };
}
