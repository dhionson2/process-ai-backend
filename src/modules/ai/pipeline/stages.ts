import { generateArtifacts } from '../../generation/artifact-generator.js';
import type { ConfirmedFact } from '../../projects/conversation.repository.js';
import { validateProcessSpec } from '../../validation/validation.service.js';
import { normalizeInterpretation } from '../interpretation-context.js';
import { assessReadiness } from '../readiness.js';
import { identityForQuestion, semanticSlotForQuestion } from '../semantic-grounding.js';
import { applyConfirmations, confirmationKey } from '../confirmations.js';
import { compileBusinessIntent, IntentCompilationError, SemanticGroundingError } from '../semantic-process.js';
import { removalKey, removalQuestion, unexpectedRemovals } from '../preservation.js';
import type { ModelCalls } from './model-calls.js';
import type { TurnContext } from './turn-context.js';
import { next, OrchestrationFailure, stop, type GenerationOutcome, type Json, type RepairBudget, type StageResult } from './types.js';

type Stage = { ctx: TurnContext; calls: ModelCalls; budget: RepairBudget };

/**
 * Ends the turn asking the requester; usage and latency are the turn totals so far. Every question of every
 * origin (model, readiness gate, compiler, validator) passes the same guard: a question the requester already
 * answered is never asked again. If nothing new is left to ask, the turn fails with recovery guidance instead
 * of looping.
 */
export function clarify({ ctx, calls }: Pick<Stage, 'ctx' | 'calls'>, value: Json, intermediate?: Json): GenerationOutcome {
  const fresh = (value.questions ?? []).filter((question: Json) => !alreadyAnswered(ctx, question));
  if (!fresh.length) {
    ctx.trace.push({ stage: 'clarification', status: 'loop-prevented', details: { repeated: (value.questions ?? []).length } });
    throw new OrchestrationFailure('CLARIFICATION_UNRESOLVED', 'A pergunta já foi respondida, mas a resposta não resolveu o ponto; nenhuma pergunta repetida foi enviada');
  }
  if (fresh.length < (value.questions ?? []).length) ctx.trace.push({ stage: 'clarification', status: 'repeated-dropped', details: { dropped: (value.questions ?? []).length - fresh.length } });
  return clarificationOutcome({ ...value, questions: fresh }, calls.lastModel, calls.latencyMs, { ...calls.usage }, calls.providerId, ctx.knowledge.version, ctx.knowledge.moduleIds, intermediate);
}
const foldQuestion = (value: unknown) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function alreadyAnswered(ctx: TurnContext, question: Json): boolean {
  const identity = identityForQuestion(question.question, question.requirementId);
  return ctx.confirmedFacts.some(fact => (question.requirementId && fact.requirementId === question.requirementId)
    || (fact.semanticSlot && fact.semanticSlot === identity.semanticSlot)
    || foldQuestion(fact.question) === foldQuestion(question.question));
}
export function clarificationOutcome(value: Json, model: string, latencyMs: number, usage: GenerationOutcome['usage'], provider: string, knowledgeVersion: string, knowledgeModules: string[], intermediate?: Json): GenerationOutcome {
  const questions = (value.questions || []).map((question: Json) => ({ ...question, ...identityForQuestion(question.question, question.requirementId) }));
  return { kind: 'need_clarification', questions, summary: value.summary, provider, model, latencyMs, usage, knowledgeVersion, knowledgeModules, intermediate };
}

