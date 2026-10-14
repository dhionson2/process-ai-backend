import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { ValidationResult } from '../../domain/contracts.js';
import { readFoundationJson } from '../../shared/files.js';
import { validateSemantics } from './semantic.validator.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
let cache: Promise<{ schemaCheck: ValidateFunction, catalog: Record<string, unknown> }> | undefined;
function resources() {
  cache ||= Promise.all([
    readFoundationJson('contracts/process-spec.v1.schema.json'),
    readFoundationJson('contracts/mock-capability-catalog.json'),
  ]).then(([schema, catalog]) => ({ schemaCheck: ajv.compile(schema), catalog: catalog as Record<string, unknown> }));
  return cache;
}
export async function validateProcessSpec(value: unknown): Promise<ValidationResult> {
  const { schemaCheck, catalog } = await resources();
  if (!schemaCheck(value)) {
    return { valid: false, diagnostics: (schemaCheck.errors || []).map((error: ErrorObject) => ({
      code: 'SCHEMA_INVALID', path: error.instancePath || '/', message: error.message || 'Contrato inválido', severity: 'error' as const,
    })) };
  }
  const diagnostics = validateSemantics(value as Record<string, any>, catalog as Record<string, any>);
  return { valid: diagnostics.length === 0, diagnostics };
}
