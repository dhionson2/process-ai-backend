import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEnvironment } from '../src/config/env.js';
import { compileBusinessIntent, SemanticGroundingError } from '../src/modules/ai/semantic-process.js';
import { evaluateActivityGrounding, evaluateStructuredSemanticCorrespondence, evidenceOccurrenceId, explicitNumericCorrection, extractNumericThresholdFacts, identityForQuestion, makeSemanticFact, reconcileExplicitNumericCorrection, reconcileSemanticFacts, removeSemanticFact, semanticSlotForQuestion } from '../src/modules/ai/semantic-grounding.js';
import { evaluateRequirementCoverage, requirementFromEvidence, verifyRequirementEvidence, proposeLiteralCoverageLinks, type RequirementLedgerV1 } from '../src/modules/ai/requirement-coverage.js';

const options = { targetProfile: 'generic-bpmn2' as const, knowledgeVersion: '1.0.0', model: 'controlled-fixture', semanticGroundingMode: 'controlled' as const };
const empty = { rules: [], suggestions: [], pendingConfiguration: [] };

test('flag controlado permanece opt-in e mantém legacy como baseline', () => {
  assert.equal(readEnvironment({}).aiSemanticGroundingMode, 'legacy');
  assert.equal(readEnvironment({ AI_SEMANTIC_GROUNDING_MODE: 'controlled' }).aiSemanticGroundingMode, 'controlled');
  assert.throws(() => readEnvironment({ AI_SEMANTIC_GROUNDING_MODE: 'automatic' }), /AI_SEMANTIC_GROUNDING_MODE inválido/);
});

test('S01 — comprova paráfrase morfológica de atividade sem usar o nome como identidade', async () => {
  const evidence = "O Gestor executa 'Verificar completude da solicitação'.";
  const intent = { kind: 'business_intent', name: 'Processo de teste', purpose: evidence, actors: [{ name: 'Gestor', evidence, resolution: 'unresolved' }], startFields: [], activities: [{ kind: 'task', name: 'Verificação de completude', actor: 'Gestor', evidence }], ...empty };
  const result = await compileBusinessIntent(intent, { ...options, sourceText: evidence, activitySourceText: evidence });
  assert.ok(result.spec.nodes.some((node: any) => node.type === 'userTask' && node.name === 'Verificação de completude'));
  assert.ok(result.spec.metadata.requirementProvenance.some((item: any) => item.name === 'Verificação de completude' && item.confirmed));
  const requirement = requirementFromEvidence({ messageId: 'grounding-ledger', text: evidence, type: 'activity', start: 0, end: evidence.length });
  const ledger: RequirementLedgerV1 = { schemaVersion: '1.0.0', extraction: { complete: false, method: 'controlled-fixture', diagnostics: [] }, requirements: [requirement] };
  const element = { id: 'activity:manager:completeness-check', type: 'activity' as const, meaning: 'Verificação de completude', evidence, actor: 'Gestor' };
  const links = proposeLiteralCoverageLinks(ledger, [element], 'controlled');
  const coverage = evaluateRequirementCoverage({ ledger, elements: [element], links, messages: [{ id: 'grounding-ledger', text: evidence }] });
  assert.equal(coverage.totals.proven, 1, 'controlled correspondence contributes to coverage only after the source span validates');
});

test('correção é reconhecida como flexão nominal de corrigir sem colapsar outras ações', () => {
  assert.equal(evaluateActivityGrounding({ name: 'Corrigir solicitação', evidence: 'O funcionário realiza a correção da solicitação.' }).status, 'equivalent');
  assert.equal(evaluateActivityGrounding({ name: 'Corrigir dados de pagamento', evidence: 'O funcionário realiza a correção dos dados de pagamento.' }).status, 'equivalent');
  assert.equal(evaluateActivityGrounding({ name: 'Reprovar solicitação', evidence: 'O funcionário realiza a correção da solicitação.' }).status, 'divergent');
});

