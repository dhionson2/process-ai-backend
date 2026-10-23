import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { readEnvironment } from '../src/config/env.js';
import { selectSimilarExamples } from '../src/modules/ai/examples.js';
import { AiOrchestrator } from '../src/modules/ai/orchestrator.js';
import { diffSpecs } from '../src/modules/ai/revision-diff.js';
import { InMemoryConversationRepository } from '../src/modules/projects/conversation.repository.js';
import type { ModelProvider, StructuredRequest, StructuredResponse } from '../src/modules/providers/model-provider.js';

const spec = async () => JSON.parse(await readFile('reports/marco2-recovery-2026-10-14/C.process-spec.json', 'utf8'));

test('diff de negócio aponta etapa renomeada, campo removido e obrigatoriedade alterada', async () => {
  const before = await spec();
  const after = structuredClone(before);
  const task = after.nodes.find((node: any) => node.type === 'userTask');
  task.name = 'Conferir e registrar férias';
  const form = after.forms.find((item: any) => item.fields.length > 1);
  const removed = form.fields.pop();
  form.fields[0].required = !form.fields[0].required;
  const diff = diffSpecs(before, after, 1, 2);
  assert.ok(diff.changes.some(change => change.kind === 'changed' && change.area === 'etapa' && change.description.includes('Conferir e registrar férias')));
  assert.ok(diff.changes.some(change => change.kind === 'removed' && change.area === 'campo' && change.description.includes(removed.label)));
  assert.ok(diff.changes.some(change => change.kind === 'changed' && change.area === 'campo' && /obrigatório/.test(change.description)));
  assert.deepEqual(diffSpecs(before, before, 1, 1).changes, []);
});

