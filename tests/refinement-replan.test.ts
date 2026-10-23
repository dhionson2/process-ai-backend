import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEnvironment } from '../src/config/env.js';
import { AiOrchestrator } from '../src/modules/ai/orchestrator.js';
import { removalKey, requestMentions, sameElement, unexpectedRemovals } from '../src/modules/ai/preservation.js';
import { describeSpec } from '../src/modules/ai/spec-summary.js';
import type { ModelProvider, StructuredRequest, StructuredResponse } from '../src/modules/providers/model-provider.js';

const text = 'O servidor solicitante faz a solicitação informando a data inicial e a data final das férias. O gestor é selecionado manualmente pelo operador autorizado e aprova ou reprova. O RH é grupo RH e registra se houver aprovação. Se reprovado, o servidor deve ser informado do motivo.';
const intent = (): any => ({
  kind: 'business_intent', name: 'Solicitação de férias', purpose: 'Férias com decisão do gestor.',
  actors: [{ name: 'Servidor', evidence: 'servidor solicitante faz a solicitação' }, { name: 'Gestor', evidence: 'O gestor é selecionado manualmente pelo operador autorizado e aprova ou reprova' }, { name: 'RH', evidence: 'O RH é grupo RH e registra se houver aprovação' }],
  startFields: [{ name: 'Data inicial', type: 'date', required: true, evidence: 'data inicial e a data final das férias' }],
  activities: [{ kind: 'approval', name: 'Aprovar ou reprovar solicitação', actor: 'Gestor', evidence: 'O gestor é selecionado manualmente pelo operador autorizado e aprova ou reprova', requiresRejectionReason: true,
    onApproved: [{ kind: 'task', name: 'Registrar férias', actor: 'RH', evidence: 'O RH é grupo RH e registra se houver aprovação' }],
    onRejected: [{ kind: 'task', name: 'Receber motivo', actor: 'Servidor', evidence: 'o servidor deve ser informado do motivo' }] }],
  rules: [], suggestions: [],
});
class Queue implements ModelProvider {
  readonly id = 'queue';
  readonly prompts: StructuredRequest[] = [];
  constructor(private readonly responses: unknown[]) {}
  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    this.prompts.push(request);
    const value = this.responses.length > 1 ? this.responses.shift() : this.responses[0];
    return { value: structuredClone(value), usage: {}, latencyMs: 1, model: request.model };
  }
}
const environment = readEnvironment({ LOG_LEVEL: 'silent', AI_READINESS_GATE: 'off' });
const orchestrator = (provider: ModelProvider) => new AiOrchestrator(provider, 'm', environment);
const names = (spec: any) => spec.nodes.filter((node: any) => node.type === 'userTask' || node.type === 'serviceTask').map((node: any) => node.name);

async function firstVersion() {
  const outcome: any = await orchestrator(new Queue([intent()])).generate({ text, history: [] });
  assert.equal(outcome.kind, 'proposed_spec', JSON.stringify(outcome.questions ?? outcome.diagnostics?.slice(-2)));
  return outcome.spec;
}
const refine = (provider: ModelProvider, request: string, spec: any, confirmedFacts: any[] = []) =>
  orchestrator(provider).generate({ text: request, history: [{ role: 'user', content: text }], currentSpec: spec, originalSource: { id: 'm1', text }, authoritativeUserMessages: [{ id: 'm1', text }], confirmedFacts }) as Promise<any>;