test('S02/S25 — ação semanticamente diferente não passa mesmo com citação literal válida', () => {
  const evidence = 'O Gestor aprova a solicitação.';
  const requirement = requirementFromEvidence({ messageId: 's25', text: evidence, type: 'activity', start: 0, end: evidence.length });
  assert.equal(verifyRequirementEvidence(requirement, [{ id: 's25', text: evidence }]), true, 'literal provenance is valid independently');
  const result = evaluateActivityGrounding({ name: 'Reprovar solicitação', evidence, expectedActor: 'Gestor', actualActor: 'Gestor' });
  assert.equal(result.status, 'divergent');
  assert.ok(result.divergent.includes('action'));
  const gateRequirement = requirementFromEvidence({ messageId: 's25-gate', text: evidence, type: 'activity', start: 0, end: evidence.length });
  const ledger: RequirementLedgerV1 = { schemaVersion: '1.0.0', extraction: { complete: false, method: 'controlled-fixture', diagnostics: [] }, requirements: [gateRequirement] };
  const element = { id: 'activity:rejection', type: 'activity' as const, meaning: 'Reprovar solicitação', evidence, actor: 'Gestor' };
  const links = proposeLiteralCoverageLinks(ledger, [element], 'controlled');
  const report = evaluateRequirementCoverage({ ledger, elements: [element], links, messages: [{ id: 's25-gate', text: evidence }] });
  assert.equal(report.totals.proven, 0, 'valid provenance alone does not prove incompatible meaning');
});

test('Coverage Gate controlado não promove paráfrase com responsável diferente', () => {
  const evidence = 'O Gestor aprova a solicitação.';
  const requirement = requirementFromEvidence({ messageId: 'wrong-role-gate', text: evidence, type: 'activity', start: 0, end: evidence.length });
  const ledger: RequirementLedgerV1 = { schemaVersion: '1.0.0', extraction: { complete: false, method: 'controlled-fixture', diagnostics: [] }, requirements: [requirement] };
  const elements = [
    { id: 'actor:gestor', type: 'actor' as const, meaning: 'Gestor', actor: 'Gestor', evidence },
    { id: 'activity:director-approval', type: 'activity' as const, meaning: 'Aprovação da solicitação', actor: 'Diretor', evidence },
  ];
  const links = proposeLiteralCoverageLinks(ledger, elements, 'controlled');
  const report = evaluateRequirementCoverage({ ledger, elements, links, messages: [{ id: 'wrong-role-gate', text: evidence }] });
  assert.equal(report.totals.proven, 0);
  assert.equal(links.some(link => link.elementId === 'activity:director-approval'), false);
});

test('S03/S04/S14 — confirma a atribuição correta e diverge quando o papel ou aprovação muda', () => {
  const evidence = 'O Gestor aprova a solicitação.';
  assert.equal(evaluateActivityGrounding({ name: 'Aprovação da solicitação', evidence, expectedActor: 'Gestor', actualActor: 'Gestor' }).status, 'equivalent');
  const wrongRole = evaluateActivityGrounding({ name: 'Aprovação da solicitação', evidence, expectedActor: 'Gestor', actualActor: 'Diretor' });
  assert.equal(wrongRole.status, 'divergent');
  assert.ok(wrongRole.divergent.includes('actor'));
  assert.notEqual(semanticSlotForQuestion('Como o Gestor aprova?'), semanticSlotForQuestion('Como o Diretor aprova?'));
});

test('atividade inventada ou não analisável falha fechada em vez de virar cobertura', async () => {
  const evidence = 'O Gestor aprova a solicitação.';
  const intent = { kind: 'business_intent', name: 'Processo de teste', purpose: evidence, actors: [{ name: 'Gestor', evidence, resolution: 'unresolved' }], startFields: [], activities: [{ kind: 'task', name: 'Executar pagamento', actor: 'Gestor', evidence }], ...empty };
  await assert.rejects(() => compileBusinessIntent(intent, { ...options, sourceText: evidence, activitySourceText: evidence }), SemanticGroundingError);
  const unknown = evaluateActivityGrounding({ name: 'Etapa operacional', evidence: 'Informação de apoio disponível.', expectedActor: 'Gestor', actualActor: 'Gestor' });
  assert.equal(unknown.status, 'inconclusive');
});

test('S05/S06/S07/S10/S23 — slots estáveis reconhecem resposta equivalente entre turnos e mantêm pergunta nova distinta', () => {
  const first = identityForQuestion('Como atribuir o papel ao segundo aprovador solicitado?');
  const paraphrase = identityForQuestion('Quem executa a segunda aprovação e qual é sua atribuição?');
  const fresh = identityForQuestion('Qual campo deve registrar o resultado da decisão?');
  assert.equal(first.semanticSlot, paraphrase.semanticSlot);
  assert.equal(first.requirementId, paraphrase.requirementId);
  assert.equal(first.questionId, paraphrase.questionId);
  assert.notEqual(first.semanticSlot, fresh.semanticSlot);
  assert.equal(first.status, 'pending');
});

