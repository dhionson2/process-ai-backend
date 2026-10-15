/** Technical capabilities are opt-in by request, never inferred from administrative verbs. */
export function technicalIntent(text: string): boolean {
  return /\b(?:https?|api|endpoint|sql|conector|connector|integra[cç][aã]o|banco\s+de\s+dados|database)\b|\b[A-Za-z]+_(?:api|db)\b/i.test(text);
}
