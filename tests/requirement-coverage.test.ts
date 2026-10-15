import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRequirementCoverage, extractRequirementLedger, processSpecCoverageElements, proposeLiteralCoverageLinks, requirementFromEvidence, verifyRequirementEvidence, type CoverageElement, type RequirementStructure, type RequirementType } from '../src/modules/ai/requirement-coverage.js';
import { g03ReimbursementProcessSpec } from './fixtures/g03-reimbursement.js';
import { validateProcessSpec } from '../src/modules/validation/validation.service.js';

type Fixture = { name: string; type: RequirementType; source: string; element?: Omit<CoverageElement, 'id'>; expected: 'covered' | 'omitted' | 'partial' | 'invalid-evidence' | 'wrong-role' | 'unsupported' };
const fixtures: Fixture[] = [
  { name: 'atividade representada', type: 'activity', source: 'O solicitante envia o pedido.', element: { type: 'activity', meaning: 'O solicitante envia o pedido.', evidence: 'O solicitante envia o pedido.', evidenceSource: 'user' }, expected: 'covered' },
  { name: 'atividade omitida', type: 'activity', source: 'O RH registra a decisão.', expected: 'omitted' },
  { name: 'atividade inventada', type: 'activity', source: 'O gestor avalia o pedido.', element: { type: 'activity', meaning: 'Enviar notificação', evidence: 'O gestor avalia o pedido.', evidenceSource: 'user' }, expected: 'partial' },
  { name: 'papel divergente', type: 'actor', source: 'O gestor aprova o pedido.', element: { type: 'actor', meaning: 'Aprovar', actor: 'Financeiro', evidence: 'O gestor aprova o pedido.', evidenceSource: 'user' }, expected: 'wrong-role' },
  { name: 'condição numérica alterada', type: 'condition', source: 'Se o valor superar 2000, encaminha ao diretor.', element: { type: 'condition', meaning: 'superar 2500', evidence: 'Se o valor superar 2000, encaminha ao diretor.', evidenceSource: 'user' }, expected: 'partial' },
  { name: 'consequência ausente', type: 'consequence', source: 'Se reprovado, notifica o solicitante com o motivo.', expected: 'omitted' },
  { name: 'loop sem destino provado', type: 'loop', source: 'O funcionário corrige e reenvia ao gestor.', element: { type: 'loop', meaning: 'retorno ao solicitante', evidence: 'O funcionário corrige e reenvia ao gestor.', evidenceSource: 'user' }, expected: 'partial' },
  { name: 'requisito composto de dois ciclos sem cobertura integral', type: 'loop', source: 'O funcionário corrige e reenvia ao gestor. O financeiro revisa e retorna ao funcionário.', element: { type: 'loop', meaning: 'O financeiro revisa e retorna ao funcionário.', evidence: 'O financeiro revisa e retorna ao funcionário.', evidenceSource: 'user' }, expected: 'omitted' },
  { name: 'campo obrigatório omitido', type: 'field', source: 'O solicitante informa a data de início obrigatória.', expected: 'omitted' },
  { name: 'integração inventada', type: 'integration', source: 'Consultar a API corporativa aprovada.', element: { type: 'integration', meaning: 'API não aprovada', evidence: 'Consultar a API corporativa aprovada.', evidenceSource: 'user' }, expected: 'partial' },
  { name: 'paráfrase sem associação verificável', type: 'activity', source: 'O RH registra a solicitação.', element: { type: 'activity', meaning: 'Registrar o pedido', evidence: 'O RH registra a solicitação.', evidenceSource: 'user' }, expected: 'partial' },
  { name: 'nomes similares e sentidos diferentes', type: 'activity', source: 'O gestor analisa o pedido.', element: { type: 'activity', meaning: 'O gestor anexa o pedido', evidence: 'O gestor analisa o pedido.', evidenceSource: 'user' }, expected: 'partial' },
  { name: 'citação literal sem função compatível', type: 'activity', source: 'O RH registra a solicitação.', element: { type: 'decision', meaning: 'Registrar a solicitação', evidence: 'O RH registra a solicitação.', evidenceSource: 'user' } as any, expected: 'unsupported' },
  { name: 'requisito negado', type: 'integration', source: 'Não consultar API externa neste processo.', expected: 'unsupported' },
  { name: 'requisito confirmado em resposta anterior', type: 'field', source: 'O formulário exige o motivo da reprovação.', expected: 'omitted' },
];

