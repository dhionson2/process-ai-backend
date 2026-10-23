import type { ConfirmedFact } from '../projects/conversation.repository.js';

type Json = any;

/** A process element a yes/no clarification is about. */
export type ConfirmationKind = 'activity' | 'field' | 'actor';
export type ConfirmationSubject = { kind: ConfirmationKind; name: string };
export type AnswerPolarity = 'yes' | 'no' | 'unknown';

const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Stable binding between a clarification and the element it is about; carried as the question's requirementId. */
export function confirmationKey(subject: ConfirmationSubject): string {
  return `confirm:${subject.kind}:${fold(subject.name)}`;
}
export function subjectFromKey(key: string | undefined): ConfirmationSubject | undefined {
  const match = /^confirm:(activity|field|actor):(.+)$/.exec(key ?? '');
  return match ? { kind: match[1] as ConfirmationKind, name: match[2] } : undefined;
}

const negative = /^(nao|n|no|nope|negativo|nunca|remov\w*|retir\w*|exclu\w*|tir\w*|sem (essa|esse|ela|ele)|nao (deve|precisa|existe|faz))\b/;
const affirmative = /^(sim|s|yes|ok|okay|claro|isso|exato|correto|certo|confirm\w*|pode|deve|mantem|mante\w*|inclu\w*|positivo|com certeza|faz parte|precisa)\b/;

/**
 * Reads a free-text answer to a yes/no clarification. Only the opening of the answer decides, so "sim, mas
 * depois…" is yes and "não precisa" is no; anything else is a description, which stays available to the model
 * as confirmed text but does not decide the element by itself.
 */
export function answerPolarity(answer: string): AnswerPolarity {
  const text = fold(answer);
  if (!text) return 'unknown';
  if (negative.test(text)) return 'no';
  if (affirmative.test(text)) return 'yes';
  return 'unknown';
}

export type Confirmations = {
  confirmed: ConfirmationSubject[];
  rejected: ConfirmationSubject[];
  /** Sentences added to the requester's authoritative text; confirmed elements cite them as evidence. */
  statements: string[];
};

const kindLabel: Record<ConfirmationKind, string> = { activity: 'a etapa', field: 'o campo', actor: 'o participante' };
export const confirmationStatement = (subject: ConfirmationSubject, name = subject.name) => `O solicitante confirmou: ${kindLabel[subject.kind]} “${name}” deve fazer parte do processo.`;

/** The latest yes/no answer per bound element; unbound or descriptive answers are ignored here. */
export function collectConfirmations(facts: ConfirmedFact[]): Confirmations {
  const verdicts = new Map<string, { subject: ConfirmationSubject; polarity: AnswerPolarity }>();
  for (const fact of facts) {
    const subject = subjectFromKey(fact.requirementId);
    if (!subject) continue;
    const polarity = answerPolarity(fact.answer);
    if (polarity !== 'unknown') verdicts.set(confirmationKey(subject), { subject, polarity });
  }
  const confirmed = [...verdicts.values()].filter(item => item.polarity === 'yes').map(item => item.subject);
  const rejected = [...verdicts.values()].filter(item => item.polarity === 'no').map(item => item.subject);
  return { confirmed, rejected, statements: confirmed.map(subject => confirmationStatement(subject)) };
}

/**
 * Applies the requester's yes/no answers to a BusinessIntent plan before compilation: a confirmed element
 * cites the confirmation statement as its evidence (so every evidence gate accepts it by the usual rules), a
 * rejected activity or field is removed. Elements nobody answered about are left exactly as they were.
 */
export function applyConfirmations(plan: Json, confirmations: Confirmations): Json {
  if (!confirmations.confirmed.length && !confirmations.rejected.length) return plan;
  const result = structuredClone(plan);
  const matches = (kind: ConfirmationKind, name: unknown) => (list: ConfirmationSubject[]) => list.some(item => item.kind === kind && fold(String(name ?? '')) === item.name);
  const confirmEvidence = (kind: ConfirmationKind, item: Json) => {
    if (matches(kind, item.name)(confirmations.confirmed)) item.evidence = confirmationStatement({ kind, name: item.name }, item.name);
  };
  const fields = (list: Json[] | undefined) => (list ?? []).filter(field => !matches('field', field.name)(confirmations.rejected)).map(field => { confirmEvidence('field', field); return field; });
  const steps = (list: Json[] | undefined): Json[] => (list ?? []).filter(step => !matches('activity', step.name)(confirmations.rejected)).map(step => {
    confirmEvidence('activity', step);
    if (step.fields) step.fields = fields(step.fields);
    if (step.onApproved) step.onApproved = steps(step.onApproved);
    if (step.onRejected) step.onRejected = steps(step.onRejected);
    if (step.alternatives) step.alternatives = step.alternatives.map((alternative: Json) => ({ ...alternative, steps: steps(alternative.steps) }));
    return step;
  });
  for (const actor of result.actors ?? []) confirmEvidence('actor', actor);
  result.startFields = fields(result.startFields);
  result.activities = steps(result.activities);
  return result;
}
