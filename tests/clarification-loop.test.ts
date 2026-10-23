import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEnvironment } from '../src/config/env.js';
import { answerPolarity, applyConfirmations, collectConfirmations, confirmationKey } from '../src/modules/ai/confirmations.js';
import { AiOrchestrator } from '../src/modules/ai/orchestrator.js';
import { recoveryGuidance } from '../src/modules/ai/recovery-guidance.js';
import type { ModelProvider, StructuredRequest, StructuredResponse } from '../src/modules/providers/model-provider.js';

const text = 'O servidor solicitante faz a solicitação informando a data inicial e a data final das férias. O gestor é selecionado manualmente pelo operador autorizado e aprova ou reprova. O RH é grupo RH e registra se houver aprovação. Se reprovado, o servidor deve ser informado do motivo.';
const supported = () => ({
  kind: 'business_intent', name: 'Solicitação de férias', purpose: 'Férias com decisão do gestor.',
  actors: [{ name: 'Servidor', evidence: 'servidor solicitante faz a solicitação' }, { name: 'Gestor', evidence: 'O gestor é selecionado manualmente pelo operador autorizado e aprova ou reprova' }, { name: 'RH', evidence: 'O RH é grupo RH e registra se houver aprovação' }],
  startFields: [{ name: 'Data inicial', type: 'date', required: true, evidence: 'data inicial e a data final das férias' }] as any[],
  activities: [{ kind: 'approval', name: 'Aprovar ou reprovar solicitação', actor: 'Gestor', evidence: 'O gestor é selecionado manualmente pelo operador autorizado e aprova ou reprova', requiresRejectionReason: true,
    onApproved: [{ kind: 'task', name: 'Registrar férias', actor: 'RH', evidence: 'O RH é grupo RH e registra se houver aprovação' }] as any[],
    onRejected: [{ kind: 'task', name: 'Receber motivo', actor: 'Servidor', evidence: 'o servidor deve ser informado do motivo' }] }] as any[],
  rules: [], suggestions: [],
});

/** Each case adds exactly one step the requester never wrote with those words, at a different level of the plan. */
const cases = [
  { kind: 'activity' as const, name: 'Lançar no sistema de ponto', build: () => { const plan = supported(); plan.activities[0].onApproved.push({ kind: 'task', name: 'Lançar no sistema de ponto', actor: 'RH', evidence: 'O RH é grupo RH e registra se houver aprovação' }); return plan; },
    present: (spec: any) => spec.nodes.some((node: any) => node.name === 'Lançar no sistema de ponto') },
  { kind: 'activity' as const, name: 'Conferir documentação', build: () => { const plan = supported(); plan.activities.unshift({ kind: 'task', name: 'Conferir documentação', actor: 'Gestor', evidence: 'O gestor é selecionado manualmente pelo operador autorizado' }); return plan; },
    present: (spec: any) => spec.nodes.some((node: any) => node.name === 'Conferir documentação') },
];

class Stubborn implements ModelProvider {
  readonly id = 'stubborn';
  calls = 0;
  constructor(private readonly plan: unknown) {}
  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> { this.calls += 1; return { value: structuredClone(this.plan), usage: {}, latencyMs: 1, model: request.model }; }
}
const environment = readEnvironment({ LOG_LEVEL: 'silent', AI_READINESS_GATE: 'off' });
const fact = (question: any, answer: string) => ({ question: question.question, answer, requirementId: question.requirementId, semanticSlot: question.semanticSlot, confirmedAt: new Date().toISOString(), state: 'confirmed' as const });

test('polaridade da resposta: início da frase decide; o resto é descrição', () => {
  for (const answer of ['sim', 'Sim ela deve compro o fluxo', 'sim, mas depois do RH', 'Deve sim', 'Confirmo', 'ok', 'isso mesmo', 'pode manter']) assert.equal(answerPolarity(answer), 'yes', answer);
  for (const answer of ['não', 'Nao precisa', 'não, pode tirar', 'remova essa etapa', 'tira isso', 'não deve existir']) assert.equal(answerPolarity(answer), 'no', answer);
  for (const answer of ['o RH confere o valor', 'depende do valor', '']) assert.equal(answerPolarity(answer), 'unknown', answer);
});

test('confirmação vira evidência citável e rejeição retira o elemento, em qualquer nível do plano', () => {
  const plan = cases[0].build();
  plan.startFields.push({ name: 'Matrícula', type: 'text', required: true, evidence: 'x' });
  const confirmations = collectConfirmations([
    { question: 'q1', answer: 'sim', requirementId: confirmationKey({ kind: 'activity', name: 'Lançar no sistema de ponto' }), confirmedAt: 'x' },
    { question: 'q2', answer: 'não', requirementId: confirmationKey({ kind: 'field', name: 'Matrícula' }), confirmedAt: 'x' },
    { question: 'q3', answer: 'o rh confere', requirementId: confirmationKey({ kind: 'actor', name: 'RH' }), confirmedAt: 'x' },
  ]);
  const applied = applyConfirmations(plan, confirmations);
  const nested = applied.activities[0].onApproved.find((step: any) => step.name === 'Lançar no sistema de ponto');
  assert.equal(nested.evidence, 'O solicitante confirmou: a etapa “Lançar no sistema de ponto” deve fazer parte do processo.');
  assert.ok(!applied.startFields.some((field: any) => field.name === 'Matrícula'));
  assert.equal(applied.actors.find((actor: any) => actor.name === 'RH').evidence, 'O RH é grupo RH e registra se houver aprovação', 'resposta descritiva não decide sozinha');
  assert.equal(confirmations.statements.length, 1);
  assert.deepEqual(applyConfirmations(plan, { confirmed: [], rejected: [], statements: [] }), plan, 'sem respostas o plano não muda');
});

