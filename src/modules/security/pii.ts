/**
 * Data minimization at the edge: personal identifiers in requester text are replaced before the text is
 * persisted or sent to any model. Masking happens on input (not only in the prompt) so the evidence gate,
 * which compares literal quotes with what the requester wrote, keeps working on the masked text.
 */
const patterns: Array<{ label: string; pattern: RegExp }> = [
  { label: 'E-MAIL', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { label: 'CNPJ', pattern: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g },
  { label: 'CPF', pattern: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g },
  { label: 'TELEFONE', pattern: /(?:\+55\s?)?\(?\b\d{2}\)?\s?9?\d{4}-?\d{4}\b/g },
];

export function maskPersonalData(text: string): { text: string; masked: number } {
  let masked = 0;
  let result = text;
  for (const { label, pattern } of patterns) result = result.replace(pattern, () => { masked += 1; return `[${label}]`; });
  return { text: result, masked };
}