test('API: diff entre revisões, restauração como nova revisão e ledger com veredito', async () => {
  const app = await buildApp(readEnvironment({ LOG_LEVEL: 'silent' }), { conversationRepository: new InMemoryConversationRepository() });
  try {
    const { sessionId } = (await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Domínio', targetProfile: 'generic-bpmn2' } })).json();
    const original = await spec();
    assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/design-sessions/${sessionId}/draft`, payload: { baseRevision: 0, processSpec: original } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/revisions/1/accept`, payload: { baseRevision: 0 } })).statusCode, 200);
    const edited = structuredClone(original);
    edited.nodes.find((node: any) => node.type === 'userTask').name = 'Etapa renomeada';
    assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/design-sessions/${sessionId}/draft`, payload: { baseRevision: 1, processSpec: edited } })).statusCode, 200);

    const diff = (await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}/revisions/2/diff` })).json();
    assert.equal(diff.from, 1);
    assert.equal(diff.totals.changed, 1);

    const restored = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/revisions/1/restore`, payload: { baseRevision: 1 } });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().revision, 3, 'restaurar cria uma nova revisão; nada é apagado');
    assert.deepEqual((await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}/revisions/3/diff?against=1` })).json().changes, []);
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}/revisions` })).json().revisions.length, 3);

    const understanding = (await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}/understanding` })).json();
    const item = understanding.requirements.find((entry: any) => entry.kind === 'activity' && entry.label === 'Etapa renomeada');
    assert.ok(item, 'o ledger guarda também itens de revisões anteriores');
    assert.equal(item.inLatestRevision, false);
    const verdict = await app.inject({ method: 'PUT', url: `/api/v1/design-sessions/${sessionId}/requirements/${item.id}`, payload: { state: 'rejected' } });
    assert.equal(verdict.json().state, 'rejected');
    assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/design-sessions/${sessionId}/requirements/${item.id}`, payload: { state: 'talvez' } })).statusCode, 400);
  } finally { await app.close(); }
});

class Queue implements ModelProvider {
  readonly id = 'queue-domain';
  readonly prompts: string[] = [];
  constructor(private readonly responses: unknown[]) {}
  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    this.prompts.push(request.prompt);
    return { value: structuredClone(this.responses.shift()), usage: {}, latencyMs: 1, model: request.model };
  }
}
const text = 'O servidor solicitante faz a solicitação informando a data inicial e a data final das férias. O gestor é selecionado manualmente pelo operador autorizado e aprova ou reprova. O RH é grupo RH e registra se houver aprovação. Se reprovado, o servidor deve ser informado do motivo.';
function intent(withEndDate: boolean) {
  const approved: any[] = [{ kind: 'task', name: 'Registrar férias', actor: 'RH', evidence: 'O RH é grupo RH e registra se houver aprovação' }];
  const startFields: any[] = [{ name: 'Data inicial', type: 'date', required: true, evidence: 'data inicial e a data final das férias' }];
  if (withEndDate) startFields.push({ name: 'Data final', type: 'date', required: true, evidence: 'data inicial e a data final das férias' });
  return { kind: 'business_intent', name: 'Solicitação de férias', purpose: 'Férias com decisão do gestor.',
    actors: [{ name: 'Servidor', evidence: 'servidor solicitante faz a solicitação' }, { name: 'Gestor', evidence: 'O gestor é selecionado manualmente pelo operador autorizado e aprova ou reprova' }, { name: 'RH', evidence: 'O RH é grupo RH e registra se houver aprovação' }],
    startFields,
    activities: [{ kind: 'approval', name: 'Aprovar ou reprovar solicitação', actor: 'Gestor', evidence: 'O gestor é selecionado manualmente pelo operador autorizado e aprova ou reprova', requiresRejectionReason: true, onApproved: approved, onRejected: [{ kind: 'task', name: 'Receber motivo', actor: 'Servidor', evidence: 'o servidor deve ser informado do motivo' }] }],
    rules: [], suggestions: [] };
}

test('item rejeitado entra no prompt e, se o modelo insistir, recebe uma correção dirigida', async () => {
  const provider = new Queue([intent(true), intent(false)]);
  const outcome = await new AiOrchestrator(provider, 'modelo', readEnvironment({ LOG_LEVEL: 'silent' })).generate({
    text, history: [], requirementVerdicts: { confirmed: [{ kind: 'actor', label: 'RH' }], rejected: [{ kind: 'field', label: 'Data final' }] },
  });
  assert.match(provider.prompts[0], /Itens rejeitados pelo solicitante \(não incluir no processo\):\n- Campo: Data final/);
  assert.match(provider.prompts[0], /Itens confirmados pelo solicitante no painel[^\n]*\n- Participante: RH/);
  assert.match(provider.prompts[1], /O solicitante rejeitou “Data final”/);
  assert.equal(outcome.kind, 'proposed_spec');
  if (outcome.kind === 'proposed_spec') assert.ok(!(outcome.spec as any).forms.some((form: any) => form.fields.some((field: any) => field.label === 'Data final')));
});

test('sem vereditos nem exemplos o prompt não muda (cassetes continuam válidas)', async () => {
  const plain = new Queue([intent(false)]);
  const withEmpty = new Queue([intent(false)]);
  await new AiOrchestrator(plain, 'modelo', readEnvironment({ LOG_LEVEL: 'silent' })).generate({ text, history: [] });
  await new AiOrchestrator(withEmpty, 'modelo', readEnvironment({ LOG_LEVEL: 'silent' })).generate({ text, history: [], requirementVerdicts: { confirmed: [], rejected: [] }, fewShotExamples: [] });
  assert.equal(withEmpty.prompts[0], plain.prompts[0]);
});

test('efeito volante: aceite grava o exemplo; few-shot só entra com AI_FEW_SHOT=on e escolhe o parecido', async () => {
  const examples = [
    { sessionId: 'a', revision: 1, requestText: 'Funcionário solicita compra de material e o gestor aprova.', summary: 'Participantes: Funcionário, Gestor' },
    { sessionId: 'b', revision: 1, requestText: 'Cidadão envia sugestão para a ouvidoria registrar.', summary: 'Participantes: Cidadão, Ouvidoria' },
  ];
  const chosen = selectSimilarExamples('O funcionário solicita a compra de um material; o gestor decide.', examples);
  assert.equal(chosen.length, 1);
  assert.match(chosen[0], /compra de material/);

  for (const fewShot of ['on', 'off'] as const) {
    const provider = new Queue([{ kind: 'need_clarification', questions: [{ question: 'Quem aprova?', blocking: true }] }]);
    const repository = new InMemoryConversationRepository();
    const app = await buildApp(readEnvironment({ LOG_LEVEL: 'silent', AI_FEW_SHOT: fewShot }), { conversationRepository: repository, modelProvider: provider });
    try {
      const first = (await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Origem', targetProfile: 'generic-bpmn2' } })).json();
      await app.inject({ method: 'PUT', url: `/api/v1/design-sessions/${first.sessionId}/draft`, payload: { baseRevision: 0, processSpec: await spec() } });
      await repository.appendMessage('local-dev', first.sessionId, 'user', 'O servidor solicita férias e o gestor aprova; o RH registra.');
      await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${first.sessionId}/revisions/1/accept`, payload: { baseRevision: 0 } });
      assert.equal((await repository.listAcceptedExamples('local-dev', 10)).length, 1, 'aceite grava o exemplo');
      const second = (await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'Nova', targetProfile: 'generic-bpmn2' } })).json();
      await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${second.sessionId}/messages`, payload: { text: 'O servidor solicita férias e o gestor aprova.', baseRevision: 0 } });
      assert.equal(/Processos aceitos anteriormente nesta organização/.test(provider.prompts[0]), fewShot === 'on');
    } finally { await app.close(); }
  }
});