test('identidade da ocorrência, do requisito e do elemento técnico permanecem separadas', () => {
  const occurrenceOne = evidenceOccurrenceId('message-1', 0, 20, 'Gestor executa revisão');
  const occurrenceTwo = evidenceOccurrenceId('message-2', 0, 20, 'Gestor executa revisão');
  const a = makeSemanticFact({ type: 'activity', entity: 'revisão', attribute: 'execute', context: 'etapa:análise-inicial', value: 'Gestor', source: { sourceId: 'message-1' } });
  const b = makeSemanticFact({ type: 'activity', entity: 'revisão', attribute: 'execute', context: 'etapa:revisão-final', value: 'Gestor', source: { sourceId: 'message-2' } });
  assert.notEqual(occurrenceOne, occurrenceTwo);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.requirementId, b.requirementId, 'context/occurrence path prevents collision between similar activities in separate stages');
  assert.notEqual(a.id, 'task_revisao', 'semantic fact identity is independent of BPMN node identity');
});

test('S23 — nova ocorrência confirma o mesmo slot sem colidir com a evidência original', () => {
  const slot = semanticSlotForQuestion('Qual papel executa a revisão?');
  const first = makeSemanticFact({ type: 'actor-assignment', entity: 'review-task', attribute: 'responsible-role', context: 'request-review', stage: 'review', value: 'Gestor', source: { sourceId: 'turn-1' } });
  const second = makeSemanticFact({ type: 'actor-assignment', entity: 'review-task', attribute: 'responsible-role', context: 'request-review', stage: 'review', value: 'Gestor', source: { sourceId: 'turn-2' } });
  assert.equal(first.requirementId, second.requirementId, 'same semantic requirement keeps identity across messages');
  assert.notEqual(first.id, second.id);
  assert.notEqual(evidenceOccurrenceId('turn-1', 0, 10, 'Gestor'), evidenceOccurrenceId('turn-2', 0, 10, 'Gestor'));
  assert.ok(slot.startsWith('slot:actor-assignment:'));
});

test('S08/S12 — uma correção numérica explícita supersede o valor anterior e mantém a trilha', () => {
  const prior = extractNumericThresholdFacts([{ sourceId: 'turn-1', text: 'O Diretor aprova solicitações acima de R$ 2.000.' }]);
  assert.equal(prior.length, 1);
  const reconciled = reconcileExplicitNumericCorrection(prior, 'Altere o limite para R$ 5.000.', 'turn-2');
  assert.equal(reconciled.status, 'reconciled');
  assert.equal(reconciled.facts.find(item => item.state === 'superseded')?.value, 'gt:2000');
  assert.equal(reconciled.facts.find(item => item.state === 'confirmed')?.value, 'gt:5000');
  assert.ok(reconciled.directive?.includes('Use somente o valor atual'));
  assert.equal(explicitNumericCorrection('Mude o prazo para 5.000.'), undefined, 'an unrelated numeric field is not mistaken for a threshold correction');
  assert.equal(explicitNumericCorrection('Substitua o limite de 2.000 para 5.000.')?.value, 5000);
  const repeated = reconcileExplicitNumericCorrection(reconciled.facts, 'Altere o limite para R$ 5.000.', 'turn-3');
  assert.equal(repeated.status, 'unchanged', 'repeating the active value is idempotent');
  assert.equal(repeated.facts.length, reconciled.facts.length);
});

test('S24 — valores contraditórios sem correção explícita permanecem contraditórios', () => {
  const a = makeSemanticFact({ type: 'condition', entity: 'process', attribute: 'numeric-threshold', context: 'business-rule', value: 'gt:2000', source: { sourceId: 'turn-1' }, state: 'confirmed' });
  const b = makeSemanticFact({ type: 'condition', entity: 'process', attribute: 'numeric-threshold', context: 'business-rule', value: 'gt:5000', source: { sourceId: 'turn-2' }, state: 'new' });
  const result = reconcileSemanticFacts([a], [b]);
  assert.equal(result.find(item => item.source.sourceId === 'turn-1')?.state, 'contradictory');
  assert.equal(result.find(item => item.source.sourceId === 'turn-2')?.state, 'contradictory');
});

