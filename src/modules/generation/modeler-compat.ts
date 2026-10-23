/**
 * "Importável no Modeler": the rules the BPM Design Web Modeler applies to a file handed to «Abrir»
 * (src/features/fluxos/validation/import-validation.ts) and to a remote form definition
 * (src/features/formularios/validation/remote-schema-validation.ts, component-type-allowlist.ts),
 * ported so the scoreboard fails before a person sees the Modeler refuse a generated artifact.
 *
 * The Modeler's last layer (trial import in a throwaway bpmn-js / form-js editor) needs a DOM; here the
 * BPMN trial runs on bpmn-moddle, the same parser bpmn-js uses, and forms are checked structurally.
 * The scratch worktree PoC (docs/sdd) exercised the real chains with vitest + jsdom.
 */
// bpmn-moddle 10 ships only the model types, not the class; the constructor is typed here to what this module uses.
import { BpmnModdle } from 'bpmn-moddle';
type ModdleWarning = { message: string };
type ModdleElement = { $type?: string; $descriptor?: { properties?: Array<{ name: string; isReference?: boolean }> } } & Record<string, unknown>;
type Moddle = { fromXML(xml: string): Promise<{ rootElement?: ModdleElement; warnings: ModdleWarning[] }> };
import type { GeneratedArtifacts } from '../../domain/contracts.js';

export const MAX_BPMN_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_BPMN_ELEMENTS = 10_000;
export const MAX_FORM_DEFINITION_BYTES = 1_048_576;
export const MAX_FORM_COMPONENTS = 1_000;
export const MAX_FORM_DEPTH = 16;
/** DTD vocabulary the Modeler refuses unconditionally, case-insensitively, anywhere in the text. */
export const DTD_VOCABULARY = /<!(?:DOCTYPE|ENTITY|ELEMENT|ATTLIST|\[INCLUDE|\[IGNORE)/i;
/** Component types the Modeler admits in a remote definition (recursive through group/dynamiclist). */
export const MODELER_COMPONENT_TYPES: ReadonlySet<string> = new Set([
  'textfield', 'textarea', 'number', 'datetime', 'expression', 'select', 'radio', 'checklist', 'taglist',
  'checkbox', 'text', 'spacer', 'separator', 'table', 'group', 'dynamiclist', 'button',
]);

export type ImportabilityReport = { importable: boolean; problems: string[]; notes: string[] };

/**
 * What the assistant hands to the Modeler's form editor. form-js itself renders `filepicker`, but the Modeler's
 * remote-definition allowlist does not admit it (no upload in that product yet), so an attachment becomes a text
 * field that says so. The extension applies the same projection before `apply-form`; keep both in step.
 */
export function projectFormForModeler(schema: unknown): { schema: unknown; notes: string[] } {
  const notes: string[] = [];
  const visit = (component: unknown): unknown => {
    if (!component || typeof component !== 'object') return component;
    const item = { ...(component as Record<string, unknown>) };
    if (item.type === 'filepicker') {
      notes.push(`campo de anexo “${String(item.label ?? item.key ?? '')}” entregue como texto: o editor de formulário do Modeler não aceita upload`);
      item.type = 'textfield';
      item.description = [item.description, 'Anexo (o upload será configurado no runtime; neste editor o campo é texto).'].filter(Boolean).join(' ');
      delete item.multiple; delete item.accept;
    }
    if (Array.isArray(item.components)) item.components = item.components.map(visit);
    return item;
  };
  return { schema: visit(schema), notes };
}

const moddle: Moddle = new (BpmnModdle as unknown as new () => Moddle)();

export async function assessBpmnImportability(xml: string): Promise<string[]> {
  const problems: string[] = [];
  if (!xml.trim()) return ['BPMN vazio'];
  if (Buffer.byteLength(xml, 'utf8') > MAX_BPMN_FILE_BYTES) problems.push(`BPMN maior que ${MAX_BPMN_FILE_BYTES / 1024 / 1024} MB`);
  if (DTD_VOCABULARY.test(xml)) problems.push('BPMN contém vocabulário de DTD');
  if (problems.length) return problems;
  try {
    const { rootElement, warnings } = await moddle.fromXML(xml);
    if (rootElement?.$type !== 'bpmn:Definitions') problems.push('raiz não é bpmn:definitions');
    const unreadable = warnings.filter(warning => /unparsable|unexpected|illegal|missing/i.test(warning.message));
    if (unreadable.length) problems.push(`bpmn-moddle: ${unreadable.map(warning => warning.message).join('; ')}`);
    let elements = 0;
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const item of value) visit(item); return; }
      const element = value as ModdleElement;
      if (typeof element.$type === 'string' && element.$type.startsWith('bpmn:')) elements += 1;
      for (const property of element.$descriptor?.properties ?? []) if (!property.isReference) visit(element[property.name]);
    };
    visit(rootElement);
    if (elements > MAX_BPMN_ELEMENTS) problems.push(`${elements} elementos BPMN > máximo ${MAX_BPMN_ELEMENTS}`);
  } catch (error) {
    problems.push(`XML inválido: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
  return problems;
}

export function assessFormImportability(schema: unknown): string[] {
  const problems: string[] = [];
  const text = JSON.stringify(schema);
  if (Buffer.byteLength(text, 'utf8') > MAX_FORM_DEFINITION_BYTES) problems.push('formulário maior que 1 MB');
  const root = schema as { type?: unknown; components?: unknown } | null;
  if (!root || typeof root !== 'object' || root.type !== 'default' || !Array.isArray(root.components)) return [...problems, 'raiz do formulário não é {type: "default", components: [...]}'];
  let count = 0;
  const walk = (components: unknown[], depth: number, path: string) => {
    components.forEach((component, index) => {
      count += 1;
      const item = component as { type?: unknown; components?: unknown } | null;
      const where = `${path}/${index}`;
      if (!item || typeof item !== 'object') { problems.push(`${where}: componente não é objeto`); return; }
      if (typeof item.type !== 'string' || !MODELER_COMPONENT_TYPES.has(item.type)) problems.push(`${where}: tipo "${String(item.type)}" fora da allowlist do Modeler`);
      if (depth > MAX_FORM_DEPTH) { problems.push(`${where}: profundidade ${depth} > máximo ${MAX_FORM_DEPTH}`); return; }
      if (Array.isArray(item.components)) walk(item.components, depth + 1, `${where}/components`);
    });
  };
  walk(root.components, 1, '/components');
  if (count > MAX_FORM_COMPONENTS) problems.push(`${count} componentes > máximo ${MAX_FORM_COMPONENTS}`);
  return problems;
}

/** One verdict for a whole revision: the BPMN plus every form must pass for the revision to be importable. */
export async function assessModelerImportability(artifacts: Pick<GeneratedArtifacts, 'bpmnXml' | 'forms'>): Promise<ImportabilityReport> {
  const problems = (await assessBpmnImportability(artifacts.bpmnXml)).map(problem => `process.bpmn: ${problem}`);
  const notes: string[] = [];
  for (const form of artifacts.forms) {
    const projected = projectFormForModeler(form.json);
    notes.push(...projected.notes.map(note => `${form.id}.form.json: ${note}`));
    problems.push(...assessFormImportability(projected.schema).map(problem => `${form.id}.form.json: ${problem}`));
  }
  return { importable: problems.length === 0, problems, notes };
}
