import type { ConfirmationSubject } from './confirmations.js';
import { createHash } from 'node:crypto';
import { readFoundationJson } from '../../shared/files.js';
import { businessPatternForActivity } from './business-patterns.js';
import { technicalIntent } from '../knowledge/capability-context.js';
import type { ProjectTarget } from '../projects/conversation.repository.js';
import { evaluateActivityGrounding } from './semantic-grounding.js';

type Json = Record<string, any>;
export type BusinessIntentProvenance = { source: 'user' | 'confirmed-answer' | 'catalog' | 'knowledge' | 'inference'; evidence?: string; confirmed: boolean };
type FieldIntent = { name: string; type: string; required?: boolean; choices?: Array<{ label: string; value: string }>; evidence?: string; provenance?: BusinessIntentProvenance };
type BusinessActivityBase = { name: string; evidence?: string; provenance?: BusinessIntentProvenance };
export type BusinessActivity =
  | (BusinessActivityBase & { kind: 'task'; actor?: string; fields?: FieldIntent[] })
  | (BusinessActivityBase & { kind: 'approval'; actor?: string; requiresRejectionReason?: boolean; onApproved: BusinessActivity[]; onRejected: BusinessActivity[] })
  | (BusinessActivityBase & { kind: 'decision'; field: string; alternatives: Array<{ label: string; value: string | number | boolean; operator?: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; returnTo?: string; steps: BusinessActivity[] }> })
  | (BusinessActivityBase & { kind: 'integration'; connectorId: string; operationId: string; inputs: Array<{ parameter: string; field: string }>; outputs: Array<{ parameter: string; name: string; type: string }> });
type StepIntent = Json;

export interface BusinessIntentV1 {
  kind: 'business_intent';
  name: string;
  purpose: string;
  actors: Array<{ name: string; resolution?: 'requester' | 'manual' | 'group' | 'manager-of-requester' | 'system' | 'unresolved'; groupName?: string; evidence?: string; resolutionEvidence?: string; provenance?: BusinessIntentProvenance; assignmentProvenance?: BusinessIntentProvenance }>;
  startFields: FieldIntent[];
  activities: BusinessActivity[];
  rules: Array<{ text: string; evidence?: string; provenance?: BusinessIntentProvenance }>;
  suggestions: Array<{ text: string; evidence?: string; provenance?: BusinessIntentProvenance }>;
  pendingConfiguration: Array<{ scope: string; question: string; blocking: boolean }>;
}

/** Versioned semantic control flow. References name business concepts, never BPMN/GraphIR IDs. */
export type BusinessIntentV2Target = { kind: 'activity'; activityRef: string } | { kind: 'decision'; decisionRef: string } | { kind: 'end'; name: string };
export interface BusinessIntentV2 {
  schemaVersion: '2.0.0'; kind: 'business_intent'; name: string; purpose: string;
  actors: BusinessIntentV1['actors']; startFields: FieldIntent[];
  activities: Array<{ ref: string; kind: 'task'; name: string; actor: string; fields?: FieldIntent[]; next: BusinessIntentV2Target }>;
  decisions: Array<{ ref: string; name: string; afterActivityRef: string; outcomes: Array<{ ref: string; label: string; condition: { field: string; operator: 'eq'|'ne'|'gt'|'gte'|'lt'|'lte'; value: string|number|boolean }; target: BusinessIntentV2Target }> }>;
  returns: Array<{ fromActivityRef: string; toActivityRef: string }>;
  rules?: Array<{ text: string }>; suggestions?: Array<{ text: string }>; pendingConfiguration?: Array<{ scope: string; question: string; blocking: boolean }>;
}

/** JSON contract for offline V2 producers; technical compiler IDs are intentionally absent. */
export function businessIntentV2Schema(): Json {
  const text={type:'string',minLength:1,maxLength:255};
  const target={oneOf:[
    {type:'object',additionalProperties:false,required:['kind','activityRef'],properties:{kind:{const:'activity'},activityRef:text}},
    {type:'object',additionalProperties:false,required:['kind','decisionRef'],properties:{kind:{const:'decision'},decisionRef:text}},
    {type:'object',additionalProperties:false,required:['kind','name'],properties:{kind:{const:'end'},name:text}},
  ]};
  const field={type:'object',additionalProperties:false,required:['name','type'],properties:{name:text,type:{enum:['text','paragraph','integer','decimal','boolean','date','datetime','email','attachment','choice']},required:{type:'boolean'},choices:{type:'array',items:{type:'object',additionalProperties:false,required:['label','value'],properties:{label:text,value:{type:'string',maxLength:100}}}}}};
  const actor={type:'object',additionalProperties:false,required:['name'],properties:{name:text,resolution:{enum:['requester','manual','group','manager-of-requester','system','unresolved']},groupName:text}};
  return {$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',additionalProperties:false,required:['schemaVersion','kind','name','purpose','actors','startFields','activities','decisions','returns'],properties:{
    schemaVersion:{const:'2.0.0'},kind:{const:'business_intent'},name:text,purpose:{type:'string',maxLength:2000},actors:{type:'array',maxItems:20,items:actor},startFields:{type:'array',maxItems:50,items:field},
    activities:{type:'array',minItems:1,maxItems:60,items:{type:'object',additionalProperties:false,required:['ref','kind','name','actor','next'],properties:{ref:text,kind:{const:'task'},name:text,actor:text,fields:{type:'array',maxItems:50,items:field},next:target}}},
    decisions:{type:'array',maxItems:60,items:{type:'object',additionalProperties:false,required:['ref','name','afterActivityRef','outcomes'],properties:{ref:text,name:text,afterActivityRef:text,outcomes:{type:'array',minItems:2,maxItems:20,items:{type:'object',additionalProperties:false,required:['ref','label','condition','target'],properties:{ref:text,label:text,condition:{type:'object',additionalProperties:false,required:['field','operator','value'],properties:{field:text,operator:{enum:['eq','ne','gt','gte','lt','lte']},value:{type:['string','number','boolean']}}},target}}}}}},
    returns:{type:'array',maxItems:60,items:{type:'object',additionalProperties:false,required:['fromActivityRef','toActivityRef'],properties:{fromActivityRef:text,toActivityRef:text}}},
    rules:{type:'array',maxItems:60,items:{type:'object',additionalProperties:false,required:['text'],properties:{text:{type:'string',maxLength:1000}}}},suggestions:{type:'array',maxItems:40,items:{type:'object',additionalProperties:false,required:['text'],properties:{text:{type:'string',maxLength:1000}}}},pendingConfiguration:{type:'array',maxItems:20,items:{type:'object',additionalProperties:false,required:['scope','question','blocking'],properties:{scope:text,question:text,blocking:{type:'boolean'}}}},
  }};
}

/** The model contract expresses business meaning; graph and ProcessSpec details are compiler output. */
export function businessIntentSchema(): Json {
  const text = { type: 'string', minLength: 1, maxLength: 255 };
  const actorRef = text;
  const field = { type: 'object', additionalProperties: false, required: ['name', 'type'], properties: {
    name: text, type: { enum: ['text', 'paragraph', 'integer', 'decimal', 'boolean', 'date', 'datetime', 'email', 'attachment', 'choice'] }, evidence: text,
    required: { type: 'boolean' }, choices: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: text, value: { type: 'string', maxLength: 100 } } } },
  } };
  const actor = { type: 'object', additionalProperties: false, required: ['name'], properties: {
    name: text, evidence: text, resolution: { enum: ['requester', 'manual', 'group', 'manager-of-requester', 'system', 'unresolved'] }, groupName: text, resolutionEvidence: text,
  } };
  const fields = { type: 'array', maxItems: 20, items: field };
  const binding = { type: 'object', additionalProperties: false, required: ['parameter', 'field'], properties: { parameter: text, field: text } };
  const output = { type: 'object', additionalProperties: false, required: ['parameter', 'name', 'type'], properties: {
    parameter: text, name: text, type: { enum: ['text', 'integer', 'decimal', 'boolean', 'date', 'datetime'] },
  } };
  const conditionValue = { type: ['string', 'number', 'boolean'] };
  const step: Json = { oneOf: [
    { type: 'object', additionalProperties: false, required: ['kind', 'name'], properties: { kind: { const: 'task' }, name: text, actor: actorRef, evidence: text, fields } },
    { type: 'object', additionalProperties: false, required: ['kind', 'name', 'onApproved', 'onRejected'], properties: {
      kind: { const: 'approval' }, name: text, actor: actorRef, evidence: text, requiresRejectionReason: { type: 'boolean' },
      onApproved: { type: 'array', maxItems: 12, items: { $ref: '#/$defs/step' } }, onRejected: { type: 'array', maxItems: 12, items: { $ref: '#/$defs/step' } },
    } },
    { type: 'object', additionalProperties: false, required: ['kind', 'name', 'connectorId', 'operationId', 'inputs', 'outputs'], properties: {
      kind: { const: 'integration' }, name: text, evidence: text, connectorId: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,127}$' },
      operationId: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,127}$' },
      inputs: { type: 'array', maxItems: 20, items: binding }, outputs: { type: 'array', maxItems: 20, items: output },
    } },
    { type: 'object', additionalProperties: false, required: ['kind', 'name', 'field', 'alternatives'], properties: {
      kind: { const: 'decision' }, name: text, evidence: text, field: text, alternatives: { type: 'array', minItems: 2, maxItems: 12, items: {
        type: 'object', additionalProperties: false, required: ['label', 'value', 'steps'], properties: { label: text, value: conditionValue, operator: { enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] }, returnTo: text, steps: { type: 'array', maxItems: 12, items: { $ref: '#/$defs/step' } } },
      } },
    } },
  ] };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: { step }, oneOf: [
      { type: 'object', additionalProperties: false, required: ['kind', 'questions'], properties: { kind: { const: 'need_clarification' }, summary: { type: 'string', maxLength: 1000 }, questions: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['question', 'blocking'], properties: { question: text, blocking: { type: 'boolean' } } } } } },
      { type: 'object', additionalProperties: false, required: ['kind', 'name', 'purpose', 'actors', 'startFields', 'activities', 'rules', 'suggestions', 'pendingConfiguration'], properties: {
        kind: { const: 'business_intent' }, name: text, purpose: { type: 'string', maxLength: 2000 },
        actors: { type: 'array', maxItems: 20, items: actor }, startFields: fields, activities: { type: 'array', minItems: 1, maxItems: 24, items: { $ref: '#/$defs/step' } },
        rules: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', maxLength: 1000 }, evidence: text } } },
        suggestions: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', maxLength: 1000 }, evidence: text } } },
        pendingConfiguration: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['scope', 'question', 'blocking'], properties: { scope: text, question: text, blocking: { type: 'boolean' } } } },
      } },
    ],
  };
}

