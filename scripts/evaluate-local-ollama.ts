import { readFile } from 'node:fs/promises';
import { readEnvironment } from '../src/config/env.js';
import { AiOrchestrator, type ConversationTurn, type GenerationOutcome } from '../src/modules/ai/orchestrator.js';
import { OllamaProvider } from '../src/modules/providers/model-provider.js';

const env = readEnvironment();
if (env.aiProvider !== 'ollama' || !env.aiModel) throw new Error('Configure AI_PROVIDER=ollama e AI_MODEL no .env local');
const engine = new AiOrchestrator(new OllamaProvider(env.ollamaBaseUrl), env.aiModel, env);
const vacation = JSON.parse(await readFile('specs/foundation/examples/ferias.json', 'utf8'));
// The fixture intentionally has an unresolved sample question. It is not part of
// the actual process state for this refinement evaluation.
vacation.pendingQuestions = [];

function report(name: string, outcome: GenerationOutcome) {
  const result = outcome.kind === 'proposed_spec' ? {
    outcome: outcome.validation.valid && outcome.artifacts ? 'valid-artifacts' : 'validation-failed',
    diagnostics: outcome.validation.diagnostics.map(({ code, path, message }) => ({ code, path, message })),
    nodes: (outcome.spec.nodes as unknown[]).length,
    nodeTypes: (outcome.spec.nodes as Array<{ type: string }>).map(node => node.type),
    variableKeys: (outcome.spec.variables as Array<{ key: string }>).map(variable => variable.key),
    forms: outcome.artifacts?.forms.length ?? 0,
    bpmnChars: outcome.artifacts?.bpmnXml.length ?? 0,
    repairAttempts: outcome.repairAttempts,
    semanticOutput: outcome.intermediate,
  } : { outcome: 'need_clarification', questions: outcome.questions.map(item => ({ question: item.question, blocking: item.blocking })), blockingQuestions: outcome.questions.filter(question => question.blocking).length, semanticOutput: outcome.intermediate };
  console.log(JSON.stringify({ scenario: name, provider: outcome.provider, model: outcome.model, latencyMs: outcome.latencyMs, usage: outcome.usage, ...result }));
}
async function run(name: string, operation: Promise<GenerationOutcome>): Promise<GenerationOutcome | undefined> {
  try { const outcome = await operation; report(name, outcome); return outcome; }
  catch (error) { const value = error as { code?: string }; console.log(JSON.stringify({ scenario: name, outcome: 'request-failed', code: value.code || 'UNKNOWN' })); return undefined; }
}

