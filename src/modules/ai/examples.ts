import type { AcceptedExample } from '../projects/conversation.repository.js';
import type { ProposalUnderstanding } from './understanding.js';

const stopWords = new Set(['para', 'com', 'que', 'uma', 'um', 'por', 'dos', 'das', 'de', 'do', 'da', 'e', 'o', 'a', 'os', 'as', 'se', 'no', 'na', 'em', 'ao', 'quando', 'processo']);
function tokens(text: string): Set<string> {
  return new Set(text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9]{3,}/g)?.filter(token => !stopWords.has(token)) ?? []);
}
function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Compact, business-level description of an accepted result; it is what the model sees as a pattern. */
export function summarizeForExample(view: ProposalUnderstanding): string {
  const parts = [
    `Participantes: ${view.actors.map(item => item.label).join(', ') || '—'}`,
    `Etapas: ${view.activities.map(item => `${item.label}${item.detail ? ` (${item.detail})` : ''}`).join('; ') || '—'}`,
    ...(view.decisions.length ? [`Decisões: ${view.decisions.map(item => `${item.label} → ${item.outcomes.join(' / ')}`).join('; ')}`] : []),
    `Campos: ${view.fields.length}`,
  ];
  return parts.join('. ').slice(0, 800);
}

/**
 * Up to two accepted examples most similar to the request (token Jaccard, threshold 0.15). They are patterns of
 * how this tenant structures processes, never facts about the current one; the evidence gate still applies.
 */
export function selectSimilarExamples(requestText: string, examples: AcceptedExample[], limit = 2, threshold = 0.15): string[] {
  const query = tokens(requestText);
  return examples
    .map(example => ({ example, score: jaccard(query, tokens(example.requestText)) }))
    .filter(item => item.score >= threshold)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ example }) => `Pedido: ${example.requestText.slice(0, 400)}\nResultado aceito: ${example.summary}`);
}