test('Requirement Ledger V1 and Coverage Gate golden matrix: 15 independent positive/negative fixtures', () => {
  assert.equal(fixtures.length, 15);
  for (const [index, fixture] of fixtures.entries()) {
    const messageId = `golden-${index}`;
    const requirement = requirementFromEvidence({ messageId, text: fixture.source, type: fixture.type, start: 0, end: fixture.source.length, ...(index === 13 ? { state: 'explicitly-denied' as const, mandatory: false } : {}), ...(index === 14 ? { state: 'confirmed-answer' as const } : {}) });
    const element = fixture.element ? { ...fixture.element, id: `element-${index}` } as CoverageElement : undefined;
    const ledger = { schemaVersion: '1.0.0' as const, extraction: { complete: true, method: 'golden-independent', diagnostics: [] }, requirements: [requirement] };
    const elements = element ? [element] : [];
    const links = proposeLiteralCoverageLinks(ledger, elements);
    const report = evaluateRequirementCoverage({ ledger, elements, links, messages: [{ id: messageId, text: fixture.source }] });
    const status = report.findings.find(item => item.requirementId === requirement.id)?.status;
    assert.equal(status, fixture.expected, `${fixture.name}: ${JSON.stringify(report.findings)}`);
    if (index === 13) assert.equal(requirement.state, 'explicitly-denied');
    if (index === 14) assert.equal(requirement.state, 'confirmed-answer');
  }
});

test('two independent loops retain separate requirement IDs and only cover their own target', () => {
  const firstText = 'O gestor devolve ao solicitante para correção.';
  const secondText = 'O financeiro devolve ao funcionário para correção.';
  const text = `${firstText} ${secondText}`;
  const a = requirementFromEvidence({ messageId: 'loops', text, type: 'loop', start: 0, end: firstText.length });
  const b = requirementFromEvidence({ messageId: 'loops', text, type: 'loop', start: firstText.length + 1, end: text.length });
  const elements = [{ id: 'manager-loop', type: 'loop' as const, meaning: firstText, evidence: firstText }, { id: 'finance-loop', type: 'loop' as const, meaning: secondText, evidence: secondText }];
  const ledger = { schemaVersion: '1.0.0' as const, extraction: { complete: true, method: 'golden', diagnostics: [] }, requirements: [a, b] };
  const report = evaluateRequirementCoverage({ ledger, elements, links: proposeLiteralCoverageLinks(ledger, elements), messages: [{ id: 'loops', text }] });
  assert.notEqual(a.id, b.id);
  assert.equal(report.totals.proven, 2);
  assert.ok(report.findings.every(item => item.status === 'covered'));
});

test('ledger IDs are stable across revisions when the source message identity and evidence remain stable', () => {
  const text = 'O gestor aprova o pedido.';
  const first = requirementFromEvidence({ messageId: 'm-1', text, type: 'decision', start: 0, end: text.length });
  const revisionText = 'O gestor decide sobre o pedido.';
  const revised = requirementFromEvidence({ messageId: 'm-1', text: revisionText, type: 'decision', start: 0, end: revisionText.length });
  assert.equal(first.id, revised.id);
  assert.doesNotMatch(first.id, /gestor|aprova/);
  const repeated = 'O gestor aprova o pedido. O gestor aprova o pedido.';
  const firstOccurrence = requirementFromEvidence({ messageId: 'm-repeat', text: repeated, type: 'decision', start: 0, end: 25 });
  const secondOccurrenceStart = repeated.lastIndexOf('O gestor');
  const secondOccurrence = requirementFromEvidence({ messageId: 'm-repeat', text: repeated, type: 'decision', start: secondOccurrenceStart, end: repeated.length });
  assert.notEqual(firstOccurrence.id, secondOccurrence.id, 'source spans distinguish repeated requirements with identical words');
});