/** Backward-compatible export name for tests and callers during the internal schema transition. */
export const semanticIntentSchema = businessIntentSchema;

export class SemanticPlanLimitError extends Error {
  constructor(message: string) { super(message); this.name = 'SemanticPlanLimitError'; }
}

/** Recursive BPMN branches need a whole-plan bound in addition to per-array JSON Schema limits. */
export function assertSemanticPlanBounds(intent: Json): void {
  let total = 0;
  const walk = (steps: Json[], depth: number): void => {
    if (depth > 8) throw new SemanticPlanLimitError('O plano estruturado excedeu a profundidade máxima de decisões');
    for (const step of steps) {
      total++;
      if (total > 60) throw new SemanticPlanLimitError('O plano estruturado excedeu o limite de 60 atividades');
      if (step.kind === 'approval') { walk(step.onApproved || [], depth + 1); walk(step.onRejected || [], depth + 1); }
      if (step.kind === 'decision') for (const alternative of step.alternatives || []) walk(alternative.steps || [], depth + 1);
    }
  };
  walk(intent.activities || intent.steps || [], 1);
}

export function semanticRefinementSchema(): Json {
  const text = { type: 'string', minLength: 1, maxLength: 255 };
  const field = { type: 'object', additionalProperties: false, required: ['name', 'type', 'evidence'], properties: {
    name: text, type: { enum: ['text', 'paragraph', 'integer', 'decimal', 'boolean', 'date', 'datetime', 'email', 'attachment', 'choice'] }, evidence: text, required: { type: 'boolean' },
    choices: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: text, value: { type: 'string', maxLength: 100 } } } },
  } };
  const actor = { type: 'object', additionalProperties: false, required: ['name'], properties: { name: text, resolution: { enum: ['requester', 'manual', 'group', 'manager-of-requester', 'system'] }, groupName: text, resolutionEvidence: text } };
  const operation = { oneOf: [
    { type: 'object', additionalProperties: false, required: ['kind', 'name'], properties: { kind: { const: 'renameProcess' }, name: text } },
    { type: 'object', additionalProperties: false, required: ['kind', 'activity', 'name'], properties: { kind: { const: 'renameActivity' }, activity: text, name: text } },
    { type: 'object', additionalProperties: false, required: ['kind', 'afterActivity', 'task'], properties: { kind: { const: 'insertTaskAfter' }, afterActivity: text, task: { type: 'object', additionalProperties: false, required: ['name', 'actor'], properties: { name: text, actor, fields: { type: 'array', maxItems: 50, items: field } } } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'beforeActivity', 'rejectedTargetActivity', 'approval'], properties: { kind: { const: 'insertApprovalBefore' }, beforeActivity: text, rejectedTargetActivity: text, approval: { type: 'object', additionalProperties: false, required: ['name', 'actor'], properties: { name: text, actor, requiresRejectionReason: { type: 'boolean' } } } } },
  ] };
  const clarification = { type: 'object', additionalProperties: false, required: ['kind', 'questions'], properties: {
    kind: { const: 'need_clarification' }, summary: { type: 'string', maxLength: 1000 },
    questions: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['question', 'blocking'], properties: { question: text, blocking: { type: 'boolean' } } } },
  } };
  const refinement = { type: 'object', additionalProperties: false, required: ['kind', 'changeSummary', 'operations'], properties: {
    kind: { const: 'refinement' }, changeSummary: { type: 'string', minLength: 1, maxLength: 1000 }, operations: { type: 'array', minItems: 1, maxItems: 12, items: operation },
  } };
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', oneOf: [clarification, refinement] };
}

/**
 * Who should resolve a compilation gap:
 * - `needs-user`: information only the requester has;
 * - `model-omission`: the requester stated it and the interpretation dropped it;
 * - `model-divergence`: the interpretation added or named an element without literal support. The model is
 *   corrected first; if that fails, the requester answers a yes/no question bound to `subject`.
 */
export type IntentGapOrigin = 'needs-user' | 'model-omission' | 'model-divergence';
export class IntentCompilationError extends Error {
  constructor(readonly question: string, message = question, readonly origin: IntentGapOrigin = 'needs-user', readonly subject?: ConfirmationSubject) { super(message); this.name = 'IntentCompilationError'; }
}
export class SemanticGroundingError extends Error {
  constructor(readonly status: 'divergent' | 'inconclusive', message: string) { super(message); this.name = 'SemanticGroundingError'; }
}

type BusinessCompileOptions = { targetProfile: ProjectTarget; knowledgeVersion: string; model: string; sourceText?: string; activitySourceText?: string; confirmedAnswerText?: string; knowledgeText?: string; semanticGroundingMode?: 'legacy' | 'controlled' };
type DraftQuestion = { question: string; blocking: boolean; scope?: string };

