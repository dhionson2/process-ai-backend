/**
 * Provider-facing projections of the internal draft 2020-12 contracts. They only relax what a transport
 * cannot express; the backend still validates every response against the full contract with AJV.
 */

const envelopeKey = 'response';
export const ENVELOPE_KEY = envelopeKey;

/**
 * Wraps the contract unchanged under one property: transports that require an object root without
 * oneOf/anyOf/allOf accept it, and `$defs` move to the root so `#/$defs/...` references still resolve.
 */
export function structuredOutputEnvelope(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _metaSchema, $id: _id, $defs, ...contract } = structuredClone(schema) as Record<string, any>;
  return { type: 'object', properties: { [envelopeKey]: contract }, required: [envelopeKey], additionalProperties: false, ...($defs ? { $defs } : {}) };
}

// Anthropic structured outputs (output_config.format): supported keywords per the platform docs.
const unsupportedKeywords = new Set(['minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', '$comment', 'examples']);
const supportedFormats = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);

function projectNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(projectNode);
  if (!node || typeof node !== 'object') return node;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (unsupportedKeywords.has(key)) continue;
    if (key === 'format' && typeof value === 'string' && !supportedFormats.has(value)) continue;
    // oneOf is not supported; anyOf is. The variants are mutually exclusive by `kind`, so the meaning holds.
    result[key === 'oneOf' ? 'anyOf' : key] = key === 'properties' || key === '$defs'
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, projectNode(child)]))
      : projectNode(value);
  }
  // Every object must close its properties.
  if (result.type === 'object' && result.additionalProperties !== false) result.additionalProperties = false;
  return result;
}

/** Envelope + the keyword subset Anthropic structured outputs accept. */
export function anthropicOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return projectNode(structuredOutputEnvelope(schema)) as Record<string, unknown>;
}
