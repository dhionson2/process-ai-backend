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
  // Same targetNamespace bpmn-js writes; the Modeler («Abrir») imports the file as any hand-made diagram.
  target: 'http://bpmn.io/schema/bpmn',
};
/** form-js schema version the Modeler's vendored form-js (1.24.x) writes; older or missing versions are migrated on import. */
export const FORM_SCHEMA_VERSION = 19;

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
const NODE_SIZE = (node: Dict): [number, number] => ['startEvent', 'endEvent'].includes(node.type) ? [36, 36] : node.type.endsWith('Gateway') ? [50, 50] : [140, 80];

/**
 * Automatic layout by ELK (layered, left to right): the same engine bpmn-js users reach for, so edges do not
 * cross needlessly, decision branches stay side by side and a loop back to an earlier step is routed around.
 * Deterministic for the same ProcessSpec: elkjs is pure and seeded by element order.
 */
async function layout(spec: Dict): Promise<{ boxes: Map<string, Box>; routes: Map<string, Array<[number, number]>> }> {
  // elkjs ships no typings for the bundled entry; only `layout()` is used here.
  const ELK = (await import('elkjs/lib/elk.bundled.js')).default as unknown as new () => { layout(graph: Dict): Promise<Dict> };
  const elk = new ELK();
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '70', 'elk.spacing.nodeNode': '40', 'elk.spacing.edgeNode': '30',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF', 'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.edgeRouting': 'ORTHOGONAL', 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.padding': '[top=60,left=110,bottom=60,right=60]',
    },
    children: spec.nodes.map((node: Dict) => { const [width, height] = NODE_SIZE(node); return { id: node.id, width, height }; }),
    edges: spec.flows.map((flow: Dict) => ({ id: flow.id, sources: [flow.source], targets: [flow.target] })),
  });
  const boxes = new Map<string, Box>();
  for (const child of graph.children ?? []) boxes.set(child.id, { x: Math.round(child.x ?? 0), y: Math.round(child.y ?? 0), width: child.width ?? 0, height: child.height ?? 0 });
  const routes = new Map<string, Array<[number, number]>>();
  for (const edge of graph.edges ?? []) {
    const section = (edge as Dict).sections?.[0];
    if (!section) continue;
    const points: Array<[number, number]> = [[section.startPoint.x, section.startPoint.y], ...((section.bendPoints ?? []) as Array<{ x: number; y: number }>).map(point => [point.x, point.y] as [number, number]), [section.endPoint.x, section.endPoint.y]];
    routes.set(edge.id, points.map(([x, y]) => [Math.round(x), Math.round(y)]));
  }
  return { boxes, routes };
}

async function generateBpmn(spec: Dict): Promise<string> {
  const { boxes: positions, routes } = await layout(spec);
  const outgoing = new Map<string, Dict[]>();
  const incoming = new Map<string, Dict[]>();
  for (const flow of spec.flows) {
    outgoing.set(flow.source, [...(outgoing.get(flow.source) || []), flow]);
    incoming.set(flow.target, [...(incoming.get(flow.target) || []), flow]);
  }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<bpmn:definitions xmlns:bpmn="${NS.bpmn}" xmlns:bpmndi="${NS.bpmndi}" xmlns:dc="${NS.dc}" xmlns:di="${NS.di}" xmlns:xsi="${NS.xsi}" xmlns:flowable="http://flowable.org/bpmn" id="Definitions_${xml(spec.id)}" targetNamespace="${NS.target}">`,
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
    // ELK routed the edge; a missing section (degenerate graph) falls back to a straight connector.
    const points = routes.get(flow.id) ?? [[source.x + source.width, source.y + source.height / 2], [target.x, target.y + target.height / 2]] as Array<[number, number]>;
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
    if (field.type === 'date' || field.type === 'datetime') {
      // form-js datetime components label the date (and time) inputs, not the component; `label` alone renders no text.
      component.subtype = field.type; component.dateLabel = field.label;
      if (field.type === 'datetime') component.timeLabel = 'Hora';
      delete component.label;
    }
    if (field.type === 'select') component.values = field.options;
    const visible = field.visibleWhen ? compileFeelExpression(field.visibleWhen) : undefined;
    if (visible) component.conditional = { hide: `= not(${visible})` };
    if (field.pattern) component.validate = { ...(component.validate || {}), pattern: field.pattern };
    if (field.min !== undefined) component.validate = { ...(component.validate || {}), min: field.min };
    if (field.max !== undefined) component.validate = { ...(component.validate || {}), max: field.max };
    return component;
  });
  components.push({ type: 'button', key: 'submit', label: 'Enviar', action: 'submit', id: `Submit_${form.id}` });
  return { type: 'default', id: `Form_${form.id}`, schemaVersion: FORM_SCHEMA_VERSION, components };
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
  const bpmnXml = await generateBpmn(spec);
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
