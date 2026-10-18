import { createHash } from 'node:crypto';

export type GroundingStatus = 'equivalent' | 'divergent' | 'inconclusive';
export type GroundingFacet = 'action' | 'object' | 'actor' | 'context' | 'condition' | 'consequence' | 'negation' | 'dependency' | 'stage';
export type GroundingResult = { status: GroundingStatus; matched: GroundingFacet[]; divergent: GroundingFacet[]; reason: string };

const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]+/g, ' ').trim();
const stop = new Set('a o as os um uma de da do das dos e em no na nos nas ao aos para por com que se como qual quais quem quando onde deve devem sera ser foi pelo pela processo atividade etapa'.split(' '));
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);

/**
 * Controlled name-to-evidence grounding. Literal span verification remains a
 * separate mandatory check. This matcher only accepts a shared action lemma,
 * a shared object, compatible polarity, and a compatible explicitly named actor.
 * It deliberately has no synonym table and never treats token similarity alone
 * as proof.
 */
export function evaluateActivityGrounding(input: { name: string; evidence: string; expectedActor?: string; actualActor?: string; expectedContext?: string; actualContext?: string }): GroundingResult {
  const evidence = normalize(input.evidence);
  const name = normalize(input.name);
  const expectedActor = input.expectedActor ? normalize(input.expectedActor) : undefined;
  const actualActor = input.actualActor ? normalize(input.actualActor) : undefined;
  const actionEvidence = actionLemmas(evidence);
  const actionName = actionLemmas(name);
  const sharedAction = [...actionEvidence].find(item => actionName.has(item));
  const evidenceTokens = contentTokens(evidence);
  const nameTokens = contentTokens(name);
  const sharedObject = [...nameTokens].some(token => evidenceTokens.has(token));
  const matched: GroundingFacet[] = [];
  const divergent: GroundingFacet[] = [];

  if (sharedAction) matched.push('action');
  else if (actionEvidence.size && actionName.size) divergent.push('action');
  if (sharedObject) matched.push('object');
  else if (sharedAction && nameTokens.size && evidenceTokens.size) divergent.push('object');

  if (expectedActor && actualActor) {
    if (expectedActor !== actualActor) divergent.push('actor');
    else matched.push('actor');
  }
  const evidencePolarity = hasNegation(evidence);
  const namePolarity = hasNegation(name);
  if (evidencePolarity === namePolarity) matched.push('negation');
  else divergent.push('negation');

  if (input.expectedContext && input.actualContext) {
    if (normalize(input.expectedContext) === normalize(input.actualContext)) matched.push('context');
    else divergent.push('context');
  }
  if (divergent.length) return { status: 'divergent', matched, divergent, reason: 'Ação, objeto, papel, contexto ou polaridade da atividade diverge da evidência.' };
  if (!sharedAction || !sharedObject) return { status: 'inconclusive', matched, divergent, reason: 'A evidência literal existe, mas não fornece ação e objeto suficientes para provar a correspondência.' };
  return { status: 'equivalent', matched, divergent, reason: 'Ação e objeto correspondem; papel, contexto e polaridade explícitos são compatíveis.' };
}

function contentTokens(text: string): Set<string> {
  return new Set(normalize(text).split(' ').filter(token => token.length > 2 && !stop.has(token)));
}

function hasNegation(text: string): boolean {
  return /\b(?:nao|nunca|sem|not|never|without)\b/.test(normalize(text));
}

function actionLemmas(text: string): Set<string> {
  const lemmas = new Set<string>();
  const nominalObjects = new Set(['solicitacao', 'processo', 'atividade', 'etapa', 'documento', 'pedido', 'usuario', 'formulario', 'valor', 'campo', 'aprovador']);
  for (const token of normalize(text).split(' ')) {
    if (token.length < 5 || nominalObjects.has(token)) continue;
    // Treat the explicit correction noun and its verb as the same action.
    // This is intentionally narrow; generic token similarity is not proof.
    if (token === 'correcao' || token === 'correcoes' || token === 'corrige' || token === 'corrigem' || token === 'corrigiu' || token === 'corrigindo') {
      lemmas.add('corrigir');
      continue;
    }
    const lemma = portugueseActionLemma(token);
    if (lemma) lemmas.add(lemma);
  }
  return lemmas;
}

