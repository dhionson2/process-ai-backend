import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiOrchestrator } from '../src/modules/ai/orchestrator.js';
import { compileBusinessIntent, applySemanticRefinement } from '../src/modules/ai/semantic-process.js';
import { technicalIntent } from '../src/modules/knowledge/capability-context.js';
import { validateProcessSpec, validateFormSubmission, validatePublicationReadiness } from '../src/modules/validation/validation.service.js';
import { generateArtifacts } from '../src/modules/generation/artifact-generator.js';
import { BpmKnowledgeEngine } from '../src/modules/knowledge/knowledge.engine.js';
import { buildApp } from '../src/app.js';
import { readEnvironment } from '../src/config/env.js';
import { InMemoryConversationRepository } from '../src/modules/projects/conversation.repository.js';
import { reconstructMessageHistory } from '../src/modules/ai/message-provenance.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const vacationSource = 'Crie um processo de férias. O servidor informa o período solicitado, o gestor aprova ou reprova. Se aprovar, o RH registra as férias. Se reprovar, o servidor recebe o motivo.';
export function recoveryIntent() {
  return { kind: 'business_intent', name: 'Solicitação de férias', purpose: 'Solicitar período, obter decisão e encaminhar o resultado.',
    actors: [{ name: 'servidor', evidence: 'O servidor informa o período solicitado' }, { name: 'gestor', evidence: 'o gestor aprova ou reprova' }, { name: 'RH', evidence: 'o RH registra as férias' }],
    startFields: [{ name: 'Início do período', type: 'date', evidence: 'O servidor informa o período solicitado', required: true }, { name: 'Fim do período', type: 'date', evidence: 'O servidor informa o período solicitado', required: true }],
    activities: [{ kind: 'approval', name: 'Aprovar ou reprovar', actor: 'gestor', evidence: 'o gestor aprova ou reprova', onApproved: [{ kind: 'task', name: 'Registrar férias', actor: 'RH', evidence: 'o RH registra as férias' }], onRejected: [{ kind: 'task', name: 'Receber motivo', actor: 'servidor', evidence: 'o servidor recebe o motivo' }] }], rules: [], suggestions: [], pendingConfiguration: [] };
}
const options = { targetProfile: 'generic-bpmn2' as const, model: 'controlled-replay', knowledgeVersion: '1.1.0', sourceText: vacationSource, activitySourceText: vacationSource };
const env = { aiTimeoutMs: 1000, aiContextTokens: 8192, aiMaxOutputTokens: 2048, aiMaxInputChars: 40000, aiMaxConcurrency: 1 };

test('interpretação administrativa não recebe catálogo técnico, binding ou política de ProcessSpec', async () => {
  let captured: any;
  const provider = { id: 'controlled', async generateStructured(request: any) { captured = request; return { value: recoveryIntent(), model: 'controlled', latencyMs: 1, usage: {} }; } };
  const result = await new AiOrchestrator(provider, 'controlled', env).generate({ text: vacationSource, history: [] });
  assert.equal(result.kind, 'proposed_spec');
  assert.doesNotMatch(captured.prompt, /people_api|hr_db|notification_mock|generation-result.v1|Gere `startEvent`/);
  const schema = JSON.stringify(captured.outputSchema);
  assert.doesNotMatch(schema, /connectorId|operationId|pendingConfiguration|resolutionEvidence|groupName/);
  assert.ok(result.diagnostics?.some(item => item.stage === 'validation' && item.status === 'valid'));
  assert.equal(technicalIntent('O setor registra o pedido e atualiza o registro administrativo.'), false);
  assert.equal(technicalIntent('Consultar HTTP e atualizar banco de dados por conector autorizado.'), true);
});

