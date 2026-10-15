import { createHash } from 'node:crypto';
import { evaluateActivityGrounding } from './semantic-grounding.js';

export const REQUIREMENT_LEDGER_VERSION = '1.0.0' as const;
export type RequirementType = 'actor' | 'activity' | 'field' | 'decision' | 'condition' | 'consequence' | 'loop' | 'business-rule' | 'integration';
export type RequirementState = 'user-stated' | 'confirmed-answer' | 'unconfirmed-inference' | 'technical-configuration-pending' | 'explicitly-denied';
export type RequirementEvidence = { messageId: string; start: number; end: number; quote: string; source: 'user' | 'confirmed-answer' | 'inference' | 'catalog' | 'knowledge' };
export type RequirementStructure =
  | { kind: 'condition'; modelRef: { kind: 'flow'; id: string }; variable: string; operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; value: string | number | boolean | null; valueType: string; gatewayId: string; targetNodeId: string }
  | { kind: 'consequence'; modelRef: { kind: 'flow'; id: string }; gatewayId: string; target: { kind: 'end'; id: string } | { kind: 'node'; id: string } }
  | { kind: 'loop'; modelRef: { kind: 'flow'; id: string }; sourceNodeId: string; targetNodeId: string; actorRoleId?: string }
  | { kind: 'node-role'; modelRef: { kind: 'node'; id: string }; roleId: string }
  | { kind: 'required-field'; modelRef: { kind: 'field'; id: string }; formId: string; fieldKey: string; required: boolean; requiredWhen?: { variable: string; operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; value: string | number | boolean | null } };
export type Requirement = {
  id: string; type: RequirementType; meaning: string; originalText: string; evidence?: RequirementEvidence;
  relatedEntity?: string; dependsOn: string[]; state: RequirementState; mandatory: boolean;
  structure?: RequirementStructure;
  relations: Array<{ type: 'depends-on' | 'alternative-to' | 'consequence-of' | 'returns-to' | 'assigned-to'; targetId: string }>;
};
export type RequirementLedgerV1 = { schemaVersion: typeof REQUIREMENT_LEDGER_VERSION; extraction: { complete: boolean; method: string; diagnostics: string[] }; requirements: Requirement[] };
export type CoverageElement = { id: string; type: RequirementType; meaning: string; actor?: string; evidence?: string; evidenceSource?: string; modelRef?: { kind: 'flow' | 'node' | 'field'; id: string }; attributes?: Record<string, unknown> };
export type CoverageLink = { requirementId: string; elementId: string; basis: 'literal-grounding' | 'structural-equivalence'; verified: boolean; details: string };
export type CoverageFinding = { requirementId?: string; elementId?: string; status: 'covered' | 'omitted' | 'partial' | 'ambiguous' | 'unsupported' | 'invalid-evidence' | 'divergent-condition' | 'wrong-consequence-branch' | 'wrong-loop-target' | 'wrong-role' | 'unsupported-element'; details: string };
export type CoverageReport = { schemaVersion: '1.0.0'; extractionComplete: boolean; totals: { proven: number; missing: number; partial: number; inconclusive: number; invalidEvidence: number; divergences: number }; findings: CoverageFinding[]; links: CoverageLink[] };

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const norm = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]+/g, ' ').trim();