test('evidence intervals reject forged or stale quotes', () => {
  const text = 'O gestor aprova o pedido.';
  const req = requirementFromEvidence({ messageId: 'm-1', text, type: 'decision', start: 0, end: text.length });
  assert.equal(verifyRequirementEvidence(req, [{ id: 'm-1', text }]), true);
  assert.equal(verifyRequirementEvidence({ ...req, evidence: { ...req.evidence!, end: req.evidence!.end - 1 } }, [{ id: 'm-1', text }]), false);
});

test('sentence candidate extraction is explicitly incomplete and never claims full coverage', () => {
  const ledger = extractRequirementLedger({ messages: [{ id: 'msg', text: 'O gestor aprova o pedido. O solicitante informa o motivo.' }] });
  assert.equal(ledger.schemaVersion, '1.0.0');
  assert.equal(ledger.extraction.complete, false);
  assert.ok(ledger.requirements.length >= 2);
  assert.ok(ledger.requirements.every(item => verifyRequirementEvidence(item, [{ id: 'msg', text: 'O gestor aprova o pedido. O solicitante informa o motivo.' }])));
});

test('simple explicit negation is retained as denied, never promoted to mandatory coverage', () => {
  const text = 'Não consultar API externa neste processo.';
  const ledger = extractRequirementLedger({ messages: [{ id: 'denial', text }] });
  assert.equal(ledger.requirements[0]?.state, 'explicitly-denied');
  assert.equal(ledger.requirements[0]?.mandatory, false);
});

let controlledRequirementIndex = 0;
function controlledRequirement(type: RequirementType, structure: RequirementStructure, text: string) {
  const messageId = `controlled-ledger-${controlledRequirementIndex++}`;
  return { ...requirementFromEvidence({ messageId, text, type, start: 0, end: text.length }), structure };
}

async function evaluateAgainstG03(requirements: ReturnType<typeof controlledRequirement>[], spec = structuredClone(g03ReimbursementProcessSpec), overrides: { links?: any[]; extractionComplete?: boolean } = {}) {
  const validation = await validateProcessSpec(spec);
  const ledger = { schemaVersion: '1.0.0' as const, extraction: { complete: overrides.extractionComplete ?? true, method: 'independent-controlled-ledger', diagnostics: [] }, requirements };
  const elements = processSpecCoverageElements(spec);
  const links = overrides.links || proposeLiteralCoverageLinks(ledger, elements);
  const messages = requirements.map(item => ({ id: item.evidence!.messageId, text: item.originalText }));
  const report = evaluateRequirementCoverage({ ledger, elements, links, messages, processSpec: spec, processSpecValid: validation.valid });
  return { report, validation, spec, elements, ledger, links };
}

test('controlled Ledger proves both G03 correction loops independently with their exact destinations', async () => {
  const manager = controlledRequirement('loop', { kind: 'loop', modelRef: { kind: 'flow', id: 'f_adjust_return' }, sourceNodeId: 'employee_adjust', targetNodeId: 'manager_check', actorRoleId: 'employee' }, 'Funcionário ajusta a solicitação e retorna à verificação do Gestor.');
  const finance = controlledRequirement('loop', { kind: 'loop', modelRef: { kind: 'flow', id: 'f_docs_return' }, sourceNodeId: 'employee_correct_docs', targetNodeId: 'finance_check', actorRoleId: 'employee' }, 'Funcionário corrige a documentação e retorna diretamente à conferência do Financeiro.');
  const { report, validation } = await evaluateAgainstG03([manager, finance]);
  assert.equal(validation.valid, true);
  assert.equal(report.totals.proven, 2);
  assert.ok(report.findings.filter(item => item.requirementId === manager.id || item.requirementId === finance.id).every(item => item.status === 'covered'));
});

test('controlled Ledger detects numeric operator divergence despite correct requirementId and flow reference', async () => {
  const threshold = controlledRequirement('condition', { kind: 'condition', modelRef: { kind: 'flow', id: 'f_amount_high' }, variable: 'requested_amount', operator: 'gt', value: 2000, valueType: 'decimal', gatewayId: 'amount_gateway', targetNodeId: 'director_approval' }, 'Valor solicitado maior que 2000 segue para aprovação do Diretor.');
  const mutated = structuredClone(g03ReimbursementProcessSpec);
  (mutated.flows.find((flow: any) => flow.id === 'f_amount_low') as any).condition.op = 'lt';
  (mutated.flows.find((flow: any) => flow.id === 'f_amount_high') as any).condition.op = 'gte';
  const { report, validation } = await evaluateAgainstG03([threshold], mutated);
  assert.equal(validation.valid, true, 'the mutation remains structurally valid under ProcessSpec v1');
  assert.ok(report.findings.some(item => item.status === 'divergent-condition'));
  assert.equal(report.totals.proven, 0);
});

