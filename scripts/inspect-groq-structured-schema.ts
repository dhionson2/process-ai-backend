import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { readEnvironment } from '../src/config/env.js';
import { interpretationSchema } from '../src/modules/ai/interpretation-context.js';
import { toStrictProviderSchema } from '../src/modules/providers/model-provider.js';

const environment = readEnvironment();
const ajv = new Ajv2020({ strict: false, allErrors: true });
const results = [false, true].map(integrations => {
  const internal = interpretationSchema(integrations);
  const projected = toStrictProviderSchema(internal);
  const serialized = JSON.stringify(projected);
  const audit = { objectCount: 0, closedObjectViolations: 0, requiredViolations: 0, oneOfCount: 0, anyOfCount: 0, refs: 0, enumWithoutType: 0 };
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, any>;
    if (item.type === 'object') {
      audit.objectCount++;
      if (item.additionalProperties !== false) audit.closedObjectViolations++;
      const properties = Object.keys(item.properties || {});
      const required = Array.isArray(item.required) ? item.required : [];
      if (properties.length !== required.length || properties.some(name => !required.includes(name))) audit.requiredViolations++;
    }
    if (item.oneOf) audit.oneOfCount++;
    if (item.anyOf) audit.anyOfCount++;
    if (item.$ref) audit.refs++;
    if (Array.isArray(item.enum) && item.type === undefined) audit.enumWithoutType++;
    Object.values(item).forEach(visit);
  };
  visit(projected);
  const schemaValid = ajv.validateSchema(projected);
  let compiles = true;
  let compileError: string | undefined;
  try { ajv.compile(projected); } catch (error) { compiles = false; compileError = error instanceof Error ? error.name : 'unknown'; }
  return {
    case: integrations ? 'with-integrations' : 'without-integrations',
    internalSchemaChars: JSON.stringify(internal).length,
    providerSchemaChars: serialized.length,
    providerSchemaSha256: createHash('sha256').update(serialized).digest('hex'),
    schemaValid,
    compiles,
    ...(compileError ? { compileError } : {}),
    audit,
  };
});

const modelSupportsStrictMode = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'].includes(environment.aiModel || '');
console.log(JSON.stringify({
  provider: environment.aiProvider,
  model: environment.aiModel || null,
  configuredMode: environment.externalAiStructuredOutput,
  requestMode: environment.aiProvider === 'openai-compatible' && environment.externalAiStructuredOutput === 'json-schema-strict' ? 'json_schema with strict=true' : 'json_object',
  requestParameters: environment.aiProvider === 'openai-compatible' ? { stream: false, max_tokens: environment.aiMaxOutputTokens, temperature: 0.1, tools: false } : null,
  modelSupportsStrictMode,
  schemas: results,
}, null, 2));
if (results.some(result => !result.schemaValid || !result.compiles || result.audit.closedObjectViolations || result.audit.requiredViolations || result.audit.oneOfCount)) process.exitCode = 1;