/** Build conservative sentence-level candidates. It never claims extraction completeness. */
export function extractRequirementLedger(input: { messages: Array<{ id: string; text: string; source?: 'user' | 'confirmed-answer' }>; confirmedAnswers?: Array<{ messageId: string; text: string }> }): RequirementLedgerV1 {
  const requirements: Requirement[] = [];
  const ingest = (messageId: string, text: string, source: 'user' | 'confirmed-answer') => {
    const pattern = /[^.!?\n]+(?:[.!?]+|$)/g;
    for (const match of text.matchAll(pattern)) {
      const raw = match[0]; const leading = raw.search(/\S/); if (leading < 0) continue;
      const quote = raw.trim(); if (!quote) continue;
      const start = match.index! + leading; const end = start + quote.length;
      const type = classifyRequirement(quote); if (!type) continue;
      const explicitlyDenied = /\b(?:n[aã]o|nunca|sem)\b/i.test(quote) && !/\bn[aã]o\s+s[oó]\b/i.test(quote);
      const id = `req_${sha(`${messageId}\0${type}\0${start}`).slice(0, 20)}`;
      requirements.push({ id, type, meaning: quote, originalText: quote, evidence: { messageId, start, end, quote, source }, relatedEntity: undefined, dependsOn: [], state: explicitlyDenied ? 'explicitly-denied' : source === 'user' ? 'user-stated' : 'confirmed-answer', mandatory: !explicitlyDenied && !/\b(?:talvez|opcional|se possivel)\b/i.test(quote), relations: [] });
    }
  };
  for (const message of input.messages) ingest(message.id, message.text, message.source || 'user');
  for (const answer of input.confirmedAnswers || []) ingest(answer.messageId, answer.text, 'confirmed-answer');
  return { schemaVersion: REQUIREMENT_LEDGER_VERSION, extraction: { complete: false, method: 'sentence-candidates-v1', diagnostics: ['Heurística conservadora: pode omitir requisitos implícitos, compostos, negações complexas ou fora dos padrões reconhecidos; nenhuma cobertura total é declarada.'] }, requirements };
}

function classifyRequirement(text: string): RequirementType | undefined {
  if (/\b(?:api|http|endpoint|integrac|banco de dados|database|sistema externo|conector)\w*/i.test(text)) return 'integration';
  if (/\b(?:volta|retorna|corrigir|corrija|reenviar|reenvia|novamente)\w*/i.test(text)) return 'loop';
  if (/\b(?:se|caso|quando|acima|abaixo|maior que|menor que|igual a|até)\b/i.test(text) && /\b(?:aprova|reprova|rejeit|encaminh|registra|notifica|valor|limite|motivo)\w*/i.test(text)) return 'condition';
  if (/\b(?:aprova|reprova|rejeit|decide|decisão|alternativa|ramo)\w*/i.test(text)) return 'decision';
  if (/\b(?:motivo|consequência|notifica|encerra|registra|encaminha)\w*/i.test(text)) return 'consequence';
  if (/\b(?:obrigat[oó]ri|regra|limite|no m[aá]ximo|pelo menos|somente)\w*/i.test(text)) return 'business-rule';
  if (/\b(?:campo|informando|preencher|formulário|data|valor|nome|e-mail)\w*/i.test(text)) return 'field';
  if (/\b(?:solicitante|gestor|diretor|financeiro|rh|respons[aá]vel|usu[aá]rio|papel|equipe)\w*/i.test(text)) return 'actor';
  if (/\b(?:solicita|envia|analisa|avalia|registra|aprova|reprova|rejeita|revisa|preenche|executa|realiza|confere)\w*/i.test(text)) return 'activity';
  return undefined;
}

/** A span must be backed by the supplied message itself; model-provided quotes are not trusted. */
export function verifyRequirementEvidence(requirement: Requirement, messages: Array<{ id: string; text: string }>): boolean {
  const evidence = requirement.evidence; if (!evidence || !Number.isInteger(evidence.start) || !Number.isInteger(evidence.end) || evidence.start < 0 || evidence.end <= evidence.start) return false;
  const message = messages.find(item => item.id === evidence.messageId); if (!message || evidence.end > message.text.length) return false;
  return message.text.slice(evidence.start, evidence.end) === evidence.quote && norm(evidence.quote) === norm(requirement.originalText);
}