test('replay de perguntas reais de configuração não bloqueia uma intenção controlada completa', async () => {
  // Only these questions were retained in the old run. This is not a replay of its unavailable raw intent.
  const intent: any = recoveryIntent();
  intent.pendingConfiguration = [
    { scope: 'actor', blocking: true, question: 'Qual o grupo ou identidade que representa o Gestor para atribuição da tarefa de aprovação?' },
    { scope: 'integration', blocking: true, question: "Qual parâmetro da operação hr_db/set_request_status deve receber o status da solicitação (ex.: 'approved')?" },
  ];
  const provider = { id: 'replay', async generateStructured() { return { value: intent, model: 'controlled', latencyMs: 1, usage: {} }; } };
  const result = await new AiOrchestrator(provider, 'controlled', env).generate({ text: vacationSource, history: [] });
  assert.equal(result.kind, 'proposed_spec');
  if (result.kind !== 'proposed_spec') return;
  assert.equal(result.validation.valid, true);
  assert.equal((result.spec.nodes as any[]).some(node => node.action), false);
  assert.equal((result.artifacts?.manifest.publication as any).eligible, false);
  assert.equal((result.spec.pendingQuestions as any[]).some(item => item.question.includes('hr_db')), false);
});

test('férias controladas preservam os dois ramos, campos, justificativa e gate de publicação', async () => {
  const { spec } = await compileBusinessIntent(recoveryIntent(), options);
  assert.equal((await validateProcessSpec(spec)).valid, true);
  const gateway = spec.nodes.find((node: any) => node.type === 'exclusiveGateway');
  const routes = spec.flows.filter((flow: any) => flow.source === gateway.id);
  for (const [value, targetName] of [['approved', 'Registrar férias'], ['rejected', 'Receber motivo']]) {
    const flow = routes.find((item: any) => item.condition.right.literal === value);
    assert.equal(spec.nodes.find((node: any) => node.id === flow.target).name, targetName);
  }
  const form = spec.forms.find((item: any) => item.fields.some((field: any) => field.requiredWhen));
  const decision = form.fields.find((field: any) => field.type === 'select').bindTo;
  const reason = form.fields.find((field: any) => field.requiredWhen).bindTo;
  assert.equal((await validateFormSubmission(spec, form.id, { [decision]: 'approved' })).valid, true);
  assert.equal((await validateFormSubmission(spec, form.id, { [decision]: 'rejected' })).valid, false);
  assert.equal((await validateFormSubmission(spec, form.id, { [decision]: 'rejected', [reason]: 'Período indisponível' })).valid, true);
  assert.equal((await validatePublicationReadiness(spec, false)).publishable, false);
  const artifacts = await generateArtifacts(spec);
  assert.match(artifacts.bpmnXml, /BPMNDiagram/);
  assert.equal(artifacts.forms.length, 2);
});

test('integração inferida de verbo administrativo é rejeitada independentemente do schema enviado', async () => {
  const intent: any = recoveryIntent();
  intent.activities[0].onApproved = [{ kind: 'integration', name: 'Registrar férias', evidence: 'o RH registra as férias', connectorId: 'hr_db', operationId: 'set_request_status', inputs: [], outputs: [] }];
  await assert.rejects(() => compileBusinessIntent(intent, options), /sem solicitação explícita/);
});

test('consequência omitida ou deslocada para ramo errado não produz prévia semanticamente incompleta', async () => {
  for (const wrongBranch of [false, true]) {
    const intent: any = recoveryIntent();
    const rejected = intent.activities[0].onRejected.splice(0);
    if (wrongBranch) intent.activities[0].onApproved.push(...rejected);
    await assert.rejects(() => compileBusinessIntent(intent, options), /ramo reprovado não foi preservada/);
  }
});

