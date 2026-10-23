/**
 * Compact, human-readable rendering of a ProcessSpec for the model: the process the requester sees in the
 * Modeler, in flow order, with actors, decisions and where each branch goes. It is what a refinement turn
 * must preserve, so it uses the exact names the next BusinessIntent should repeat.
 */
type Json = Record<string, any>;

export function describeSpec(spec: Json): string {
  const roles = new Map<string, string>((spec.roles ?? []).map((role: Json) => [role.id, role.label ?? role.id]));
  const nodes = new Map<string, Json>((spec.nodes ?? []).map((node: Json) => [node.id, node]));
  const outgoing = new Map<string, Json[]>();
  for (const flow of spec.flows ?? []) outgoing.set(flow.source, [...(outgoing.get(flow.source) ?? []), flow]);
  const forms = new Map<string, Json>((spec.forms ?? []).map((form: Json) => [form.id, form]));
  const lines: string[] = [`Processo: ${spec.name}${spec.description ? ` — ${spec.description}` : ''}`];
  if (roles.size) lines.push(`Participantes: ${[...roles.values()].join(', ')}`);
  const start = (spec.nodes ?? []).find((node: Json) => node.type === 'startEvent');
  const startForm = start?.formId ? forms.get(start.formId) : undefined;
  if (startForm?.fields?.length) lines.push(`Dados informados no início: ${startForm.fields.map((field: Json) => field.label).join(', ')}`);
  lines.push('Etapas, na ordem do fluxo:');
  const seen = new Set<string>();
  const queue: string[] = start ? [start.id] : [...nodes.keys()].slice(0, 1);
  let index = 0;
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes.get(id);
    if (!node) continue;
    const next = outgoing.get(id) ?? [];
    if (node.type === 'userTask' || node.type === 'serviceTask') {
      index += 1;
      const actor = node.roleId ? roles.get(node.roleId) : undefined;
      const form = node.formId ? forms.get(node.formId) : undefined;
      const fields = form?.fields?.length ? ` [campos: ${form.fields.map((field: Json) => field.label).join(', ')}]` : '';
      lines.push(`${index}. ${node.name}${actor ? ` (${actor})` : ''}${node.type === 'serviceTask' ? ' [automática]' : ''}${fields}`);
    } else if (node.type?.endsWith('Gateway')) {
      const branches = next.map(flow => `${flow.label ?? 'sem rótulo'} → ${nodes.get(flow.target)?.name ?? flow.target}`);
      lines.push(`   Decisão “${node.name}”: ${branches.join(' | ')}`);
    } else if (node.type === 'endEvent') {
      lines.push(`   Fim: ${node.name}`);
    }
    for (const flow of next) queue.push(flow.target);
  }
  for (const node of nodes.values()) if (!seen.has(node.id) && (node.type === 'userTask' || node.type === 'serviceTask')) lines.push(`- ${node.name} (fora do caminho principal)`);
  return lines.join('\n');
}

/** Names of the elements a requester would notice disappearing: tasks, decisions and participants. */
export function namedElements(spec: Json): Array<{ kind: 'activity' | 'decision' | 'actor'; name: string }> {
  const items: Array<{ kind: 'activity' | 'decision' | 'actor'; name: string }> = [];
  for (const node of spec.nodes ?? []) {
    if (node.type === 'userTask' || node.type === 'serviceTask') items.push({ kind: 'activity', name: String(node.name ?? '') });
    else if (node.type?.endsWith('Gateway') && node.name) items.push({ kind: 'decision', name: String(node.name) });
  }
  for (const role of spec.roles ?? []) if (role.label) items.push({ kind: 'actor', name: String(role.label) });
  return items.filter(item => item.name.trim());
}