/** Propose links only when a produced element carries a literal span from that exact requirement. */
export function proposeLiteralCoverageLinks(ledger: RequirementLedgerV1, elements: CoverageElement[], semanticGroundingMode: 'legacy' | 'controlled' = 'legacy'): CoverageLink[] {
  const links: CoverageLink[] = [];
  for (const requirement of ledger.requirements) {
    if (requirement.structure) {
      const expectedRef = requirement.structure.modelRef;
      const matches = elements.filter(element => element.type === requirement.type && element.modelRef?.kind === expectedRef.kind && element.modelRef.id === expectedRef.id);
      if (matches.length === 1) links.push({ requirementId: requirement.id, elementId: matches[0].id, basis: 'structural-equivalence', verified: true, details: 'Candidate link from explicit model reference; relational checks remain authoritative.' });
      continue;
    }
    const evidence = requirement.evidence?.quote;
    if (!evidence) continue;
    const matches = elements.filter(element => element.evidence && norm(element.evidence) === norm(evidence));
    const literalMeaningMatches = matches.length === 1 && norm(matches[0].meaning) === norm(requirement.meaning);
    if (literalMeaningMatches || (matches.length === 1 && !(semanticGroundingMode === 'controlled' && requirement.type === 'activity'))) {
      links.push({ requirementId: requirement.id, elementId: matches[0].id, basis: 'literal-grounding', verified: true, details: 'Candidate link from a unique literal evidence span; Gate still verifies structure and meaning.' });
      continue;
    }
    if (semanticGroundingMode === 'controlled' && requirement.type === 'activity') {
      const equivalent = elements.filter(element => element.type === 'activity' && activityGrounding(element, evidence, elements).status === 'equivalent');
      if (equivalent.length === 1) links.push({ requirementId: requirement.id, elementId: equivalent[0].id, basis: 'structural-equivalence', verified: true, details: 'Ação, objeto, polaridade e papel explícito foram comparados pelo grounding controlado; proveniência literal permanece validada pelo Gate.' });
    }
  }
  return links;
}

type Json = Record<string, any>;

/** Build an independent inventory of ProcessSpec elements and their stable model references. */
export function processSpecCoverageElements(spec: Json): CoverageElement[] {
  const elements: CoverageElement[] = [];
  const nodes = new Map<string, Json>((spec.nodes || []).map((node: Json) => [node.id, node]));
  const roles = new Map<string, Json>((spec.roles || []).map((role: Json) => [role.id, role]));
  for (const node of spec.nodes || []) {
    if (['userTask', 'serviceTask', 'manualTask', 'businessRuleTask', 'sendTask', 'receiveTask'].includes(node.type)) {
      elements.push({ id: `activity:${node.id}`, type: 'activity', meaning: node.name, modelRef: { kind: 'node', id: node.id } });
    }
    if (node.type === 'userTask' && node.roleId) {
      const role = roles.get(node.roleId);
      elements.push({ id: `actor-assignment:${node.id}`, type: 'actor', meaning: role?.label || node.roleId, actor: role?.label || node.roleId, modelRef: { kind: 'node', id: node.id } });
    }
  }
  for (const flow of spec.flows || []) {
    const source = nodes.get(flow.source);
    if (flow.condition) elements.push({ id: `condition:${flow.id}`, type: 'condition', meaning: flow.label || flow.id, modelRef: { kind: 'flow', id: flow.id } });
    if (source?.type === 'exclusiveGateway') elements.push({ id: `consequence:${flow.id}`, type: 'consequence', meaning: flow.label || flow.id, modelRef: { kind: 'flow', id: flow.id } });
    // Every actual sequence flow can be checked as a proposed return edge; the ledger fixes endpoints.
    elements.push({ id: `loop:${flow.id}`, type: 'loop', meaning: flow.label || flow.id, modelRef: { kind: 'flow', id: flow.id } });
  }
  for (const form of spec.forms || []) for (const field of form.fields || []) {
    elements.push({ id: `field:${form.id}:${field.key}`, type: 'field', meaning: field.label, modelRef: { kind: 'field', id: `${form.id}/${field.key}` } });
  }
  return elements;
}