/** Add machine-verifiable provenance and compile only facts grounded in the conversation. */
export async function compileBusinessIntent(value: BusinessIntentV1 | Json, options: BusinessCompileOptions): Promise<{ businessIntent: BusinessIntentV1; spec: Json }> {
  const intent = structuredClone(value) as Json;
  const activitySource = options.activitySourceText ?? options.sourceText ?? '';
  const confirmedSource = options.confirmedAnswerText ?? '';
  const evidenceSources = [
    { source: 'user' as const, text: activitySource },
    { source: 'confirmed-answer' as const, text: confirmedSource },
  ];
  const provenance = (evidence?: string): BusinessIntentProvenance => {
    const match = evidenceSources.find(source => evidence && containsQuote(source.text, evidence));
    return match ? { source: match.source, evidence, confirmed: match.source === 'user' || match.source === 'confirmed-answer' }
      : { source: 'inference', ...(evidence ? { evidence } : {}), confirmed: false };
  };
  const assumptions: Json[] = [];
  // Runtime configuration is derived below. A model-supplied `blocking` flag cannot gate preview.
  // Structural ambiguities use need_clarification or fail compilation with a concrete diagnostic.
  const questions: DraftQuestion[] = [];
  let rejectionReasonConfirmed = /(?:se|caso|quando).{0,100}(?:reprov|rejeit).{0,120}(?:motivo|justific|raz[aã]o)|(?:motivo|justific|raz[aã]o).{0,100}(?:se|quando|caso).{0,50}(?:reprov|rejeit)/i.test([options.sourceText || '', confirmedSource].join('\n'));
  const addSuggestion = (text: string, evidence?: string) => {
    if (assumptions.some(item => normalized(item.text) === normalized(text))) return;
    assumptions.push({ id: `suggestion_${slug(text)}`, text: text.slice(0, 255), confirmed: false, origin: 'inference' });
    if (evidence) provenance(evidence);
  };
  const ask = (question: string, scope: string) => {
    if (!questions.some(item => normalized(item.question) === normalized(question))) questions.push({ question, blocking: true, scope });
  };
  const askForActor = (actor: Json) => {
    const question = `Como o runtime deve atribuir o papel “${actor.name}”? A identidade do responsável pode ser configurada depois da prévia.`;
    if (!questions.some(item => normalized(item.question) === normalized(question))) questions.push({ question, blocking: true, scope: `actor:${actor.name}` });
  };
  const actors = new Map<string, Json>();
  const rawActors = (intent.actors || []) as Json[];
  for (const actor of rawActors) {
    actor.provenance = provenance(actor.evidence || actor.resolutionEvidence);
    const nameGrounded = !activitySource || roleNameSupported(actor.name, activitySource);
    if (!nameGrounded) {
      addSuggestion(`O papel “${actor.name}” foi sugerido pelo modelo sem aparecer na descrição; ele não foi incluído como papel confirmado.`, actor.evidence);
      ask(`“${actor.name}” deve ser um papel deste processo?`, `actor:${actor.name}`);
      continue;
    }
    const explicitAssignment = !options.sourceText || (actor.resolution && resolutionIsSupported(actor, options.sourceText));
    actor.assignmentProvenance = explicitAssignment ? provenance(actor.resolutionEvidence) : provenance(undefined);
    if (!actor.resolution || actor.resolution === 'unresolved' || !explicitAssignment || (actor.resolution === 'group' && !actor.groupName)) {
      if (actor.resolution && actor.resolution !== 'unresolved' && !explicitAssignment)
        addSuggestion(`A atribuição “${actor.resolution}” sugerida para “${actor.name}” não foi confirmada.`, actor.resolutionEvidence);
      actor.resolution = 'unresolved';
      delete actor.groupName;
      askForActor(actor);
    }
    actors.set(normalized(actor.name), actor);
  }

  const ensureActor = (name: string | undefined, evidence?: string): string => {
    if (!name) {
      const placeholder = 'Responsável pendente';
      if (!actors.has(normalized(placeholder))) actors.set(normalized(placeholder), { name: placeholder, resolution: 'unresolved', provenance: { source: 'inference', confirmed: false }, assignmentProvenance: { source: 'inference', confirmed: false } });
      ask('Qual papel deve executar uma das atividades descritas?', `actor:${placeholder}`);
      return placeholder;
    }
    const key = normalized(name);
    const activityQuoteSupportsActor = !activitySource || Boolean(evidence && containsQuote(evidence, name));
    if (!activityQuoteSupportsActor) {
      addSuggestion(`O responsável “${name}” sugerido para a atividade não foi confirmado.`, evidence);
      ask(`Qual papel executa a atividade “${evidence || name}”?`, `actor:${name}`);
      const placeholder = 'Responsável pendente';
      if (!actors.has(normalized(placeholder))) actors.set(normalized(placeholder), { name: placeholder, resolution: 'unresolved', provenance: { source: 'inference', confirmed: false }, assignmentProvenance: { source: 'inference', confirmed: false } });
      ask('Qual papel deve executar uma das atividades descritas?', `actor:${placeholder}`);
      return placeholder;
    }
    if (!actors.has(key)) actors.set(key, { name, resolution: 'unresolved', evidence: name, provenance: provenance(name), assignmentProvenance: { source: 'inference', confirmed: false } });
    const actor = actors.get(key)!;
    if (actor.resolution === 'unresolved') askForActor(actor);
    return actor.name;
  };
  const selectedFields = (values: FieldIntent[] = [], usage: string): FieldIntent[] => values.filter(field => {
    field.provenance = provenance(field.evidence);
    if (!activitySource || (field.provenance.confirmed && adequateQuote(activitySource, field.evidence))) return true;
    addSuggestion(`O campo “${field.name}” foi sugerido, mas não há trecho confirmado que peça sua coleta; ele ficou fora do formulário.`, field.evidence);
    return false;
  });
  const normalizeActivities = async (items: Json[]): Promise<Json[]> => {
    const result: Json[] = [];
    for (const activity of items || []) {
      if (!businessPatternForActivity(activity.kind)) {
        addSuggestion(`O padrão de atividade “${activity.kind}” não é suportado pelo compilador e não foi incluído.`, activity.evidence);
        ask(`Como representar a atividade “${activity.name}” usando tarefas humanas, decisões ou operações autorizadas?`, `activity:${activity.name}`);
        throw new IntentCompilationError(`A atividade “${activity.name}” usa um padrão sem implementação determinística; esclareça como representá-la antes da prévia.`);
      }
    activity.provenance = provenance(activity.evidence);
      const sourceSupported = !activitySource || (activity.provenance.confirmed && adequateQuote(activitySource, activity.evidence));
      const mentionedActor = [...actors.values()].find((actor: Json) => activity.evidence && containsQuote(activity.evidence, actor.name));
      const grounding = options.semanticGroundingMode === 'controlled' && activitySource && activity.evidence
        ? evaluateActivityGrounding({ name: activity.name, evidence: activity.evidence, expectedActor: mentionedActor?.name, actualActor: activity.actor })
        : undefined;
      const nameSupported = !activitySource || (grounding ? grounding.status === 'equivalent' : Boolean(activity.evidence && stepEvidenceMatchesName(activity.name, activity.evidence)));
      if (!sourceSupported || !nameSupported) {
        addSuggestion(`A atividade “${activity.name}” não tem suporte literal suficiente e não foi incluída no fluxo confirmado.`, activity.evidence);
        if (grounding && grounding.status !== 'equivalent') throw new SemanticGroundingError(grounding.status, grounding.reason);
        ask(`A atividade “${activity.name}” deve fazer parte deste processo?`, `activity:${activity.name}`);
        throw unsupportedElement('activity', activity.name);
      }
      if (activity.kind === 'integration') {
        if (activitySource && !technicalIntent(activitySource)) throw new IntentCompilationError(`A atividade “${activity.name}” foi interpretada como integração técnica sem solicitação explícita. Confirme se há uma integração ou uma tarefa humana.`);
        const catalog = await capabilityCatalog();
        const operation = catalog.connectors.find((item: Json) => item.connectorId === activity.connectorId)?.operations.find((item: Json) => item.operationId === activity.operationId);
        const integrationEvidence = !options.sourceText || Boolean(activity.evidence && containsQuote(options.sourceText || activitySource, activity.evidence));
        if (!operation || !integrationEvidence) {
          addSuggestion(`A integração “${activity.connectorId}/${activity.operationId}” não foi autorizada e confirmada para este processo; ela não foi compilada.`, activity.evidence);
          ask(`Qual operação aprovada do catálogo deve atender à integração solicitada em “${activity.name}”?`, `integration:${activity.name}`);
          throw new IntentCompilationError(`A integração “${activity.name}” não corresponde a operação confirmada do catálogo. Escolha uma operação autorizada antes da prévia.`);
        }
      }
      if (activity.actor !== undefined) activity.actor = ensureActor(activity.actor, activity.evidence);
      else if (activity.kind === 'task' || activity.kind === 'approval') activity.actor = ensureActor(undefined, activity.evidence);
      if (activity.kind === 'approval') {
        if (activity.requiresRejectionReason === true && !rejectionReasonConfirmed) addSuggestion(`A obrigatoriedade de motivo na reprovação sugerida para “${activity.name}” não aparece como regra explícita e foi removida.`, activity.evidence);
        activity.requiresRejectionReason = rejectionReasonConfirmed;
      }
      if (activity.fields) activity.fields = selectedFields(activity.fields, activity.name);
      if (activity.kind === 'approval') {
        activity.onApproved = await normalizeActivities(activity.onApproved || []);
        activity.onRejected = await normalizeActivities(activity.onRejected || []);
      }
      if (activity.kind === 'decision') for (const alternative of activity.alternatives || []) alternative.steps = await normalizeActivities(alternative.steps || []);
      result.push(activity);
    }
    return result;
  };
  for (const suggestion of intent.suggestions || []) {
    const source = provenance(suggestion.evidence);
    suggestion.provenance = source;
    addSuggestion(suggestion.text, suggestion.evidence);
  }
  for (const rule of intent.rules || []) {
    rule.provenance = provenance(rule.evidence);
    if (activitySource && rule.provenance.confirmed && !adequateQuote(activitySource, rule.evidence)) rule.provenance = { source: 'inference', evidence: rule.evidence, confirmed: false };
    if (activitySource && !rule.provenance.confirmed) addSuggestion(`Regra sugerida sem confirmação: ${rule.text}`, rule.evidence);
  }
  rejectionReasonConfirmed ||= (intent.rules || []).some((rule: Json) => rule.provenance?.confirmed && /(?:se|caso|quando).{0,100}(?:reprov|rejeit).{0,120}(?:motivo|justific|raz[aã]o)|(?:motivo|justific|raz[aã]o).{0,100}(?:se|quando|caso).{0,50}(?:reprov|rejeit)/i.test(rule.text));
  const startFields = selectedFields(intent.startFields || [], 'start');
  const activities = await normalizeActivities(intent.activities || []);
  if (!activities.length) throw new IntentCompilationError('O modelo não identificou nenhuma atividade do processo que possa ser confirmada na descrição. Quais tarefas ou decisões devem fazer parte do fluxo?');
  if (hasExplicitDecision(activitySource) && !containsDecision(activities)) {
    { const question = 'A descrição contém uma decisão explícita, mas o BusinessIntent não a representou como aprovação ou decisão com alternativas. Confirme como estruturar os ramos antes de gerar a prévia.'; throw new IntentCompilationError(question, question, 'model-omission'); }
  }
  assertConditionalCoverage(activities, activitySource);
  const normalizedIntent = { kind: 'process_intent', name: intent.name, purpose: intent.purpose, actors: [...actors.values()], startFields, steps: activities };
  const requirementProvenance: Json[] = [];
  const recordProvenance = (path: string, name: string, item?: BusinessIntentProvenance) => {
    if (!item) return;
    requirementProvenance.push({ path, name, source: item.source, confirmed: item.confirmed, ...(item.evidence ? { evidenceSha256: createHash('sha256').update(item.evidence).digest('hex') } : {}) });
  };
  for (const actor of actors.values()) {
    recordProvenance(`roles/${slug(actor.name)}`, actor.name, actor.provenance);
    recordProvenance(`roles/${slug(actor.name)}/assignment`, actor.name, actor.assignmentProvenance);
  }
  for (const field of startFields) recordProvenance(`startFields/${slug(field.name)}`, field.name, field.provenance);
  const recordActivities = (items: Json[], prefix: string) => items.forEach((activity, index) => {
    const path = `${prefix}/${index}`;
    recordProvenance(path, activity.name, activity.provenance);
    for (const field of activity.fields || []) recordProvenance(`${path}/fields/${slug(field.name)}`, field.name, field.provenance);
    recordActivities([...(activity.onApproved || []), ...(activity.onRejected || []), ...(activity.alternatives || []).flatMap((item: Json) => item.steps || [])], path);
  });
  recordActivities(activities, 'activities');
  for (const [index, rule] of (intent.rules || []).entries()) recordProvenance(`rules/${index}`, rule.text, rule.provenance);
  const spec = await compileProcessIntent(normalizedIntent, {
    ...options,
    sourceText: undefined,
    activitySourceText: '',
    allowUnresolvedActors: true,
    pendingConfiguration: questions,
    assumptions,
    businessRules: [
      ...(intent.rules || []).filter((rule: Json) => !options.sourceText || rule.provenance?.confirmed).map((rule: Json) => rule.text as string),
      ...(rejectionReasonConfirmed ? ['O motivo é obrigatório somente quando houver reprovação, conforme regra explícita do solicitante.'] : []),
    ],
  });
  spec.metadata.requirementProvenance = requirementProvenance;
  const businessIntent = {
    ...intent, actors: [...actors.values()] as BusinessIntentV1['actors'], startFields, activities: activities as BusinessActivity[],
    rules: intent.rules || [],
    suggestions: [...(intent.suggestions || []), ...assumptions.map(item => ({ text: item.text, provenance: { source: 'inference' as const, confirmed: false } }))],
    pendingConfiguration: questions.map(item => ({ scope: item.scope || 'process', question: item.question, blocking: item.blocking })),
  };
  return { businessIntent: businessIntent as BusinessIntentV1, spec };
}

