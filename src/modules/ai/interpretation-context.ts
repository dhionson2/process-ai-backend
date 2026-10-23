import { businessIntentSchema } from './semantic-process.js';

/** Actor fields owned by the compiler; a model that still emits them must not decide runtime bindings. */
const compilerOwnedActorFields = ['resolution', 'groupName', 'resolutionEvidence'];

/** Provider-facing projection: business interpretation does not decide runtime bindings or preview gates. */
export function interpretationSchema(includeIntegrations: boolean): Record<string, any> {
  const schema = businessIntentSchema();
  const business = schema.oneOf[1];
  delete business.properties.pendingConfiguration;
  business.required = business.required.filter((name: string) => name !== 'pendingConfiguration');
  const actor = business.properties.actors.items;
  for (const name of compilerOwnedActorFields) delete actor.properties[name];
  if (!includeIntegrations) schema.$defs.step.oneOf = schema.$defs.step.oneOf.filter((item: any) => item.properties.kind.const !== 'integration');
  return schema;
}

export function normalizeInterpretation(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value as any).kind && (value as any).businessIntent && typeof (value as any).businessIntent === 'object') {
    return normalizeInterpretation((value as any).businessIntent);
  }
  if (!value || typeof value !== 'object' || (value as any).kind !== 'business_intent') return value;
  const actors = Array.isArray((value as any).actors)
    ? (value as any).actors.map((actor: unknown) => {
      if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return actor;
      const projected: Record<string, unknown> = { ...actor };
      for (const name of compilerOwnedActorFields) delete projected[name];
      return projected;
    })
    : (value as any).actors;
  return { ...value, actors, pendingConfiguration: (value as any).pendingConfiguration || [] };
}
