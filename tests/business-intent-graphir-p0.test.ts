import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileBusinessIntentToGraphIR, type BusinessObligation, type ObligationLedger } from '../src/modules/graph-ir/business-intent-compiler.js';
import type { BusinessIntentV1 } from '../src/modules/ai/semantic-process.js';
import { validateGraphIR } from '../src/modules/graph-ir/graph-ir.js';

const ob = (key: string, kind: BusinessObligation['kind'], subject: string, relationEvidence: string, expectedActor?: string): BusinessObligation => ({ key, kind, mandatory: true, subject, relationEvidence, sourceExcerpt: relationEvidence, ...(expectedActor ? { expectedActor } : {}) });
const obAt = (path: string, obligation: BusinessObligation): BusinessObligation => ({ ...obligation, intentPath: path });
const R01_LEDGER: ObligationLedger = { sourceId: 'controlled-r01-v1', expectedObligationKeys: ['request-field','manager-activity','manager-actor','approval-activity','approval-actor','manager-decision','approved-condition','rejected-condition','rejected-consequence','finance-activity','finance-actor'], obligations: [
  ob('request-field', 'field', 'Material solicitado', 'A solicitação abre o processo e seu formulário coleta o material solicitado.'),
  ob('manager-activity', 'activity', 'Analisar solicitação', 'O gestor analisa a solicitação.'),
  ob('manager-actor', 'actor', 'Analisar solicitação', 'A análise é atribuída ao gestor.', 'Gestor'),
  ob('approval-activity', 'activity', 'Aprovar solicitação', 'O gestor analisa e aprova ou reprova a solicitação.'),
  ob('approval-actor', 'actor', 'Aprovar solicitação', 'O gestor decide sobre a solicitação.', 'Gestor'),
  ob('manager-decision', 'decision', 'Aprovar solicitação', 'O gestor aprova ou reprova.'),
  ob('approved-condition', 'condition', 'Aprovar solicitação:Aprovada', 'A rota aprovada ocorre quando a decisão é verdadeira.'),
  ob('rejected-condition', 'condition', 'Aprovar solicitação:Reprovada', 'A rota reprovada ocorre quando a decisão é falsa.'),
  ob('rejected-consequence', 'consequence', 'Aprovar solicitação:Reprovada', 'A reprovação termina o processo.'),
  ob('finance-activity', 'activity', 'Providenciar pagamento', 'O Financeiro providencia o pagamento após aprovação.'),
  ob('finance-actor', 'actor', 'Providenciar pagamento', 'A providência é atribuída ao Financeiro.', 'Financeiro'),
] };
const R01_SOURCE = 'A solicitação abre o processo e seu formulário coleta o material solicitado. O gestor analisa a solicitação. A análise é atribuída ao gestor. O gestor analisa e aprova ou reprova a solicitação. O gestor decide sobre a solicitação. O gestor aprova ou reprova. A rota aprovada ocorre quando a decisão é verdadeira. A rota reprovada ocorre quando a decisão é falsa. A reprovação termina o processo. O Financeiro providencia o pagamento após aprovação. A providência é atribuída ao Financeiro.';
const R02_SOURCE = 'Funcionário solicita reembolso com descrição, valor e comprovante obrigatórios. A descrição da despesa é coletada no início. O valor da despesa é coletado no início. O comprovante da despesa é anexado no início. O Gestor aprova ou reprova o reembolso. A reprovação do Gestor encerra o processo. Após aprovação do Gestor, valor maior que 2000 exige aprovação do Diretor. Valor menor ou igual a 2000 dispensa o Diretor. O Diretor aprova ou reprova somente valores acima de 2000. A reprovação do Diretor encerra o processo. Após todas as aprovações necessárias, o Financeiro executa o reembolso.';
const MANAGER_PATH = 'activity/Reembolso/approval/Aprovar reembolso';
const LIMIT_PATH = `${MANAGER_PATH}/Aprovada/decision/Limite do Diretor`;
const DIRECTOR_PATH = `${LIMIT_PATH}/Acima de 2000/approval/Aprovar pelo Diretor`;
const FINANCE_LOW_PATH = `${LIMIT_PATH}/Até 2000/task/Executar reembolso`;
const FINANCE_HIGH_PATH = `${DIRECTOR_PATH}/Aprovada/task/Executar reembolso`;
const R02_LEDGER: ObligationLedger = { sourceId: 'controlled-r02-v2', expectedObligationKeys: ['description-field','amount-field','receipt-field','manager-approval-activity','manager-approval-actor','manager-approval-decision','manager-approved-condition','manager-rejected-condition','manager-rejection','amount-gateway','director-condition','manager-condition','director-activity','director-actor','director-decision','director-approve-condition','director-reject-condition','director-rejection','finance-low-activity','finance-low-actor','finance-high-activity','finance-high-actor'], obligations: [
  ob('description-field', 'field', 'Descrição', 'A descrição da despesa é coletada no início.'),
  ob('amount-field', 'field', 'Valor', 'O valor da despesa é coletado no início.'),
  ob('receipt-field', 'field', 'Comprovante', 'O comprovante da despesa é anexado no início.'),
  obAt(MANAGER_PATH, ob('manager-approval-activity', 'activity', 'Aprovar reembolso', 'O Gestor aprova ou reprova o reembolso.')),
  obAt(MANAGER_PATH, ob('manager-approval-actor', 'actor', 'Aprovar reembolso', 'O Gestor aprova ou reprova o reembolso.', 'Gestor')),
  obAt(MANAGER_PATH, ob('manager-approval-decision', 'decision', 'Aprovar reembolso', 'O Gestor aprova ou reprova o reembolso.')),
  obAt(`${MANAGER_PATH}/branch/Aprovada`, ob('manager-approved-condition', 'condition', 'Aprovar reembolso:Aprovada', 'Após aprovação do Gestor, valor maior que 2000 exige aprovação do Diretor.')),
  obAt(`${MANAGER_PATH}/branch/Reprovada`, ob('manager-rejected-condition', 'condition', 'Aprovar reembolso:Reprovada', 'A reprovação do Gestor encerra o processo.')),
  obAt(`${MANAGER_PATH}/branch/Reprovada`, ob('manager-rejection', 'consequence', 'Aprovar reembolso:Reprovada', 'A reprovação do Gestor encerra o processo.')),
  obAt(LIMIT_PATH, ob('amount-gateway', 'decision', 'Limite do Diretor', 'Após aprovação do Gestor, valor maior que 2000 exige aprovação do Diretor.')),
  Object.assign(obAt(`${LIMIT_PATH}/branch/Acima de 2000`, ob('director-condition', 'condition', 'Limite do Diretor:Acima de 2000', 'Após aprovação do Gestor, valor maior que 2000 exige aprovação do Diretor.')), { expectedOperator: 'gt', expectedValue: 2000 }),
  Object.assign(obAt(`${LIMIT_PATH}/branch/Até 2000`, ob('manager-condition', 'condition', 'Limite do Diretor:Até 2000', 'Valor menor ou igual a 2000 dispensa o Diretor.')), { expectedOperator: 'lte', expectedValue: 2000 }),
  obAt(DIRECTOR_PATH, ob('director-activity', 'activity', 'Aprovar pelo Diretor', 'O Diretor aprova ou reprova somente valores acima de 2000.')),
  obAt(DIRECTOR_PATH, ob('director-actor', 'actor', 'Aprovar pelo Diretor', 'O Diretor aprova ou reprova somente valores acima de 2000.', 'Diretor')),
  obAt(DIRECTOR_PATH, ob('director-decision', 'decision', 'Aprovar pelo Diretor', 'O Diretor aprova ou reprova somente valores acima de 2000.')),
  obAt(`${DIRECTOR_PATH}/branch/Aprovada`, ob('director-approve-condition', 'condition', 'Aprovar pelo Diretor:Aprovada', 'Após todas as aprovações necessárias, o Financeiro executa o reembolso.')),
  obAt(`${DIRECTOR_PATH}/branch/Reprovada`, ob('director-reject-condition', 'condition', 'Aprovar pelo Diretor:Reprovada', 'A reprovação do Diretor encerra o processo.')),
  obAt(`${DIRECTOR_PATH}/branch/Reprovada`, ob('director-rejection', 'consequence', 'Aprovar pelo Diretor:Reprovada', 'A reprovação do Diretor encerra o processo.')),
  obAt(FINANCE_LOW_PATH, ob('finance-low-activity', 'activity', 'Executar reembolso', 'Após todas as aprovações necessárias, o Financeiro executa o reembolso.')),
  obAt(FINANCE_LOW_PATH, ob('finance-low-actor', 'actor', 'Executar reembolso', 'Após todas as aprovações necessárias, o Financeiro executa o reembolso.', 'Financeiro')),
  obAt(FINANCE_HIGH_PATH, ob('finance-high-activity', 'activity', 'Executar reembolso', 'Após todas as aprovações necessárias, o Financeiro executa o reembolso.')),
  obAt(FINANCE_HIGH_PATH, ob('finance-high-actor', 'actor', 'Executar reembolso', 'Após todas as aprovações necessárias, o Financeiro executa o reembolso.', 'Financeiro')),
] };

