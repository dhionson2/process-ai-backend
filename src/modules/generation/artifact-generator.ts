import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { Diagnostic, GeneratedArtifacts } from '../../domain/contracts.js';
import { validateProcessSpec } from '../validation/validation.service.js';

type Dict = Record<string, any>;
type Box = { x: number; y: number; width: number; height: number };
const NS = {
  bpmn: 'http://www.omg.org/spec/BPMN/20100524/MODEL',
  bpmndi: 'http://www.omg.org/spec/BPMN/20100524/DI',
  dc: 'http://www.omg.org/spec/DD/20100524/DC',
  di: 'http://www.omg.org/spec/DD/20100524/DI',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
};

const xml = (value: unknown): string => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => {
  if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  return item;
});
function compileExpression(expr: Dict): string {
  if (expr.var) return '${' + expr.var + '}';
  if (Object.hasOwn(expr, 'literal')) return typeof expr.literal === 'string' ? `'${expr.literal.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'` : String(expr.literal);
  const op = expr.op;
  if (op === 'and' || op === 'or') return `(${expr.args.map(compileExpression).join(op === 'and' ? ' and ' : ' or ')})`;
  if (op === 'not') return `not(${compileExpression(expr.arg)})`;
  if (op === 'isSet') return `${compileExpression(expr.arg)} != null`;
  return `(${compileExpression(expr.left)} ${({ eq: '==', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' } as Record<string, string>)[op]} ${compileExpression(expr.right)})`;
}
function compileFeelExpression(expr: Dict): string {
  if (expr.var) return expr.var;
  if (Object.hasOwn(expr, 'literal')) return typeof expr.literal === 'string' ? JSON.stringify(expr.literal) : expr.literal === null ? 'null' : String(expr.literal);
  const op = expr.op;
  if (op === 'and' || op === 'or') return `(${expr.args.map(compileFeelExpression).join(op === 'and' ? ' and ' : ' or ')})`;
  if (op === 'not') return `not(${compileFeelExpression(expr.arg)})`;
  if (op === 'isSet') return `${compileFeelExpression(expr.arg)} != null`;
  return `(${compileFeelExpression(expr.left)} ${({ eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' } as Record<string, string>)[op]} ${compileFeelExpression(expr.right)})`;
}
function layout(spec: Dict): Map<string, Box> {
  const nodes: Dict[] = spec.nodes;
  const outgoing = new Map<string, string[]>();
  for (const flow of spec.flows) outgoing.set(flow.source, [...(outgoing.get(flow.source) || []), flow.target]);
  const start = nodes.find(node => node.type === 'startEvent')!.id;
  const depths = new Map([[start, 0]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) for (const target of outgoing.get(queue[i]) || []) if (!depths.has(target)) { depths.set(target, depths.get(queue[i])! + 1); queue.push(target); }
  const layers = new Map<number, Dict[]>();
  for (const node of nodes) { const depth = depths.get(node.id) ?? nodes.length; layers.set(depth, [...(layers.get(depth) || []), node]); }
  const result = new Map<string, Box>();
  for (const [depth, group] of [...layers].sort(([a], [b]) => a - b)) group.forEach((node, row) => {
    const [width, height] = ['startEvent', 'endEvent'].includes(node.type) ? [36, 36] : node.type.endsWith('Gateway') ? [50, 50] : [140, 80];
    result.set(node.id, { x: 110 + depth * 210, y: 130 + (row - (group.length - 1) / 2) * 180, width, height });
  });
  return result;
}

function generateBpmn(spec: Dict): string {
  const positions = layout(spec);
  const outgoing = new Map<string, Dict[]>();
  const incoming = new Map<string, Dict[]>();
  for (const flow of spec.flows) {
    outgoing.set(flow.source, [...(outgoing.get(flow.source) || []), flow]);
    incoming.set(flow.target, [...(incoming.get(flow.target) || []), flow]);
  }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<bpmn:definitions xmlns:bpmn="${NS.bpmn}" xmlns:bpmndi="${NS.bpmndi}" xmlns:dc="${NS.dc}" xmlns:di="${NS.di}" xmlns:xsi="${NS.xsi}" xmlns:process-ai="urn:process-ai:preview" xmlns:flowable="http://flowable.org/bpmn" id="Definitions_${xml(spec.id)}" targetNamespace="urn:process-design:preview">`,
    `  <bpmn:process id="${xml(spec.id)}" name="${xml(spec.name)}" isExecutable="false">`,
  ];
  for (const node of spec.nodes) {
    const attrs = [`id="${xml(node.id)}"`, `name="${xml(node.name)}"`];
    if (node.type.endsWith('Gateway')) attrs.push('gatewayDirection="Diverging"');
    if (node.defaultFlowId) attrs.push(`default="${xml(node.defaultFlowId)}"`);
    const role = spec.roles.find((candidate: Dict) => candidate.id === node.roleId);
    // candidateGroups has concrete assignment semantics. Requester, manual and
    // manager-of-requester roles are not group identifiers; emitting their
    // ProcessSpec role IDs would silently invent a runtime binding.
    if (node.roleId && role?.resolution === 'group' && role.groupKey) attrs.push(`flowable:candidateGroups="${xml(role.groupKey)}"`);
    if (['startEvent', 'userTask'].includes(node.type) && node.formId) attrs.push(`flowable:formKey="${xml(node.formId)}"`);
    lines.push(`    <bpmn:${node.type} ${attrs.join(' ')}>`);
    if (node.documentation) lines.push(`      <bpmn:documentation>${xml(node.documentation)}</bpmn:documentation>`);
    if (node.type === 'serviceTask') {
      const action = node.action;
      lines.push(`      <bpmn:documentation>${xml(`PREVIEW-ONLY: ${action.capability} via ${action.connectorId}/${action.operationId}; configuração declarativa do ProcessSpec, execução desativada.`)}</bpmn:documentation>`);
    }
    for (const flow of incoming.get(node.id) || []) lines.push(`      <bpmn:incoming>${xml(flow.id)}</bpmn:incoming>`);
    for (const flow of outgoing.get(node.id) || []) lines.push(`      <bpmn:outgoing>${xml(flow.id)}</bpmn:outgoing>`);
    lines.push(`    </bpmn:${node.type}>`);
  }
  for (const flow of spec.flows) {
    const attrs = [`id="${xml(flow.id)}"`, `sourceRef="${xml(flow.source)}"`, `targetRef="${xml(flow.target)}"`];
    if (flow.label) attrs.push(`name="${xml(flow.label)}"`);
    if (flow.condition) {
      lines.push(`    <bpmn:sequenceFlow ${attrs.join(' ')}>`);
      lines.push(`      <bpmn:documentation>${xml(`CONDITION AST (preview): ${stable(flow.condition)}`)}</bpmn:documentation>`);
      lines.push(`      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="urn:process-ai:expression-ast">${xml(stable(flow.condition))}</bpmn:conditionExpression>`);
      lines.push('    </bpmn:sequenceFlow>');
    } else lines.push(`    <bpmn:sequenceFlow ${attrs.join(' ')} />`);
  }
  lines.push('  </bpmn:process>', `  <bpmndi:BPMNDiagram id="Diagram_${xml(spec.id)}">`, `    <bpmndi:BPMNPlane id="Plane_${xml(spec.id)}" bpmnElement="${xml(spec.id)}">`);
  for (const node of spec.nodes) {
    const box = positions.get(node.id)!;
    lines.push(`      <bpmndi:BPMNShape id="Shape_${xml(node.id)}" bpmnElement="${xml(node.id)}"><dc:Bounds x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" /></bpmndi:BPMNShape>`);
  }
  for (const flow of spec.flows) {
    const source = positions.get(flow.source)!;
    const target = positions.get(flow.target)!;
    const x1 = source.x + source.width; const y1 = source.y + source.height / 2;
    const x2 = target.x; const y2 = target.y + target.height / 2;
    const points: Array<[number, number]> = [[x1, y1]];
    if (y1 !== y2) { const mid = (x1 + x2) / 2; points.push([mid, y1], [mid, y2]); }
    points.push([x2, y2]);
    const waypointXml = points.map(([x, y]) => `<di:waypoint x="${x}" y="${y}" />`).join('');
    lines.push(`      <bpmndi:BPMNEdge id="Edge_${xml(flow.id)}" bpmnElement="${xml(flow.id)}">${waypointXml}</bpmndi:BPMNEdge>`);
  }
  lines.push('    </bpmndi:BPMNPlane>', '  </bpmndi:BPMNDiagram>', '</bpmn:definitions>', '');
  return lines.join('\n');
}

