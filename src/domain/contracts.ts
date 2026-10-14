export type Diagnostic = { code: string; path: string; message: string; severity: 'error' | 'warning' };
export type ValidationResult = { valid: boolean; diagnostics: Diagnostic[] };
export type ExampleSlug = 'ferias' | 'http-db';
export interface ExampleListItem { id: ExampleSlug; name: string; description: string }
export interface ExampleArtifact { id: string; schema: unknown }
export interface ExampleBundle {
  spec: Record<string, unknown>;
  bpmnXml: string;
  forms: ExampleArtifact[];
  manifest: Record<string, unknown>;
  notice: string;
}
// O tipo de domínio completo deriva de specs/foundation/contracts/process-spec.v1.schema.json.
// Não inventar aqui um segundo schema independente: usar codegen após estabilizar contrato.
