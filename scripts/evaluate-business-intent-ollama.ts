import { Ajv2020 } from 'ajv/dist/2020.js';
import { readEnvironment } from '../src/config/env.js';
import { generateArtifacts } from '../src/modules/generation/artifact-generator.js';
import { BpmKnowledgeEngine } from '../src/modules/knowledge/knowledge.engine.js';
import { OllamaProvider } from '../src/modules/providers/model-provider.js';
import { validateProcessSpec } from '../src/modules/validation/validation.service.js';
import { businessIntentSchema, compileBusinessIntent } from '../src/modules/ai/semantic-process.js';

const env = readEnvironment();
if (env.aiProvider !== 'ollama' || !env.aiModel) throw new Error('Configure AI_PROVIDER=ollama e AI_MODEL no ambiente');
const provider = new OllamaProvider(env.ollamaBaseUrl);
const knowledge = new BpmKnowledgeEngine();
const schema = businessIntentSchema();
const validateJson = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
const cases = [
  {
    id: 'vacation',
    text: 'Crie um processo de solicitação de férias. O servidor faz a solicitação, o gestor aprova ou reprova e, se aprovado, o RH registra. Se reprovado, o servidor deve ser informado do motivo.',
  },
  {
    id: 'administrative-approval',
    text: 'Modele uma aprovação administrativa simples: o solicitante envia um pedido e um analista aprova ou rejeita. Encerre o processo em qualquer resultado.',
  },
];

for (const item of cases) {
  const selected = await knowledge.select(item.text, Math.min(7000, env.aiMaxInputChars / 2));
  const prompt = `Extraia somente os fatos literais da solicitação abaixo para BusinessIntent. Não copie fatos dos exemplos/conhecimento. Não invente tarefas, campos, regras ou perguntas. Se uma informação for desconhecida, deixe ausente ou use pendingConfiguration somente quando estruturalmente necessária. Use nomes e conteúdo em português. Cada evidence deve ser um trecho literal contíguo da solicitação.\n\nSolicitação do usuário:\n${item.text}\n\nConhecimento explicativo versionado (não é fonte de fatos do usuário):\n${selected.text}`;
  try {
    const response = await provider.generateStructured({
      model: env.aiModel, system: 'Você é um extrator de fatos de processo. Responda somente com BusinessIntent JSON conforme schema. Conhecimento externo ao pedido nunca é fato confirmado.',
      prompt, outputSchema: schema, timeoutMs: env.aiTimeoutMs, contextTokens: env.aiContextTokens,
      maxOutputTokens: env.aiMaxOutputTokens, temperature: 0,
    });
    const rawValid = validateJson(response.value);
    const businessIntent = response.value as Record<string, any>;
    let result: Record<string, unknown>;
    if (!rawValid) {
      result = { outcome: 'invalid-structured-output', schemaErrors: validateJson.errors?.map(error => ({ path: error.instancePath, message: error.message })) };
    } else if (businessIntent.kind === 'need_clarification') {
      result = { outcome: 'model-asks-clarification', questions: businessIntent.questions };
    } else {
      try {
        const compiled = await compileBusinessIntent(businessIntent, {
          targetProfile: 'generic-bpmn2', knowledgeVersion: selected.version, model: response.model,
          sourceText: item.text, activitySourceText: item.text, knowledgeText: selected.text,
        });
        const validation = await validateProcessSpec(compiled.spec);
        const artifacts = validation.valid ? await generateArtifacts(compiled.spec) : undefined;
        result = {
          outcome: validation.valid && artifacts && !artifacts.diagnostics.some(diagnostic => diagnostic.severity === 'error') ? 'valid-artifacts' : 'validation-failed',
          validation: validation.diagnostics.map(({ code, path, message }) => ({ code, path, message })),
          extracted: { actors: compiled.businessIntent.actors, activities: compiled.businessIntent.activities, fields: compiled.businessIntent.startFields, rules: compiled.businessIntent.rules, suggestions: compiled.businessIntent.suggestions, pendingConfiguration: compiled.businessIntent.pendingConfiguration },
          processSpec: { id: compiled.spec.id, status: compiled.spec.status, roles: compiled.spec.roles, nodes: compiled.spec.nodes.map((node: any) => ({ id: node.id, type: node.type, name: node.name })), flows: compiled.spec.flows, pendingQuestions: compiled.spec.pendingQuestions }, artifactSummary: artifacts && { bpmnChars: artifacts.bpmnXml.length, forms: artifacts.forms.map((form: any) => ({ id: form.id, fields: form.json.components.map((component: any) => component.label) })), publicationEligible: artifacts.manifest.publication.eligible },
        };
      } catch (error) {
        result = { outcome: 'compilation-clarification-or-rejection', error: error instanceof Error ? error.message : 'Erro de compilação', extracted: businessIntent };
      }
    }
    console.log(JSON.stringify({ scenario: item.id, provider: provider.id, model: response.model, latencyMs: response.latencyMs, usage: response.usage, knowledgeModules: selected.moduleIds, ...result }));
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    console.log(JSON.stringify({ scenario: item.id, provider: provider.id, model: env.aiModel, outcome: 'provider-failure', code: failure.code || 'UNKNOWN', message: failure.message || 'falha' }));
  }
}