test('same requirement ID linked to a different valid condition is a divergence, not coverage or omission', async () => {
  const threshold = controlledRequirement('condition', { kind: 'condition', modelRef: { kind: 'flow', id: 'f_amount_high' }, variable: 'requested_amount', operator: 'gt', value: 2000, valueType: 'decimal', gatewayId: 'amount_gateway', targetNodeId: 'director_approval' }, 'Valor maior que 2000 segue ao Diretor.');
  const { report } = await evaluateAgainstG03([threshold], structuredClone(g03ReimbursementProcessSpec), { links: [{ requirementId: threshold.id, elementId: 'condition:f_amount_low', basis: 'structural-equivalence', verified: true, details: 'deliberately wrong branch association' }] });
  assert.ok(report.findings.some(item => item.requirementId === threshold.id && item.status === 'divergent-condition'));
  assert.ok(!report.findings.some(item => item.requirementId === threshold.id && item.status === 'omitted'));
  assert.equal(report.totals.proven, 0);
});

test('controlled Ledger detects consequence moved to a different terminal branch', async () => {
  const consequence = controlledRequirement('consequence', { kind: 'consequence', modelRef: { kind: 'flow', id: 'f_director_rejected' }, gatewayId: 'director_decision_gateway', target: { kind: 'end', id: 'end_director_rejected' } }, 'Reprovação do Diretor encerra o processo no final correspondente.');
  const mutated = structuredClone(g03ReimbursementProcessSpec);
  const directorRejected = mutated.flows.find((flow: any) => flow.id === 'f_director_rejected') as any;
  const notReimbursable = mutated.flows.find((flow: any) => flow.id === 'f_not_reimbursable') as any;
  [directorRejected.target, notReimbursable.target] = [notReimbursable.target, directorRejected.target];
  const { report, validation } = await evaluateAgainstG03([consequence], mutated);
  assert.equal(validation.valid, true, 'both end events are valid and reachable in the mutated fixture');
  assert.ok(report.findings.some(item => item.status === 'wrong-consequence-branch'));
  assert.equal(report.totals.proven, 0);
});

test('controlled Ledger detects a correction cycle redirected to the wrong reviewer', async () => {
  const cycle = controlledRequirement('loop', { kind: 'loop', modelRef: { kind: 'flow', id: 'f_docs_return' }, sourceNodeId: 'employee_correct_docs', targetNodeId: 'finance_check', actorRoleId: 'employee' }, 'Funcionário corrige documentos e retorna à conferência do Financeiro.');
  const mutated = structuredClone(g03ReimbursementProcessSpec);
  (mutated.flows.find((flow: any) => flow.id === 'f_docs_return') as any).target = 'manager_check';
  const { report, validation } = await evaluateAgainstG03([cycle], mutated);
  assert.equal(validation.valid, true, 'the wrong return is still a structurally valid sequence flow');
  assert.ok(report.findings.some(item => item.status === 'wrong-loop-target'));
});

test('controlled Ledger detects wrong task role and a removed conditional rejection reason', async () => {
  const role = controlledRequirement('actor', { kind: 'node-role', modelRef: { kind: 'node', id: 'finance_check' }, roleId: 'finance' }, 'A conferência documental é atribuída ao Financeiro.');
  const field = controlledRequirement('field', { kind: 'required-field', modelRef: { kind: 'field', id: 'form_director_approval/director_rejection_reason' }, formId: 'form_director_approval', fieldKey: 'director_rejection_reason', required: false, requiredWhen: { variable: 'director_approved', operator: 'eq', value: false } }, 'Exigir justificativa quando o Diretor reprovar.');
  const mutated = structuredClone(g03ReimbursementProcessSpec);
  (mutated.nodes.find((node: any) => node.id === 'finance_check') as any).roleId = 'manager';
  const directorForm = mutated.forms.find((form: any) => form.id === 'form_director_approval')! as any;
  directorForm.fields.find((item: any) => item.key === 'director_rejection_reason').requiredWhen = undefined;
  const { report, validation } = await evaluateAgainstG03([role, field], mutated);
  assert.equal(validation.valid, true);
  assert.ok(report.findings.some(item => item.status === 'wrong-role'));
  assert.ok(report.findings.some(item => item.status === 'partial' && item.requirementId === field.id));
});