test('resposta REST não promove a pergunta técnica da IA a evidência do usuário', async () => {
  const requests: any[] = [];
  const responses = [{ kind: 'need_clarification', summary: 'Teste de regressão', questions: [{ question: 'Qual campo mapear em hr_db/set_request_status?', blocking: true }] }, recoveryIntent()];
  const provider = { id: 'controlled', async generateStructured(request: any) { requests.push(request); return { value: responses.shift(), model: 'controlled', latencyMs: 1, usage: {} }; } };
  const app = await buildApp(readEnvironment({ AI_MODEL: 'controlled', LOG_LEVEL: 'silent' }), { modelProvider: provider, conversationRepository: new InMemoryConversationRepository() });
  try {
    const created = (await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Evidência isolada' } })).json();
    await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${created.sessionId}/messages`, payload: { text: vacationSource, baseRevision: 0 } });
    const answered = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${created.sessionId}/answers`, payload: { answers: ['Essa operação não foi solicitada. Mantenha apenas as tarefas descritas.'], baseRevision: 0 } });
    assert.equal(answered.json().status, 'validated', answered.body);
    assert.doesNotMatch(JSON.stringify(requests[1].outputSchema), /connectorId|operationId/);
    const history = (await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${created.sessionId}/history` })).json();
    assert.equal(history.messages.filter((item: any) => item.role === 'user').some((item: any) => item.content.includes('hr_db')), false);
  } finally { await app.close(); }
});

test('histórico legado remove pergunta da IA embutida na resposta sem apagar persistência nem reatribuir autoria', () => {
  const messages: any[] = [
    { id: 'q', role: 'assistant', content: 'Qual grupo deve receber a tarefa?', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'a', role: 'user', content: 'Pergunta: Qual grupo deve receber a tarefa?\n\nResposta: Deixe a identidade pendente.', createdAt: '2026-01-01T00:00:01Z' },
  ];
  const stored = structuredClone(messages);
  const history = reconstructMessageHistory(messages, [{ question: 'Qual grupo deve receber a tarefa?', answer: 'Deixe a identidade pendente.', confirmedAt: '2026-01-01T00:00:01Z' }]);
  assert.equal(history[0].role, 'assistant');
  assert.equal(history[0].content, 'Qual grupo deve receber a tarefa?');
  assert.equal(history[1].role, 'user');
  assert.equal(history[1].content, 'Deixe a identidade pendente.');
  assert.deepEqual(messages, stored, 'a projeção de histórico não altera o registro original');
});

test('endpoint de histórico reconstrói separadamente pergunta legada e resposta do usuário', async () => {
  const repository = new InMemoryConversationRepository();
  const app = await buildApp(readEnvironment({ AI_MODEL: 'history-test', LOG_LEVEL: 'silent' }), {
    modelProvider: { id: 'history-test', async generateStructured() { throw new Error('unexpected model call'); } },
    conversationRepository: repository,
  });
  try {
    const created = (await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Histórico legado' } })).json();
    const question = 'Qual grupo deve receber a tarefa?';
    const answer = 'Mantenha a identidade pendente.';
    await repository.appendMessage('local-dev', created.sessionId, 'assistant', question);
    await repository.appendMessage('local-dev', created.sessionId, 'user', `Pergunta: ${question}\n\nResposta: ${answer}`);
    await repository.appendConfirmedFacts('local-dev', created.sessionId, [{ question, answer, confirmedAt: '2026-01-01T00:00:00Z' }]);
    const history = (await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${created.sessionId}/history` })).json();
    assert.deepEqual(history.messages.map((message: any) => ({ role: message.role, content: message.content })), [
      { role: 'assistant', content: question }, { role: 'user', content: answer },
    ]);
  } finally { await app.close(); }
});

test('refinamento com novo papel funcional mantém binding pendente e todas as etapas anteriores', async () => {
  const { spec } = await compileBusinessIntent(recoveryIntent(), options);
  const original = structuredClone(spec);
  const refined = applySemanticRefinement(spec, { kind: 'refinement', operations: [{ kind: 'insertApprovalBefore', beforeActivity: 'Registrar férias', rejectedTargetActivity: 'Receber motivo', approval: { name: 'Aprovação do diretor', actor: { name: 'Diretor' }, requiresRejectionReason: true } }] }, { sourceText: vacationSource + ' O diretor fará a segunda aprovação antes de registrar férias.' });
  assert.deepEqual(spec, original);
  for (const node of spec.nodes) assert.deepEqual(refined.nodes.find((item: any) => item.id === node.id), node);
  assert.equal(refined.roles.find((role: any) => role.label === 'Diretor').resolution, 'unresolved');
  assert.equal((await validateProcessSpec(refined)).valid, true);
  assert.equal(refined.nodes.filter((node: any) => node.type === 'exclusiveGateway').length, 2);
  assert.equal(((await generateArtifacts(refined)).manifest.publication as any).eligible, false);
});