/** Stage 1 — interpret: one model call, normalized and checked against the contract, with one structural correction. */
export async function interpret({ ctx, calls, budget }: Stage): Promise<Json> {
  const completion = await calls.call(ctx.prompt);
  ctx.trace.push({ stage: 'provider', status: 'received', details: { kind: (completion.value as Json)?.kind, latencyMs: completion.latencyMs, usage: completion.usage } });
  let value = normalizeInterpretation(completion.value) as Json;
  if (ctx.validator(value)) {
    ctx.trace.push({ stage: 'normalization', status: 'valid', details: { kind: value.kind } });
  } else {
    const schemaDiagnostics = safeSchemaDiagnostics(ctx.validator.errors);
    ctx.trace.push({ stage: 'normalization', status: 'rejected', details: { code: 'MODEL_PLAN_INVALID', schemaDiagnostics } });
    const repairPrompt = `${ctx.prompt}\n\nA resposta JSON anterior está fora do contrato BusinessIntent. Corrija somente a estrutura apontada pelos diagnósticos; preserve todos os fatos, atores, campos, atividades, decisões, condições, retornos e destinos. Retorne um único objeto json no formato BusinessIntent descrito nas instruções, sem envelope e sem campos adicionais. Diagnósticos: ${JSON.stringify(schemaDiagnostics)}\nResposta anterior: ${JSON.stringify(value)}`;
    if (repairPrompt.length + ctx.schemaChars > ctx.environment.aiMaxInputChars) throw new OrchestrationFailure('AI_INPUT_LIMIT_EXCEEDED', 'A correção estrutural ultrapassaria o limite de contexto; nenhuma proposta parcial foi salva');
    budget.consume('structural');
    value = normalizeInterpretation((await calls.call(repairPrompt, 'repair')).value) as Json;
    if (!ctx.validator(value)) {
      ctx.trace.push({ stage: 'normalization', status: 'repair-rejected', details: { code: 'MODEL_PLAN_INVALID', schemaDiagnostics: safeSchemaDiagnostics(ctx.validator.errors) } });
      throw new OrchestrationFailure('MODEL_PLAN_INVALID', 'A resposta continuou fora do contrato BusinessIntent após uma correção estrutural');
    }
    ctx.trace.push({ stage: 'normalization', status: 'repair-valid', details: { kind: value.kind } });
  }
  ctx.enforcePlanBounds(value);
  return value;
}

/** Stage 2 — a question the requester already answered is sent back to the model once, never to the user. */
export async function recoverRepeatedQuestion({ ctx, calls, budget }: Stage, value: Json): Promise<Json> {
  if (value.kind !== 'need_clarification') return value;
  const mode = ctx.environment.aiSemanticGroundingMode || 'legacy';
  const repeatedFact = findRepeatedQuestion(value.questions, ctx.confirmedFacts, mode);
  if (!repeatedFact) return value;
  const recoveryPrompt = `${ctx.prompt}\n\nCorreção obrigatória: você repetiu uma pergunta já respondida. Fato confirmado:\nPergunta: ${repeatedFact.question}\nResposta: ${repeatedFact.answer}\nEste fato resolve a pergunta. Não retorne need_clarification para o mesmo assunto, nem com uma paráfrase. Continue a geração/refinamento usando a resposta confirmada. Se faltar outra informação independente, pergunte somente essa informação.`;
  budget.consume('repeated-question');
  const recovered = normalizeInterpretation((await calls.call(recoveryPrompt, 'repair')).value) as Json;
  if (!ctx.validator(recovered)) {
    ctx.trace.push({ stage: 'normalization', status: 'recovery-rejected', details: { code: 'MODEL_PLAN_INVALID', schemaDiagnostics: safeSchemaDiagnostics(ctx.validator.errors) } });
    throw new OrchestrationFailure('MODEL_PLAN_INVALID', 'A recuperação de pergunta repetida retornou estrutura fora do contrato interno');
  }
  ctx.enforcePlanBounds(recovered);
  // Still-repeated questions are dropped by the guard in clarify(); new questions in the same answer still reach the requester.
  if (recovered.kind === 'need_clarification' && findRepeatedQuestion(recovered.questions, ctx.confirmedFacts, mode)) ctx.trace.push({ stage: 'normalization', status: 'recovery-still-repeated', details: {} });
  return recovered;
}

/** Stage 3 — deterministic readiness gate before a first proposal (see readiness.ts). */
export function readiness(stage: Stage, plan: Json): StageResult<Json> {
  const { ctx } = stage;
  if (ctx.refinementMode || plan.kind !== 'business_intent' || ctx.confirmedFacts.length > 0 || (ctx.environment.aiReadinessGate ?? 'on') !== 'on') return next(plan);
  const assessment = assessReadiness(plan, ctx.userSource);
  ctx.trace.push({ stage: 'readiness', status: assessment.ready ? 'ready' : 'needs-input', details: { gaps: assessment.gaps.map(gap => gap.slot) } });
  if (assessment.ready) return next(plan);
  return stop(clarify(stage, { kind: 'need_clarification', summary: assessment.understanding, questions: assessment.gaps.map(gap => ({ question: gap.question, blocking: true })) }, plan));
}

type Compiled = { plan: Json; spec: Json; compiledIntent?: Json };

