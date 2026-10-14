import type { ExampleArtifact, ExampleBundle, ExampleListItem, ExampleSlug } from '../../domain/contracts.js';
import { readFoundationJson, readFoundationText } from '../../shared/files.js';

const index: ExampleListItem[] = [
  { id: 'ferias', name: 'Solicitação de férias', description: 'Aprovação do gestor, RH e comunicação' },
  { id: 'http-db', name: 'Integração HTTP e atualização de registro', description: 'Fluxo declarativo, sem chamadas ou SQL executados' },
];
export function listExamples(): ExampleListItem[] { return index; }
export async function getExample(id: ExampleSlug): Promise<ExampleBundle> {
  const spec = await readFoundationJson(`examples/${id}.json`) as Record<string, unknown>;
  const manifest = await readFoundationJson(`examples/generated/${id}.manifest.json`) as Record<string, unknown>;
  const bpmnXml = await readFoundationText(`examples/generated/${id}.bpmn`);
  const exampleFiles = id === 'ferias'
    ? [['form_inicio', 'ferias-form_inicio.form.json'], ['form_gestor', 'ferias-form_gestor.form.json'], ['form_rh', 'ferias-form_rh.form.json']]
    : [['frm_param', 'http-db-frm_param.form.json'], ['frm_approve', 'http-db-frm_approve.form.json']];
  const forms: ExampleArtifact[] = await Promise.all(exampleFiles.map(async ([formId, filename]) => ({
    id: formId, schema: await readFoundationJson(`examples/generated/${filename}`),
  })));
  return {
    spec, manifest, bpmnXml, forms,
    notice: 'Prévia estática de referência. Não executável nem homologada com Flowable ou Unique.',
  };
}