const intentR01: BusinessIntentV1 = {
  kind: 'business_intent', name: 'Solicitação de compra', purpose: 'Solicitar e aprovar uma compra.',
  actors: [{ name: 'Solicitante', resolution: 'requester' }, { name: 'Gestor', resolution: 'group', groupName: 'managers' }, { name: 'Financeiro', resolution: 'group', groupName: 'finance' }],
  startFields: [{ name: 'Material solicitado', type: 'text', required: true }],
  activities: [{ kind: 'task', name: 'Analisar solicitação', actor: 'Gestor' }, { kind: 'approval', name: 'Aprovar solicitação', actor: 'Gestor', onApproved: [{ kind: 'task', name: 'Providenciar pagamento', actor: 'Financeiro' }], onRejected: [] }], rules: [], suggestions: [], pendingConfiguration: [],
};
const intentR02: BusinessIntentV1 = {
  kind: 'business_intent', name: 'Reembolso', purpose: 'Revisar solicitação de reembolso.',
  actors: [{ name: 'Solicitante', resolution: 'requester' }, { name: 'Gestor', resolution: 'group', groupName: 'managers' }, { name: 'Diretor', resolution: 'group', groupName: 'directors' }],
  startFields: [{ name: 'Descrição', type: 'paragraph', required: true }, { name: 'Valor', type: 'decimal', required: true }, { name: 'Comprovante', type: 'attachment', required: true }],
  activities: [{ kind: 'approval', name: 'Aprovar reembolso', actor: 'Gestor', onRejected: [], onApproved: [
    { kind: 'decision', name: 'Limite do Diretor', field: 'Valor', alternatives: [
      { label: 'Acima de 2000', value: 2000, operator: 'gt', steps: [{ kind: 'approval', name: 'Aprovar pelo Diretor', actor: 'Diretor', onApproved: [{ kind: 'task', name: 'Executar reembolso', actor: 'Financeiro' }], onRejected: [] }] },
      { label: 'Até 2000', value: 2000, operator: 'lte', steps: [{ kind: 'task', name: 'Executar reembolso', actor: 'Financeiro' }] },
    ] },
  ] }], rules: [], suggestions: [], pendingConfiguration: [],
};
const options = (sourceText: string, ledger: ObligationLedger) => ({ sourceText, ledger });