export async function allowedOperationsSummary(): Promise<string> {
  const catalog = await capabilityCatalog();
  return catalog.connectors.flatMap((connector: Json) => connector.operations.map((operation: Json) =>
    `- ${connector.connectorId}/${operation.operationId}: capability=${operation.capability}, sideEffect=${operation.sideEffectLevel}`)).join('\n');
}

export const normalized = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function isRejectionReasonField(name: string): boolean {
  return /(?:motivo|reason|justific\w*|raz[aã]o).{0,40}(?:reprov|rejei)|(?:reprov|rejei).{0,40}(?:motivo|reason|justific\w*|raz[aã]o)/i.test(name);
}
/** One honest yes/no question per element without literal support, bound to the element so the answer counts. */
function unsupportedElement(kind: ConfirmationSubject['kind'], name: string): IntentCompilationError {
  const label = kind === 'activity' ? 'A etapa' : kind === 'field' ? 'O campo' : 'O participante';
  const question = `${label} “${name}” não aparece com essas palavras no seu pedido. Ela deve fazer parte do processo? Responda sim ou não, ou descreva com suas palavras.`
    .replace('Ela deve', kind === 'activity' ? 'Ela deve' : 'Ele deve');
  return new IntentCompilationError(question, question, 'model-divergence', { kind, name });
}
const containsQuote = (context: string, quote: string) => normalized(context).includes(normalized(quote));
function adequateQuote(context: string, quote?: string): boolean {
  if (!quote || !containsQuote(context, quote)) return false;
  const stop = new Set(['a', 'as', 'ao', 'aos', 'de', 'da', 'das', 'do', 'dos', 'e', 'em', 'na', 'nas', 'no', 'nos', 'o', 'os', 'para', 'por', 'que', 'se']);
  return normalized(quote).split(' ').filter(token => token.length >= 2 && !stop.has(token)).length >= 2;
}
function resolutionIsSupported(actor: Json, sourceText: string): boolean {
  const evidence = actor.resolutionEvidence;
  const proof = typeof evidence === 'string' && containsQuote(sourceText, evidence) ? normalized(evidence) : '';
  const source = normalized(sourceText);
  if (actor.resolution === 'requester') return initiatesRequest(actor.name, proof || sourceText);
  if (actor.resolution === 'manual') return /manual|operador .* selecion|operador .* atribui|selecionado .* operador|atribuido .* operador/.test(proof);
  if (actor.resolution === 'group') return Boolean(actor.groupName && normalized(actor.groupName) === normalized(actor.name) && source.includes(normalized(actor.name))) || /grupo|equipe|setor/.test(proof);
  if (actor.resolution === 'manager-of-requester') return /gestor do (servidor|solicitante)|superior hierarquico|manager of requester/.test(proof);
  if (actor.resolution === 'system') return /sistema|automatic|automatizado/.test(proof);
  return false;
}
const slug = (value: string) => normalized(value).replace(/\s+/g, '_').replace(/^[^a-z]+/, '').slice(0, 44) || 'item';
class Ids {
  private used = new Set<string>();
  make(prefix: string, name: string): string {
    const root = `${prefix}_${slug(name)}`.slice(0, 112);
    let id = root; let index = 2;
    while (this.used.has(id)) id = `${root.slice(0, 120 - String(index).length - 1)}_${index++}`;
    this.used.add(id); return id;
  }
}
const fieldTypes: Record<string, { type: string; form: string }> = {
  text: { type: 'string', form: 'text' }, paragraph: { type: 'string', form: 'textarea' }, integer: { type: 'integer', form: 'integer' },
  decimal: { type: 'decimal', form: 'decimal' }, boolean: { type: 'boolean', form: 'boolean' }, date: { type: 'date', form: 'date' },
  datetime: { type: 'datetime', form: 'datetime' }, email: { type: 'string', form: 'email' }, attachment: { type: 'string', form: 'attachment' }, choice: { type: 'string', form: 'select' },
};
type FieldBinding = { name: string; key: string; variable: string; type: string };
type StepMeta = Json & { id: string; gatewayId?: string; formId?: string; decisionVariable?: string; reasonVariable?: string };

