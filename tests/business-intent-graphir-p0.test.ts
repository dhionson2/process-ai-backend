import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileBusinessIntentToGraphIR, type BusinessObligation, type ObligationLedger } from '../src/modules/graph-ir/business-intent-compiler.js';
import type { BusinessIntentV1 } from '../src/modules/ai/semantic-process.js';
import { validateGraphIR } from '../src/modules/graph-ir/graph-ir.js';
import { lowerGraphIRToProcessSpec } from '../src/modules/graph-ir/processspec.adapter.js';
import { validateProcessSpec } from '../src/modules/validation/validation.service.js';

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

test('P0 compila returnTo em loop-back com target exato e preserva condições numéricas', async () => {
  const intent: BusinessIntentV1 = {
    kind: 'business_intent', name: 'Reembolso com correção', purpose: 'Revisar e corrigir reembolso.',
    actors: [{ name: 'Gestor', resolution: 'group', groupName: 'managers' }],
    startFields: [{ name: 'Valor', type: 'decimal', required: true }],
    activities: [
      { kind: 'task', name: 'Analisar reembolso', actor: 'Gestor' },
      { kind: 'decision', name: 'Revisão do Gestor', field: 'Valor', alternatives: [
        { label: 'Acima de 2000', value: 2000, operator: 'gt', steps: [{ kind: 'task', name: 'Corrigir reembolso', actor: 'Gestor' }], returnTo: 'Analisar reembolso' },
        { label: 'Até 2000', value: 2000, operator: 'lte', steps: [{ kind: 'task', name: 'Aprovar valor baixo', actor: 'Gestor' }] },
      ] },
    ], rules: [], suggestions: [], pendingConfiguration: [],
  };
  const source = 'O Gestor analisa reembolso. Valores acima de 2000 levam a corrigir reembolso e retornar para Analisar reembolso. Valores até 2000 seguem para Aprovar valor baixo.';
  const root = `activity/${intent.name}`;
  const decision = `${root}/decision/Revisão do Gestor`;
  const obligations: BusinessObligation[] = [
    obAt(`${root}/task/Analisar reembolso`, ob('analysis', 'activity', 'Analisar reembolso', 'O Gestor analisa reembolso.')),
    obAt(`${decision}`, ob('decision', 'decision', 'Revisão do Gestor', 'Valores acima de 2000 levam a corrigir reembolso e retornar para Analisar reembolso.')),
    obAt(`${root}/decision/Revisão do Gestor/Acima de 2000/task/Corrigir reembolso`, ob('correct', 'activity', 'Corrigir reembolso', 'Valores acima de 2000 levam a corrigir reembolso')),
    obAt(`${root}/decision/Revisão do Gestor/Até 2000/task/Aprovar valor baixo`, ob('approve-low', 'activity', 'Aprovar valor baixo', 'Valores até 2000 seguem para Aprovar valor baixo.')),
    obAt(`${decision}/branch/Acima de 2000`, Object.assign(ob('condition-high', 'condition', 'Revisão do Gestor:Acima de 2000', 'Valores acima de 2000 levam a corrigir reembolso'), { intentPath: `${decision}/branch/Acima de 2000`, expectedOperator: 'gt', expectedValue: 2000 })),
    Object.assign(obAt(`${decision}/branch/Acima de 2000`, ob('loop-correct', 'loop', 'Revisão do Gestor:Acima de 2000', 'Valores acima de 2000 levam a corrigir reembolso e retornar para Analisar reembolso.')), { expectedTarget: 'Analisar reembolso' }),
    Object.assign(obAt(`${decision}/branch/Até 2000`, Object.assign(ob('condition-low', 'condition', 'Revisão do Gestor:Até 2000', 'Valores até 2000 seguem para Aprovar valor baixo.'), { expectedOperator: 'lte', expectedValue: 2000 })), {}),
  ];
  const ledger = { sourceId: 'R04', expectedObligationKeys: obligations.map(item => item.key), obligations };
  const result = await compileBusinessIntentToGraphIR(intent, options(source, ledger));
  assert.equal(result.evidence.internalConsistency, 'pass', JSON.stringify(result.evidence.diagnostics));
  const loop = result.graph!.edges.find(edge => edge.kind === 'loop-back')!;
  assert.equal(result.graph!.nodes.find(node => node.id === loop.source)?.name, 'Corrigir reembolso');
  assert.equal(result.graph!.nodes.find(node => node.id === loop.target)?.name, 'Analisar reembolso');
  const high = result.graph!.edges.find(edge => edge.label === 'Acima de 2000')!;
  assert.equal((high.condition as any).op, 'gt');
  assert.equal((high.condition as any).right.literal, 2000);
  const low = result.graph!.edges.find(edge => edge.label === 'Até 2000')!;
  assert.equal((low.condition as any).op, 'lte');
  assert.equal((low.condition as any).right.literal, 2000);
  const directorRoute = (amount: number) => amount > 2000 ? high.target : low.target;
  assert.equal(directorRoute(1999.99), low.target);
  assert.equal(directorRoute(2000), low.target);
  assert.equal(directorRoute(2000.01), high.target);
  assert.ok(result.processSpec && result.artifacts?.bpmnXml.includes('<bpmn:definitions'));
});

