import { businessIntentSchema } from './semantic-process.js';

/** Provider-facing projection: business interpretation does not decide runtime bindings or preview gates. */
export function interpretationSchema(includeIntegrations: boolean): Record<string, any> {
  const schema = businessIntentSchema();
  const business = schema.oneOf[1];
  delete business.properties.pendingConfiguration;
  business.required = business.required.filter((name: string) => name !== 'pendingConfiguration');
  const actor = business.properties.actors.items;
  for (const name of ['resolution', 'groupName', 'resolutionEvidence']) delete actor.properties[name];
  if (!includeIntegrations) schema.$defs.step.oneOf = schema.$defs.step.oneOf.filter((item: any) => item.properties.kind.const !== 'integration');
  return schema;
}

export function normalizeInterpretation(value: unknown): unknown {
  if (!value || typeof value !== 'object' || (value as any).kind !== 'business_intent') return value;
  return { ...value, pendingConfiguration: (value as any).pendingConfiguration || [] };
}
