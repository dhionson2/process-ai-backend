import { createHash } from 'node:crypto';
import type { BusinessActivity, BusinessIntentV1 } from '../ai/semantic-process.js';
import { validateProcessSpec } from '../validation/validation.service.js';
import { generateArtifacts } from '../generation/artifact-generator.js';
import { validateGraphIR, type GraphIRV1 } from './graph-ir.js';
import { lowerGraphIRToProcessSpec } from './processspec.adapter.js';

export type ObligationKind = 'activity' | 'actor' | 'field' | 'decision' | 'condition' | 'consequence' | 'loop';
export interface BusinessObligation {
  key: string;
  kind: ObligationKind;
  mandatory: boolean;
  subject: string;
  relationEvidence: string;
  sourceExcerpt: string;
  expectedActor?: string;
  expectedTarget?: string;
  expectedOperator?: string;
  expectedValue?: string | number | boolean;
  /** Exact semantic occurrence path; distinguishes repeated activities with the same display name. */
  intentPath?: string;
}
export interface ObligationLedger { sourceId: string; expectedObligationKeys: string[]; obligations: BusinessObligation[] }
export interface CompileBusinessIntentOptions {
  sourceText: string;
  targetProfile?: GraphIRV1['process']['targetProfile'];
  ledger: ObligationLedger;
}
export type BusinessGraphDecision = 'approved' | 'partial' | 'rejected';
export interface BusinessGraphCompilation {
  decision: BusinessGraphDecision;
  graph: GraphIRV1 | null;
  processSpec: Record<string, any> | null;
  artifacts: Awaited<ReturnType<typeof generateArtifacts>> | null;
  traceability: Array<{ obligationKey: string; relationEvidence: string; elementPaths: string[]; covered: boolean }>;
  evidence: { internalConsistency: 'pass' | 'fail'; knownObligationCoverage: 'complete' | 'partial' | 'not-evaluated'; interpretationCompleteness: 'not-measured'; artifactSupport: 'supported' | 'unsupported'; diagnostics: Array<{ code: string; path: string; message: string }> };
}

type MutableGraph = GraphIRV1;
const norm = (v: string) => v.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]+/g, ' ').trim();
const slug = (v: string) => norm(v).replaceAll(' ', '_').slice(0, 48) || 'item';
const hash = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 10);
const stableId = (kind: string, key: string) => `g_${kind}_${slug(key)}_${hash(`${kind}:${norm(key)}`)}`;
const graphExpression = (variableId: string, operator: string, value: string | number | boolean) => ({ op: operator, left: { var: variableId }, right: { literal: value } });
const idKey = (kind: string, key: string) => `${kind}:${norm(key)}`;
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const fieldType: Record<string, { form: string; variable: string }> = {
  text: { form: 'text', variable: 'string' }, paragraph: { form: 'textarea', variable: 'string' }, integer: { form: 'integer', variable: 'integer' }, decimal: { form: 'decimal', variable: 'decimal' }, boolean: { form: 'boolean', variable: 'boolean' }, date: { form: 'date', variable: 'date' }, datetime: { form: 'datetime', variable: 'datetime' }, email: { form: 'email', variable: 'string' }, attachment: { form: 'attachment', variable: 'array' }, choice: { form: 'select', variable: 'string' },
};