test('P0 rejeita returnTo inexistente e ambíguo sem escolher um target', async () => {
  const makeIntent = (target: string): BusinessIntentV1 => ({
    kind: 'business_intent', name: 'Retorno inválido', purpose: 'Validar destino.', actors: [{ name: 'Gestor', resolution: 'group', groupName: 'managers' }], startFields: [],
    activities: [{ kind: 'decision', name: 'Decisão', field: 'Estado', alternatives: [{ label: 'Corrigir', value: false, steps: [{ kind: 'task', name: 'Corrigir', actor: 'Gestor' }], returnTo: target }] }],
    rules: [], suggestions: [], pendingConfiguration: [],
  });
  const source = 'O Gestor corrige e retorna para Revisar.';
  const base = makeIntent('Revisar');
  base.startFields = [{ name: 'Estado', type: 'boolean', required: true }];
  const path = `activity/${base.name}/decision/Decisão/Corrigir/task/Corrigir`;
  const decisionPath = `activity/${base.name}/decision/Decisão`;
  const ledger: ObligationLedger = { sourceId: 'return-target', expectedObligationKeys: ['correct', 'condition', 'loop'], obligations: [
    obAt(path, ob('correct', 'activity', 'Corrigir', 'O Gestor corrige.')),
    obAt(`${decisionPath}/branch/Corrigir`, ob('condition', 'condition', 'Decisão:Corrigir', 'O Gestor corrige.')),
    Object.assign(obAt(`${decisionPath}/branch/Corrigir`, ob('loop', 'loop', 'Decisão:Corrigir', 'O Gestor corrige e retorna para Revisar.')), { expectedTarget: 'Revisar' }),
  ] };
  const missing = await compileBusinessIntentToGraphIR(base, options(source, ledger));
  assert.ok(missing.evidence.diagnostics.some(item => item.code === 'BUSINESS_RETURN_TARGET_MISSING'));
  const ambiguous = structuredClone(base);
  ambiguous.activities.unshift({ kind: 'task', name: 'Revisar', actor: 'Gestor' });
  ambiguous.activities.push({ kind: 'task', name: 'Revisar', actor: 'Gestor' });
  const ambiguousResult = await compileBusinessIntentToGraphIR(ambiguous, options(source, ledger));
  assert.ok(ambiguousResult.evidence.diagnostics.some(item => item.code === 'BUSINESS_RETURN_TARGET_AMBIGUOUS'));
  assert.equal(ambiguousResult.graph!.edges.some(edge => edge.kind === 'loop-back'), false);
});