const componentType: Record<string, string> = { text: 'textfield', textarea: 'textarea', integer: 'number', decimal: 'number', boolean: 'checkbox', select: 'select', date: 'datetime', datetime: 'datetime', email: 'textfield', attachment: 'filepicker' };
function compileForm(form: Dict): Record<string, unknown> {
  const components: Dict[] = form.fields.map((field: Dict, index: number) => {
    const component: Dict = { type: componentType[field.type], key: field.bindTo, label: field.label, id: `Field_${form.id}_${index}` };
    if (field.description) component.description = field.description;
    if (field.required) component.validate = { required: true };
    if (field.type === 'integer') component.numberType = 'integer';
    if (field.type === 'decimal') component.numberType = 'decimal';
    if (field.type === 'date' || field.type === 'datetime') component.subtype = field.type;
    if (field.type === 'select') component.values = field.options;
    const visible = field.visibleWhen ? compileFeelExpression(field.visibleWhen) : undefined;
    if (visible) component.conditional = { hide: `= not(${visible})` };
    if (field.pattern) component.validate = { ...(component.validate || {}), pattern: field.pattern };
    if (field.min !== undefined) component.validate = { ...(component.validate || {}), min: field.min };
    if (field.max !== undefined) component.validate = { ...(component.validate || {}), max: field.max };
    return component;
  });
  components.push({ type: 'button', key: 'submit', label: 'Enviar', action: 'submit', id: `Submit_${form.id}` });
  return { type: 'default', components };
}