const request = 'Crie um processo de solicitação de férias. O servidor faz a solicitação, o gestor aprova ou reprova e, se aprovado, o RH registra. Se reprovado, o servidor deve ser informado do motivo.';
const initial = await run('A-vacation-initial', engine.generate({ text: request, history: [], targetProfile: 'generic-bpmn2' }));
if (initial?.kind === 'need_clarification') {
  const replies = initial.questions.map(({ question }) => {
    const q = question.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (/rh|grupo/.test(q)) return 'O RH é o grupo rh, selecionado manualmente pelo operador autorizado.';
    if (/gestor|hierarqu|atribu/.test(q)) return 'O runtime atribui o papel gestor pela relação nativa manager-of-requester do solicitante; não consulte outra base.';
    if (/motivo|justific/.test(q)) return 'Em caso de reprovação, o motivo é informado ao servidor; não adicione prazo ou regra legal.';
    return 'Use somente o processo descrito; não invente prazos ou regras legais. Para a rejeição, capture um motivo textual e informe-o ao solicitante.';
  });
  const answer = replies.map((value, index) => `Resposta ${index + 1}: ${value}`).join('\n');
  const nextHistory: ConversationTurn[] = [
    { role: 'user', content: request },
    { role: 'assistant', content: initial.questions.map((item, index) => `${index + 1}. ${item.question}`).join('\n') },
  ];
  const confirmedFacts = initial.questions.map((item, index) => ({ question: item.question, answer: replies[index], confirmedAt: new Date().toISOString() }));
  let answered = await engine.generate({ text: answer, history: nextHistory, confirmedFacts, targetProfile: 'generic-bpmn2' });
  report('A-vacation-after-clarification', answered);
  if (answered.kind === 'need_clarification') {
    const finalAnswers = answered.questions.map(({ question }) => {
      const q = question.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      if (/gestor/.test(q)) return 'O gestor é manager-of-requester, relação hierárquica nativa já disponível ao runtime.';
      if (/rh|grupo/.test(q)) return 'A equipe RH é o grupo rh; a atribuição é escolhida manualmente pelo operador autorizado.';
      if (/reprov|motivo|justific/.test(q)) return 'Em qualquer reprovação, o motivo textual deve ser informado ao servidor; a solicitação termina como reprovada.';
      return 'Nenhuma regra de dias, prazo ou norma legal foi solicitada; mantenha essas regras fora do escopo.';
    });
    const nextFacts = answered.questions.map((item, index) => ({ question: item.question, answer: finalAnswers[index], confirmedAt: new Date().toISOString() }));
    answered = await engine.generate({
      text: finalAnswers.map((value, index) => `Resposta ${index + 1}: ${value}`).join('\n'),
      history: [...nextHistory, { role: 'user', content: answer }, { role: 'assistant', content: answered.questions.map(item => item.question).join('\n') }],
      confirmedFacts: [...confirmedFacts, ...nextFacts], targetProfile: 'generic-bpmn2',
    });
    report('A-vacation-after-second-clarification', answered);
  }
}

const adminText = 'Modele um processo simples de aprovação administrativa: o solicitante envia um pedido e um analista administrativo, selecionado manualmente pelo operador autorizado, aprova ou rejeita. A decisão é registrada; encerre em qualquer decisão. Não invente formulário, prazo ou regra adicional; use somente título/descrição do pedido como dados se forem indispensáveis.';
const admin = await run('B-admin-approval', engine.generate({ text: adminText, history: [], targetProfile: 'generic-bpmn2' }));
if (admin?.kind === 'need_clarification') {
  const answers = admin.questions.map(({ question }) => {
    const q = question.toLowerCase();
    if (/analista|papel|responsabil|atribui|operador/.test(q)) return 'O operador autorizado seleciona manualmente o analista. O analista aprova ou rejeita o pedido; isso resolve a atribuição.';
    if (/prazo|tempo|limite/.test(q)) return 'Não há prazo ou limite de tempo especificado; mantenha fora do escopo.';
    if (/formul|campo|t[ií]tulo|descri/.test(q)) return 'Não é necessário formulário; modele somente a decisão descrita, sem campos adicionais.';
    return 'Não há regra adicional especificada. O analista registra a decisão e o fluxo termina em qualquer resultado.';
  });
  const confirmedFacts = admin.questions.map((item, index) => ({ question: item.question, answer: answers[index], confirmedAt: new Date().toISOString() }));
  await run('B-admin-after-clarification', engine.generate({ text: answers.map((answer, index) => `Resposta ${index + 1}: ${answer}`).join('\n'), history: [{ role: 'user', content: adminText }, { role: 'assistant', content: admin.questions.map(item => item.question).join('\n') }], confirmedFacts, targetProfile: 'generic-bpmn2' }));
}