test('P0.2 compila dois loop-backs independentes com referências e destinos sem cruzamento', async () => {
  const intent: BusinessIntentV1 = {
    kind: 'business_intent', name: 'Dois ciclos de correção', purpose: 'Comprovar destinos independentes.',
    actors: [{ name: 'Colaborador', resolution: 'requester' }, { name: 'Gestor', resolution: 'manual' }, { name: 'Financeiro', resolution: 'manual' }],
    startFields: [{ name: 'Destino da análise', type: 'choice', required: true, choices: [{ label: 'Gestor', value: 'gestor' }, { label: 'Financeiro', value: 'financeiro' }, { label: 'Concluído', value: 'concluido' }] }],
    activities: [
      { kind: 'task', name: 'Analisar solicitação', actor: 'Gestor' },
      { kind: 'task', name: 'Conferir e processar reembolso', actor: 'Financeiro' },
      { kind: 'decision', name: 'Rota de correção', field: 'Destino da análise', alternatives: [
        { label: 'Correção da solicitação', value: 'gestor', steps: [{ kind: 'task', name: 'Corrigir solicitação', actor: 'Colaborador' }], returnTo: 'Analisar solicitação' },
        { label: 'Correção do pagamento', value: 'financeiro', steps: [{ kind: 'task', name: 'Corrigir dados de pagamento', actor: 'Colaborador' }], returnTo: 'Conferir e processar reembolso' },
        { label: 'Concluído', value: 'concluido', steps: [] },
      ] },
    ], rules: [], suggestions: [], pendingConfiguration: [],
  };
  const source = 'O Gestor analisa solicitação. O Financeiro confere e processa reembolso. A correção da solicitação retorna ao Gestor. A correção de pagamento retorna diretamente ao Financeiro. O processo pode ser concluído.';
  const root = `activity/${intent.name}`;
  const decision = `${root}/decision/Rota de correção`;
  const obligations: BusinessObligation[] = [
    obAt(`${root}/task/Analisar solicitação`, ob('manager-review', 'activity', 'Analisar solicitação', 'O Gestor analisa solicitação.')),
    obAt(`${root}/task/Conferir e processar reembolso`, ob('finance-review', 'activity', 'Conferir e processar reembolso', 'O Financeiro confere e processa reembolso.')),
    obAt(`${root}/decision/Rota de correção/Correção da solicitação/task/Corrigir solicitação`, ob('correct-request', 'activity', 'Corrigir solicitação', 'A correção da solicitação retorna ao Gestor.')),
    obAt(`${root}/decision/Rota de correção/Correção do pagamento/task/Corrigir dados de pagamento`, ob('correct-payment', 'activity', 'Corrigir dados de pagamento', 'A correção de pagamento retorna diretamente ao Financeiro.')),
    obAt(decision, ob('route-decision', 'decision', 'Rota de correção', 'O processo pode ser concluído.')),
    obAt(`${decision}/branch/Correção da solicitação`, ob('route-manager', 'condition', 'Rota de correção:Correção da solicitação', 'A correção da solicitação retorna ao Gestor.')),
    obAt(`${decision}/branch/Correção do pagamento`, ob('route-finance', 'condition', 'Rota de correção:Correção do pagamento', 'A correção de pagamento retorna diretamente ao Financeiro.')),
    obAt(`${decision}/branch/Concluído`, ob('route-done', 'condition', 'Rota de correção:Concluído', 'O processo pode ser concluído.')),
    Object.assign(obAt(`${decision}/branch/Correção da solicitação`, ob('loop-manager', 'loop', 'Rota de correção:Correção da solicitação', 'A correção da solicitação retorna ao Gestor.')), { expectedTarget: 'Analisar solicitação' }),
    Object.assign(obAt(`${decision}/branch/Correção do pagamento`, ob('loop-finance', 'loop', 'Rota de correção:Correção do pagamento', 'A correção de pagamento retorna diretamente ao Financeiro.')), { expectedTarget: 'Conferir e processar reembolso' }),
  ];
  const result = await compileBusinessIntentToGraphIR(intent, options(source, { sourceId: 'P0.2-two-loops', expectedObligationKeys: obligations.map(item => item.key), obligations }));
  assert.equal(result.evidence.internalConsistency, 'pass', JSON.stringify(result.evidence.diagnostics));
  assert.equal(result.evidence.interpretationCompleteness, 'not-measured');
  assert.equal(validateGraphIR(result.graph).valid, true);
  const lowered = await lowerGraphIRToProcessSpec(result.graph);
  assert.equal(lowered.valid, true, JSON.stringify(lowered.diagnostics));
  assert.ok(result.processSpec);
  assert.equal((await validateProcessSpec(lowered.processSpec)).valid, true);
  assert.ok(result.artifacts?.bpmnXml.includes('<bpmn:definitions'));
  assert.ok(result.artifacts?.forms.some(form => form.json.components.some((component: any) => component.label === 'Destino da análise')));
  const loops = result.graph!.edges.filter(edge => edge.kind === 'loop-back');
  assert.equal(loops.length, 2);
  const byId = new Map(result.graph!.nodes.map(node => [node.id, node]));
  const loopPairs = loops.map(edge => ({ source: byId.get(edge.source)?.name, target: byId.get(edge.target)?.name, refs: edge.requirementRefs }));
  assert.deepEqual(loopPairs.map(({ source, target }) => [source, target]).sort(), [
    ['Corrigir dados de pagamento', 'Conferir e processar reembolso'],
    ['Corrigir solicitação', 'Analisar solicitação'],
  ]);
  assert.ok(loops.every(edge => edge.id.startsWith('g_edge_') && edge.requirementRefs.length === 1));
  for (const edge of loops) {
    const requirement = result.graph!.requirements.find(item => edge.requirementRefs.includes(item.id));
    assert.equal(requirement?.kind, 'loop');
    assert.equal(requirement?.sourceNodeId, edge.source);
    assert.equal(requirement?.targetNodeId, edge.target);
  }
  assert.equal(loops.find(edge => byId.get(edge.source)?.name === 'Corrigir dados de pagamento')?.target, result.graph!.nodes.find(node => node.name === 'Conferir e processar reembolso')?.id);
  assert.notEqual(loops.find(edge => byId.get(edge.source)?.name === 'Corrigir dados de pagamento')?.target, result.graph!.nodes.find(node => node.name === 'Analisar solicitação')?.id);
});