for (const scenario of cases) {
  test(`${scenario.kind} sem sustentação literal: corrige no modelo, pergunta uma vez, "sim" inclui, "não" retira, e nunca repete`, async () => {
    const plan = scenario.build();
    const first = new Stubborn(plan);
    const asked: any = await new AiOrchestrator(first, 'm', environment).generate({ text, history: [] });
    assert.equal(asked.kind, 'need_clarification');
    assert.equal(first.calls, 2, 'uma correção dirigida ao modelo antes de perguntar à pessoa');
    const question = asked.questions[0];
    assert.equal(question.requirementId, confirmationKey({ kind: scenario.kind, name: scenario.name }), 'pergunta amarrada ao elemento');
    assert.match(question.question, /Responda sim ou não, ou descreva com suas palavras/);

    const yes: any = await new AiOrchestrator(new Stubborn(plan), 'm', environment).generate({ text: 'sim', history: [{ role: 'user', content: text }], confirmedFacts: [fact(question, 'sim')] });
    assert.equal(yes.kind, 'proposed_spec', JSON.stringify(yes.questions ?? yes.diagnostics?.slice(-3)));
    assert.equal(scenario.present(yes.spec), true, 'o elemento confirmado entra no processo');

    if (scenario.kind !== 'actor') {
      const no: any = await new AiOrchestrator(new Stubborn(plan), 'm', environment).generate({ text: 'não', history: [{ role: 'user', content: text }], confirmedFacts: [fact(question, 'não, pode tirar')] });
      assert.equal(no.kind, 'proposed_spec');
      assert.equal(scenario.present(no.spec), false, 'o elemento rejeitado sai do processo');
    }

    await assert.rejects(
      () => new AiOrchestrator(new Stubborn(plan), 'm', environment).generate({ text: 'texto livre', history: [{ role: 'user', content: text }], confirmedFacts: [fact(question, 'depende do valor')] }),
      (error: any) => error.code === 'CLARIFICATION_UNRESOLVED',
      'resposta que não resolve gera orientação, nunca a mesma pergunta de novo',
    );
  });
}

test('campo ou participante sem sustentação literal ficam fora como sugestão, sem pergunta e sem loop', async () => {
  const plan = supported();
  plan.startFields.push({ name: 'Matrícula', type: 'text', required: true, evidence: 'número de matrícula do servidor' });
  plan.actors.push({ name: 'Diretoria', evidence: 'a diretoria acompanha' });
  const outcome: any = await new AiOrchestrator(new Stubborn(plan), 'm', environment).generate({ text, history: [] });
  assert.equal(outcome.kind, 'proposed_spec');
  assert.ok(!outcome.spec.forms.some((form: any) => form.fields.some((field: any) => field.label === 'Matrícula')));
  assert.ok(!outcome.spec.roles.some((role: any) => role.label === 'Diretoria'));
});

test('trava anti-loop vale para qualquer origem e orienta a pessoa a reescrever', async () => {
  const question = { question: 'Quem aprova o pedido?', blocking: true };
  const model = { id: 'repeat', async generateStructured(request: StructuredRequest) { return { value: { kind: 'need_clarification', questions: [question, { question: 'Há prazo para a aprovação?', blocking: true }] }, usage: {}, latencyMs: 1, model: request.model }; } };
  const outcome: any = await new AiOrchestrator(model as ModelProvider, 'm', environment).generate({ text: 'Um pedido.', history: [], confirmedFacts: [{ question: question.question, answer: 'O gestor', confirmedAt: 'x' }] });
  assert.deepEqual(outcome.questions.map((item: any) => item.question), ['Há prazo para a aprovação?'], 'só a pergunta nova chega à pessoa');
  const guidance = recoveryGuidance('CLARIFICATION_UNRESOLVED');
  assert.equal(guidance.category, 'missing-information');
  assert.deepEqual(guidance.actions, ['rephrase']);
});

test('API: a resposta à pergunta de confirmação sobrevive à persistência e destrava o elemento (sem loop)', async () => {
  const { buildApp } = await import('../src/app.js');
  const { InMemoryConversationRepository } = await import('../src/modules/projects/conversation.repository.js');
  const plan = cases[0].build();
  const provider = new Stubborn(plan);
  const app = await buildApp(readEnvironment({ LOG_LEVEL: 'silent', AI_READINESS_GATE: 'off' }), { conversationRepository: new InMemoryConversationRepository(), modelProvider: provider });
  try {
    const { sessionId } = (await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Loop', targetProfile: 'generic-bpmn2' } })).json();
    const asked = (await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, payload: { text, baseRevision: 0 } })).json();
    assert.equal(asked.status, 'needs-input');
    assert.match(asked.questions[0].question, /Lançar no sistema de ponto/);
    const answered = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/answers`, payload: { answers: ['sim ela deve compor o fluxo'], baseRevision: 0, questionSetId: asked.questionSetId } });
    assert.equal(answered.json().status, 'validated', JSON.stringify(answered.json()).slice(0, 400));
    const spec = (await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}/revisions/1` })).json().processSpec;
    assert.ok(spec.nodes.some((node: any) => node.name === 'Lançar no sistema de ponto'));
  } finally { await app.close(); }
});