/** Normalize common inflection/nominalization forms without merging distinct actions. */
function portugueseActionLemma(token: string): string | undefined {
  const suffixes: Array<[RegExp, string]> = [
    [/^(.*)acoes$/, '$1ar'], [/^(.*)icoes$/, '$1ir'], [/^(.*)ucoes$/, '$1uir'],
    [/^(.*)acao$/, '$1ar'], [/^(.*)icao$/, '$1ir'], [/^(.*)ucao$/, '$1uir'],
    [/^(.*)amentos$/, '$1ar'], [/^(.*)imentos$/, '$1ir'], [/^(.*)amento$/, '$1ar'], [/^(.*)imento$/, '$1ir'],
    [/^(.*)ando$/, '$1ar'], [/^(.*)endo$/, '$1er'], [/^(.*)indo$/, '$1ir'],
    [/^(.*)aram$/, '$1ar'], [/^(.*)eram$/, '$1er'], [/^(.*)iram$/, '$1ir'],
    [/^(.*)avam$/, '$1ar'], [/^(.*)iam$/, '$1ir'], [/^(.*)am$/, '$1ar'], [/^(.*)em$/, '$1er'],
    [/^(.*)ou$/, '$1ar'], [/^(.*)eu$/, '$1er'], [/^(.*)iu$/, '$1ir'], [/^(.*)a$/, '$1ar'], [/^(.*)e$/, '$1er'],
  ];
  for (const [pattern, replacement] of suffixes) {
    const match = token.match(pattern);
    if (match && match[1].length >= 4) return token.replace(pattern, replacement);
  }
  if (/^[a-z]{5,}(?:ar|er|ir)$/.test(token)) return token;
  return undefined;
}

export type SemanticQuestion = { questionId: string; requirementId: string; semanticSlot: string; status: 'pending' | 'answered' };
export type SemanticFactState = 'new' | 'confirmed' | 'superseded' | 'contradictory' | 'pending' | 'removed';
export type SemanticFact = {
  id: string;
  type: string;
  entity: string;
  attribute: string;
  context: string;
  stage?: string;
  value: string;
  source: { sourceId: string; start?: number; end?: number; evidenceSha256?: string };
  requirementId?: string;
  state: SemanticFactState;
  dependsOn: string[];
  relations: Array<{ type: 'supports' | 'contradicts' | 'supersedes' | 'removes'; factId: string }>;
};

/** Compare structured claims exactly. No token/synonym fallback is permitted for these facets. */
export function evaluateStructuredSemanticCorrespondence(expected: SemanticFact, actual: SemanticFact): GroundingResult {
  const matched: GroundingFacet[] = [];
  const divergent: GroundingFacet[] = [];
  const compare = (facet: GroundingFacet, left: string, right: string) => {
    if (!left || !right) return;
    if (normalize(left) === normalize(right)) matched.push(facet); else divergent.push(facet);
  };
  if (normalize(expected.type) !== normalize(actual.type)) divergent.push('action');
  compare('action', expected.attribute, actual.attribute);
  compare('object', expected.entity, actual.entity);
  compare('context', expected.context, actual.context);
  compare('condition', expected.value, actual.value);
  if (expected.stage || actual.stage) compare('stage', expected.stage || '', actual.stage || '');
  const expectedDependencies = [...expected.dependsOn].sort().join('|');
  const actualDependencies = [...actual.dependsOn].sort().join('|');
  if (expectedDependencies || actualDependencies) compare('dependency', expectedDependencies, actualDependencies);
  const relationSignature = (fact: SemanticFact) => fact.relations.map(item => `${item.type}:${item.factId}`).sort().join('|');
  const expectedRelations = relationSignature(expected);
  const actualRelations = relationSignature(actual);
  if (expectedRelations || actualRelations) compare('consequence', expectedRelations, actualRelations);
  if (expected.type === 'actor-assignment' || actual.type === 'actor-assignment') compare('actor', expected.value, actual.value);
  if (divergent.length) return { status: 'divergent', matched, divergent: [...new Set(divergent)], reason: 'Os campos estruturados da relação divergem.' };
  const required = [expected.type, expected.entity, expected.attribute, expected.context, expected.value];
  if (required.some(value => !value)) return { status: 'inconclusive', matched, divergent, reason: 'A relação estruturada não contém todos os slots necessários para comparação.' };
  return { status: 'equivalent', matched: [...new Set(matched)], divergent, reason: 'Tipo e slots estruturados correspondem exatamente.' };
}