test('S09/S13/S15-S17 — comparação estruturada detecta operador, etapa, dependência e ramo distintos', () => {
  const expected = makeSemanticFact({ type: 'condition', entity: 'requested_amount', attribute: 'approval-threshold', context: 'decision', stage: 'director-review', value: 'gt:2000', source: { sourceId: 'requirement' }, dependsOn: ['manager-approval'], relations: [{ type: 'supports', factId: 'director-approval' }] });
  const same = makeSemanticFact({ ...expected, source: { sourceId: 'plan' } });
  assert.equal(evaluateStructuredSemanticCorrespondence(expected, same).status, 'equivalent');
  const operator = makeSemanticFact({ ...expected, value: 'gte:2000', source: { sourceId: 'plan' } });
  const operatorResult = evaluateStructuredSemanticCorrespondence(expected, operator);
  assert.equal(operatorResult.status, 'divergent');
  assert.ok(operatorResult.divergent.includes('condition'));
  const stage = makeSemanticFact({ ...expected, stage: 'finance-review', source: { sourceId: 'plan' } });
  assert.ok(evaluateStructuredSemanticCorrespondence(expected, stage).divergent.includes('stage'));
  const consequence = makeSemanticFact({ ...expected, relations: [{ type: 'supports', factId: 'manager-approval' }], source: { sourceId: 'plan' } });
  assert.ok(evaluateStructuredSemanticCorrespondence(expected, consequence).divergent.includes('consequence'));
  const dependency = makeSemanticFact({ ...expected, dependsOn: ['finance-approval'], source: { sourceId: 'plan' } });
  assert.ok(evaluateStructuredSemanticCorrespondence(expected, dependency).divergent.includes('dependency'));
});

test('negação explícita remove o fato ativo preservando vínculo e histórico', () => {
  const active = makeSemanticFact({ type: 'integration', entity: 'external-service', attribute: 'invoke', context: 'process', value: 'enabled', source: { sourceId: 'turn-1' }, state: 'confirmed' });
  const removed = removeSemanticFact([active], active.requirementId!, 'turn-2');
  assert.equal(removed[0].state, 'removed');
  assert.deepEqual(removed[0].relations.at(-1), { type: 'removes', factId: 'turn-2' });
});

test('ambiguidade de reconciliação técnica não fabrica um valor substituto', () => {
  const previous = extractNumericThresholdFacts([
    { sourceId: 'a', text: 'Solicitações acima de 2.000 vão ao Diretor.' },
    { sourceId: 'b', text: 'Valores superiores a 8.000 exigem análise adicional.' },
  ]);
  const result = reconcileExplicitNumericCorrection(previous, 'Altere o limite para 5.000.', 'c');
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.facts.filter(item => item.state === 'confirmed').length, 2, 'ambiguous correction preserves both previously confirmed values without promoting a replacement');
  assert.ok(!result.facts.some(item => item.value === 'gt:5000'));
});

test('correção com alvo nomeado não é aplicada ao único limite conhecido sem identidade do alvo', () => {
  const previous = extractNumericThresholdFacts([{ sourceId: 'director-rule', text: 'O Diretor aprova despesas acima de R$ 2.000.' }]);
  const result = reconcileExplicitNumericCorrection(previous, 'Altere o limite do Financeiro para R$ 5.000.', 'wrong-target');
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.facts[0].state, 'confirmed');
  assert.equal(result.facts[0].value, 'gt:2000');
});

test('limites distintos com o mesmo valor continuam ambíguos e preservam os fatos ativos', () => {
  const previous = extractNumericThresholdFacts([
    { sourceId: 'director-rule', text: 'O Diretor aprova despesas acima de R$ 2.000.' },
    { sourceId: 'finance-rule', text: 'O Financeiro revisa pagamentos acima de R$ 2.000.' },
  ]);
  assert.equal(previous[0].requirementId, previous[1].requirementId, 'the narrow extractor currently has no reliable business-rule identity');
  const result = reconcileExplicitNumericCorrection(previous, 'Altere o limite para R$ 5.000.', 'correction');
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.facts.map(fact => fact.state), ['confirmed', 'confirmed']);
  assert.equal(reconcileExplicitNumericCorrection(previous, 'Altere o limite do Diretor para R$ 5.000.', 'wrong-target').status, 'ambiguous', 'a named target is not silently inferred while the narrow facts lack stable rule identity');
});

test('IDs de slot são determinísticos e explícita negação não equivale à afirmação', () => {
  assert.equal(identityForQuestion('Qual papel executa revisão?').questionId, identityForQuestion('Qual papel executa revisão?').questionId);
  const result = evaluateActivityGrounding({ name: 'Não executar pagamento', evidence: 'Executar pagamento.', expectedActor: 'Financeiro', actualActor: 'Financeiro' });
  assert.equal(result.status, 'divergent');
  assert.ok(result.divergent.includes('negation'));
});