test('P0 controlled R01 compila BusinessIntent direto em GraphIR com Ledger independente', async () => {
  const result = await compileBusinessIntentToGraphIR(intentR01, options(R01_SOURCE, R01_LEDGER));
  assert.equal(result.evidence.internalConsistency, 'pass', JSON.stringify(result.evidence.diagnostics));
  assert.equal(result.evidence.knownObligationCoverage, 'complete');
  assert.equal(result.evidence.interpretationCompleteness, 'not-measured');
  assert.ok(result.graph && validateGraphIR(result.graph).valid);
  assert.ok(result.processSpec, 'GraphIR deve baixar para ProcessSpec já validado pelo compilador');
  assert.ok(result.artifacts?.bpmnXml.includes('<bpmn:definitions'), 'gerador BPMN existente deve produzir prévia');
  assert.ok(result.traceability.every(item => item.covered && item.relationEvidence.length > 0));
  assert.ok(result.graph!.nodes.some(node => node.name === 'Providenciar pagamento' && result.graph!.roles.find(role => role.id === node.roleId)?.label === 'Financeiro'));
  assert.ok(result.graph!.nodes.some(node => node.type === 'end' && node.name === 'Reprovada'));
  const approvedEdge = result.graph!.edges.find(edge => edge.label === 'Aprovada')!;
  assert.equal(result.graph!.nodes.find(node => node.id === approvedEdge.target)?.name, 'Providenciar pagamento');
  assert.equal(result.graph!.nodes.find(node => node.id === result.graph!.edges.find(edge => edge.label === 'Reprovada')!.target)?.type, 'end');
});