/** Explicit links are verified only by source-span integrity and type-safe structural correspondence. */
export function evaluateRequirementCoverage(input: { ledger: RequirementLedgerV1; elements: CoverageElement[]; links?: CoverageLink[]; messages: Array<{ id: string; text: string }>; processSpec?: Json; processSpecValid?: boolean }): CoverageReport {
  const findings: CoverageFinding[] = []; const links: CoverageLink[] = [];
  const validElements = new Map(input.elements.map(element => [element.id, element]));
  const linkedReqs = new Set<string>(); const linkedElements = new Set<string>(); const assessedReqs = new Set<string>();
  for (const link of input.links || []) {
    const requirement = input.ledger.requirements.find(item => item.id === link.requirementId); const element = validElements.get(link.elementId);
    if (!requirement || !element || !verifyRequirementEvidence(requirement, input.messages)) { findings.push({ requirementId: link.requirementId, elementId: link.elementId, status: 'invalid-evidence', details: 'Vínculo aponta para requisito/elemento inexistente ou evidência cujo intervalo não confere com a mensagem.' }); continue; }
    assessedReqs.add(requirement.id);
    if (requirement.type !== element.type) { findings.push({ requirementId: requirement.id, elementId: element.id, status: 'unsupported', details: `Tipo incompatível: requisito ${requirement.type}, elemento ${element.type}.` }); continue; }
    if (requirement.structure) {
      if (!structureTypeMatches(requirement.type, requirement.structure.kind)) { findings.push({ requirementId: requirement.id, elementId: element.id, status: 'unsupported', details: 'O tipo do requisito não aceita a relação estrutural informada.' }); continue; }
      const relational = verifyStructuralRequirement(requirement, element, input.processSpec, input.processSpecValid);
      if (relational.status) { findings.push({ requirementId: requirement.id, elementId: element.id, status: relational.status, details: relational.details }); continue; }
      const verified = link.verified && link.basis === 'structural-equivalence';
      links.push({ ...link, verified, details: relational.details });
      if (verified) { linkedReqs.add(requirement.id); linkedElements.add(element.id); }
      findings.push({ requirementId: requirement.id, elementId: element.id, status: verified ? 'covered' : 'partial', details: relational.details });
      continue;
    }
    if (requirement.type === 'actor' && element.actor && norm(requirement.meaning) !== norm(element.actor) && !norm(requirement.meaning).includes(norm(element.actor))) { findings.push({ requirementId: requirement.id, elementId: element.id, status: 'wrong-role', details: 'Papel do elemento diverge do papel requerido.' }); continue; }
    const meaningMatches = norm(requirement.meaning) === norm(element.meaning) || (link.basis === 'structural-equivalence' && requirement.type === 'activity' && activityGrounding(element, requirement.evidence!.quote, input.elements).status === 'equivalent');
    const next = { ...link, verified: link.verified && meaningMatches && (link.basis === 'literal-grounding' || link.basis === 'structural-equivalence'), details: link.details };
    links.push(next);
    if (next.verified) { linkedReqs.add(requirement.id); linkedElements.add(element.id); }
    findings.push({ requirementId: requirement.id, elementId: element.id, status: next.verified ? 'covered' : 'partial', details: next.verified ? 'Evidência de intervalo válida e significado normalizado igual, com tipo estrutural compatível.' : 'Citação literal e tipo compatível não comprovam equivalência funcional; significado ou prova estrutural diverge.' });
  }
  for (const requirement of input.ledger.requirements) {
    if (!verifyRequirementEvidence(requirement, input.messages)) { findings.push({ requirementId: requirement.id, status: 'invalid-evidence', details: 'A evidência não corresponde exatamente ao intervalo da mensagem de origem.' }); continue; }
    if (!linkedReqs.has(requirement.id) && !assessedReqs.has(requirement.id)) findings.push({ requirementId: requirement.id, status: requirement.state === 'explicitly-denied' ? 'unsupported' : input.ledger.extraction.complete ? 'omitted' : 'unsupported', details: requirement.state === 'explicitly-denied' ? 'O requisito está explicitamente negado e não deve ser compilado como obrigação.' : input.ledger.extraction.complete ? 'Nenhum elemento vinculado.' : 'Sem vínculo verificável; extração incompleta impede concluir omissão.' });
  }
  for (const element of input.elements) if (!linkedElements.has(element.id)) findings.push({ elementId: element.id, status: 'unsupported-element', details: 'Elemento produzido sem vínculo verificável a requisito explícito.' });
  const requirementIds = new Set(input.ledger.requirements.filter(item => item.state !== 'explicitly-denied').map(item => item.id));
  const idsWith = (statuses: CoverageFinding['status'][]) => new Set(findings.filter(item => item.requirementId && requirementIds.has(item.requirementId) && statuses.includes(item.status)).map(item => item.requirementId));
  const invalidIds = idsWith(['invalid-evidence']);
  const divergenceIds = idsWith(['divergent-condition', 'wrong-consequence-branch', 'wrong-loop-target', 'wrong-role']);
  const partialIds = idsWith(['partial']);
  const provenIds = idsWith(['covered']);
  const missingIds = idsWith(['omitted']);
  const inconclusiveIds = idsWith(['ambiguous', 'unsupported']);
  // Each obligation belongs to one aggregate bucket. Higher-confidence failure
  // and divergence findings take precedence over partial/proven associations.
  const invalidEvidence = invalidIds.size;
  for (const id of invalidIds) { divergenceIds.delete(id); partialIds.delete(id); provenIds.delete(id); missingIds.delete(id); inconclusiveIds.delete(id); }
  const divergences = divergenceIds.size;
  for (const id of divergenceIds) { partialIds.delete(id); provenIds.delete(id); missingIds.delete(id); inconclusiveIds.delete(id); }
  const partial = partialIds.size;
  for (const id of partialIds) { provenIds.delete(id); missingIds.delete(id); inconclusiveIds.delete(id); }
  const proven = provenIds.size;
  for (const id of provenIds) { missingIds.delete(id); inconclusiveIds.delete(id); }
  const missing = missingIds.size;
  for (const id of missingIds) inconclusiveIds.delete(id);
  const inconclusive = inconclusiveIds.size;
  return { schemaVersion: '1.0.0', extractionComplete: input.ledger.extraction.complete, totals: { proven, missing, partial, inconclusive, invalidEvidence, divergences }, findings, links };
}