/** Compile semantic language into the existing canonical ProcessSpec. No business rule is inferred here. */
export async function compileProcessIntent(intent: Json, options: { targetProfile: ProjectTarget; knowledgeVersion: string; model: string; sourceText?: string; activitySourceText?: string; allowUnresolvedActors?: boolean; pendingConfiguration?: DraftQuestion[]; assumptions?: Json[]; businessRules?: string[] }): Promise<Json> {
  const ids = new Ids();
  const catalog = await capabilityCatalog();
  const roles: Json[] = [];
  const roleIndex = new Map<string, Json>();
  const roleEvidenceText = options.activitySourceText ?? options.sourceText;
  for (const actor of intent.actors as Json[]) {
    const key = normalized(actor.name);
    if (!key || roleIndex.has(key)) throw new IntentCompilationError(`Há mais de um ator chamado “${actor.name}”. Esclareça qual tarefa pertence a cada ator.`);
    if (roleEvidenceText && !roleNameSupported(actor.name, roleEvidenceText)) throw unsupportedElement('actor', actor.name);
    if (roleEvidenceText && actor.resolution !== 'requester' && initiatesRequest(actor.name, roleEvidenceText)) {
      actor.resolution = 'requester';
      const index = normalized(roleEvidenceText).indexOf(normalized(actor.name));
      actor.resolutionEvidence = roleEvidenceText.slice(Math.max(0, index), Math.max(0, index) + actor.name.length + 100);
    }
    if (!actor.resolution || (options.allowUnresolvedActors && actor.resolution === 'unresolved')) {
      if (!options.allowUnresolvedActors) throw new IntentCompilationError(`Como o runtime deve atribuir o papel “${actor.name}” (solicitante, atribuição manual, grupo ou relação hierárquica)?`);
      actor.resolution = 'unresolved';
    }
    if (actor.resolution === 'group' && !actor.groupName) {
      if (!options.allowUnresolvedActors) throw new IntentCompilationError(`Qual é o grupo autorizado para o papel “${actor.name}”?`);
      actor.resolution = 'unresolved';
    }
    if (options.sourceText && actor.resolution !== 'unresolved' && !resolutionIsSupported(actor, options.sourceText)) {
      if (!options.allowUnresolvedActors) throw new IntentCompilationError(`A solicitação não confirma a resolução “${actor.resolution}” para “${actor.name}”. Como o runtime deve localizar esse responsável?`);
      actor.resolution = 'unresolved'; delete actor.groupName;
      options.pendingConfiguration ||= [];
      options.pendingConfiguration.push({ question: `Como o runtime deve atribuir o papel “${actor.name}”?`, blocking: true, scope: `actor:${actor.name}` });
    }
    const role = { id: ids.make('role', actor.name), label: actor.name, resolution: actor.resolution, ...(actor.groupName ? { groupKey: slug(actor.groupName) } : {}) };
    roles.push(role); roleIndex.set(key, role);
  }
  const nodes: Json[] = [];
  const flows: Json[] = [];
  const forms: Json[] = [];
  const variables: Json[] = [];
  const fieldBindings: FieldBinding[] = [];
  const metadata = new Map<object, StepMeta>();
  let flowNumber = 0;
  const conditionalRuleText = [options.sourceText || '', ...(options.businessRules || [])].join('\n');
  const conditionalRejectionReason = /(?:se|caso|quando).{0,100}(?:reprov|rejeit).{0,120}(?:motivo|justific|raz[aã]o)|(?:motivo|justific|raz[aã]o).{0,100}(?:se|quando|caso).{0,50}(?:reprov|rejeit)/i.test(conditionalRuleText);
  const activitySourceText = options.activitySourceText ?? options.sourceText;
  const addFlow = (source: string, target: string, label?: string, condition?: Json) => flows.push({ id: `flow_${String(++flowNumber).padStart(4, '0')}`, source, target, ...(label ? { label } : {}), ...(condition ? { condition } : {}) });
  const addFormFields = (formId: string, usage: 'start' | 'task', name: string, inputs: FieldIntent[]) => {
    const selectedInputs = inputs.filter(input => !(usage === 'start' && conditionalRejectionReason && isRejectionReasonField(input.name)));
    if (!selectedInputs.length) return undefined;
    if (activitySourceText) for (const input of selectedInputs) {
      if (!input.evidence && ['Decisão', 'Motivo da rejeição'].includes(input.name)) continue;
      if (!input.evidence || !containsQuote(activitySourceText, input.evidence)) throw unsupportedElement('field', input.name);
    }
    const fields = selectedInputs.map(input => {
      const specType = fieldTypes[input.type];
      if (!specType) throw new IntentCompilationError(`O campo “${input.name}” tem tipo não suportado: ${input.type}.`);
      if (input.type === 'choice' && !input.choices?.length) throw new IntentCompilationError(`Quais são as opções permitidas para “${input.name}”?`);
      const key = ids.make('field', input.name);
      const variable = ids.make('var', `${formId}_${input.name}`);
      const field: Json = { key, label: input.name, type: specType.form, required: input.required ?? false, bindTo: variable,
        ...(input.choices ? { options: input.choices } : {}) };
      const variableValue: Json = { key: variable, type: specType.type, required: input.required ?? false, sensitive: false, scope: 'process', source: { kind: 'form', formId, fieldKey: key }, ...(input.choices ? { enumValues: input.choices.map(choice => choice.value) } : {}) };
      forms.find(form => form.id === formId)?.fields.push(field);
      if (!forms.some(form => form.id === formId)) forms.push({ id: formId, name, usage, fields: [field] });
      variables.push(variableValue); fieldBindings.push({ name: input.name, key, variable, type: specType.type });
      return { field, variable: variableValue };
    });
    return fields;
  };
  const startId = ids.make('start', intent.name);
  const endId = ids.make('end', 'process finished');
  nodes.push({ id: startId, type: 'startEvent', name: intent.name });
  nodes.push({ id: endId, type: 'endEvent', name: 'Processo encerrado' });
  const effectiveStartFields = (intent.startFields || []).filter((input: FieldIntent) => !(conditionalRejectionReason && isRejectionReasonField(input.name)));
  const startFormId = effectiveStartFields.length ? ids.make('form', `${intent.name} request`) : undefined;
  if (startFormId) {
    addFormFields(startFormId, 'start', `${intent.name} — solicitação`, effectiveStartFields as FieldIntent[]);
    nodes[0].formId = startFormId;
  }
  const walk = (steps: StepIntent[]) => {
    for (const step of steps) {
      if (activitySourceText && (!step.evidence || !containsQuote(activitySourceText, step.evidence))) {
        throw unsupportedElement('activity', step.name);
      }
      if (activitySourceText && !stepEvidenceMatchesName(step.name, step.evidence)) throw unsupportedElement('activity', step.name);
      if (options.sourceText && step.evidence && step.actor && !containsQuote(step.evidence, step.actor)) {
        throw new IntentCompilationError(`A solicitação não liga “${step.actor}” à atividade “${step.name}”. Qual papel deve executá-la?`);
      }
      const id = ids.make(step.kind === 'integration' ? 'service' : 'task', step.name);
      const meta: StepMeta = { id };
      if (step.kind === 'approval' || step.kind === 'decision') meta.gatewayId = ids.make('gateway', step.name);
      if (step.kind === 'task' || step.kind === 'approval') {
        const taskFields: FieldIntent[] = step.kind === 'task' ? (step.fields || []) : [{ name: 'Decisão', type: 'choice', required: true, choices: [{ label: 'Aprovar', value: 'approved' }, { label: 'Rejeitar', value: 'rejected' }] }];
        const requiresRejectionReason = step.kind === 'approval' && (step.requiresRejectionReason === true || conditionalRejectionReason);
        if (step.kind === 'approval' && requiresRejectionReason) taskFields.push({ name: 'Motivo da rejeição', type: 'paragraph', required: false });
        if (taskFields.length) meta.formId = ids.make('form', step.name);
        if (step.kind === 'approval') {
          meta.decisionVariable = ids.make('var', `${step.name} decision`);
          taskFields[0].name = 'Decisão';
          if (requiresRejectionReason) meta.reasonVariable = ids.make('var', `${step.name} rejection reason`);
        }
        if (!roleIndex.has(normalized(step.actor))) throw new IntentCompilationError(`Qual é a atribuição/resolução do ator “${step.actor}” usado na tarefa “${step.name}”?`);
        if (meta.formId) {
          addFormFields(meta.formId, 'task', step.name, taskFields);
          if (step.kind === 'approval') {
            const decisionForm = forms.find(form => form.id === meta.formId)!;
            const decisionField = decisionForm.fields[0];
            const decisionVariable = variables.find(item => item.key === decisionField.bindTo)!;
            decisionVariable.key = meta.decisionVariable!; decisionVariable.enumValues = ['approved', 'rejected'];
            decisionField.bindTo = meta.decisionVariable;
            fieldBindings.find(binding => binding.key === decisionField.key)!.variable = meta.decisionVariable!;
            if (requiresRejectionReason) {
              const reasonField = decisionForm.fields[1];
              const reasonVariable = variables.find(item => item.key === reasonField.bindTo)!;
              reasonVariable.key = meta.reasonVariable!;
              reasonField.bindTo = meta.reasonVariable;
              reasonField.visibleWhen = { op: 'eq', left: { var: meta.decisionVariable }, right: { literal: 'rejected' } };
              reasonField.requiredWhen = structuredClone(reasonField.visibleWhen);
              fieldBindings.find(binding => binding.key === reasonField.key)!.variable = meta.reasonVariable!;
            }
          }
        }
      }
      if (step.kind === 'integration') {
        const connector = catalog.connectors.find((item: Json) => item.connectorId === step.connectorId);
        const operation = connector?.operations.find((item: Json) => item.operationId === step.operationId);
        if (!operation) throw new IntentCompilationError(`A operação declarativa “${step.connectorId}/${step.operationId}” não consta no catálogo autorizado.`);
        meta['capability'] = operation.capability; meta['sideEffectLevel'] = operation.sideEffectLevel;
        for (const output of step.outputs as Json[]) {
          const variableType = fieldTypes[output.type];
          if (!variableType) throw new IntentCompilationError(`Tipo de saída não suportado para “${output.name}”.`);
          const variable = ids.make('var', output.name);
          variables.push({ key: variable, type: variableType.type, required: false, sensitive: false, scope: 'process', source: { kind: 'action', nodeId: id, outputKey: output.parameter } });
          fieldBindings.push({ name: output.name, key: output.parameter, variable, type: variableType.type });
        }
      }
      metadata.set(step, meta);
      if (step.kind === 'approval') { walk(step.onApproved || []); walk(step.onRejected || []); }
      if (step.kind === 'decision') for (const alternative of step.alternatives || []) walk(alternative.steps || []);
    }
  };
  walk(intent.steps);
  const variableFor = (name: string): FieldBinding => {
    const matches = fieldBindings.filter(binding => normalized(binding.name) === normalized(name));
    if (matches.length !== 1) throw new IntentCompilationError(matches.length ? `Qual campo “${name}” deve ser usado? Há referências ambíguas.` : `Em qual campo existente está “${name}”?`);
    return matches[0];
  };
  const decisionFieldBinding = (step: Json): FieldBinding => {
    try { return variableFor(step.field); }
    catch (error) {
      const evidence = normalized(`${step.name} ${step.evidence || ''} ${step.field}`);
      const numericThreshold = step.alternatives.length >= 2 && step.alternatives.every((alternative: Json) => typeof alternative.value === 'number' && ['gt', 'gte', 'lt', 'lte'].includes(alternative.operator || 'eq'));
      const numericFields = [...new Map(fieldBindings.filter(binding => ['integer', 'decimal'].includes(binding.type)).map(binding => [binding.variable, binding])).values()];
      if (numericThreshold && /\b(valor|montante|quantia|amount)\b/.test(evidence) && numericFields.length === 1) return numericFields[0];
      throw error;
    }
  };
  const resolveReturnTarget = (name: string, roots: StepIntent[], stepMetadata: Map<object, StepMeta>): string => {
    const matches: StepIntent[] = [];
    const visit = (steps: StepIntent[]) => {
      for (const step of steps) {
        if (normalized(step.name) === normalized(name)) matches.push(step);
        if (step.kind === 'approval') { visit(step.onApproved || []); visit(step.onRejected || []); }
        if (step.kind === 'decision') for (const alternative of step.alternatives || []) visit(alternative.steps || []);
      }
    };
    visit(roots);
    if (matches.length !== 1) throw new IntentCompilationError(`O retorno “${name}” deve apontar para uma única atividade existente.`);
    const target = stepMetadata.get(matches[0]);
    if (!target) throw new IntentCompilationError(`Não foi possível resolver a atividade de retorno “${name}”.`);
    return target.id;
  };
  const actorRole = (name: string) => roleIndex.get(normalized(name))!;
  const compileSequence = (steps: StepIntent[], continuation: string): string => {
    let entry = continuation;
    for (let index = steps.length - 1; index >= 0; index--) entry = compileStep(steps[index], entry);
    return entry;
  };
  const compileStep = (step: StepIntent, continuation: string): string => {
    const meta = metadata.get(step)!;
    if (step.kind === 'task') {
      nodes.push({ id: meta.id, type: 'userTask', name: step.name, roleId: actorRole(step.actor).id, ...(meta.formId ? { formId: meta.formId } : {}) });
      addFlow(meta.id, continuation); return meta.id;
    }
    if (step.kind === 'approval') {
      nodes.push({ id: meta.id, type: 'userTask', name: step.name, roleId: actorRole(step.actor).id, formId: meta.formId });
      nodes.push({ id: meta.gatewayId, type: 'exclusiveGateway', name: step.name }); addFlow(meta.id, meta.gatewayId!);
      const approvedEntry = compileSequence(step.onApproved || [], continuation);
      // Rejection is terminal by default; rejected-branch work must not fall through
      // into the continuation reserved for the approved branch.
      const rejectedEntry = compileSequence(step.onRejected || [], endId);
      addFlow(meta.gatewayId!, approvedEntry, 'Aprovado', { op: 'eq', left: { var: meta.decisionVariable }, right: { literal: 'approved' } });
      addFlow(meta.gatewayId!, rejectedEntry, 'Rejeitado', { op: 'eq', left: { var: meta.decisionVariable }, right: { literal: 'rejected' } });
      return meta.id;
    }
    if (step.kind === 'decision') {
      const binding = decisionFieldBinding(step);
      const type = binding.type;
      const valueCompatible = (value: unknown) => type === 'boolean' ? typeof value === 'boolean' : ['integer', 'decimal'].includes(type) ? typeof value === 'number' : type === 'string' ? typeof value === 'string' : false;
      if ((step.alternatives as Json[]).some(alternative => !valueCompatible(alternative.value))) throw new IntentCompilationError(`Os valores das alternativas não são compatíveis com o tipo do campo “${step.field}”.`);
      nodes.push({ id: meta.gatewayId, type: 'exclusiveGateway', name: step.name });
      for (const alternative of step.alternatives as Json[]) {
        const branchContinuation = alternative.returnTo ? resolveReturnTarget(alternative.returnTo, intent.steps, metadata) : continuation;
        const target = compileSequence(alternative.steps || [], branchContinuation);
        addFlow(meta.gatewayId!, target, alternative.label, { op: alternative.operator || 'eq', left: { var: binding.variable }, right: { literal: alternative.value } });
      }
      return meta.gatewayId!;
    }
    if (step.kind === 'integration') {
      const operation = catalog.connectors.find((item: Json) => item.connectorId === step.connectorId)?.operations.find((item: Json) => item.operationId === step.operationId)!;
      const inputs: Json = {};
      for (const mapping of step.inputs as Json[]) inputs[mapping.parameter] = { var: variableFor(mapping.field).variable };
      const outputs = Object.fromEntries((step.outputs as Json[]).map(output => [output.parameter, variableFor(output.name).variable]));
      const action: Json = { capability: operation.capability, connectorId: step.connectorId, operationId: step.operationId, inputMapping: inputs, outputMapping: outputs,
        timeoutMs: 10000, retryPolicy: { maxAttempts: 0, backoffMs: 0 }, sideEffectLevel: operation.sideEffectLevel };
      if (operation.sideEffectLevel !== 'read') {
        let instance = variables.find(variable => variable.source.kind === 'system' && variable.source.systemKey === 'processInstanceId');
        if (!instance) { instance = { key: ids.make('var', 'process instance id'), type: 'string', required: true, sensitive: false, scope: 'process', source: { kind: 'system', systemKey: 'processInstanceId' } }; variables.push(instance); }
        action.idempotencyKey = { var: instance.key }; action.approvalRequired = true;
      }
      nodes.push({ id: meta.id, type: 'serviceTask', name: step.name, action }); addFlow(meta.id, continuation); return meta.id;
    }
    throw new IntentCompilationError(`Tipo de etapa sem suporte: ${step.kind}.`);
  };
  const first = compileSequence(intent.steps, endId);
  addFlow(startId, first);
  const pending = options.pendingConfiguration || [];
  const relatedRoleNode = (scope?: string): string | undefined => {
    const roleName = scope?.startsWith('actor:') ? scope.slice('actor:'.length) : undefined;
    const role = roleName ? roleIndex.get(normalized(roleName)) : undefined;
    return role ? nodes.find(node => node.type === 'userTask' && node.roleId === role.id)?.id : undefined;
  };
  const spec = {
    schemaVersion: '1.0.0', id: ids.make('process', intent.name), name: intent.name, description: intent.purpose, locale: 'pt-BR', targetProfile: options.targetProfile, status: pending.some(item => item.blocking) ? 'needs-input' : 'draft',
    roles, variables, forms, nodes, flows,
    pendingQuestions: pending.slice(0, 100).map((item, index) => ({ id: `pq_${index + 1}`, question: item.question.slice(0, 255), blocking: item.blocking, ...(relatedRoleNode(item.scope) ? { relatedNodeId: relatedRoleNode(item.scope) } : {}) })),
    assumptions: options.assumptions || [], policies: { manualApprovalRequired: true, allowExecution: false },
    metadata: { knowledgeVersion: options.knowledgeVersion, modelId: options.model, revision: 0 },
  };
  return spec;
}
function roleNameSupported(name: string, sourceText: string): boolean {
  const stop = new Set(['de', 'da', 'do', 'e', 'para', 'por', 'the', 'of', 'and']);
  const terms = normalized(name).split(' ').filter(term => term.length >= 2 && !stop.has(term));
  const sourceTerms = normalized(sourceText).split(' ');
  return terms.some(term => sourceTerms.some(candidate => candidate === term || (Math.min(candidate.length, term.length) >= 5 && (candidate.startsWith(term) || term.startsWith(candidate)))));
}
function stepEvidenceMatchesName(name: string, evidence: string): boolean {
  const stop = new Set(['para', 'com', 'sobre', 'de', 'da', 'do', 'e', 'em', 'ao', 'a', 'o', 'the', 'with', 'for', 'of', 'and']);
  const words = (value: string) => normalized(value).split(' ').filter(token => token.length >= 4 && !stop.has(token));
  const stem = (token: string) => {
    for (const suffix of ['amentos', 'imentos', 'amento', 'imento', 'idades', 'idade', 'acoes', 'acao', 'antes', 'ando', 'endo', 'indo', 'ados', 'adas', 'idos', 'idas', 'aram', 'eram', 'iram', 'avam', 'iam', 'ude', 'ou', 'eu', 'iu', 'ava', 'ar', 'er', 'ir', 'as', 'es', 'os', 'a', 'e', 'o']) {
      if (token.endsWith(suffix) && token.length - suffix.length >= 5) return token.slice(0, -suffix.length);
    }
    return token;
  };
  const nameWords = words(name);
  const evidenceWords = words(evidence);
  return nameWords.some(a => evidenceWords.some(b => {
    const left = stem(a); const right = stem(b);
    return a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a))) || (Math.min(left.length, right.length) >= 5 && (left === right || left.startsWith(right) || right.startsWith(left)));
  }));
}
function containsDecision(activities: Json[]): boolean {
  return activities.some(activity => activity.kind === 'approval' || activity.kind === 'decision' ||
    containsDecision([...(activity.onApproved || []), ...(activity.onRejected || []), ...(activity.alternatives || []).flatMap((item: Json) => item.steps || [])]));
}
/** Checks explicit conditional consequences before IDs/graphs can hide a misplaced branch. */
function assertConditionalCoverage(activities: Json[], source: string): void {
  const evidenceByBranch = { approved: [] as string[], rejected: [] as string[] };
  let rejectionReasonRepresented = false;
  const evidence = (items: Json[]): string[] => items.flatMap(item => [item.evidence || '', ...evidence(item.onApproved || []), ...evidence(item.onRejected || []), ...(item.alternatives || []).flatMap((option: Json) => evidence(option.steps || []))]);
  const walk = (items: Json[]) => { for (const item of items) {
    if (item.kind === 'approval') {
      evidenceByBranch.approved.push(...evidence(item.onApproved || []));
      evidenceByBranch.rejected.push(...evidence(item.onRejected || []));
      if (item.requiresRejectionReason === true) rejectionReasonRepresented = true;
    }
    walk([...(item.onApproved || []), ...(item.onRejected || []), ...(item.alternatives || []).flatMap((option: Json) => option.steps || [])]);
  } };
  walk(activities);
  for (const clause of source.split(/[.!?;\n]/)) {
    const match = clause.trim().match(/^(?:se|quando|caso)\s+(?:for\s+)?(aprov\w*|reprov\w*|rejeit\w*)\s*,\s*(.+)$/i);
    if (!match || !/receb|inform|comunic|registr|encaminh|envi|notific|analis|verific|aprova/i.test(match[2])) continue;
    const side = /^aprov/i.test(match[1]) ? 'approved' : 'rejected';
    const represented = evidenceByBranch[side].some(quote => adequateQuote(source, quote) && (containsQuote(match[2], quote) || containsQuote(quote, match[2]))) || (side === 'rejected' && rejectionReasonRepresented && /motivo|justific|raz[aã]o/i.test(match[2]) && /obrigatori|mandatory/i.test(match[2]));
    if (!represented) { const question = `A consequência explícita do ramo ${side === 'approved' ? 'aprovado' : 'reprovado'} não foi preservada: “${match[2].trim()}”. Represente essa atividade no ramo correspondente.`; throw new IntentCompilationError(question, question, 'model-omission'); }
  }
}
function hasExplicitDecision(text: string): boolean {
  const choices = text.match(/\b(aprov(?:a|am|ar|ado|ada|ados|adas)|reprov(?:a|am|ar|ado|ada|ados|adas)|rejeit(?:a|am|ar|ado|ada|ados|adas)|approve[sd]?|reject(?:s|ed)?|accept(?:s|ed)?|decline[sd]?)\b/gi) || [];
  return choices.length >= 2;
}
export function initiatesRequest(name: string, sourceText: string): boolean {
  const role = normalized(name);
  const clause = sourceText.split(/[.!?;]/).map(normalized).find(candidate => candidate.includes(role));
  if (!role || !clause) return false;
  const actorIndex = clause.indexOf(role);
  const actionIndex = clause.search(/\b(faz|envia|inicia|submete|preenche|solicita|cria|submit|sends|initiates|makes)\b/);
  const requestTermIndex = clause.search(/\b(solicitacao|pedido|request|application)\b/);
  if (actionIndex >= 0 && requestTermIndex > actionIndex && actorIndex <= actionIndex && actionIndex - actorIndex < 50) return true;
  return new RegExp(`(?:solicitacao|pedido|request|application).{0,40}(?:por|pelo|pela|by|from).{0,25}${role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(clause);
}

async function capabilityCatalog(): Promise<{ connectors: Array<Json> }> {
  return readFoundationJson('contracts/mock-capability-catalog.json') as Promise<{ connectors: Array<Json> }>;
}

/** Apply a human-meaningful patch to one uniquely identified linear activity. */
export function applySemanticRefinement(currentSpec: Json, patch: Json, options: { sourceText?: string } = {}): Json {
  const next = structuredClone(currentSpec);
  for (const operation of patch.operations as Json[]) {
    if (operation.kind === 'renameProcess') { next.name = operation.name; continue; }
    if (operation.kind === 'renameActivity') {
      const matches = next.nodes.filter((node: Json) => normalized(node.name) === normalized(operation.activity));
      if (matches.length !== 1) throw new IntentCompilationError(`Qual atividade “${operation.activity}” deve ser renomeada?`);
      matches[0].name = operation.name; continue;
    }
    if (operation.kind === 'insertTaskAfter') {
      const matches = next.nodes.filter((node: Json) => normalized(node.name) === normalized(operation.afterActivity));
      if (matches.length !== 1) throw new IntentCompilationError(`Em qual atividade única “${operation.afterActivity}” devo inserir a etapa?`);
      const source = matches[0]; const outgoing = next.flows.filter((flow: Json) => flow.source === source.id);
      if (outgoing.length !== 1) throw new IntentCompilationError(`“${source.name}” tem mais de uma saída. Especifique o ramo onde inserir a tarefa.`);
      const target = next.nodes.find((node: Json) => node.id === outgoing[0].target);
      if (target?.type === 'exclusiveGateway' && next.flows.some((flow: Json) => flow.source === target.id && flow.condition)) throw new IntentCompilationError(`“${source.name}” leva a uma decisão ramificada. Esclareça qual ramo deve receber a nova tarefa.`);
      const actor = operation.task.actor;
      const role = refinementRole(next, actor, options.sourceText);
      const taskId = uniqueId(next.nodes.map((item: Json) => item.id), 'task', operation.task.name);
      pendingRefinementRole(next, role, taskId);
      const newNode: Json = { id: taskId, type: 'userTask', name: operation.task.name, roleId: role.id };
      const taskFields = operation.task.fields as FieldIntent[] || [];
      if (taskFields.length) {
        const formId = uniqueId(next.forms.map((item: Json) => item.id), 'form', operation.task.name); newNode.formId = formId;
        const fields: Json[] = [];
        for (const input of taskFields) {
          const type = fieldTypes[input.type];
          if (!type || (input.type === 'choice' && !input.choices?.length)) throw new IntentCompilationError(`Defina tipo e opções válidos para o campo “${input.name}”.`);
          const fieldKey = uniqueId(fields.map(item => item.key), 'field', input.name);
          const variableKey = uniqueId(next.variables.map((item: Json) => item.key), 'var', `${operation.task.name} ${input.name}`);
          fields.push({ key: fieldKey, label: input.name, type: type.form, required: input.required ?? false, bindTo: variableKey, ...(input.choices ? { options: input.choices } : {}) });
          next.variables.push({ key: variableKey, type: type.type, required: input.required ?? false, sensitive: false, scope: 'process', source: { kind: 'form', formId, fieldKey }, ...(input.choices ? { enumValues: input.choices.map((choice: Json) => choice.value) } : {}) });
        }
        next.forms.push({ id: formId, name: operation.task.name, usage: 'task', fields });
      }
      const splitFlow = outgoing[0]; splitFlow.source = taskId;
      next.flows.push({ id: uniqueId(next.flows.map((item: Json) => item.id), 'flow', `${source.id} ${taskId}`), source: source.id, target: taskId });
      next.nodes.push(newNode); continue;
    }
    if (operation.kind === 'insertApprovalBefore') {
      insertApprovalBefore(next, operation, options.sourceText);
      continue;
    }
    throw new IntentCompilationError('O tipo de refinamento solicitado não é suportado.');
  }
  return next;
}

function insertApprovalBefore(spec: Json, operation: Json, sourceText?: string): void {
  const targets = resolveActivityReference(spec, operation.beforeActivity);
  if (targets.length !== 1) throw new IntentCompilationError(`Qual atividade única recebe a segunda aprovação: “${operation.beforeActivity}”?`);
  const target = targets[0];
  const incoming = spec.flows.filter((flow: Json) => flow.target === target.id);
  if (incoming.length !== 1) throw new IntentCompilationError(`“${target.name}” tem múltiplas entradas. Especifique qual ramo receberá a aprovação.`);
  const rejectedTargets = resolveActivityReference(spec, operation.rejectedTargetActivity);
  if (rejectedTargets.length !== 1) throw new IntentCompilationError(`Qual atividade existente deve receber o fluxo quando “${operation.approval.name}” reprovar?`);
  const rejectedTarget = rejectedTargets[0];
  if (rejectedTarget.id === target.id) throw new IntentCompilationError('O caminho de reprovação não pode voltar para a atividade que exige aprovação. Especifique o destino da rejeição.');
  const actor = operation.approval.actor;
  const role = refinementRole(spec, actor, sourceText);
  const approvalName = operation.approval.name;
  const taskId = uniqueId(spec.nodes.map((item: Json) => item.id), 'task', approvalName);
  pendingRefinementRole(spec, role, taskId);
  const gatewayId = uniqueId([...spec.nodes.map((item: Json) => item.id), taskId], 'gateway', approvalName);
  const formId = uniqueId(spec.forms.map((item: Json) => item.id), 'form', approvalName);
  const decisionFieldKey = uniqueId(spec.forms.flatMap((form: Json) => form.fields.map((field: Json) => field.key)), 'field', `${approvalName} decision`);
  const decisionVariableKey = uniqueId(spec.variables.map((item: Json) => item.key), 'var', `${approvalName} decision`);
  const decisionField: Json = { key: decisionFieldKey, label: 'Decisão', type: 'select', required: true, bindTo: decisionVariableKey, options: [{ label: 'Aprovar', value: 'approved' }, { label: 'Rejeitar', value: 'rejected' }] };
  const formFields = [decisionField];
  spec.variables.push({ key: decisionVariableKey, type: 'string', required: true, sensitive: false, scope: 'process', source: { kind: 'form', formId, fieldKey: decisionFieldKey }, enumValues: ['approved', 'rejected'] });
  let newReasonVariableKey: string | undefined;
  if (operation.approval.requiresRejectionReason) {
    const reasonFieldKey = uniqueId(spec.forms.flatMap((form: Json) => form.fields.map((field: Json) => field.key)), 'field', `${approvalName} rejection reason`);
    const reasonVariableKey = uniqueId(spec.variables.map((item: Json) => item.key), 'var', `${approvalName} rejection reason`);
    newReasonVariableKey = reasonVariableKey;
    const rejection = { op: 'eq', left: { var: decisionVariableKey }, right: { literal: 'rejected' } };
    formFields.push({ key: reasonFieldKey, label: 'Motivo da rejeição', type: 'textarea', required: false, bindTo: reasonVariableKey, visibleWhen: rejection, requiredWhen: structuredClone(rejection) });
    spec.variables.push({ key: reasonVariableKey, type: 'string', required: false, sensitive: false, scope: 'process', source: { kind: 'form', formId, fieldKey: reasonFieldKey } });
  }
  spec.forms.push({ id: formId, name: approvalName, usage: 'task', fields: formFields });
  spec.nodes.push({ id: taskId, type: 'userTask', name: approvalName, roleId: role.id, formId }, { id: gatewayId, type: 'exclusiveGateway', name: approvalName });
  const replaced = incoming[0];
  replaced.target = taskId;
  const usedFlows = spec.flows.map((flow: Json) => flow.id);
  const addFlow = (source: string, targetId: string, condition?: Json) => spec.flows.push({ id: uniqueId(usedFlows.concat(spec.flows.map((flow: Json) => flow.id)), 'flow', `${source} ${targetId}`), source, target: targetId, ...(condition ? { condition } : {}) });
  addFlow(taskId, gatewayId);
  addFlow(gatewayId, target.id, { op: 'eq', left: { var: decisionVariableKey }, right: { literal: 'approved' } });
  let rejectedContinuation = rejectedTarget.id;
  if (newReasonVariableKey && rejectedTarget.type === 'serviceTask') {
    const oldReason = mappedReasonVariable(spec, rejectedTarget);
    if (oldReason) {
      const outgoing = spec.flows.filter((flow: Json) => flow.source === rejectedTarget.id);
      if (outgoing.length !== 1) throw new IntentCompilationError(`A notificação “${rejectedTarget.name}” tem saídas ambíguas para a nova justificativa. Esclareça o destino.`);
      const cloneId = uniqueId(spec.nodes.map((node: Json) => node.id), 'service', `${rejectedTarget.name} ${approvalName}`);
      const clone: Json = { ...structuredClone(rejectedTarget), id: cloneId, name: `${rejectedTarget.name} (${approvalName})` };
      clone.action = remapVariable(clone.action, oldReason, newReasonVariableKey);
      spec.nodes.push(clone);
      const priorOutgoing = outgoing[0];
      spec.flows.push({ ...structuredClone(priorOutgoing), id: uniqueId(spec.flows.map((flow: Json) => flow.id), 'flow', `${cloneId} ${priorOutgoing.target}`), source: cloneId });
      rejectedContinuation = cloneId;
    }
  }
  addFlow(gatewayId, rejectedContinuation, { op: 'eq', left: { var: decisionVariableKey }, right: { literal: 'rejected' } });
}

function resolveActivityReference(spec: Json, reference: string): Json[] {
  const key = normalized(reference);
  return spec.nodes.filter((node: Json) => node.id === reference || normalized(node.name) === key);
}

function refinementRole(spec: Json, actor: Json, sourceText?: string): Json {
  if (!actor?.name?.trim()) throw new IntentCompilationError('Qual papel fará a nova atividade?');
  const existing = spec.roles.find((item: Json) => normalized(item.label) === normalized(actor.name));
  if (existing) return existing;
  if (sourceText && !roleNameSupported(actor.name, sourceText)) throw new IntentCompilationError(`Qual papel confirmado fará a nova atividade? “${actor.name}” não aparece na solicitação.`);
  const supported = actor.resolution && (actor.resolution !== 'group' || actor.groupName) && (!sourceText || resolutionIsSupported(actor, sourceText));
  const resolution = supported ? actor.resolution : 'unresolved';
  const role = { id: uniqueId(spec.roles.map((item: Json) => item.id), 'role', actor.name), label: actor.name, resolution, ...(resolution === 'group' ? { groupKey: slug(actor.groupName) } : {}) };
  spec.roles.push(role);
  return role;
}

function pendingRefinementRole(spec: Json, role: Json, nodeId: string): void {
  if (role.resolution !== 'unresolved') return;
  spec.status = 'needs-input';
  spec.pendingQuestions.push({ id: uniqueId(spec.pendingQuestions.map((item: Json) => item.id), 'pq', role.label), question: `Como o runtime deve atribuir o papel “${role.label}”?`, blocking: true, relatedNodeId: nodeId });
}

function mappedReasonVariable(spec: Json, node: Json): string | undefined {
  const mapped = collectVars(node.action?.inputMapping);
  for (const key of mapped) {
    const variable = spec.variables.find((item: Json) => item.key === key);
    if (variable?.source?.kind !== 'form') continue;
    const field = spec.forms.find((form: Json) => form.id === variable.source.formId)?.fields.find((candidate: Json) => candidate.key === variable.source.fieldKey);
    if (field && /motivo|reason|justific|raz[aã]o/i.test(field.label)) return key;
  }
  return undefined;
}
function collectVars(value: any): string[] {
  if (!value || typeof value !== 'object') return [];
  if (typeof value.var === 'string') return [value.var];
  return Object.values(value).flatMap(collectVars);
}
function remapVariable(value: any, previous: string, next: string): any {
  if (!value || typeof value !== 'object') return value;
  if (value.var === previous) return { ...value, var: next };
  if (Array.isArray(value)) return value.map(item => remapVariable(item, previous, next));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapVariable(item, previous, next)]));
}

function uniqueId(existing: string[], prefix: string, name: string): string {
  const used = new Set(existing); const root = `${prefix}_${slug(name)}`.slice(0, 112); let value = root; let index = 2;
  while (used.has(value)) value = `${root.slice(0, 120 - String(index).length - 1)}_${index++}`;
  return value;
}