async function writeExamples(): Promise<void> {
  const { readFile, writeFile, mkdir } = await import('node:fs/promises');
  const root = resolve(process.cwd(), 'specs/foundation/examples');
  const destination = resolve(root, 'generated');
  await mkdir(destination, { recursive: true });
  for (const id of ['ferias', 'http-db']) {
    const spec = JSON.parse(await readFile(resolve(root, `${id}.json`), 'utf8'));
    const result = await generateArtifacts(spec);
    if (result.diagnostics.some(item => item.severity === 'error')) {
      throw new Error(`${id}: ${JSON.stringify(result.diagnostics)}`);
    }
    await writeFile(resolve(destination, `${id}.bpmn`), result.bpmnXml, 'utf8');
    for (const form of result.forms) await writeFile(resolve(destination, `${id}-${form.id}.form.json`), `${JSON.stringify(form.json, null, 2)}\n`, 'utf8');
    await writeFile(resolve(destination, `${id}.manifest.json`), `${JSON.stringify(result.manifest, null, 2)}\n`, 'utf8');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await writeExamples();

export async function generateArtifacts(value: unknown): Promise<GeneratedArtifacts> {
  const validation = await validateProcessSpec(value);
  if (!validation.valid) return { bpmnXml: '', forms: [], manifest: {}, diagnostics: validation.diagnostics };
  const spec = value as Dict;
  let forms: GeneratedArtifacts['forms'];
  try { forms = spec.forms.map((form: Dict) => ({ id: form.id, json: compileForm(form) })); }
  catch (error) { return { bpmnXml: '', forms: [], manifest: {}, diagnostics: [{ code: 'FORM_RULE_UNSUPPORTED', path: '/forms', message: error instanceof Error ? error.message : 'Regra de formulário não suportada', severity: 'error' }] }; }
  const bpmnXml = generateBpmn(spec);
  const hashes: Record<string, string> = {};
  hashes['process.bpmn'] = createHash('sha256').update(bpmnXml).digest('hex');
  for (const form of forms) hashes[`${form.id}.form.json`] = createHash('sha256').update(`${JSON.stringify(form.json, null, 2)}\n`).digest('hex');
  const delegatedRules = spec.forms.flatMap((form: Dict) => form.fields.filter((field: Dict) => Boolean(field.requiredWhen)).map((field: Dict) => ({ formId: form.id, fieldKey: field.key, rule: 'requiredWhen', validator: 'ProcessSpec submission validation' })));
  const blockingQuestions = spec.pendingQuestions.filter((question: Dict) => question.blocking);
  const unresolvedRoles = spec.roles.filter((item: Dict) => item.resolution === 'unresolved');
  const hasPendingConfiguration = blockingQuestions.length > 0 || unresolvedRoles.length > 0;
  const manifest = {
    specId: spec.id,
    specRevision: spec.metadata?.revision ?? 0,
    targetProfile: spec.targetProfile,
    generatorVersion: '1.0.0',
    previewOnly: true,
    isExecutable: false,
    formArtifacts: Object.fromEntries(forms.map(form => [form.id, `${spec.id}-${form.id}.form.json`])),
    artifactStatus: 'valid-for-preview',
    validation: {
      formJsValidatesRequiredWhen: false,
      externalValidationRequired: spec.forms.some((form: Dict) => form.fields.some((field: Dict) => Boolean(field.requiredWhen))),
      sourceOfBusinessRules: 'ProcessSpec',
    },
    configuration: {
      ready: !hasPendingConfiguration,
      unresolvedRoles: unresolvedRoles.map((role: Dict) => role.id),
      pendingQuestions: blockingQuestions.map((question: Dict) => question.id),
    },
    publication: {
      eligible: false,
      reason: hasPendingConfiguration ? 'Configuração obrigatória permanece pendente; resolva as perguntas do ProcessSpec antes da publicação.' : delegatedRules.length ? 'Runtime de destino ainda não comprovou a aplicação das regras condicionais do ProcessSpec.' : 'Publicação real não está habilitada nesta fase.',
    },
    capabilities: ['bpmn-preview', 'form-js-preview', ...(hasPendingConfiguration ? ['draft-with-pending-configuration'] : []), ...(spec.forms.some((form: Dict) => form.fields.some((field: Dict) => Boolean(field.requiredWhen))) ? ['backend-conditional-form-validation'] : [])],
    uncompiledRules: [] as unknown[],
    delegatedRules,
    pendingQuestions: spec.pendingQuestions,
    checksums: hashes,
    notes: ['Artefatos destinados a modelagem e prévia; service tasks permanecem declarativas e não executáveis.', 'Conectores HTTP, banco de dados e notificação nunca são invocados durante geração.'],
  };
  const diagnostics: Diagnostic[] = [];
  if (spec.forms.some((form: Dict) => form.fields.some((field: Dict) => Boolean(field.requiredWhen)))) {
    diagnostics.push({ code: 'EXTERNAL_FORM_VALIDATION_REQUIRED', path: '/forms', message: 'A prévia foi gerada. O form-js não aplica requiredWhen; valide cada submissão com POST /api/v1/validate-form antes de aceitá-la. Publicação bloqueada até o runtime de destino garantir esta validação.', severity: 'warning' });
  }
  if (hasPendingConfiguration) diagnostics.push({ code: 'PROCESS_CONFIGURATION_PENDING', path: '/pendingQuestions', message: 'A prévia BPMN/Form foi gerada sem atribuições de runtime confirmadas. O artefato permanece não publicável até resolver as pendências.', severity: 'warning' });
  return { bpmnXml, forms, manifest, diagnostics };
}