/** Two-pass, offline compiler. Pass 1 registers business symbols; pass 2 emits only backend identities and references. */
export async function compileBusinessIntentToGraphIR(intent: BusinessIntentV1, options: CompileBusinessIntentOptions): Promise<BusinessGraphCompilation> {
  const diagnostics: BusinessGraphCompilation['evidence']['diagnostics'] = [];
  const add = (code: string, path: string, message: string) => diagnostics.push({ code, path, message });
  const obligations = [...options.ledger.obligations].sort((a, b) => lexical(a.key, b.key));
  const unsupportedActivities = flatten(intent.activities).filter(item => item.activity.kind === 'integration');
  for (const item of unsupportedActivities) add('BUSINESS_INTEGRATION_UNSUPPORTED', `/activities/${item.path}`, 'Integrações declarativas não fazem parte deste compilador P0.');
  const duplicateKeys = new Set<string>();
  const obligationSymbols = new Map<string, BusinessObligation>();
  const relationSymbols = new Map<string, BusinessObligation>();
  for (const obligation of obligations) {
    const k = norm(obligation.key);
    if (obligationSymbols.has(k)) duplicateKeys.add(k);
    obligationSymbols.set(k, obligation);
    const relationKey = `${obligation.kind}:${norm(obligation.subject)}:${norm(obligation.intentPath || '')}`;
    if (relationSymbols.has(relationKey)) duplicateKeys.add(relationKey);
    relationSymbols.set(relationKey, obligation);
    if (!obligation.relationEvidence.trim()) add('BUSINESS_LEDGER_RELATION_EVIDENCE_REQUIRED', `/ledger/${obligation.key}`, 'Cada obrigação exige evidência explícita da relação esperada.');
    if (!obligation.sourceExcerpt.trim() || !options.sourceText.includes(obligation.sourceExcerpt)) add('BUSINESS_EVIDENCE_NOT_GROUNDED', `/ledger/${obligation.key}`, 'A citação independente da obrigação não aparece na fonte controlada.');
  }
  for (const k of duplicateKeys) add('BUSINESS_LEDGER_IDENTITY_COLLISION', '/ledger', `Chave de obrigação ambígua: ${k}`);
  const symbols = new Map<string, { id: string; key: string; type: string; required?: boolean; sensitive?: boolean; scope?: string; enumValues?: Array<string | number | boolean>; source: Record<string, unknown> }>();
  const roles = new Map<string, { id: string; label: string; resolution: string; groupKey?: string }>();
  const forms: GraphIRV1['formRefs'] = [];
  const activitySymbols = new Map<string, { nodeId: string; formId?: string; roleId?: string; activity: BusinessActivity }>();
  const activityKey = (path: string, activity: BusinessActivity) => `${path}/${activity.kind}/${activity.name}`;
  const addRole = (name?: string) => {
    if (!name) return undefined;
    const key = norm(name); const prior = roles.get(key);
    if (prior) return prior.id;
    const actor = intent.actors.find(item => norm(item.name) === key);
    const id = stableId('role', name);
    roles.set(key, { id, label: name, resolution: actor?.resolution || 'unresolved', ...(actor?.groupName ? { groupKey: stableId('group', actor.groupName) } : {}) });
    return id;
  };
  const registerField = (field: any, owner: string, formId: string) => {
    const descriptor = fieldType[field.type];
    if (!descriptor) { add('BUSINESS_FIELD_TYPE_UNSUPPORTED', `/fields/${field.name}`, `Tipo de campo não suportado: ${field.type}`); return; }
    const key = idKey('variable', field.name);
    const existing = symbols.get(key);
    if (existing && existing.type !== descriptor.variable) { add('BUSINESS_SYMBOL_TYPE_COLLISION', `/fields/${field.name}`, 'O mesmo campo semântico foi declarado com tipos incompatíveis.'); return; }
    const fieldKey = stableId('field', `${owner}/${field.name}`);
    const variable = existing || { id: stableId('var', field.name), key: stableId('key', field.name), type: descriptor.variable, required: Boolean(field.required), scope: 'process', ...(field.type === 'attachment' ? { sensitive: false } : {}), ...(field.type === 'choice' && field.choices ? { enumValues: field.choices.map((choice: any) => choice.value) } : {}), source: { kind: 'form' as const, formRef: formId, fieldKey } };
    if (!existing) symbols.set(key, variable);
    const targetForm = forms.find(form => form.id === formId)!;
    if (!targetForm.fields.some(item => norm(String(item.label)) === norm(field.name))) targetForm.fields.push({ key: stableId('field', `${owner}/${field.name}`), label: field.name, type: descriptor.form, bindTo: variable.id, required: Boolean(field.required), ...(field.type === 'choice' && field.choices ? { options: field.choices.map((choice: any) => ({ label: choice.label, value: choice.value })) } : {}), requirementRefs: [] });
  };
  // Pass 1: register roles and every form-backed business symbol before resolving conditions.
  for (const actor of intent.actors) addRole(actor.name);
  const startFormId = stableId('form', 'solicitacao');
  forms.push({ id: startFormId, name: 'Dados da solicitação', usage: 'start', fields: [] });
  for (const field of intent.startFields) registerField(field, 'start', startFormId);
  const activities = flatten(intent.activities, `activity/${intent.name}`);
  const registerActivitySymbols = (items: BusinessActivity[], path: string) => {
    for (const activity of items) {
      const key = activityKey(path, activity); const nodeId = stableId('node', key);
      if (activity.kind === 'task' || activity.kind === 'approval') {
        const roleId = addRole(activity.actor); const formId = stableId('form', key);
        activitySymbols.set(key, { nodeId, roleId, formId, activity });
        forms.push({ id: formId, name: activity.name, usage: 'task', fields: [] });
        if (activity.kind === 'task') for (const field of activity.fields || []) registerField(field, key, formId);
        else {
          registerField({ name: `Decisão ${activity.name}`, type: 'boolean', required: true }, key, formId);
          if (activity.requiresRejectionReason) registerField({ name: `Motivo da reprovação ${activity.name}`, type: 'paragraph', required: false }, key, formId);
          registerActivitySymbols(activity.onApproved, `${key}/Aprovada`);
          registerActivitySymbols(activity.onRejected, `${key}/Reprovada`);
        }
      } else if (activity.kind === 'decision') {
        activitySymbols.set(key, { nodeId, activity });
        for (const alternative of activity.alternatives) registerActivitySymbols(alternative.steps, `${key}/${alternative.label}`);
      } else {
        add('BUSINESS_INTEGRATION_UNSUPPORTED', `/activities/${key}`, 'Integrações declarativas não fazem parte deste compilador P0.');
      }
    }
  };
  registerActivitySymbols(intent.activities, `activity/${intent.name}`);
  for (const entry of activities) if (entry.activity.kind === 'task' || entry.activity.kind === 'approval') addRole(entry.activity.actor);
  // A declared decision references a business field; it must resolve uniquely.
  for (const entry of activities) if (entry.activity.kind === 'decision' && !symbols.has(idKey('variable', entry.activity.field))) add('BUSINESS_SYMBOL_UNRESOLVED', `/activities/${entry.path}/field`, `Campo de decisão não declarado: ${entry.activity.field}`);

  // Pass 2: emit graph elements and ledger bindings from the registered symbols.
  const graph: MutableGraph = { schemaVersion: '1.0.0', process: { id: stableId('process', intent.name), name: intent.name, description: intent.purpose, locale: 'pt-BR', targetProfile: options.targetProfile || 'generic-bpmn2' }, roles: [...roles.values()].sort((a, b) => lexical(a.id, b.id)), variables: [...symbols.values()].sort((a, b) => lexical(a.id, b.id)), requirements: [], nodes: [], edges: [], formRefs: forms, metadata: { provenance: [] } };
  const ref = new Map<string, string[]>();
  const addRequirement = (ob: BusinessObligation, graphRequirement: Omit<GraphIRV1['requirements'][number], 'id' | 'kind' | 'mandatory'>) => {
    const kind = ob.kind === 'activity' ? 'activity' : ob.kind === 'actor' ? 'actor' : ob.kind === 'field' ? 'form-field' : ob.kind === 'decision' ? 'structure' : ob.kind === 'condition' ? 'condition' : ob.kind === 'consequence' ? 'consequence' : 'loop';
    const id = stableId('req', ob.key);
    if (graph.requirements.some(item => item.id === id)) { add('BUSINESS_LEDGER_IDENTITY_COLLISION', `/ledger/${ob.key}`, 'A mesma obrigação foi ligada mais de uma vez.'); return id; }
    graph.requirements.push({ id, kind, mandatory: ob.mandatory, ...graphRequirement } as GraphIRV1['requirements'][number]);
    ref.set(ob.key, [...(ref.get(ob.key) || []), id]);
    return id;
  };
  const obligationFor = (kind: ObligationKind, subject: string, intentPath?: string) => obligations.filter(ob => ob.kind === kind && norm(ob.subject) === norm(subject) && (!ob.intentPath || norm(ob.intentPath) === norm(intentPath || '')));
  const bind = (kind: ObligationKind, subject: string, payload: Omit<GraphIRV1['requirements'][number], 'id' | 'kind' | 'mandatory'>) => {
    for (const ob of obligationFor(kind, subject)) addRequirement(ob, payload);
  };
  const startId = stableId('node', 'início'); const startReq: string[] = [];
  graph.nodes.push({ id: startId, type: 'start', name: 'Início', formRef: startFormId, requirementRefs: startReq });
  const connect = (source: string, target: string, key: string, opts: Partial<GraphIRV1['edges'][number]> = {}) => graph.edges.push({ id: stableId('edge', key), source, target, kind: opts.kind || 'sequence', ...((opts.gatewayId || graph.nodes.find(node => node.id === source)?.type === 'exclusiveGateway') ? { gatewayId: opts.gatewayId || source } : {}), ...(opts.condition ? { condition: opts.condition } : {}), ...(opts.label ? { label: opts.label } : {}), requirementRefs: opts.requirementRefs || [] });
  const emit = (activity: BusinessActivity, path: string, from: string, alreadyConnected = false, continuationFollows = false): string => {
      const key = activityKey(path, activity); const symbol = activitySymbols.get(key);
    if (!symbol) { add('BUSINESS_SYMBOL_UNRESOLVED', `/activities/${key}`, 'Atividade ausente da tabela de símbolos da primeira passagem.'); return from; }
    if (activity.kind === 'task' || activity.kind === 'approval') {
      const nodeId = symbol.nodeId; const roleId = symbol.roleId!; const formId = symbol.formId!; const refs: string[] = [];
      for (const ob of obligationFor('activity', activity.name, key)) refs.push(addRequirement(ob, { nodeId }));
      for (const ob of obligationFor('actor', activity.name, key)) refs.push(addRequirement(ob, { nodeId, roleId }));
      graph.nodes.push({ id: nodeId, type: 'humanTask', name: activity.name, roleId, formRef: formId, requirementRefs: refs });
      if (!alreadyConnected) connect(from, nodeId, `${key}/in`);
      if (activity.kind === 'task') return nodeId;
      const gatewayId = stableId('node-gateway', key); const decisionRefs: string[] = [];
      for (const ob of obligationFor('decision', activity.name, key)) decisionRefs.push(addRequirement(ob, { nodeId: gatewayId }));
      graph.nodes.push({ id: gatewayId, type: 'exclusiveGateway', name: `Decisão: ${activity.name}`, requirementRefs: decisionRefs });
      connect(nodeId, gatewayId, `${key}/decision-in`);
      const variableId = String(symbols.get(idKey('variable', `Decisão ${activity.name}`))?.id || '');
      const terminals: string[] = [];
      for (const branch of [{ label: 'Aprovada', value: true, list: activity.onApproved, kind: 'condition' as const }, { label: 'Reprovada', value: false, list: activity.onRejected, kind: 'consequence' as const }]) {
        const branchPath = `${key}/${branch.label}`; const first = branch.list[0];
        const targetKey = first ? activityKey(`${key}/${branch.label}`, first) : '';
        const target = first ? activitySymbols.get(targetKey)?.nodeId : stableId('node-end', branchPath);
        if (!target) { add('BUSINESS_SYMBOL_UNRESOLVED', `/activities/${branchPath}`, 'Destino de ramo ausente da tabela de símbolos.'); continue; }
        const edgeRefs: string[] = [];
        const branchIntentPath = `${key}/branch/${branch.label}`;
        const routeObligations = obligationFor('condition', `${activity.name}:${branch.label}`, branchIntentPath);
        if (!routeObligations.length) add('BUSINESS_BRANCH_CONDITION_MISSING', `/activities/${branchPath}`, 'Cada saída de decisão exige obrigação independente de condição.');
        for (const ob of routeObligations) edgeRefs.push(addRequirement(ob, { variableId, operator: 'eq', value: branch.value }));
        for (const ob of obligationFor('consequence', `${activity.name}:${branch.label}`, branchIntentPath)) edgeRefs.push(addRequirement(ob, { sourceNodeId: gatewayId, targetNodeId: target }));
        connect(gatewayId, target, branchPath, { gatewayId, condition: graphExpression(variableId, 'eq', branch.value), label: branch.label, requirementRefs: edgeRefs });
        if (!first) { graph.nodes.push({ id: target, type: 'end', name: branch.label, requirementRefs: [] }); terminals.push(target); }
        else {
          let tail = emit(first, `${key}/${branch.label}`, gatewayId, true, branch.list.length > 1);
          for (let i = 1; i < branch.list.length; i++) tail = emit(branch.list[i], `${key}/${branch.label}/${branch.list[i - 1].kind}/${branch.list[i - 1].name}`, tail, false, i < branch.list.length - 1);
          terminals.push(tail);
        }
      }
      return terminals[0] || gatewayId;
    }
    if (activity.kind !== 'decision') return from;
    const gatewayId = symbol.nodeId; const variable = symbols.get(idKey('variable', activity.field)); const refs: string[] = [];
    if (!variable) { add('BUSINESS_SYMBOL_UNRESOLVED', `/activities/${key}/field`, `Campo de decisão não declarado: ${activity.field}`); return from; }
    for (const ob of obligationFor('decision', activity.name, key)) refs.push(addRequirement(ob, { nodeId: gatewayId }));
    graph.nodes.push({ id: gatewayId, type: 'exclusiveGateway', name: activity.name, requirementRefs: refs }); if (!alreadyConnected) connect(from, gatewayId, `${key}/in`);
    const terminals: string[] = [];
    for (const alternative of activity.alternatives) {
      const branchPath = `${key}/${alternative.label}`; const first = alternative.steps[0];
      const targetKey = first ? activityKey(branchPath, first) : '';
      const target = first ? activitySymbols.get(targetKey)?.nodeId : stableId('node-end', branchPath);
      if (!target) { add('BUSINESS_SYMBOL_UNRESOLVED', `/activities/${branchPath}`, 'Destino de ramo ausente da tabela de símbolos.'); continue; }
      const operator = alternative.operator || 'eq'; const edgeRefs: string[] = []; const subject = `${activity.name}:${alternative.label}`;
      const branchIntentPath = `${key}/branch/${alternative.label}`;
      for (const ob of obligationFor('condition', subject, branchIntentPath)) edgeRefs.push(addRequirement(ob, { variableId: variable.id, operator, value: alternative.value }));
      for (const ob of obligationFor('consequence', subject, branchIntentPath)) edgeRefs.push(addRequirement(ob, { sourceNodeId: gatewayId, targetNodeId: target }));
      connect(gatewayId, target, branchPath, { gatewayId, condition: graphExpression(variable.id, operator, alternative.value), label: alternative.label, requirementRefs: edgeRefs });
      if (!first) { graph.nodes.push({ id: target, type: 'end', name: alternative.label, requirementRefs: [] }); terminals.push(target); }
      else {
        let tail = emit(first, branchPath, gatewayId, true, alternative.steps.length > 1);
        for (let i = 1; i < alternative.steps.length; i++) tail = emit(alternative.steps[i], `${branchPath}/${alternative.steps[i - 1].kind}/${alternative.steps[i - 1].name}`, tail, false, i < alternative.steps.length - 1);
        terminals.push(tail);
      }
    }
    if (continuationFollows && terminals.length > 1 && activity.alternatives.filter((item: { steps: BusinessActivity[] }) => item.steps.length > 0).length > 1) add('BUSINESS_BRANCH_MERGE_UNSUPPORTED', `/activities/${key}`, 'O subset GraphIR/ProcessSpec atual não oferece gateway de convergência separado para estes ramos.');
    return terminals[0] || gatewayId;
  };
  const buildSequence = (items: BusinessActivity[], from: string, path: string): string => {
    let cursor = from;
    for (let i = 0; i < items.length; i++) cursor = emit(items[i], path, cursor, false, i < items.length - 1);
    return cursor;
  };
  buildSequence(intent.activities, startId, `activity/${intent.name}`);
  const openTails = graph.nodes.filter(node => node.type !== 'end' && !graph.edges.some(edge => edge.source === node.id));
  if (openTails.length) {
    const finalId = stableId('node-end', 'fim-concluido'); graph.nodes.push({ id: finalId, type: 'end', name: 'Concluído', requirementRefs: [] });
    for (const node of openTails) connect(node.id, finalId, `fim/concluido/${node.id}`);
  }
  graph.nodes = graph.nodes.map(node => ({ ...node, requirementRefs: [...new Set(node.requirementRefs)] }));
  for (const fieldIntent of intent.startFields) {
    const form = graph.formRefs.find(item => item.id === startFormId)!;
    const field = form.fields.find((item: any) => norm(String(item.label)) === norm(fieldIntent.name)) as any;
    if (field) for (const ob of obligationFor('field', fieldIntent.name)) field.requirementRefs = [...field.requirementRefs, addRequirement(ob, { formRef: form.id, fieldKey: String(field.key) })];
  }
  for (const entry of activities) if (entry.activity.kind === 'task') {
    const key = activityKey(entry.path, entry.activity); const formId = stableId('form', key);
    for (const fieldIntent of entry.activity.fields || []) {
      const form = graph.formRefs.find(item => item.id === formId)!;
      const field = form.fields.find((item: any) => norm(String(item.label)) === norm(fieldIntent.name)) as any;
      if (field) for (const ob of obligationFor('field', fieldIntent.name)) field.requirementRefs = [...field.requirementRefs, addRequirement(ob, { formRef: form.id, fieldKey: String(field.key) })];
    }
  }
  const baseTrace = obligations.map(ob => ({ obligationKey: ob.key, relationEvidence: ob.relationEvidence, elementPaths: [] as string[], covered: false }));
  for (const item of baseTrace) {
    const reqId = stableId('req', item.obligationKey); const req = graph.requirements.find(entry => entry.id === reqId);
    if (!req) continue;
    item.covered = graph.nodes.some(node => node.requirementRefs.includes(reqId)) || graph.edges.some(edge => edge.requirementRefs.includes(reqId)) || graph.formRefs.some(form => form.fields.some((field: any) => field.requirementRefs.includes(reqId)));
    graph.nodes.filter(node => node.requirementRefs.includes(reqId)).forEach(node => item.elementPaths.push(`/nodes/${node.id}`));
    graph.edges.filter(edge => edge.requirementRefs.includes(reqId)).forEach(edge => item.elementPaths.push(`/edges/${edge.id}`));
    graph.formRefs.forEach(form => form.fields.forEach((field: any) => { if (field.requirementRefs.includes(reqId)) item.elementPaths.push(`/formRefs/${form.id}/fields/${field.key}`); }));
  }
  for (const ob of obligations) {
    const edgeForObligation = () => {
      if (ob.intentPath) {
        const marker = ob.intentPath.lastIndexOf('/branch/');
        if (marker >= 0) {
          const parentPath = ob.intentPath.slice(0, marker);
          const gatewayIds = new Set([stableId('node', parentPath), stableId('node-gateway', parentPath)]);
          return graph.edges.find(edge => gatewayIds.has(edge.source) && norm(edge.label || '') === norm(ob.intentPath!.slice(marker + '/branch/'.length)));
        }
      }
      const label = ob.subject.split(':').at(-1) || '';
      return graph.edges.find(edge => norm(edge.label || '') === norm(label));
    };
    if (ob.expectedActor) {
      const match = graph.nodes.find(node => node.name === ob.subject && node.type === 'humanTask' && (!ob.intentPath || node.id === stableId('node', ob.intentPath)));
      const actual = graph.roles.find(role => role.id === match?.roleId)?.label;
      if (actual !== ob.expectedActor) add('BUSINESS_ACTOR_FIDELITY_MISMATCH', `/ledger/${ob.key}`, `Responsável esperado “${ob.expectedActor}”; intenção compilada “${actual || 'ausente'}”.`);
    }
    if (ob.expectedTarget) {
      const matchingEdge = edgeForObligation();
      const targetName = graph.nodes.find(node => node.id === matchingEdge?.target)?.name;
      if (!matchingEdge || norm(targetName || '') !== norm(ob.expectedTarget)) add('BUSINESS_BRANCH_FIDELITY_MISMATCH', `/ledger/${ob.key}`, `Destino esperado “${ob.expectedTarget}”; intenção compilada “${targetName || 'ausente'}”.`);
    }
    if (ob.expectedOperator) {
      const edge = edgeForObligation();
      const actual = edge?.condition as any;
      if (!actual || actual.op !== ob.expectedOperator || !Object.is(actual.right?.literal, ob.expectedValue)) add('BUSINESS_CONDITION_FIDELITY_MISMATCH', `/ledger/${ob.key}`, `Condição esperada ${ob.expectedOperator} ${String(ob.expectedValue)} diverge da intenção compilada.`);
    }
  }
  graph.nodes.sort((a, b) => lexical(a.id, b.id)); graph.edges.sort((a, b) => lexical(a.id, b.id)); graph.roles.sort((a, b) => lexical(a.id, b.id)); graph.variables.sort((a, b) => lexical(a.id, b.id)); graph.requirements.sort((a, b) => lexical(a.id, b.id)); graph.formRefs.sort((a, b) => lexical(a.id, b.id));
  const graphValidation = validateGraphIR(graph);
  diagnostics.push(...graphValidation.diagnostics.map(item => ({ code: item.code, path: item.path, message: item.message })));
  if (!graphValidation.valid) return result(graph, null, null, baseTrace, 'fail', 'not-evaluated', diagnostics, 'unsupported');
  const lowered = await lowerGraphIRToProcessSpec(graph);
  if (!lowered.valid || !lowered.processSpec) {
    diagnostics.push(...lowered.diagnostics.map(item => ({ code: item.code, path: item.path, message: item.message })));
    return result(graph, null, null, baseTrace, 'fail', 'not-evaluated', diagnostics, 'unsupported');
  }
  const processValidation = await validateProcessSpec(lowered.processSpec);
  if (!processValidation.valid) {
    diagnostics.push(...processValidation.diagnostics.map(item => ({ code: item.code, path: item.path, message: item.message })));
    return result(graph, null, null, baseTrace, 'fail', 'not-evaluated', diagnostics, 'unsupported');
  }
  const artifacts = await generateArtifacts(lowered.processSpec);
  const attachmentRequested = intent.startFields.some(field => field.type === 'attachment') || activities.some(item => item.activity.kind === 'task' && item.activity.fields?.some(field => field.type === 'attachment'));
  const attachmentFormIds = new Set(lowered.processSpec.forms.filter((form: any) => form.fields.some((field: any) => field.type === 'attachment')).map((form: any) => form.id));
  const unsupportedAttachment = attachmentRequested && [...attachmentFormIds].some(formId => {
    const form = artifacts.forms.find(item => item.id === formId);
    return !form || !JSON.stringify(form.json).includes('"type":"filepicker"');
  });
  if (unsupportedAttachment) diagnostics.push({ code: 'BUSINESS_ATTACHMENT_UNSUPPORTED', path: '/forms', message: 'O campo attachment não foi projetado como filepicker em um formulário que o contém.' });
  const expected = obligations.filter(ob => ob.mandatory);
  const covered = expected.filter(ob => baseTrace.find(item => item.obligationKey === ob.key)?.covered);
  const actualObligationKeys = new Set(obligations.map(obligation => obligation.key));
  const ledgerComplete = options.ledger.expectedObligationKeys.length === actualObligationKeys.size && options.ledger.expectedObligationKeys.every(key => actualObligationKeys.has(key));
  const coverage = expected.length === covered.length && ledgerComplete ? 'complete' : 'partial';
  return result(graph, lowered.processSpec, artifacts, baseTrace, 'pass', coverage, diagnostics, unsupportedAttachment ? 'unsupported' : 'supported');

  function result(graphValue: GraphIRV1 | null, processSpec: Record<string, any> | null, artifactValue: Awaited<ReturnType<typeof generateArtifacts>> | null, traceability: BusinessGraphCompilation['traceability'], internal: 'pass' | 'fail', coverage: 'complete' | 'partial' | 'not-evaluated', allDiagnostics: BusinessGraphCompilation['evidence']['diagnostics'], artifactSupport: 'supported' | 'unsupported'): BusinessGraphCompilation {
    return { decision: internal === 'fail' || duplicateKeys.size ? 'rejected' : artifactSupport === 'unsupported' || allDiagnostics.some(item => item.code === 'BUSINESS_EVIDENCE_NOT_GROUNDED' || item.code.includes('_FIDELITY_MISMATCH') || item.code === 'BUSINESS_BRANCH_MERGE_UNSUPPORTED') ? 'partial' : coverage === 'complete' ? 'approved' : 'partial', graph: graphValue, processSpec, artifacts: artifactValue, traceability, evidence: { internalConsistency: internal, knownObligationCoverage: coverage, interpretationCompleteness: 'not-measured', artifactSupport, diagnostics: allDiagnostics } };
  }
}

function flatten(activities: BusinessActivity[], root = 'activity'): Array<{ activity: BusinessActivity; path: string }> {
  const result: Array<{ activity: BusinessActivity; path: string }> = [];
  const walk = (items: BusinessActivity[], prefix: string) => items.forEach((activity) => {
    const path = `${prefix}/${activity.kind}/${activity.name}`; result.push({ activity, path });
    if (activity.kind === 'approval') { walk(activity.onApproved, `${path}/Aprovada`); walk(activity.onRejected, `${path}/Reprovada`); }
    else if (activity.kind === 'decision') activity.alternatives.forEach(alternative => walk(alternative.steps, `${path}/${alternative.label}`));
  });
  walk(activities, root); return result;
}

