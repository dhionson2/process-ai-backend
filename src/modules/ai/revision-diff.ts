type Json = any;

export type ChangeKind = 'added' | 'removed' | 'changed';
export type SpecChange = { kind: ChangeKind; area: 'etapa' | 'decisão' | 'papel' | 'campo' | 'caminho'; description: string };
export type RevisionDiff = { from: number; to: number; changes: SpecChange[]; totals: Record<ChangeKind, number> };

const taskTypes = new Set(['userTask', 'serviceTask']);
const nameOf = (node: Json) => String(node?.name ?? node?.id ?? '');

/**
 * Business-level difference between two ProcessSpecs: steps, decisions, roles, form fields and paths that
 * were added, removed or changed. Elements are matched by their stable IDs, so a rename reads as a change.
 */
export function diffSpecs(before: Json, after: Json, from: number, to: number): RevisionDiff {
  const changes: SpecChange[] = [];
  const roleLabel = (spec: Json, roleId: string) => (spec?.roles ?? []).find((role: Json) => role.id === roleId)?.label ?? roleId;
  const byId = (items: Json[] = []) => new Map(items.map(item => [item.id, item]));

  const beforeNodes = byId(before?.nodes); const afterNodes = byId(after?.nodes);
  for (const [id, node] of afterNodes) {
    const previous = beforeNodes.get(id);
    const area = taskTypes.has(node.type) ? 'etapa' : node.type === 'exclusiveGateway' ? 'decisão' : undefined;
    if (!area) continue;
    if (!previous) { changes.push({ kind: 'added', area, description: `“${nameOf(node)}”${node.roleId ? ` (${roleLabel(after, node.roleId)})` : ''}` }); continue; }
    if (nameOf(previous) !== nameOf(node)) changes.push({ kind: 'changed', area, description: `“${nameOf(previous)}” passou a se chamar “${nameOf(node)}”` });
    if (area === 'etapa' && previous.roleId !== node.roleId) changes.push({ kind: 'changed', area, description: `“${nameOf(node)}” passou de ${roleLabel(before, previous.roleId)} para ${roleLabel(after, node.roleId)}` });
  }
  for (const [id, node] of beforeNodes) {
    if (afterNodes.has(id)) continue;
    if (taskTypes.has(node.type)) changes.push({ kind: 'removed', area: 'etapa', description: `“${nameOf(node)}”` });
    else if (node.type === 'exclusiveGateway') changes.push({ kind: 'removed', area: 'decisão', description: `“${nameOf(node)}”` });
  }

  const beforeRoles = byId(before?.roles); const afterRoles = byId(after?.roles);
  for (const [id, role] of afterRoles) if (!beforeRoles.has(id)) changes.push({ kind: 'added', area: 'papel', description: `“${role.label ?? id}”` });
  for (const [id, role] of beforeRoles) if (!afterRoles.has(id)) changes.push({ kind: 'removed', area: 'papel', description: `“${role.label ?? id}”` });

  const fields = (spec: Json) => new Map<string, Json>((spec?.forms ?? []).flatMap((form: Json) => (form.fields ?? []).map((field: Json) => [`${form.id}/${field.key}`, { ...field, formName: form.name ?? form.id }])));
  const beforeFields = fields(before); const afterFields = fields(after);
  for (const [key, field] of afterFields) {
    const previous = beforeFields.get(key);
    if (!previous) changes.push({ kind: 'added', area: 'campo', description: `“${field.label ?? field.key}” em ${field.formName}` });
    else if (Boolean(previous.required) !== Boolean(field.required)) changes.push({ kind: 'changed', area: 'campo', description: `“${field.label ?? field.key}” ${field.required ? 'passou a ser obrigatório' : 'deixou de ser obrigatório'}` });
  }
  for (const [key, field] of beforeFields) if (!afterFields.has(key)) changes.push({ kind: 'removed', area: 'campo', description: `“${field.label ?? field.key}” de ${field.formName}` });

  const flowKey = (flow: Json) => `${flow.source}->${flow.target}`;
  const flowLabel = (spec: Json, flow: Json) => {
    const nodes = byId(spec?.nodes);
    return `${nameOf(nodes.get(flow.source))} → ${nameOf(nodes.get(flow.target))}${flow.label ? ` (${flow.label})` : ''}`;
  };
  const beforeFlows = new Map<string, Json>((before?.flows ?? []).map((flow: Json) => [flowKey(flow), flow]));
  const afterFlows = new Map<string, Json>((after?.flows ?? []).map((flow: Json) => [flowKey(flow), flow]));
  for (const [key, flow] of afterFlows) {
    const previous = beforeFlows.get(key);
    if (!previous) changes.push({ kind: 'added', area: 'caminho', description: flowLabel(after, flow) });
    else if (JSON.stringify(previous.condition ?? null) !== JSON.stringify(flow.condition ?? null)) changes.push({ kind: 'changed', area: 'caminho', description: `Condição de ${flowLabel(after, flow)}` });
  }
  for (const [key, flow] of beforeFlows) if (!afterFlows.has(key)) changes.push({ kind: 'removed', area: 'caminho', description: flowLabel(before, flow) });

  const totals = { added: 0, removed: 0, changed: 0 };
  for (const change of changes) totals[change.kind] += 1;
  return { from, to, changes, totals };
}