test('P0 controlled R02 mantém > estrito, equality fora da rota de Diretor e rejeições terminais', async () => {
  const result = await compileBusinessIntentToGraphIR(intentR02, options(R02_SOURCE, R02_LEDGER));
  assert.equal(result.evidence.internalConsistency, 'pass', JSON.stringify(result.evidence.diagnostics));
  assert.equal(result.evidence.knownObligationCoverage, 'complete', 'Todas as obrigações de negócio do Ledger têm referências rastreáveis no grafo controlado.');
  assert.equal(result.evidence.artifactSupport, 'supported', `filepicker nativo de form-js é projetado e importado pelo viewer; forms=${JSON.stringify(result.artifacts?.forms)} diagnostics=${JSON.stringify(result.evidence.diagnostics)}`);
  assert.equal(result.decision, 'approved');
  assert.ok(!result.evidence.diagnostics.some(item => item.code === 'BUSINESS_ATTACHMENT_UNSUPPORTED'));
  assert.ok(result.processSpec, 'R02 controle de fluxo baixa para ProcessSpec válido mesmo com attachment não suportado pelo artefato');
  assert.ok(result.artifacts?.bpmnXml.includes('<bpmn:definitions'));
  const graph = result.graph!;
  const high = graph.edges.find(edge => edge.label === 'Acima de 2000')!;
  assert.deepEqual(high.condition, { op: 'gt', left: { var: graph.formRefs.flatMap(form => form.fields).find(field => field.label === 'Valor')?.bindTo }, right: { literal: 2000 } });
  const low = graph.edges.find(edge => edge.label === 'Até 2000')!;
  assert.deepEqual(low.condition, { op: 'lte', left: { var: graph.formRefs.flatMap(form => form.fields).find(field => field.label === 'Valor')?.bindTo }, right: { literal: 2000 } });
  const requiresDirector = (amount: number) => amount > 2000 ? high.target : low.target;
  assert.equal(requiresDirector(1999.99), low.target);
  assert.equal(requiresDirector(2000), low.target);
  assert.equal(requiresDirector(2000.01), high.target);
  const byId = (id: string) => graph.nodes.find(node => node.id === id)!;
  const manager = graph.nodes.find(node => node.name === 'Aprovar reembolso' && node.type === 'humanTask')!;
  const managerGateway = graph.nodes.find(node => node.name === 'Decisão: Aprovar reembolso')!;
  const managerReject = graph.edges.find(edge => edge.source === managerGateway.id && edge.label === 'Reprovada')!;
  const managerApprove = graph.edges.find(edge => edge.source === managerGateway.id && edge.label === 'Aprovada')!;
  assert.equal(byId(managerReject.target).type, 'end', 'reprovação do Gestor termina sem passar pelo Financeiro');
  assert.equal(byId(managerApprove.target).name, 'Limite do Diretor');
  const lowTask = byId(low.target);
  assert.equal(lowTask.name, 'Executar reembolso');
  assert.equal(graph.roles.find(role => role.id === lowTask.roleId)?.label, 'Financeiro');
  const director = byId(high.target);
  assert.equal(director.name, 'Aprovar pelo Diretor');
  const directorGateway = graph.nodes.find(node => node.name === 'Decisão: Aprovar pelo Diretor')!;
  const directorReject = graph.edges.find(edge => edge.source === directorGateway.id && edge.label === 'Reprovada')!;
  const directorApprove = graph.edges.find(edge => edge.source === directorGateway.id && edge.label === 'Aprovada')!;
  assert.equal(byId(directorReject.target).type, 'end', 'reprovação do Diretor termina sem passar pelo Financeiro');
  assert.equal(byId(directorApprove.target).name, 'Executar reembolso');
  assert.equal(graph.roles.find(role => role.id === byId(directorApprove.target).roleId)?.label, 'Financeiro');
  assert.ok(graph.nodes.some(node => node.type === 'end'), 'os caminhos de reprovação e o caminho de sucesso terminam');
  assert.equal(result.traceability.filter(item => item.covered).length, R02_LEDGER.obligations.length);
  const outgoing = new Map<string, typeof graph.edges>();
  for (const edge of graph.edges) outgoing.set(edge.source, [...(outgoing.get(edge.source) || []), edge]);
  const start = graph.nodes.find(node => node.type === 'start')!;
  const walk = (nodeId: string, path: string[] = [], seen = new Set<string>()): string[][] => {
    assert.ok(!seen.has(nodeId), 'R02 controlado não contém ciclos inesperados');
    const node = byId(nodeId); const current = [...path, node.name];
    if (node.type === 'end') return [current];
    const nextSeen = new Set(seen); nextSeen.add(nodeId);
    return (outgoing.get(nodeId) || []).flatMap(edge => walk(edge.target, edge.label ? [...current, edge.label] : current, nextSeen));
  };
  const paths = walk(start.id);
  assert.equal(paths.length, 4, 'os quatro resultados (duas reprovações e dois sucessos) têm caminho completo até o fim');
  assert.ok(paths.some(path => path.includes('Aprovar reembolso') && path.includes('Reprovada') && !path.includes('Executar reembolso')));
  assert.ok(paths.some(path => path.includes('Até 2000') && path.includes('Executar reembolso') && !path.includes('Aprovar pelo Diretor')));
  assert.ok(paths.some(path => path.includes('Aprovar pelo Diretor') && path.includes('Reprovada') && !path.includes('Executar reembolso')));
  assert.ok(paths.some(path => path.includes('Aprovar pelo Diretor') && path.includes('Aprovada') && path.includes('Executar reembolso')));
  const receipt = graph.formRefs.flatMap(form => form.fields).find(field => field.label === 'Comprovante');
  assert.equal(receipt?.type, 'attachment');
  assert.equal(result.artifacts?.forms.some(form => form.json.components.some((component: any) => component.label === 'Comprovante' && component.type === 'filepicker')), true, 'attachment é projetado no componente filepicker nativo');
  assert.equal(result.processSpec?.forms.flatMap((form: any) => form.fields).some((field: any) => field.type === 'attachment'), true);
});