test('resumo do processo atual lista etapas em ordem, decisões com ramos e participantes', async () => {
  const summary = describeSpec(await firstVersion());
  assert.match(summary, /Participantes: .*Gestor/);
  assert.match(summary, /1\. Aprovar ou reprovar solicitação \(Gestor/);
  assert.match(summary, /Decisão “.*”: .*→ Registrar férias.*\|.*→ Receber motivo/);
  assert.match(summary, /Dados informados no início: Data inicial/);
});

test('ajuste = replanejamento completo: a etapa pedida entra, o resto fica, com o mesmo contrato da primeira versão', async () => {
  const spec = await firstVersion();
  const plan = intent();
  plan.activities[0].onApproved.push({ kind: 'task', name: 'Pagar férias', actor: 'RH', evidence: 'o RH paga as férias depois de registrar' });
  const provider = new Queue([plan]);
  const outcome = await refine(provider, 'Depois de registrar, o RH paga as férias depois de registrar.', spec);
  assert.equal(outcome.kind, 'proposed_spec', JSON.stringify(outcome.questions ?? outcome.diagnostics?.slice(-3)));
  assert.deepEqual(names(outcome.spec), ['Aprovar ou reprovar solicitação', 'Registrar férias', 'Pagar férias', 'Receber motivo'].sort((a, b) => names(outcome.spec).indexOf(a) - names(outcome.spec).indexOf(b)));
  assert.ok(names(outcome.spec).includes('Pagar férias'));
  assert.equal(provider.prompts.length, 1, 'uma chamada: nada para corrigir');
  assert.match(provider.prompts[0].prompt, /Pedido de ajuste atual \(o que muda\):\nDepois de registrar/);
});

test('o que sumir sem ter sido pedido é corrigido uma vez e depois perguntado, uma pergunta por elemento, amarrada ao elemento', async () => {
  const spec = await firstVersion();
  const dropping = intent(); dropping.activities[0].onApproved = []; // "Registrar férias" vanished
  const provider = new Queue([dropping]);
  const outcome = await refine(provider, 'Inclua a data de retorno no formulário inicial informando a data inicial e a data final das férias.', spec);
  assert.equal(provider.prompts.length, 2, 'uma correção dirigida ao modelo antes de perguntar à pessoa');
  assert.match(provider.prompts[1].prompt, /deixaria de fora “Registrar férias”/);
  assert.equal(outcome.kind, 'need_clarification', JSON.stringify(outcome));
  assert.equal(outcome.questions.length, 1);
  assert.match(outcome.questions[0].question, /“Registrar férias” deixaria de existir.*Confirma a remoção/);
  assert.equal(outcome.questions[0].requirementId, removalKey({ kind: 'activity', name: 'Registrar férias' }));
  assert.match(outcome.summary, /deixaria de fora parte do processo atual/);

  // "sim": the removal is approved and the next turn goes through without asking again.
  const fact = { question: outcome.questions[0].question, answer: 'sim', requirementId: outcome.questions[0].requirementId, confirmedAt: 'x' };
  const approved = await refine(new Queue([dropping]), 'sim', spec, [fact]);
  assert.equal(approved.kind, 'proposed_spec', JSON.stringify(approved.questions));
  assert.ok(!names(approved.spec).includes('Registrar férias'));

  // "não": the element must stay; a model that keeps dropping it never produces the same question twice.
  await assert.rejects(() => refine(new Queue([dropping]), 'não', spec, [{ ...fact, answer: 'não, mantenha' }]), (error: any) => error.code === 'CLARIFICATION_UNRESOLVED');
});

test('remoção pedida explicitamente não gera pergunta', async () => {
  const spec = await firstVersion();
  const dropping = intent(); dropping.activities[0].onApproved = [];
  const provider = new Queue([dropping]);
  const outcome = await refine(provider, 'Remova a etapa Registrar férias.', spec);
  assert.equal(outcome.kind, 'proposed_spec', JSON.stringify(outcome.questions));
  assert.equal(provider.prompts.length, 1);
  assert.ok(!names(outcome.spec).includes('Registrar férias'));
});

test('renomear não conta como remover; mencionar o elemento no pedido libera a mudança', () => {
  assert.equal(sameElement('Pagar reembolso', 'Pagar reembolso ao colaborador'), true);
  assert.equal(sameElement('Analisar solicitação de férias', 'Análise da solicitação'), true);
  assert.equal(sameElement('Registrar férias', 'Pagar férias'), false);
  assert.equal(requestMentions('Renomeie "Registrar férias" para "Lançar férias no sistema"', 'Registrar férias'), true);
  assert.equal(requestMentions('Inclua a data de retorno', 'Registrar férias'), false);
  const current = { nodes: [{ type: 'userTask', name: 'Registrar férias' }, { type: 'exclusiveGateway', name: 'Aprovado?' }], roles: [{ label: 'RH' }] };
  const next = { nodes: [{ type: 'userTask', name: 'Lançar férias no sistema' }, { type: 'exclusiveGateway', name: 'Aprovado?' }], roles: [{ label: 'RH' }] };
  assert.deepEqual(unexpectedRemovals(current, next, 'troque o nome', { approved: new Set(), kept: new Set() }).map(item => item.name), ['Registrar férias']);
  assert.deepEqual(unexpectedRemovals(current, next, 'Renomeie Registrar férias', { approved: new Set(), kept: new Set() }), []);
});

test('elementos sem sustentação literal são perguntados todos de uma vez, e erro de digitação não derruba a citação', async () => {
  const plan = intent();
  plan.activities[0].onApproved.push({ kind: 'task', name: 'Lançar no ponto', actor: 'RH', evidence: 'O RH é grupo RH e registra se houver aprovação' });
  plan.activities.unshift({ kind: 'task', name: 'Conferir documentação', actor: 'Gestor', evidence: 'O gestor é selecionado manualmente pelo operador autorizado' });
  const provider = new Queue([plan]);
  const outcome: any = await orchestrator(provider).generate({ text, history: [] });
  assert.equal(outcome.kind, 'need_clarification', JSON.stringify(outcome));
  assert.deepEqual(outcome.questions.map((question: any) => question.requirementId).sort(), ['confirm:activity:conferir documentacao', 'confirm:activity:lancar no ponto']);
  assert.equal(provider.prompts.length, 2, 'uma correção dirigida antes de perguntar');

  const typo = text.replace('férias', 'verias').replace('reprova', 'repova');
  const typed = intent(); typed.activities[0].onApproved[0].evidence = 'o RH registra se houver aprovação';
  const fine: any = await orchestrator(new Queue([typed])).generate({ text: typo, history: [] });
  assert.equal(fine.kind, 'proposed_spec', JSON.stringify(fine.questions));
});
