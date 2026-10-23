/**
 * Preservation check for refinements: a replanned process may only drop what the requester asked to drop.
 * Anything else that disappears is a model omission — corrected once by the model, then put to the person
 * as a yes/no question bound to the element, so the answer counts on the next turn and is never asked twice.
 */
import type { ConfirmedFact } from '../projects/conversation.repository.js';
import { answerPolarity } from './confirmations.js';
import { namedElements } from './spec-summary.js';

type Json = Record<string, any>;
export type RemovalDecisions = { approved: Set<string>; kept: Set<string> };
export type Dropped = { kind: 'activity' | 'decision' | 'actor'; name: string };

const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const stop = new Set(['a', 'as', 'ao', 'aos', 'de', 'da', 'das', 'do', 'dos', 'e', 'em', 'na', 'nas', 'no', 'nos', 'o', 'os', 'para', 'por', 'que', 'se', 'com', 'sobre', 'ou', 'um', 'uma']);
const words = (value: string) => fold(value).split(' ').filter(token => token.length >= 3 && !stop.has(token));
const stem = (token: string) => {
  for (const suffix of ['amentos', 'imentos', 'amento', 'imento', 'idades', 'idade', 'acoes', 'acao', 'ados', 'adas', 'idos', 'idas', 'ando', 'endo', 'indo', 'ado', 'ada', 'ido', 'ida', 'ar', 'er', 'ir', 'es', 's']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) return token.slice(0, -suffix.length);
  }
  return token;
};
const sameWord = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a))) || (() => { const left = stem(a); const right = stem(b); return Math.min(left.length, right.length) >= 4 && (left === right || left.startsWith(right) || right.startsWith(left)); })();

/** Two element names mean the same thing when most of their meaningful words match (renames keep the core words). */
export function sameElement(left: string, right: string): boolean {
  const a = words(left); const b = words(right);
  if (!a.length || !b.length) return fold(left) === fold(right);
  const matched = a.filter(word => b.some(other => sameWord(word, other))).length;
  return matched / Math.min(a.length, b.length) >= 0.6;
}

/** The request mentions the element (to remove, rename or replace it), so dropping it is intended. */
export function requestMentions(requestText: string, name: string): boolean {
  const request = words(requestText);
  const target = words(name);
  if (!target.length) return false;
  const matched = target.filter(word => request.some(other => sameWord(word, other))).length;
  return matched / target.length >= 0.6;
}

export const removalKey = (item: Dropped) => `remove:${item.kind}:${fold(item.name)}`;
export const removalQuestion = (item: Dropped) => {
  const label = item.kind === 'activity' ? 'A etapa' : item.kind === 'decision' ? 'A decisão' : 'O participante';
  return `${label} “${item.name}” deixaria de existir com esse ajuste. Confirma a remoção? Responda sim ou não.`;
};

/** Yes/no answers to removal questions from earlier turns. */
export function removalDecisions(facts: ConfirmedFact[]): RemovalDecisions {
  const decisions: RemovalDecisions = { approved: new Set(), kept: new Set() };
  for (const fact of facts) {
    const match = /^remove:(?:activity|decision|actor):(.+)$/.exec(fact.requirementId ?? '');
    if (!match) continue;
    const polarity = answerPolarity(fact.answer);
    if (polarity === 'yes') { decisions.approved.add(match[1]); decisions.kept.delete(match[1]); }
    else if (polarity === 'no') { decisions.kept.add(match[1]); decisions.approved.delete(match[1]); }
  }
  return decisions;
}

/** Elements of the current process missing from the replanned one without the requester having asked for it. */
export function unexpectedRemovals(currentSpec: Json, nextSpec: Json, requestText: string, decisions: RemovalDecisions): Dropped[] {
  const after = namedElements(nextSpec);
  return namedElements(currentSpec).filter(item => {
    if (after.some(candidate => candidate.kind === item.kind && sameElement(candidate.name, item.name))) return false;
    if (decisions.approved.has(fold(item.name))) return false;
    if (decisions.kept.has(fold(item.name))) return true;
    return !requestMentions(requestText, item.name);
  });
}
