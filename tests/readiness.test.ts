import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEnvironment } from '../src/config/env.js';
import { AiOrchestrator } from '../src/modules/ai/orchestrator.js';
import { assessReadiness } from '../src/modules/ai/readiness.js';
import type { ModelProvider, StructuredRequest, StructuredResponse } from '../src/modules/providers/model-provider.js';

const vacationSource = 'Crie um processo de férias. O servidor informa o período solicitado, o gestor aprova ou reprova. Se aprovar, o RH registra as férias. Se reprovar, o servidor recebe o motivo.';
const vagueText = 'Quero criar uma solicitação de férias para aprovação do gestor.';
const vagueIntent = {
  kind: 'business_intent', name: 'Solicitação de férias', purpose: 'Solicitar férias com aprovação do gestor.',
  actors: [{ name: 'Servidor', evidence: 'solicitação de férias' }, { name: 'Gestor', evidence: 'aprovação do gestor' }],
  startFields: [{ name: 'Data de início', type: 'date', required: true }],
  activities: [{ kind: 'approval', name: 'Aprovar férias', actor: 'Gestor', evidence: 'aprovação do gestor', onApproved: [], onRejected: [] }],
  rules: [], suggestions: [],
};

class CountingProvider implements ModelProvider {
  readonly id = 'counting-test';
  calls = 0;
  constructor(private readonly value: unknown) {}
  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    this.calls += 1;
    return { value: structuredClone(this.value), usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 2, model: request.model };
  }
}

test('pedido vago gera resumo do entendimento e até três perguntas sobre o que o solicitante não disse', () => {
  const assessment = assessReadiness(vagueIntent, vagueText);
  assert.equal(assessment.ready, false);
  assert.deepEqual(assessment.gaps.map(gap => gap.slot), ['initiator', 'start-data', 'approval-outcome']);
  assert.match(assessment.understanding, /Entendi um processo de “Solicitação de férias”/);
  assert.match(assessment.understanding, /Participantes citados: Servidor, Gestor/);
  assert.match(assessment.gaps[2].question, /depois que o gestor aprova/);
  assert.ok(assessment.gaps.every(gap => gap.question.length <= 255));
});

test('descrição completa passa direto, sem pergunta', () => {
  const intent = { ...vagueIntent, actors: [{ name: 'Servidor' }, { name: 'Gestor' }, { name: 'RH' }], activities: [{ kind: 'approval', name: 'Aprovar', actor: 'Gestor', onApproved: [{ kind: 'task', name: 'Registrar' }], onRejected: [] }] };
  assert.deepEqual(assessReadiness(intent, vacationSource).gaps, []);
  assert.equal(assessReadiness({ ...vagueIntent, actors: [{ name: 'Cidadão' }, { name: 'Ouvidoria' }], activities: [{ kind: 'task', name: 'Registrar sugestão', actor: 'Ouvidoria' }] }, 'O cidadão envia uma sugestão informando o assunto. A ouvidoria registra.').ready, true);
  assert.equal(assessReadiness({ ...vagueIntent, actors: [{ name: 'Gestor' }] }, 'O gestor aprova ou reprova e o processo termina. O funcionário solicita informando o item.').gaps.some(gap => gap.slot === 'approval-outcome'), false, 'desfecho "termina" basta');
});

test('o gate usa o texto do solicitante, não o que o modelo inferiu', () => {
  // The model claims a "Servidor" initiator and a start field, but the requester never said so.
  const assessment = assessReadiness(vagueIntent, vagueText);
  assert.ok(assessment.gaps.some(gap => gap.slot === 'initiator'));
  assert.ok(assessment.gaps.some(gap => gap.slot === 'start-data'));
});

test('orquestrador pergunta antes da primeira proposta, uma única chamada, e não bloqueia de novo após respostas', async () => {
  const environment = readEnvironment({ LOG_LEVEL: 'silent' });
  const provider = new CountingProvider(vagueIntent);
  const first = await new AiOrchestrator(provider, 'model', environment).generate({ text: vagueText, history: [] });
  assert.equal(first.kind, 'need_clarification');
  if (first.kind !== 'need_clarification') return;
  assert.equal(first.questions.length, 3);
  assert.match(first.summary ?? '', /Entendi/);
  assert.equal(provider.calls, 1);
  assert.ok(first.diagnostics?.some(item => item.stage === 'readiness' && item.status === 'needs-input'));

  const answered = await new AiOrchestrator(new CountingProvider(vagueIntent), 'model', environment).generate({
    text: 'O servidor solicita.', history: [],
    confirmedFacts: [{ question: first.questions[0].question, answer: 'O servidor solicita.', confirmedAt: new Date().toISOString() }],
  });
  assert.ok(!answered.diagnostics?.some(item => item.stage === 'readiness'), 'após uma rodada respondida o gate não volta a bloquear');
});

test('AI_READINESS_GATE=off mantém o comportamento anterior para comparação no placar', async () => {
  const environment = readEnvironment({ LOG_LEVEL: 'silent', AI_READINESS_GATE: 'off' });
  const outcome = await new AiOrchestrator(new CountingProvider(vagueIntent), 'model', environment).generate({ text: vagueText, history: [] });
  assert.ok(!outcome.diagnostics?.some(item => item.stage === 'readiness'));
  assert.throws(() => readEnvironment({ AI_READINESS_GATE: 'talvez' }), /AI_READINESS_GATE/);
});