const questionKinds: Array<[string, RegExp]> = [
  ['actor-assignment', /\b(?:quem|papel|responsavel|responsabilidade|atribui|atribuicao|executa|aprovador)\b/],
  ['activity-existence', /\b(?:atividade|etapa|tarefa|fluxo)\b/],
  ['field-requirement', /\b(?:campo|informacao|preencher|coletar|formulario)\b/],
  ['condition-value', /\b(?:condicao|limite|valor|maior|menor|acima|abaixo|igual|threshold)\b/],
  ['consequence-target', /\b(?:destino|retornar|retorna|voltar|encaminhar|encaminha|ramo)\b/],
  ['integration-capability', /\b(?:integracao|api|endpoint|conector|sistema externo)\b/],
];
const questionContextStop = new Set([...stop, 'qual', 'quais', 'quem', 'como', 'quando', 'onde', 'deve', 'devem', 'pode', 'podem', 'ser', 'sera', 'serao', 'fazer', 'feito', 'necessario', 'preciso', 'informar', 'confirmar', 'esclarecer', 'papel', 'responsavel', 'atribuir', 'atribui', 'atribuida', 'atribuido', 'atribuicao', 'executa', 'executar', 'execucao', 'atividade', 'etapa', 'tarefa', 'campo', 'informacao', 'limite', 'valor', 'condicao', 'destino', 'fluxo', 'ramo', 'integracao', 'aprovacao', 'aprovador', 'solicitado', 'sua']);

/** Stable slot identity uses a typed semantic category plus its contextual entities. */
export function semanticSlotForQuestion(question: string): string {
  const value = normalize(question);
  const kind = questionKinds.find(([, expression]) => expression.test(value))?.[0] || 'unclassified';
  const entities = value.split(' ').filter(token => token.length > 2 && !questionContextStop.has(token)).map(token => token.replace(/(primeir|segund|terceir)[oa]?$/, '$1')).sort();
  const context = entities.length ? [...new Set(entities)].join('_') : value.replace(/\s+/g, '_');
  return `slot:${kind}:${context.slice(0, 100)}`;
}

export function identityForQuestion(question: string, requirementId?: string): SemanticQuestion {
  const semanticSlot = semanticSlotForQuestion(question);
  const stableRequirementId = requirementId || `req_${hash(semanticSlot)}`;
  return { questionId: `q_${hash(semanticSlot)}`, requirementId: stableRequirementId, semanticSlot, status: 'pending' };
}

export function semanticFactId(semanticSlot: string): string { return `fact_${hash(semanticSlot)}`; }
export function evidenceOccurrenceId(sourceId: string, start: number, end: number, quote: string): string { return `evidence_${hash(`${sourceId}\0${start}\0${end}\0${quote}`)}`; }

/** Keep only the latest event per semantic fact identity for effective context. */
export function latestSemanticFactEvents<T extends { semanticFactId?: string; semanticFact?: SemanticFact }>(events: T[]): T[] {
  const latest = new Map<string, number>();
  events.forEach((event, index) => {
    const id = event.semanticFactId || event.semanticFact?.id;
    if (id) latest.set(id, index);
  });
  return events.filter((event, index) => {
    const id = event.semanticFactId || event.semanticFact?.id;
    return !id || latest.get(id) === index;
  });
}

export function reconcileSemanticFacts(previous: SemanticFact[], incoming: SemanticFact[], explicitCorrection = false): SemanticFact[] {
  const result = previous.map(fact => ({ ...fact, dependsOn: [...fact.dependsOn], relations: [...fact.relations] }));
  for (const next of incoming) {
    const existing = result.filter(fact => fact.state === 'confirmed' && semanticFactSlot(fact) === semanticFactSlot(next));
    if (!existing.length) { result.push({ ...next, state: next.state === 'pending' ? 'pending' : 'new' }); continue; }
    const supporting = existing.find(fact => fact.value === next.value);
    if (supporting && !explicitCorrection) {
      result.push({ ...next, state: 'confirmed', relations: [...next.relations, { type: 'supports', factId: supporting.id }] });
    } else if (explicitCorrection) {
      for (const prior of existing) { prior.state = 'superseded'; prior.relations.push({ type: 'supersedes', factId: next.id }); }
      result.push({ ...next, state: 'confirmed', relations: [...next.relations, ...existing.map(prior => ({ type: 'supersedes' as const, factId: prior.id }))] });
    } else {
      for (const prior of existing) { prior.state = 'contradictory'; prior.relations.push({ type: 'contradicts', factId: next.id }); }
      result.push({ ...next, state: 'contradictory', relations: [...next.relations, ...existing.map(prior => ({ type: 'contradicts' as const, factId: prior.id }))] });
    }
  }
  return result;
}

export function removeSemanticFact(facts: SemanticFact[], requirementId: string, sourceId: string): SemanticFact[] {
  return facts.map(fact => fact.requirementId === requirementId && fact.state === 'confirmed'
    ? { ...fact, state: 'removed', relations: [...fact.relations, { type: 'removes' as const, factId: sourceId }] }
    : { ...fact, relations: [...fact.relations] });
}