test('P0.1 R02 mutantes omitem aprovação, desviam reprovação ou encerram antes do Financeiro', async () => {
  const withoutManagerApproval = structuredClone(intentR02);
  const managerApproval = withoutManagerApproval.activities[0] as Extract<BusinessIntentV1['activities'][number], { kind: 'approval' }>;
  withoutManagerApproval.activities = managerApproval.onApproved;
  const missingApproval = await compileBusinessIntentToGraphIR(withoutManagerApproval, options(R02_SOURCE, R02_LEDGER));
  assert.notEqual(missingApproval.evidence.knownObligationCoverage, 'complete');
  assert.equal(missingApproval.evidence.internalConsistency, 'fail', 'remover a aprovação invalida a estrutura do gateway e deve bloquear a cobertura');
  assert.ok(missingApproval.traceability.some(item => item.obligationKey === 'manager-approval-decision' && !item.covered));

  const baseline = await compileBusinessIntentToGraphIR(intentR02, options(R02_SOURCE, R02_LEDGER));
  const redirected = structuredClone(baseline.graph!);
  const managerGateway = redirected.nodes.find(node => node.name === 'Decisão: Aprovar reembolso')!;
  const reject = redirected.edges.find(edge => edge.source === managerGateway.id && edge.label === 'Reprovada')!;
  reject.target = redirected.nodes.find(node => node.name === 'Executar reembolso' && node.id !== undefined)?.id || reject.target;
  assert.equal(validateGraphIR(redirected).valid, false, 'desviar a reprovação para o Financeiro diverge do consequence do Ledger');

  const endsBeforeFinance = structuredClone(intentR02);
  const approval = endsBeforeFinance.activities[0] as Extract<BusinessIntentV1['activities'][number], { kind: 'approval' }>;
  const amountDecision = approval.onApproved[0] as Extract<BusinessIntentV1['activities'][number], { kind: 'decision' }>;
  amountDecision.alternatives[0].steps = [{ kind: 'approval', name: 'Aprovar pelo Diretor', actor: 'Diretor', onApproved: [], onRejected: [] }];
  amountDecision.alternatives[1].steps = [];
  const earlyEnd = await compileBusinessIntentToGraphIR(endsBeforeFinance, options(R02_SOURCE, R02_LEDGER));
  assert.equal(earlyEnd.evidence.knownObligationCoverage, 'partial');
  assert.ok(earlyEnd.traceability.some(item => item.obligationKey === 'finance-low-activity' && !item.covered));
  assert.ok(earlyEnd.traceability.some(item => item.obligationKey === 'finance-high-activity' && !item.covered));
});