/** Compare an assigned activity role with roles explicitly present in the source sentence. */
function activityGrounding(element: CoverageElement, evidence: string, elements: CoverageElement[]) {
  const namedActors = [...new Set(elements
    .filter(candidate => candidate.type === 'actor')
    .map(candidate => candidate.meaning.trim())
    .filter(actor => actor.length > 0 && norm(evidence).includes(norm(actor))))];
  if (namedActors.length > 1) return { status: 'inconclusive' as const, matched: [], divergent: [], reason: 'Mais de um papel aparece na evidência; a atribuição não é inequívoca.' };
  return evaluateActivityGrounding({
    name: element.meaning,
    evidence,
    ...(namedActors.length === 1 && element.actor ? { expectedActor: namedActors[0], actualActor: element.actor } : {}),
  });
}

function verifyStructuralRequirement(requirement: Requirement, element: CoverageElement, spec: Json | undefined, processSpecValid?: boolean): { status?: CoverageFinding['status']; details: string } {
  const expected = requirement.structure!;
  if (element.modelRef?.kind !== expected.modelRef.kind || element.modelRef.id !== expected.modelRef.id) return { status: expected.kind === 'condition' ? 'divergent-condition' : expected.kind === 'consequence' ? 'wrong-consequence-branch' : expected.kind === 'loop' ? 'wrong-loop-target' : expected.kind === 'node-role' ? 'wrong-role' : 'partial', details: 'O elemento associado não referencia o nó/fluxo/campo especificado pelo requisito.' };
  if (!spec || processSpecValid !== true) return { status: 'ambiguous', details: 'ProcessSpec ausente ou sem aprovação do Validation Engine; correspondência estrutural não comprovada.' };
  if (expected.kind === 'condition') {
    const flow = (spec.flows || []).find((item: Json) => item.id === expected.modelRef.id);
    const variable = (spec.variables || []).find((item: Json) => item.key === expected.variable);
    const condition = flow?.condition;
    const actualVariable = condition?.left?.var;
    const actualValue = condition?.right?.literal;
    const typeMatches = variable?.type === expected.valueType;
    if (!flow || flow.source !== expected.gatewayId || flow.target !== expected.targetNodeId || actualVariable !== expected.variable || condition?.op !== expected.operator || actualValue !== expected.value || !typeMatches) {
      return { status: 'divergent-condition', details: 'Fluxo diverge em gateway, destino, variável, operador, literal ou tipo declarado da variável.' };
    }
    return { details: 'Gateway, ramo, variável, operador, valor e tipo correspondem exatamente ao requisito estruturado.' };
  }
  if (expected.kind === 'consequence') {
    const flow = (spec.flows || []).find((item: Json) => item.id === expected.modelRef.id);
    if (!flow || flow.source !== expected.gatewayId) return { status: 'wrong-consequence-branch', details: 'A consequência não está ligada ao gateway/decisão esperado.' };
    if (expected.target.kind === 'node') {
      if (flow.target !== expected.target.id) return { status: 'wrong-consequence-branch', details: 'O ramo da decisão aponta para um destino diferente do requerido.' };
    } else if (flow.target !== expected.target.id || !isTerminalWithoutWork(expected.target.id, spec)) {
      return { status: 'wrong-consequence-branch', details: 'O ramo não termina no endEvent esperado por um caminho composto somente de gateways.' };
    }
    return { details: 'O fluxo parte da decisão esperada e alcança o destino terminal especificado sem executar outras atividades.' };
  }
  if (expected.kind === 'loop') {
    const flow = (spec.flows || []).find((item: Json) => item.id === expected.modelRef.id);
    if (!flow || flow.source !== expected.sourceNodeId || flow.target !== expected.targetNodeId) return { status: 'wrong-loop-target', details: 'A aresta de retorno não liga a origem e o destino exatos do ciclo requerido.' };
    if (expected.actorRoleId) {
      const source = (spec.nodes || []).find((node: Json) => node.id === flow.source);
      if (source?.roleId !== expected.actorRoleId) return { status: 'wrong-role', details: 'A origem do ciclo está atribuída a papel diferente do requerido.' };
    }
    return { details: 'A aresta de retorno e o papel da origem correspondem exatamente ao ciclo requerido.' };
  }
  if (expected.kind === 'node-role') {
    const node = (spec.nodes || []).find((item: Json) => item.id === expected.modelRef.id);
    if (!node || node.roleId !== expected.roleId) return { status: 'wrong-role', details: 'A tarefa está atribuída a papel diferente do requerido.' };
    return { details: 'A tarefa referencia o roleId exato do requisito.' };
  }
  const form = (spec.forms || []).find((item: Json) => item.id === expected.formId);
  const field = form?.fields?.find((item: Json) => item.key === expected.fieldKey);
  const ref = `${expected.formId}/${expected.fieldKey}`;
  if (!field || element.modelRef?.id !== ref) return { status: 'partial', details: 'Campo esperado não está presente no formulário associado.' };
  if (field.required !== expected.required || !requiredWhenMatches(field.requiredWhen, expected.requiredWhen)) return { status: 'partial', details: 'Obrigatoriedade simples ou condicional diverge do requisito estruturado.' };
  return { details: 'Campo e obrigatoriedade correspondem exatamente ao formulário especificado.' };
}

