import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEnvironment } from '../src/config/env.js';
import { AiOrchestrator } from '../src/modules/ai/orchestrator.js';
import type { ModelProvider, StructuredRequest, StructuredResponse } from '../src/modules/providers/model-provider.js';

const request = 'O servidor solicitante faz a solicitação informando a data inicial e a data final das férias. O gestor é selecionado manualmente pelo operador autorizado e aprova ou reprova. O RH é grupo RH e registra se houver aprovação. Se reprovado, o servidor deve ser informado do motivo.';
function intent(withRejectedBranch: boolean) {
  return { kind: 'business_intent', name: 'Solicitação de férias', purpose: 'Solicitar férias, obter decisão do gestor e registrar no RH quando aprovada.',
    actors: [{ name: 'Servidor', evidence: 'servidor solicitante faz a solicitação' }, { name: 'Gestor', evidence: 'O gestor é selecionado manualmente pelo operador autorizado e aprova ou reprova' }, { name: 'RH', evidence: 'O RH é grupo RH e registra se houver aprovação' }],
    startFields: [{ name: 'Data inicial', type: 'date', required: true, evidence: 'data inicial e a data final das férias' }, { name: 'Data final', type: 'date', required: true, evidence: 'data inicial e a data final das férias' }],
    activities: [{ kind: 'approval', name: 'Aprovar ou reprovar solicitação', actor: 'Gestor', evidence: 'O gestor é selecionado manualmente pelo operador autorizado e aprova ou reprova', requiresRejectionReason: true,
      onApproved: [{ kind: 'task', name: 'Registrar férias', actor: 'RH', evidence: 'O RH é grupo RH e registra se houver aprovação' }],
      onRejected: withRejectedBranch ? [{ kind: 'task', name: 'Receber motivo', actor: 'Servidor', evidence: 'o servidor deve ser informado do motivo' }] : [] }],
    rules: [{ text: 'Exigir motivo quando houver reprovação.', evidence: 'Se reprovado, o servidor deve ser informado do motivo.' }], suggestions: [],
  };
}
class QueueProvider implements ModelProvider {
  readonly id = 'queue-test';
  readonly prompts: string[] = [];
  constructor(private readonly responses: unknown[]) {}
  async generateStructured(structured: StructuredRequest): Promise<StructuredResponse> {
    this.prompts.push(structured.prompt);
    return { value: structuredClone(this.responses.shift()), usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.002 }, latencyMs: 5, model: structured.model };
  }
}

test('omissão do modelo sobre algo que o solicitante disse vira uma correção dirigida ao modelo, não pergunta ao usuário', async () => {
  const provider = new QueueProvider([intent(false), intent(true)]);
  const outcome = await new AiOrchestrator(provider, 'model', readEnvironment({ LOG_LEVEL: 'silent' })).generate({ text: request, history: [] });
  assert.equal(outcome.kind, 'proposed_spec', JSON.stringify(outcome.diagnostics?.filter(item => item.stage === 'compilation')));
  assert.equal(provider.prompts.length, 2);
  assert.match(provider.prompts[1], /Correção obrigatória: a interpretação anterior omitiu/);
  assert.match(provider.prompts[1], /ramo reprovado não foi preservada/);
  assert.ok(outcome.diagnostics?.some(item => item.stage === 'compilation' && item.status === 'omission-repaired'));
  if (outcome.kind === 'proposed_spec') {
    assert.equal(outcome.repairAttempts, 1);
    assert.ok(Math.abs((outcome.usage.costUsd ?? 0) - 0.004) < 1e-9, 'custo das duas chamadas contabilizado');
  }
});

test('se a correção também omitir, pergunta ao usuário uma vez e não faz terceira chamada', async () => {
  const provider = new QueueProvider([intent(false), intent(false)]);
  const outcome = await new AiOrchestrator(provider, 'model', readEnvironment({ LOG_LEVEL: 'silent' })).generate({ text: request, history: [] });
  assert.equal(outcome.kind, 'need_clarification');
  assert.equal(provider.prompts.length, 2);
  if (outcome.kind === 'need_clarification') assert.match(outcome.questions[0].question, /ramo reprovado/);
});