/** Compiles one plan; compiler errors are rethrown typed for the stage that decides who answers them. */
async function compose(ctx: TurnContext, rawPlan: Json, model: string): Promise<{ spec: Json; compiledIntent?: Json }> {
  const plan = applyConfirmations(rawPlan, ctx.confirmations);
  ctx.trace.push({ stage: 'compilation', status: 'started', details: { kind: plan.kind, refinement: ctx.refinementMode, modelConfigurationFlags: plan.pendingConfiguration?.length || 0 } });
  try {
    const compiled = await compileBusinessIntent(plan, {
      targetProfile: ctx.targetProfile, knowledgeVersion: ctx.knowledge.version, model,
      sourceText: ctx.userSource,
      activitySourceText: ctx.userSource,
      confirmedAnswerText: ctx.confirmedFacts.map(fact => fact.answer).join('\n'),
      knowledgeText: ctx.knowledge.text,
      semanticGroundingMode: ctx.groundingMode,
    });
    ctx.auditCoverage(compiled.businessIntent as Json);
    assertNoRejectedItems(ctx, compiled.spec);
    if (ctx.refinementMode) {
      assertPreserved(ctx, compiled.spec);
      // A description edited by hand in the Modeler survives a replanning that did not ask to change it.
      const current = ctx.args.currentSpec!;
      if (typeof current.description === 'string' && current.description && !/descri/i.test(ctx.args.text)) compiled.spec.description = current.description;
    }
    return { spec: compiled.spec, compiledIntent: compiled.businessIntent as Json };
  } catch (error) {
    if (!ctx.coverageAudited()) ctx.auditCoverage(plan);
    ctx.trace.push({ stage: 'compilation', status: 'rejected', details: { code: error instanceof IntentCompilationError ? 'INTENT_INCOMPLETE' : error instanceof SemanticGroundingError ? `SEMANTIC_GROUNDING_${error.status.toUpperCase()}` : 'REFINEMENT_AMBIGUOUS' } });
    if (error instanceof IntentCompilationError) throw error;
    if (error instanceof SemanticGroundingError) throw new OrchestrationFailure(`SEMANTIC_GROUNDING_${error.status.toUpperCase()}`, error.message);
    throw new OrchestrationFailure('REFINEMENT_AMBIGUOUS', error instanceof Error ? error.message : 'Refinamento não aplicável sem ambiguidade');
  }
}

const normalizedLabel = (value: unknown) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/**
 * Deterministic check of the requester's rejections: a compiled spec that still contains a rejected item is a
 * divergence from what the requester said, so it takes the model-omission path (one correction, then a question).
 */
function assertNoRejectedItems(ctx: TurnContext, spec: Json): void {
  if (!ctx.rejectedItems.length) return;
  const present = (kind: string) => kind === 'actor' ? (spec.roles ?? []).map((role: Json) => role.label)
    : kind === 'decision' ? (spec.nodes ?? []).filter((node: Json) => node.type === 'exclusiveGateway').map((node: Json) => node.name)
    : kind === 'field' ? (spec.forms ?? []).flatMap((form: Json) => (form.fields ?? []).map((field: Json) => field.label))
    : (spec.nodes ?? []).filter((node: Json) => node.type === 'userTask' || node.type === 'serviceTask').map((node: Json) => node.name);
  const violation = ctx.rejectedItems.find(item => present(item.kind).some((label: unknown) => normalizedLabel(label) === normalizedLabel(item.label)));
  if (violation) {
    const question = `O solicitante rejeitou “${violation.label}”, mas a proposta ainda o inclui. Remova esse item e preserve o restante.`;
    throw new IntentCompilationError(question, question, 'model-omission');
  }
}

/**
 * Preservation gate of a refinement: the replanned process may only drop what the request asked to drop.
 * Anything else missing is a model omission (one correction), then a yes/no question per element.
 */
function assertPreserved(ctx: TurnContext, spec: Json): void {
  const dropped = unexpectedRemovals(ctx.args.currentSpec!, spec, ctx.args.text, ctx.removals);
  if (!dropped.length) return;
  ctx.trace.push({ stage: 'preservation', status: 'dropped', details: { elements: dropped.map(item => `${item.kind}:${item.name}`) } });
  const list = dropped.map(item => `“${item.name}”`).join(', ');
  const question = `A nova versão deixaria de fora ${list}, que o pedido não mandou remover. Mantenha esses elementos com os mesmos nomes e responsáveis, a menos que o pedido peça explicitamente a remoção.`;
  throw new IntentCompilationError(question, question, 'model-omission', undefined, dropped.map(item => ({ question: removalQuestion(item), requirementId: removalKey(item) })));
}