const httpText = 'Modele declarativamente uma consulta HTTP somente leitura usando apenas o conector fictício people_api e a operação aprovada lookup_request (capability http.request, sideEffectLevel read), entrada requestId string e saída found boolean. O requester fornece requestId. Esses metadados são a autorização de catálogo para o exercício; não invente URL, credenciais ou resposta real, e não execute a integração. Mapeie found para variável de saída e termine sem decisão adicional.';
const http = await run('C-declarative-http', engine.generate({ text: httpText, history: [], targetProfile: 'generic-bpmn2' }));
if (http?.kind === 'need_clarification') {
  const answers = http.questions.map(({ question }) => {
    const q = question.toLowerCase();
    if (/endpoint|url|catalog|operação/.test(q)) return 'A operação catalogada lookup_request resolve o endpoint no runtime; não forneça URL.';
    if (/requestid|formato|gerad/.test(q)) return 'O requester fornece requestId como string, sem formato específico.';
    if (/não encontrada|false|resposta|lógica|erro/.test(q)) return 'Registre found como saída booleana da consulta e termine normalmente; não crie ramo nem efeito adicional.';
    return 'Os metadados de operação, entrada e saída já fornecidos são suficientes; não adicione tarefa ou efeito.';
  });
  const confirmedFacts = http.questions.map((item, index) => ({ question: item.question, answer: answers[index], confirmedAt: new Date().toISOString() }));
  await run('C-http-after-clarification', engine.generate({ text: answers.map((answer, index) => `Resposta ${index + 1}: ${answer}`).join('\n'), history: [{ role: 'user', content: httpText }, { role: 'assistant', content: http.questions.map(item => item.question).join('\n') }], confirmedFacts, targetProfile: 'generic-bpmn2' }));
}

const refinementText = 'Adicione uma segunda aprovação em série após a aprovação do gestor atual e antes da decisão final. O papel e o método de atribuição do segundo aprovador não foram definidos; peça esses esclarecimentos sem alterar a revisão atual.';
const refinement = await run('D-second-approval-refinement', engine.generate({ text: refinementText, history: [], currentSpec: vacation, targetProfile: 'generic-bpmn2' }));
if (refinement?.kind === 'need_clarification') {
  const answers = refinement.questions.map(({ question }) => {
    const q = question.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (/papel|responsavel|quem|pessoa/.test(q)) return 'O segundo aprovador é o diretor da unidade, com atribuição manual por operador autorizado.';
    if (/localiz|atribu|resolver/.test(q)) return 'A atribuição do diretor será manual, selecionada por um operador autorizado.';
    if (/reprov|motivo|recus/.test(q)) return 'Se qualquer aprovador reprovar, o fluxo termina como reprovado e o servidor recebe o motivo.';
    return 'O segundo aprovador é o diretor da unidade, com atribuição manual. Se qualquer aprovador reprovar, o fluxo termina e o servidor recebe o motivo.';
  });
  const confirmedFacts = refinement.questions.map((item, index) => ({ question: item.question, answer: answers[index], confirmedAt: new Date().toISOString() }));
  const answered = await run('D-second-approval-after-answers', engine.generate({
    text: answers.map((answer, index) => `Resposta ${index + 1}: ${answer}`).join('\n'),
    history: [{ role: 'user', content: refinementText }, { role: 'assistant', content: refinement.questions.map(item => item.question).join('\n') }],
    currentSpec: vacation, confirmedFacts, targetProfile: 'generic-bpmn2',
  }));
  const repeatedQuestions = answered?.kind === 'need_clarification' ? answered.questions.filter(next => refinement.questions.some(previous => questionSimilarity(previous.question, next.question) >= 0.65)).length : 0;
  console.log(JSON.stringify({ scenario: 'E-clarification-followup', outcome: answered?.kind || 'request-failed', repeatedQuestionCount: repeatedQuestions, firstQuestionCount: refinement.questions.length, followupQuestionCount: answered?.kind === 'need_clarification' ? answered.questions.length : 0 }));
}

function questionSimilarity(a: string, b: string): number {
  const stop = new Set(['como', 'qual', 'quais', 'deve', 'para', 'de', 'do', 'da', 'o', 'a', 'e', 'em', 'um', 'uma', 'que', 'ser', 'sua', 'seu']);
  const tokens = (value: string) => new Set(value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]+/g)?.filter(token => token.length > 2 && !stop.has(token)) || []);
  const left = tokens(a); const right = tokens(b);
  if (!left.size || !right.size) return 0;
  const overlap = [...left].filter(token => right.has(token)).length;
  return overlap / Math.min(left.size, right.size);
}