test('replay da resposta real Groq que referenciou atividades por ID preserva os dois ramos', async () => {
  const source = 'Crie um processo de férias. O servidor informa o período solicitado, o gestor aprova ou reprova. Se aprovar, o RH registra as férias. Se reprovar, o servidor recebe o motivo.';
  const intent: any = recoveryIntent();
  intent.name = 'Processo de férias';
  intent.actors = [
    { name: 'Servidor', evidence: 'O servidor informa o período solicitado', resolution: 'requester', resolutionEvidence: 'O servidor informa o período solicitado' },
    { name: 'Gestor', evidence: 'o gestor aprova ou reprova' },
    { name: 'RH', evidence: 'o RH registra as férias' },
  ];
  intent.activities = [
    { kind: 'task', name: 'Informar período de férias', actor: 'Servidor', evidence: 'O servidor informa o período solicitado', fields: [{ name: 'período', type: 'text', required: true, evidence: 'O servidor informa o período solicitado' }] },
    { kind: 'approval', name: 'Aprovar férias', actor: 'Gestor', evidence: 'o gestor aprova ou reprova', requiresRejectionReason: true,
      onApproved: [{ kind: 'task', name: 'Registrar férias', actor: 'RH', evidence: 'o RH registra as férias' }],
      onRejected: [{ kind: 'task', name: 'Comunicar motivo ao servidor', actor: 'Servidor', evidence: 'o servidor recebe o motivo' }] },
  ];
  const compiled = await compileBusinessIntent(intent, { ...options, sourceText: source, activitySourceText: source });
  const captured = JSON.parse(await readFile(resolve('tests/fixtures/groq-real-refinement.json'), 'utf8'));
  const answer = 'O diretor fará a segunda aprovação. Se reprovar, o servidor recebe o motivo, como na primeira aprovação.';
  const refined = applySemanticRefinement(compiled.spec, captured, { sourceText: `${source}\n${answer}` });
  assert.equal((await validateProcessSpec(refined)).valid, true);
  const gateway = refined.nodes.find((node: any) => node.name === 'Segunda aprovação' && node.type === 'exclusiveGateway');
  const routes = refined.flows.filter((flow: any) => flow.source === gateway.id);
  const destination = (value: string) => refined.nodes.find((node: any) => node.id === routes.find((flow: any) => flow.condition?.right?.literal === value)?.target)?.name;
  assert.equal(destination('approved'), 'Registrar férias');
  assert.equal(destination('rejected'), 'Comunicar motivo ao servidor');
  assert.equal(refined.roles.find((role: any) => role.label === 'Diretor').resolution, 'unresolved');
  assert.equal(((await generateArtifacts(refined)).manifest.publication as any).eligible, false);
});

test('encaminhamento administrativo para outro setor não precisa de operação técnica', async () => {
  const source = 'O atendente encaminha o pedido. O protocolo recebe o pedido.';
  const intent = { kind: 'business_intent', name: 'Encaminhamento', purpose: source, actors: [{ name: 'atendente' }, { name: 'protocolo' }], startFields: [], activities: [{ kind: 'task', name: 'Encaminhar pedido', actor: 'atendente', evidence: 'O atendente encaminha o pedido' }, { kind: 'task', name: 'Receber pedido', actor: 'protocolo', evidence: 'O protocolo recebe o pedido' }], rules: [], suggestions: [], pendingConfiguration: [] };
  const { spec } = await compileBusinessIntent(intent, { ...options, sourceText: source, activitySourceText: source });
  assert.equal((await validateProcessSpec(spec)).valid, true);
  assert.equal(spec.nodes.filter((node: any) => node.type === 'userTask').length, 2);
  assert.equal(spec.nodes.some((node: any) => node.action), false);
});