/** Turns a compiler gap into the right conversation: every question of the gap goes to the requester in one round. */
function compilerGapOutcome(stage: Stage, error: unknown, plan: Json): GenerationOutcome {
  if (!(error instanceof IntentCompilationError)) throw error;
  const questions = error.questions ?? [{ question: error.question, ...(error.subject ? { requirementId: confirmationKey(error.subject) } : {}) }];
  const summary = stage.ctx.refinementMode && error.origin === 'model-omission'
    ? 'O ajuste foi interpretado, mas a nova versão deixaria de fora parte do processo atual. Confirme antes de eu redesenhar.'
    : 'A intenção foi interpretada, mas falta uma informação para compilar o fluxo com segurança.';
  return clarify(stage, { kind: 'need_clarification', summary, questions: questions.map(item => ({ ...item, blocking: true })) }, plan);
}

/**
 * Stage 4 — compile. When the requester already stated what the interpretation dropped (model omission),
 * one targeted correction goes to the model and its answer passes schema, compiler and validation again.
 */
export async function compile(stage: Stage, plan: Json): Promise<StageResult<Compiled>> {
  const { ctx, calls, budget } = stage;
  try { return next({ plan, ...await compose(ctx, plan, calls.lastModel) }); }
  catch (error) {
    const modelSide = error instanceof IntentCompilationError && (error.origin === 'model-omission' || error.origin === 'model-divergence');
    if (!(modelSide && budget.canUse('omission'))) return stop(compilerGapOutcome(stage, error, plan));
    const subjects = error.questions?.length ? error.message : error.subject ? `${error.subject.kind} “${error.subject.name}”` : 'elemento';
    const correction = error.origin === 'model-divergence'
      ? `Correção obrigatória: elementos da interpretação anterior não têm sustentação literal no texto do solicitante (${subjects}). Nomeie etapas, campos e participantes com as palavras que o solicitante usou e cite como evidência um trecho literal dele; se o elemento não foi pedido, remova-o.`
      : `Correção obrigatória: a interpretação anterior omitiu algo que o solicitante descreveu explicitamente. ${error.question}`;
    const omissionPrompt = `${ctx.prompt}\n\n${correction}\nRetorne o BusinessIntent completo, preservando todos os demais fatos, sem inventar etapas, campos, papéis ou regras.\nResposta anterior:\n${JSON.stringify(plan)}`;
    if (omissionPrompt.length + ctx.schemaChars > ctx.environment.aiMaxInputChars) return stop(compilerGapOutcome(stage, error, plan));
    budget.consume('omission');
    ctx.trace.push({ stage: 'compilation', status: 'omission-repair', details: {} });
    const candidate = normalizeInterpretation((await calls.call(omissionPrompt, 'repair')).value) as Json;
    if (!ctx.validator(candidate) || candidate.kind !== 'business_intent') return stop(compilerGapOutcome(stage, error, plan));
    ctx.enforcePlanBounds(candidate);
    try {
      const compiled = await compose(ctx, candidate, calls.lastModel);
      ctx.trace.push({ stage: 'compilation', status: 'omission-repaired', details: {} });
      return next({ plan: candidate, ...compiled });
    } catch (secondError) { return stop(compilerGapOutcome(stage, secondError, plan)); }
  }
}

type Validated = Compiled & { validation: Awaited<ReturnType<typeof validateProcessSpec>> };