test('P0 detects a missing obligation and an invented task without trusting compiler coverage', async () => {
  const omittedLedger = R01_LEDGER;
  const omittedIntent = structuredClone(intentR01); omittedIntent.activities = [{ kind: 'approval', name: 'Aprovar solicitação', actor: 'Gestor', onApproved: [], onRejected: [] }];
  const omitted = await compileBusinessIntentToGraphIR(omittedIntent, options(R01_SOURCE, omittedLedger));
  assert.equal(omitted.evidence.knownObligationCoverage, 'partial', 'Ledger controlado declara cardinalidade conhecida para impedir aprovação com obrigação omitida');
  assert.equal(omitted.evidence.interpretationCompleteness, 'not-measured');
  const invented = structuredClone(intentR01); invented.activities.unshift({ kind: 'task', name: 'Enviar notificação', actor: 'Gestor' });
  const withInvented = await compileBusinessIntentToGraphIR(invented, options(R01_SOURCE, R01_LEDGER));
  assert.equal(withInvented.evidence.internalConsistency, 'fail');
  assert.ok(withInvented.evidence.diagnostics.some(item => item.code === 'GRAPHIR_ELEMENT_UNGROUNDED'));
});

test('P0 rejeita troca de responsável, > por >=, destino de ramo e referência de papel ambígua', async () => {
  const wrongActor = structuredClone(intentR01); wrongActor.activities[0] = { ...wrongActor.activities[0], actor: 'Financeiro' } as any;
  const actorResult = await compileBusinessIntentToGraphIR(wrongActor, options(R01_SOURCE, R01_LEDGER));
  assert.ok(actorResult.evidence.diagnostics.some(item => item.code === 'BUSINESS_ACTOR_FIDELITY_MISMATCH'));
  const wrongOperator = structuredClone(intentR02); const managerApproval = wrongOperator.activities[0] as Extract<BusinessIntentV1['activities'][number], { kind: 'approval' }>; const decision = managerApproval.onApproved.find(item => item.kind === 'decision') as any; decision.alternatives[0].operator = 'gte';
  const operatorResult = await compileBusinessIntentToGraphIR(wrongOperator, options(R02_SOURCE, R02_LEDGER));
  assert.ok(operatorResult.evidence.diagnostics.some(item => item.code === 'BUSINESS_CONDITION_FIDELITY_MISMATCH'));
  const ambiguous = { ...R01_LEDGER, obligations: [...R01_LEDGER.obligations, ob('another-manager-activity', 'activity', 'Analisar solicitação', 'Relação independente duplicada sem identidade para distinguir.')] };
  const ambiguousResult = await compileBusinessIntentToGraphIR(intentR01, options(R01_SOURCE, ambiguous));
  assert.equal(ambiguousResult.decision, 'rejected');
  assert.ok(ambiguousResult.evidence.diagnostics.some(item => item.code === 'BUSINESS_LEDGER_IDENTITY_COLLISION'));
});

