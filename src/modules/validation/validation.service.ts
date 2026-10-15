import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { PublicationReadiness, ValidationResult } from '../../domain/contracts.js';
import { readFoundationJson } from '../../shared/files.js';
import { validateSemantics } from './semantic.validator.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
let cache: Promise<{ schemaCheck: ValidateFunction, catalog: Record<string, unknown> }> | undefined;
function resources() {
  cache ||= Promise.all([
    readFoundationJson('contracts/process-spec.v1.schema.json'),
    readFoundationJson('contracts/mock-capability-catalog.json'),
  ]).then(([schema, catalog]) => ({ schemaCheck: ajv.compile(schema as object), catalog: catalog as Record<string, unknown> }));
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
  return { valid: !diagnostics.some(item => item.severity === 'error'), diagnostics };
}

type FormSubmission = { valid: boolean; diagnostics: Array<{ code: string; path: string; message: string }> };
function evaluateExpression(expression: Record<string, any>, data: Record<string, unknown>): unknown {
  if (typeof expression.var === 'string') return data[expression.var];
  if (Object.hasOwn(expression, 'literal')) return expression.literal;
  const op = expression.op as string;
  if (op === 'and') return expression.args.every((child: Record<string, any>) => evaluateExpression(child, data) === true);
  if (op === 'or') return expression.args.some((child: Record<string, any>) => evaluateExpression(child, data) === true);
  if (op === 'not') return evaluateExpression(expression.arg, data) !== true;
  if (op === 'isSet') { const value = evaluateExpression(expression.arg, data); return value !== undefined && value !== null && value !== ''; }
  const left = evaluateExpression(expression.left, data) as any;
  const right = evaluateExpression(expression.right, data) as any;
  if (op === 'eq') return left === right;
  if (op === 'ne') return left !== right;
  if (op === 'gt') return left > right;
  if (op === 'gte') return left >= right;
  if (op === 'lt') return left < right;
  if (op === 'lte') return left <= right;
  return false;
}

/** Validates submitted form data using ProcessSpec rules independently of form-js. */
export async function validateFormSubmission(value: unknown, formId: string, data: Record<string, unknown>): Promise<FormSubmission> {
  const processResult = await validateProcessSpec(value);
  if (!processResult.valid) return { valid: false, diagnostics: processResult.diagnostics.map(({ code, path, message }) => ({ code, path, message })) };
  const spec = value as Record<string, any>;
  const form = spec.forms.find((item: Record<string, any>) => item.id === formId);
  if (!form) return { valid: false, diagnostics: [{ code: 'FORM_UNDEFINED', path: `/forms/${formId}`, message: 'Formulário não encontrado' }] };
  const diagnostics: FormSubmission['diagnostics'] = [];
  for (const field of form.fields as Array<Record<string, any>>) {
    const fieldValue = data[field.bindTo];
    const required = field.required || (field.requiredWhen && evaluateExpression(field.requiredWhen, data) === true);
    if (required && (fieldValue === undefined || fieldValue === null || (typeof fieldValue === 'string' && fieldValue.trim() === ''))) {
      diagnostics.push({ code: 'FORM_FIELD_REQUIRED', path: `/forms/${formId}/fields/${field.key}`, message: `${field.label} é obrigatório para esta decisão` });
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

/** Simulates the minimum publication guard for ProcessSpec conditional form rules. */
export async function validatePublicationReadiness(value: unknown, runtimeGuaranteesConditionalValidation: boolean): Promise<PublicationReadiness> {
  const processResult = await validateProcessSpec(value);
  const usesConditionalRules = processResult.valid && (value as Record<string, any>).forms.some((form: Record<string, any>) =>
    form.fields.some((field: Record<string, any>) => Boolean(field.requiredWhen)));
  const blockers: PublicationReadiness['blockers'] = [];
  const process = value as Record<string, any>;
  if (processResult.valid && (process.pendingQuestions.some((question: Record<string, any>) => question.blocking) || process.roles.some((role: Record<string, any>) => role.resolution === 'unresolved'))) {
    blockers.push({ code: 'PROCESS_CONFIGURATION_PENDING', path: '/pendingQuestions', message: 'O processo ainda tem configuração obrigatória pendente e não pode ser publicado.', severity: 'error' });
  }
  if (usesConditionalRules && !runtimeGuaranteesConditionalValidation) {
    blockers.push({ code: 'RUNTIME_CONDITIONAL_VALIDATION_UNGUARANTEED', path: '/runtimeCapabilities/conditionalFormValidation', message: 'O runtime de destino não comprovou a validação das regras requiredWhen do ProcessSpec.', severity: 'error' });
  }
  return {
    publishable: false,
    checks: { conditionalRulesDelegated: !usesConditionalRules || runtimeGuaranteesConditionalValidation, runtimeGuaranteesConditionalValidation },
    blockers: [...processResult.diagnostics, ...blockers, { code: 'PUBLICATION_DISABLED_IN_PHASE1', path: '/', message: 'Esta API apenas simula a verificação; publicação real não está habilitada nesta fase.', severity: 'error' }],
  };
}