test('P0.2 documenta a lacuna V1 de convergência necessária ao caminho compartilhado do R04', async () => {
  const intent: BusinessIntentV1 = {
    kind: 'business_intent', name: 'Convergência R04', purpose: 'Representar Diretor e rota direta chegando à mesma conferência financeira.',
    actors: [{ name: 'Diretor', resolution: 'manual' }, { name: 'Financeiro', resolution: 'manual' }], startFields: [{ name: 'Valor', type: 'decimal', required: true }],
    activities: [
      { kind: 'decision', name: 'Decisão de valor', field: 'Valor', alternatives: [
        { label: 'Acima de 2000', value: 2000, operator: 'gt', steps: [{ kind: 'task', name: 'Aprovar reembolso', actor: 'Diretor' }] },
        { label: 'Até 2000', value: 2000, operator: 'lte', steps: [{ kind: 'task', name: 'Conferir e processar reembolso', actor: 'Financeiro' }] },
      ] },
      { kind: 'task', name: 'Conferir e processar reembolso', actor: 'Financeiro' },
    ], rules: [], suggestions: [], pendingConfiguration: [],
  };
  const source = 'Valor acima de 2000 exige aprovação do Diretor. Valor até 2000 segue diretamente ao Financeiro. Depois da aprovação do Diretor ou da rota direta, o Financeiro confere e processa o reembolso.';
  const decisionPath = `activity/${intent.name}/decision/Decisão de valor`;
  const obligations: BusinessObligation[] = [
    obAt(decisionPath, ob('amount-decision', 'decision', 'Decisão de valor', 'Valor acima de 2000 exige aprovação do Diretor.')),
    obAt(`${decisionPath}/Acima de 2000/task/Aprovar reembolso`, ob('director-approval', 'activity', 'Aprovar reembolso', 'Valor acima de 2000 exige aprovação do Diretor.')),
    obAt(`${decisionPath}/Até 2000/task/Conferir e processar reembolso`, ob('finance-direct', 'activity', 'Conferir e processar reembolso', 'Valor até 2000 segue diretamente ao Financeiro.')),
    obAt(`${decisionPath}/branch/Acima de 2000`, Object.assign(ob('amount-high', 'condition', 'Decisão de valor:Acima de 2000', 'Valor acima de 2000 exige aprovação do Diretor.'), { intentPath: `${decisionPath}/branch/Acima de 2000`, expectedOperator: 'gt', expectedValue: 2000 })),
    obAt(`${decisionPath}/branch/Até 2000`, Object.assign(ob('amount-low', 'condition', 'Decisão de valor:Até 2000', 'Valor até 2000 segue diretamente ao Financeiro.'), { intentPath: `${decisionPath}/branch/Até 2000`, expectedOperator: 'lte', expectedValue: 2000 })),
    obAt(`activity/${intent.name}/task/Conferir e processar reembolso`, ob('finance-activity', 'activity', 'Conferir e processar reembolso', 'Depois da aprovação do Diretor ou da rota direta, o Financeiro confere e processa o reembolso.')),
  ];
  const result = await compileBusinessIntentToGraphIR(intent, options(source, { sourceId: 'R04-shared-finance-convergence', expectedObligationKeys: obligations.map(item => item.key), obligations }));
  assert.ok(result.evidence.diagnostics.some(item => item.code === 'BUSINESS_BRANCH_MERGE_UNSUPPORTED'));
  assert.equal(result.evidence.interpretationCompleteness, 'not-measured');
});