function structureTypeMatches(type: RequirementType, kind: NonNullable<Requirement['structure']>['kind']): boolean {
  return (kind === 'condition' && type === 'condition') || (kind === 'consequence' && type === 'consequence') || (kind === 'loop' && type === 'loop') || (kind === 'node-role' && type === 'actor') || (kind === 'required-field' && type === 'field');
}

function requiredWhenMatches(actual: Json | undefined, expected: Extract<NonNullable<Requirement['structure']>, { kind: 'required-field' }>['requiredWhen']): boolean {
  if (!expected) return actual === undefined;
  return actual?.op === expected.operator && actual?.left?.var === expected.variable && actual?.right?.literal === expected.value;
}

function isTerminalWithoutWork(startId: string, spec: Json): boolean {
  const nodes = new Map<string, Json>((spec.nodes || []).map((node: Json) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  for (const flow of spec.flows || []) outgoing.set(flow.source, [...(outgoing.get(flow.source) || []), flow.target]);
  const visit = (nodeId: string, seen: Set<string>): boolean => {
    if (seen.has(nodeId)) return false;
    const node = nodes.get(nodeId); if (!node) return false;
    if (node.type === 'endEvent') return true;
    if (node.type !== 'exclusiveGateway') return false;
    const targets = outgoing.get(nodeId) || [];
    return targets.length > 0 && targets.every(target => visit(target, new Set([...seen, nodeId])));
  };
  return visit(startId, new Set());
}

/** Create a requirement from trusted user text, not from a model citation. */
export function requirementFromEvidence(args: { messageId: string; text: string; type: RequirementType; start: number; end: number; state?: RequirementState; mandatory?: boolean }): Requirement {
  const quote = args.text.slice(args.start, args.end);
  const id = `req_${sha(`${args.messageId}\0${args.type}\0${args.start}`).slice(0, 20)}`;
  return { id, type: args.type, meaning: quote, originalText: quote, evidence: { messageId: args.messageId, start: args.start, end: args.end, quote, source: args.state === 'confirmed-answer' ? 'confirmed-answer' : 'user' }, dependsOn: [], state: args.state || 'user-stated', mandatory: args.mandatory ?? true, relations: [] };
}