/** Stage 5 — deterministic validation, with one correction of the plan when no semantic correction ran. */
export async function validate(stage: Stage, compiled: Compiled): Promise<StageResult<Validated>> {
  const { ctx, calls, budget } = stage;
  let { plan, spec, compiledIntent } = compiled;
  let validation = await validateProcessSpec(spec);
  ctx.trace.push({ stage: 'validation', status: validation.valid ? 'valid' : 'invalid', details: { codes: validation.diagnostics.map(item => item.code), nodes: spec.nodes.length, forms: spec.forms.length } });
  if (validation.valid || !budget.canUse('validation')) return next({ plan, spec, compiledIntent, validation });
  budget.consume('validation');
  const diagnostics = validation.diagnostics.map(({ code, path, message }) => ({ code, path, message }));
  const repairDetails = `\n\n${ctx.refinementMode ? 'O refinamento aplicado' : 'O ProcessSpec composto do plano'} falhou na validação determinística. Corrija somente a alteração solicitada e os diagnósticos; preserve os dados não relacionados e não enfraqueça segurança. Retorne o mesmo tipo de resposta estruturada:\n${JSON.stringify(diagnostics)}\n\nResposta anterior:\n${JSON.stringify(plan)}`;
  let repairKnowledge = ctx.knowledge.text.replace(/## Exemplo sintético válido de ProcessSpec v1[^\n]*\n[\s\S]*?(?=\n\n## Fonte |$)/, '').trim();
  let repairPrompt = `${ctx.composePrompt(repairKnowledge)}${repairDetails}`;
  if (repairPrompt.length + ctx.schemaChars > ctx.environment.aiMaxInputChars) {
    const availableKnowledgeChars = ctx.environment.aiMaxInputChars - ctx.schemaChars - ctx.composePrompt('').length - repairDetails.length;
    if (availableKnowledgeChars < 0) throw new OrchestrationFailure('AI_INPUT_LIMIT_EXCEEDED', 'A correção ultrapassaria o limite de contexto; a proposta não foi salva');
    repairKnowledge = repairKnowledge.slice(0, availableKnowledgeChars).replace(/\n[^\n]*$/, '').trim();
    repairPrompt = `${ctx.composePrompt(repairKnowledge)}${repairDetails}`;
  }
  const repaired = normalizeInterpretation((await calls.call(repairPrompt, 'repair')).value) as Json;
  if (!ctx.validator(repaired)) {
    ctx.trace.push({ stage: 'normalization', status: 'repair-rejected', details: { code: 'MODEL_PLAN_INVALID', schemaDiagnostics: safeSchemaDiagnostics(ctx.validator.errors) } });
    throw new OrchestrationFailure('MODEL_PLAN_INVALID', 'A tentativa única de correção retornou uma estrutura fora do contrato interno de plano BPMN');
  }
  ctx.enforcePlanBounds(repaired);
  if (repaired.kind === 'need_clarification') return stop(clarify(stage, repaired, repaired));
  plan = repaired;
  try { ({ spec, compiledIntent } = await compose(ctx, plan, calls.lastModel)); }
  catch (error) { return stop(compilerGapOutcome(stage, error, plan)); }
  validation = await validateProcessSpec(spec);
  return next({ plan, spec, compiledIntent, validation });
}

/** Stage 6 — project the validated spec into BPMN and forms, or explain why the proposal stays invalid. */
export async function finalize(stage: Stage, validated: Validated): Promise<GenerationOutcome> {
  const { ctx, calls, budget } = stage;
  const { plan, spec, compiledIntent, validation } = validated;
  const base = { provider: calls.providerId, model: calls.lastModel, latencyMs: calls.latencyMs, usage: { ...calls.usage }, repairAttempts: budget.reported(), knowledgeVersion: ctx.knowledge.version, knowledgeModules: ctx.knowledge.moduleIds, intermediate: compiledIntent || plan };
  if (!validation.valid) {
    const question = clarificationForProcessSpecDiagnostics(validation.diagnostics);
    if (question) {
      ctx.trace.push({ stage: 'clarification', status: 'required', details: { code: 'PROCESSSPEC_SEMANTIC_CLARIFICATION', diagnosticCodes: [...new Set(validation.diagnostics.map(item => item.code))] } });
      return clarify(stage, { kind: 'need_clarification', summary: 'A proposta ainda não representa com segurança um detalhe do processo. Confirme o ponto abaixo antes de gerar os artefatos.', questions: [{ question, blocking: true }] }, plan);
    }
    return { kind: 'proposed_spec', spec, changeSummary: plan.changeSummary || 'Plano proposto pelo modelo', validation: { valid: false, diagnostics: validation.diagnostics }, ...base };
  }
  const artifacts = await generateArtifacts(spec);
  ctx.trace.push({ stage: 'artifacts', status: 'generated', details: { forms: artifacts.forms.length, bpmnChars: artifacts.bpmnXml.length, codes: artifacts.diagnostics.map(item => item.code) } });
  if (artifacts.diagnostics.some(diagnostic => diagnostic.severity === 'error')) throw new OrchestrationFailure('ARTIFACT_GENERATION_FAILED', 'ProcessSpec validado não pôde ser projetado nos artefatos de prévia');
  return { kind: 'proposed_spec', spec, changeSummary: plan.changeSummary || 'Processo estruturado a partir do plano validado', validation: { valid: true, diagnostics: validation.diagnostics }, artifacts, ...base };
}

export function findRepeatedQuestion(questions: Array<{ question: string; semanticSlot?: string }>, facts: ConfirmedFact[], mode: 'legacy' | 'controlled' = 'legacy'): ConfirmedFact | undefined {
  if (mode === 'controlled') {
    for (const question of questions) {
      const slot = question.semanticSlot || semanticSlotForQuestion(question.question);
      const matched = facts.find(fact => fact.state !== 'contradictory' && (fact.semanticSlot || semanticSlotForQuestion(fact.question)) === slot);
      if (matched) return matched;
    }
    return undefined;
  }
  const stopWords = new Set(['como', 'qual', 'quais', 'quem', 'onde', 'quando', 'para', 'deve', 'de', 'do', 'da', 'o', 'a', 'e', 'em', 'um', 'uma', 'que', 'ser', 'sua', 'seu', 'solicitado']);
  const tokens = (value: string) => new Set(value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('pt-BR').match(/[a-z0-9]+/g)?.filter(token => token.length > 2 && !stopWords.has(token)) || []);
  const similarity = (left: Set<string>, right: Set<string>) => {
    if (!left.size || !right.size) return 0;
    const matches = [...left].filter(a => [...right].some(b => a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a))))).length;
    return matches / Math.min(left.size, right.size);
  };
  for (const question of questions) {
    const nextTokens = tokens(question.question);
    const repeated = facts.find(fact => similarity(nextTokens, tokens(fact.question)) >= 0.65);
    if (repeated) return repeated;
  }
  return undefined;
}
function clarificationForProcessSpecDiagnostics(diagnostics: Array<{ code: string }>): string | undefined {
  const codes = new Set(diagnostics.map(item => item.code));
  if (['END_MISSING', 'END_COUNT_INVALID', 'NODE_UNREACHABLE', 'NO_PATH_TO_END', 'FLOW_TARGET_INVALID'].some(code => codes.has(code)))
    return 'O que deve acontecer no final de cada caminho do processo? Algum resultado precisa encerrar ou encaminhar a solicitação?';
  if (['GATEWAY_OUTPUTS_INSUFFICIENT', 'GATEWAY_ROUTE_UNCONDITIONED', 'GATEWAY_CONDITION_INVALID', 'CONDITION_VARIABLE_MISSING'].some(code => codes.has(code)))
    return 'Qual regra define cada caminho dessa decisão e o que acontece quando nenhum deles se aplica?';
  if (['VARIABLE_SOURCE_INVALID', 'VARIABLE_REFERENCE_MISSING', 'FORM_FIELD_BINDING_INVALID', 'FORM_FIELD_TYPE_MISMATCH'].some(code => codes.has(code)))
    return 'Qual campo do formulário fornece o valor usado nessa condição ou tarefa?';
  if (['ACTOR_REFERENCE_MISSING', 'ROLE_REFERENCE_MISSING', 'TASK_ROLE_REQUIRED'].some(code => codes.has(code)))
    return 'Qual papel deve executar a atividade que ficou sem responsável?';
  return undefined;
}
export function safeSchemaDiagnostics(errors: Array<{ instancePath?: string; keyword?: string; message?: string; params?: Record<string, unknown> }> | null | undefined) {
  const source = errors || [];
  const specific = source.filter(error => error.keyword !== 'oneOf' && error.keyword !== 'anyOf');
  const prioritized = (specific.length ? specific : source).slice().sort((a, b) => {
    const depth = (value?: string) => (value || '').split('/').filter(Boolean).length;
    const depthDelta = depth(b.instancePath) - depth(a.instancePath);
    if (depthDelta) return depthDelta;
    const priority = (keyword?: string) => keyword === 'required' || keyword === 'type' || keyword === 'enum' || keyword === 'const' ? 0 : keyword === 'additionalProperties' ? 1 : 2;
    return priority(a.keyword) - priority(b.keyword);
  });
  return prioritized.slice(0, 20).map(error => ({
    path: (error.instancePath || '/').slice(0, 256),
    keyword: (error.keyword || 'unknown').slice(0, 64),
    message: (error.message || 'não corresponde ao schema').slice(0, 256),
    ...(['additionalProperties', 'required'].includes(error.keyword || '') && typeof error.params?.additionalProperty === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(error.params.additionalProperty) ? { property: error.params.additionalProperty } : {}),
    ...(['required'].includes(error.keyword || '') && typeof error.params?.missingProperty === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(error.params.missingProperty) ? { property: error.params.missingProperty } : {}),
  }));
}