test('P0.2 fixture R04 preserva as seis atividades e falha fechado na junção financeira ausente em V1', async () => {
  const intent: BusinessIntentV1 = {
    kind: 'business_intent', name: 'R04 — Reembolso', purpose: 'Registrar, aprovar, conferir e corrigir reembolso.',
    actors: [{ name: 'Colaborador', resolution: 'requester' }, { name: 'Gestor', resolution: 'manual' }, { name: 'Diretor', resolution: 'manual' }, { name: 'Financeiro', resolution: 'manual' }],
    startFields: [{ name: 'Valor solicitado', type: 'decimal', required: true }],
    activities: [
      { kind: 'task', name: 'Registrar solicitação', actor: 'Colaborador' },
      { kind: 'task', name: 'Analisar solicitação', actor: 'Gestor', fields: [{ name: 'Decisão do Gestor', type: 'choice', required: true, choices: [{ label: 'Reprovar', value: 'reprovar' }, { label: 'Corrigir', value: 'corrigir' }, { label: 'Aprovar', value: 'aprovar' }] }] },
      { kind: 'decision', name: 'Resultado do Gestor', field: 'Decisão do Gestor', alternatives: [
        { label: 'Reprovado', value: 'reprovar', steps: [] },
        { label: 'Correção solicitada', value: 'corrigir', steps: [{ kind: 'task', name: 'Corrigir solicitação', actor: 'Colaborador' }], returnTo: 'Analisar solicitação' },
        { label: 'Aprovado', value: 'aprovar', steps: [{ kind: 'decision', name: 'Faixa de aprovação', field: 'Valor solicitado', alternatives: [
          { label: 'Acima de 2000', value: 2000, operator: 'gt', steps: [
            { kind: 'task', name: 'Aprovar reembolso', actor: 'Diretor', fields: [{ name: 'Decisão do Diretor', type: 'choice', required: true, choices: [{ label: 'Reprovar', value: 'reprovar' }, { label: 'Aprovar', value: 'aprovar' }] }] },
            { kind: 'decision', name: 'Resultado do Diretor', field: 'Decisão do Diretor', alternatives: [
              { label: 'Reprovado', value: 'reprovar', steps: [] }, { label: 'Aprovado', value: 'aprovar', steps: [] },
            ] },
          ] },
          { label: 'Até 2000', value: 2000, operator: 'lte', steps: [] },
        ] }] },
      ] },
      { kind: 'task', name: 'Conferir e processar reembolso', actor: 'Financeiro', fields: [{ name: 'Resultado financeiro', type: 'choice', required: true, choices: [{ label: 'Confirmar', value: 'confirmar' }, { label: 'Corrigir pagamento', value: 'corrigir' }] }, { name: 'Número da transação', type: 'text', required: true }] },
      { kind: 'decision', name: 'Resultado financeiro', field: 'Resultado financeiro', alternatives: [
        { label: 'Correção de pagamento solicitada', value: 'corrigir', steps: [{ kind: 'task', name: 'Corrigir dados de pagamento', actor: 'Colaborador' }], returnTo: 'Conferir e processar reembolso' },
        { label: 'Confirmado', value: 'confirmar', steps: [] },
      ] },
    ], rules: [], suggestions: [], pendingConfiguration: [],
  };
  const source = 'O Colaborador registra a solicitação. O Gestor analisa a solicitação e pode reprovar, solicitar correção ou aprovar. A reprovação do Gestor encerra. A correção retorna ao Gestor, que reavalia o valor atualizado. Valor acima de 2000 exige aprovação do Diretor. Valor menor ou igual a 2000 segue ao Financeiro. A reprovação do Diretor encerra e a aprovação segue ao Financeiro. O Financeiro confere e processa o reembolso; a correção dos dados de pagamento retorna diretamente ao Financeiro sem repetir aprovações. Quando confirmado, o processo encerra.';
  const root = `activity/${intent.name}`;
  const manager = `${root}/decision/Resultado do Gestor`;
  const amount = `${manager}/Aprovado/decision/Faixa de aprovação`;
  const director = `${amount}/Acima de 2000/task/Aprovar reembolso`;
  const directorResult = `${director}/decision/Resultado do Diretor`;
  const financeDecision = `${root}/decision/Resultado financeiro`;
  const obligations: BusinessObligation[] = [];
  const addActivity = (path: string, name: string, evidence: string) => obligations.push(obAt(path, ob(`activity-${obligations.length}`, 'activity', name, evidence)));
  const addStructure = (path: string, name: string, evidence: string) => obligations.push(obAt(path, ob(`structure-${obligations.length}`, 'decision', name, evidence)));
  const addCondition = (path: string, subject: string, evidence: string, operator?: string, value?: string | number | boolean) => obligations.push(Object.assign(obAt(path, ob(`condition-${obligations.length}`, 'condition', subject, evidence)), { ...(operator ? { expectedOperator: operator } : {}), ...(value !== undefined ? { expectedValue: value } : {}) }));
  addActivity(`${root}/task/Registrar solicitação`, 'Registrar solicitação', 'O Colaborador registra a solicitação.');
  addActivity(`${root}/task/Analisar solicitação`, 'Analisar solicitação', 'O Gestor analisa a solicitação');
  addActivity(`${manager}/Correção solicitada/task/Corrigir solicitação`, 'Corrigir solicitação', 'A correção retorna ao Gestor');
  addStructure(manager, 'Resultado do Gestor', 'O Gestor analisa a solicitação e pode reprovar, solicitar correção ou aprovar.');
  addCondition(`${manager}/branch/Reprovado`, 'Resultado do Gestor:Reprovado', 'A reprovação do Gestor encerra.');
  addCondition(`${manager}/branch/Correção solicitada`, 'Resultado do Gestor:Correção solicitada', 'solicitar correção');
  addCondition(`${manager}/branch/Aprovado`, 'Resultado do Gestor:Aprovado', 'ou aprovar');
  obligations.push(Object.assign(obAt(`${manager}/branch/Correção solicitada`, ob('loop-manager', 'loop', 'Resultado do Gestor:Correção solicitada', 'A correção retorna ao Gestor')), { expectedTarget: 'Analisar solicitação' }));
  addStructure(amount, 'Faixa de aprovação', 'Valor acima de 2000 exige aprovação do Diretor.');
  addCondition(`${amount}/branch/Acima de 2000`, 'Faixa de aprovação:Acima de 2000', 'Valor acima de 2000 exige aprovação do Diretor.', 'gt', 2000);
  addCondition(`${amount}/branch/Até 2000`, 'Faixa de aprovação:Até 2000', 'Valor menor ou igual a 2000 segue ao Financeiro.', 'lte', 2000);
  addActivity(director, 'Aprovar reembolso', 'exige aprovação do Diretor');
  addStructure(directorResult, 'Resultado do Diretor', 'A reprovação do Diretor encerra e a aprovação segue ao Financeiro.');
  addCondition(`${directorResult}/branch/Reprovado`, 'Resultado do Diretor:Reprovado', 'A reprovação do Diretor encerra');
  addCondition(`${directorResult}/branch/Aprovado`, 'Resultado do Diretor:Aprovado', 'a aprovação segue ao Financeiro');
  addActivity(`${root}/task/Conferir e processar reembolso`, 'Conferir e processar reembolso', 'O Financeiro confere e processa o reembolso');
  addStructure(financeDecision, 'Resultado financeiro', 'Quando confirmado, o processo encerra.');
  addCondition(`${financeDecision}/branch/Correção de pagamento solicitada`, 'Resultado financeiro:Correção de pagamento solicitada', 'a correção dos dados de pagamento retorna diretamente ao Financeiro');
  addCondition(`${financeDecision}/branch/Confirmado`, 'Resultado financeiro:Confirmado', 'Quando confirmado, o processo encerra.');
  addActivity(`${financeDecision}/Correção de pagamento solicitada/task/Corrigir dados de pagamento`, 'Corrigir dados de pagamento', 'a correção dos dados de pagamento retorna diretamente ao Financeiro');
  obligations.push(Object.assign(obAt(`${financeDecision}/branch/Correção de pagamento solicitada`, ob('loop-finance', 'loop', 'Resultado financeiro:Correção de pagamento solicitada', 'a correção dos dados de pagamento retorna diretamente ao Financeiro')), { expectedTarget: 'Conferir e processar reembolso' }));
  const taskNames = (items: BusinessIntentV1['activities']): string[] => items.flatMap(item => item.kind === 'task' ? [item.name] : item.kind === 'decision' ? item.alternatives.flatMap(alternative => taskNames(alternative.steps)) : item.kind === 'approval' ? [...taskNames(item.onApproved), ...taskNames(item.onRejected)] : []);
  assert.deepEqual(taskNames(intent.activities), ['Registrar solicitação', 'Analisar solicitação', 'Corrigir solicitação', 'Aprovar reembolso', 'Conferir e processar reembolso', 'Corrigir dados de pagamento']);
  const result = await compileBusinessIntentToGraphIR(intent, options(source, { sourceId: 'R04-controlled-v1', expectedObligationKeys: obligations.map(item => item.key), obligations }));
  assert.ok(result.evidence.diagnostics.some(item => item.code === 'BUSINESS_BRANCH_MERGE_UNSUPPORTED'));
  assert.equal(validateGraphIR(result.graph).valid, false);
  assert.ok(result.evidence.diagnostics.some(item => item.code === 'GRAPHIR_END_HAS_OUTGOING'), 'a linear continuation after a fork would incorrectly leave a rejection end; the semantic validator blocks it');
  assert.equal(result.processSpec, null);
  assert.equal(result.artifacts, null);
  const nodesById = new Map(result.graph!.nodes.map(node => [node.id, node]));
  const r04Loops = result.graph!.edges.filter(edge => edge.kind === 'loop-back');
  assert.deepEqual(r04Loops.map(edge => [nodesById.get(edge.source)?.name, nodesById.get(edge.target)?.name]).sort(), [
    ['Corrigir dados de pagamento', 'Conferir e processar reembolso'],
    ['Corrigir solicitação', 'Analisar solicitação'],
  ]);
  const paymentLoop = r04Loops.find(edge => nodesById.get(edge.source)?.name === 'Corrigir dados de pagamento')!;
  assert.equal(nodesById.get(paymentLoop.target)?.name, 'Conferir e processar reembolso');
  assert.ok(!r04Loops.some(edge => nodesById.get(edge.source)?.name === 'Corrigir dados de pagamento' && ['Analisar solicitação', 'Aprovar reembolso'].includes(nodesById.get(edge.target)?.name || '')));
  const amountEdges = result.graph!.edges.filter(edge => ['Acima de 2000', 'Até 2000'].includes(edge.label || ''));
  assert.deepEqual(amountEdges.map(edge => [(edge.condition as any).op, (edge.condition as any).right.literal]).sort(), [['gt', 2000], ['lte', 2000]]);
  const highRoute = amountEdges.find(edge => edge.label === 'Acima de 2000')!;
  const lowRoute = amountEdges.find(edge => edge.label === 'Até 2000')!;
  assert.equal(nodesById.get(highRoute.target)?.name, 'Aprovar reembolso');
  assert.equal(nodesById.get(lowRoute.target)?.type, 'end', 'V1 termina a rota <= 2000 em vez de convergir com o Financeiro compartilhado; isso torna a insuficiência explícita.');
  assert.equal(result.decision, 'rejected');
  assert.equal(result.evidence.internalConsistency, 'fail');
  assert.equal(result.evidence.interpretationCompleteness, 'not-measured');
});

