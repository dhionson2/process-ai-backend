type Json = any;

export type UnderstandingItem = { label: string; detail?: string; origin: 'user' | 'confirmed-answer' | 'inference' | 'unknown'; confirmed: boolean };
export type ProposalUnderstanding = {
  revision: number;
  status: string;
  processName: string;
  actors: UnderstandingItem[];
  activities: UnderstandingItem[];
  decisions: Array<{ label: string; outcomes: string[] }>;
  fields: Array<{ form: string; label: string; type: string; required: boolean }>;
  pending: string[];
  provenance: { user: number; confirmedAnswer: number; inference: number; unconfirmed: number };
};

function provenanceFor(spec: Json, name: string): Pick<UnderstandingItem, 'origin' | 'confirmed'> {
  const entries: Json[] = (spec?.metadata?.requirementProvenance ?? []).filter((entry: Json) => entry?.name === name);
  const stated = entries.find(entry => entry.source === 'user' || entry.source === 'confirmed-answer');
  const chosen = stated ?? entries[0];
  if (!chosen) return { origin: 'unknown', confirmed: false };
  const origin = ['user', 'confirmed-answer', 'inference'].includes(chosen.source) ? chosen.source : 'unknown';
  return { origin, confirmed: chosen.confirmed === true };
}

/**
 * Business-facing projection of a ProcessSpec: who participates, what happens, which decisions and
 * fields exist, where each item came from, and what is still pending. Read-only; never alters the spec.
 */
export function projectUnderstanding(spec: Json, revision: number, status: string): ProposalUnderstanding {
  const nodes: Json[] = spec?.nodes ?? [];
  const flows: Json[] = spec?.flows ?? [];
  const roles: Json[] = spec?.roles ?? [];
  const roleLabel = (roleId: string) => roles.find(role => role.id === roleId)?.label ?? roleId;
  const actors = roles.map(role => ({
    label: String(role.label ?? role.id),
    detail: role.resolution === 'unresolved' || !role.resolution ? 'responsável no ambiente ainda não definido' : `atribuição: ${role.resolution}`,
    ...provenanceFor(spec, role.label),
  }));
  const activities = nodes.filter(node => node.type === 'userTask' || node.type === 'serviceTask').map(node => ({
    label: String(node.name ?? node.id),
    ...(node.roleId ? { detail: roleLabel(node.roleId) } : {}),
    ...provenanceFor(spec, node.name),
  }));
  const decisions = nodes.filter(node => node.type === 'exclusiveGateway').map(node => ({
    label: String(node.name ?? node.id),
    outcomes: flows.filter(flow => flow.source === node.id).map(flow => String(flow.label ?? nodes.find(target => target.id === flow.target)?.name ?? flow.target)),
  })).filter(decision => decision.outcomes.length > 1);
  const fields = (spec?.forms ?? []).flatMap((form: Json) => (form.fields ?? []).map((field: Json) => ({ form: String(form.name ?? form.id), label: String(field.label ?? field.key), type: String(field.type), required: field.required === true })));
  const pending: string[] = (spec?.pendingQuestions ?? []).map((question: Json) => String(question.question)).filter(Boolean);
  const provenanceEntries: Json[] = spec?.metadata?.requirementProvenance ?? [];
  return {
    revision, status, processName: String(spec?.name ?? ''),
    actors, activities, decisions, fields, pending,
    provenance: {
      user: provenanceEntries.filter(entry => entry.source === 'user').length,
      confirmedAnswer: provenanceEntries.filter(entry => entry.source === 'confirmed-answer').length,
      inference: provenanceEntries.filter(entry => entry.source === 'inference').length,
      unconfirmed: provenanceEntries.filter(entry => entry.confirmed !== true).length,
    },
  };
}