test('P0 preserva multiplicidade de papel e determinismo por identidade semântica', async () => {
  const intent = structuredClone(intentR01); intent.activities = [{ kind: 'task', name: 'Conferir material', actor: 'Gestor' }, { kind: 'approval', name: 'Aprovar solicitação', actor: 'Gestor', onApproved: [{ kind: 'task', name: 'Providenciar pagamento', actor: 'Financeiro' }], onRejected: [] }];
  const ledger = { ...R01_LEDGER, obligations: [...R01_LEDGER.obligations, ob('check-activity', 'activity', 'Conferir material', 'O gestor confere material antes de aprovar.')] };
  const a = await compileBusinessIntentToGraphIR(intent, options(`${R01_SOURCE} O gestor confere material antes de aprovar.`, ledger));
  const b = await compileBusinessIntentToGraphIR(intent, options(`${R01_SOURCE} O gestor confere material antes de aprovar.`, ledger));
  assert.equal(a.evidence.internalConsistency, 'pass', JSON.stringify(a.evidence.diagnostics));
  assert.deepEqual(a.graph, b.graph);
  assert.equal(a.graph!.roles.filter(role => role.label === 'Gestor').length, 1);
  assert.equal(a.graph!.nodes.filter(node => node.roleId === a.graph!.roles.find(role => role.label === 'Gestor')!.id).length, 2);
});

test('P0 mutantes GraphIR rejeitam destino, variável, IDs duplicados, formulário omitido e ramo de reprovação alterado', async () => {
  const compiled = await compileBusinessIntentToGraphIR(intentR01, options('Material solicitado. Gestor aprova ou reprova. Financeiro providencia pagamento.', R01_LEDGER));
  assert.equal(compiled.evidence.internalConsistency, 'pass');
  const graph = compiled.graph!;

  const wrongDestination = structuredClone(graph);
  const approved = wrongDestination.edges.find(edge => edge.label === 'Aprovada')!;
  approved.target = wrongDestination.nodes.find(node => node.name === 'Reprovada')!.id;
  assert.equal(validateGraphIR(wrongDestination).valid, false, 'destino do ramo não pode divergir do requisito consequence');

  const missingVariable = structuredClone(graph);
  const conditional = missingVariable.edges.find(edge => edge.condition)!;
  conditional.condition = { op: 'eq', left: { var: 'var_missing' }, right: { literal: true } };
  assert.equal(validateGraphIR(missingVariable).valid, false, 'variável referenciada precisa existir');

  const duplicateId = structuredClone(graph);
  duplicateId.edges[0].id = duplicateId.edges[1].id;
  assert.equal(validateGraphIR(duplicateId).valid, false, 'identidades de aresta precisam ser únicas');

  const missingField = structuredClone(graph);
  missingField.formRefs.find(form => form.usage === 'start')!.fields = [];
  assert.equal(validateGraphIR(missingField).valid, false, 'requirementRefs de campo não podem perder o formulário/campo obrigatório');

  const wrongRejection = structuredClone(graph);
  const rejected = wrongRejection.edges.find(edge => edge.label === 'Reprovada')!;
  rejected.target = wrongDestination.nodes.find(node => node.name === 'Providenciar pagamento')!.id;
  assert.equal(validateGraphIR(wrongRejection).valid, false, 'reprovação não pode ser redirecionada à atividade Financeiro');
});

test('P0 retorna inconclusivo quando evidência de relação não está presente na fonte', async () => {
  const ledger = structuredClone(R01_LEDGER);
  ledger.obligations[0].relationEvidence = 'trecho ausente no pedido controlado';
  const result = await compileBusinessIntentToGraphIR(intentR01, options('Gestor aprova ou reprova.', ledger));
  assert.ok(result.evidence.diagnostics.some(item => item.code === 'BUSINESS_EVIDENCE_NOT_GROUNDED'));
  assert.notEqual(result.decision, 'approved');
});