test('invalid ProcessSpec never proves a linked relationship, even with the expected IDs', async () => {
  const cycle = controlledRequirement('loop', { kind: 'loop', modelRef: { kind: 'flow', id: 'f_docs_return' }, sourceNodeId: 'employee_correct_docs', targetNodeId: 'finance_check' }, 'Retornar para a conferência financeira.');
  const mutated = structuredClone(g03ReimbursementProcessSpec);
  (mutated.flows.find((flow: any) => flow.id === 'f_docs_return') as any).target = 'missing_node';
  const { report, validation } = await evaluateAgainstG03([cycle], mutated);
  assert.equal(validation.valid, false);
  assert.ok(report.findings.some(item => item.status === 'ambiguous'));
  assert.equal(report.totals.proven, 0);
});

test('controlled Ledger separates omitted, invented, unknown requirement IDs, and invalid evidence', async () => {
  const required = controlledRequirement('loop', { kind: 'loop', modelRef: { kind: 'flow', id: 'f_adjust_return' }, sourceNodeId: 'employee_adjust', targetNodeId: 'manager_check' }, 'Ajustar e reenviar a solicitação.');
  const invalid = { ...required, id: 'req-invalid-evidence', evidence: { ...required.evidence!, start: 999, end: 1000 } };
  const { report, elements } = await evaluateAgainstG03([required, invalid], structuredClone(g03ReimbursementProcessSpec), { links: [{ requirementId: 'req-does-not-exist', elementId: 'activity:finance_check', basis: 'structural-equivalence', verified: true, details: 'unknown ID' }] });
  assert.ok(report.findings.some(item => item.requirementId === required.id && item.status === 'omitted'));
  assert.ok(report.findings.some(item => item.requirementId === invalid.id && item.status === 'invalid-evidence'));
  assert.ok(report.findings.some(item => item.requirementId === 'req-does-not-exist' && item.status === 'invalid-evidence'));
  assert.ok(elements.some(item => item.id === 'activity:finance_check'));
  const invented = [...elements, { id: 'activity:invented', type: 'activity' as const, meaning: 'Invented step', modelRef: { kind: 'node' as const, id: 'invented' } }];
  const inventedReport = evaluateRequirementCoverage({ ledger: { schemaVersion: '1.0.0', extraction: { complete: true, method: 'controlled', diagnostics: [] }, requirements: [] }, elements: invented, messages: [], processSpec: g03ReimbursementProcessSpec, processSpecValid: true });
  assert.ok(inventedReport.findings.some(item => item.elementId === 'activity:invented' && item.status === 'unsupported-element'));
});

test('similar labels do not prove distinct field requirements, and controlled partial matches stay partial', async () => {
  const one = controlledRequirement('field', { kind: 'required-field', modelRef: { kind: 'field', id: 'form_request/justification' }, formId: 'form_request', fieldKey: 'justification', required: true }, 'Justificativa obrigatória.');
  const other = controlledRequirement('field', { kind: 'required-field', modelRef: { kind: 'field', id: 'form_request/receipt_reference' }, formId: 'form_request', fieldKey: 'receipt_reference', required: true }, 'Referência obrigatória.');
  const { report, validation } = await evaluateAgainstG03([one, other]);
  assert.equal(validation.valid, true);
  assert.equal(report.totals.proven, 2);
  const partial = { ...one, structure: { ...one.structure!, required: false } as RequirementStructure };
  const result = await evaluateAgainstG03([partial]);
  assert.ok(result.report.findings.some(item => item.requirementId === one.id && item.status === 'partial'));
});