function semanticFactSlot(fact: SemanticFact): string { return `${normalize(fact.type)}:${normalize(fact.entity)}:${normalize(fact.attribute)}:${normalize(fact.context)}:${normalize(fact.stage || '')}`; }

export function explicitNumericCorrection(text: string): { value: number; target: string; qualifiedTarget: boolean } | undefined {
  const normalized = normalize(text);
  if (!/\b(?:altere|alterar|mude|mudar|atualize|atualizar|substitua|substituir|corrija|corrigir|change|update|replace)\b/.test(normalized)) return undefined;
  if (!/\b(?:limite|valor|montante|quantia|threshold|amount)\b/.test(normalized)) return undefined;
  const match = text.match(/(?:\bpara\b|\bto\b|=|->)\s*(?:R\$\s*)?([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/i);
  if (!match) return undefined;
  const value = Number(match[1].replace(/\./g, '').replace(',', '.'));
  const targetText = normalized.match(/\b(?:limite|valor|montante|quantia|threshold|amount)\b(.*?)\b(?:para|to)\b/)?.[1] || '';
  const qualifier = targetText.replace(/\b(?:de|do|da|dos|das|the|of|for|a|o|as|os)\b/g, ' ').replace(/[0-9.,]+/g, ' ').trim();
  return Number.isFinite(value) ? { value, target: 'numeric-threshold', qualifiedTarget: Boolean(qualifier) } : undefined;
}

export function makeSemanticFact(input: Omit<SemanticFact, 'id' | 'state' | 'dependsOn' | 'relations'> & { id?: string; state?: SemanticFactState; dependsOn?: string[]; relations?: SemanticFact['relations'] }): SemanticFact {
  const slot = `${normalize(input.type)}:${normalize(input.entity)}:${normalize(input.attribute)}:${normalize(input.context)}:${normalize(input.stage || '')}`;
  return { ...input, id: input.id || `factv_${hash(`${slot}\0${input.value}\0${input.source.sourceId}`)}`, requirementId: input.requirementId || `req_${hash(slot)}`, state: input.state || 'new', dependsOn: input.dependsOn || [], relations: input.relations || [] };
}

/** Extract only explicit numeric threshold statements; this is a narrow, conservative reconciliation aid. */
export function extractNumericThresholdFacts(messages: Array<{ sourceId: string; text: string }>): SemanticFact[] {
  const facts: SemanticFact[] = [];
  const pattern = /\b(acima de|maior que|superiores? a|greater than|over)\s+(?:R\$\s*)?([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/gi;
  for (const message of messages) for (const match of message.text.matchAll(pattern)) {
    const value = Number(match[2].replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(value)) continue;
    const operator = /maior que|greater than|acima de|superior a|over/i.test(match[1]) ? 'gt' : 'gt';
    const start = match.index || 0;
    facts.push(makeSemanticFact({ type: 'condition', entity: 'process', attribute: 'numeric-threshold', context: 'business-rule', value: `${operator}:${value}`, source: { sourceId: message.sourceId, start, end: start + match[0].length, evidenceSha256: createHash('sha256').update(match[0]).digest('hex') }, state: 'confirmed' }));
  }
  return facts;
}

export function reconcileExplicitNumericCorrection(previous: SemanticFact[], text: string, sourceId: string): { facts: SemanticFact[]; status: 'reconciled' | 'ambiguous' | 'unchanged'; directive?: string } {
  const correction = explicitNumericCorrection(text);
  if (!correction) return { facts: previous, status: 'unchanged' };
  const active = previous.filter(fact => fact.attribute === 'numeric-threshold' && fact.state === 'confirmed');
  if (correction.qualifiedTarget || active.length !== 1) return { facts: previous, status: 'ambiguous' };
  const prior = active[0];
  const operator = prior.value.split(':')[0] || 'gt';
  if (`${operator}:${correction.value}` === prior.value) return { facts: previous, status: 'unchanged' };
  const start = text.search(/[0-9]/);
  const value = makeSemanticFact({ type: prior.type, entity: prior.entity, attribute: prior.attribute, context: prior.context, value: `${operator}:${correction.value}`, source: { sourceId, start: Math.max(start, 0), end: text.length, evidenceSha256: createHash('sha256').update(text).digest('hex') }, requirementId: prior.requirementId, state: 'confirmed' });
  const facts = reconcileSemanticFacts(previous, [value], true);
  return { facts, status: 'reconciled', directive: `Correção explícita no slot ${prior.requirementId}: ${prior.value} foi substituído por ${value.value}. Use somente o valor atual; preserve a ocorrência anterior como histórico supersedido.` };
}
