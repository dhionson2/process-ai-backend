/**
 * Translates technical failure codes into user-facing recovery guidance. The code stays the contract
 * for machines; this projection tells a person what happened and what to do next. Guidance never
 * weakens a gate: it explains a rejection, it does not turn it into a proposal.
 */
export type RecoveryCategory =
  | 'missing-information'
  | 'interpretation-divergence'
  | 'model-output-invalid'
  | 'input-too-large'
  | 'provider-unavailable'
  | 'configuration'
  | 'conflict'
  | 'invalid-request'
  | 'unexpected';

export type RecoveryAction = 'answer' | 'rephrase' | 'retry' | 'wait' | 'shorten' | 'reload' | 'contact-admin';

export type RecoveryGuidance = {
  category: RecoveryCategory;
  title: string;
  message: string;
  actions: RecoveryAction[];
  /** Always true for generation failures: the submitted text and the current revision were kept. */
  preserved: boolean;
  retryAfterMs?: number;
};

type Rule = { match: (code: string) => boolean; guidance: Omit<RecoveryGuidance, 'preserved' | 'retryAfterMs'> };

const exact = (...codes: string[]) => (code: string) => codes.includes(code);

const rules: Rule[] = [
  {
    match: code => /_CLARIFICATION$|_REQUIREMENT_INCOMPLETE$|^GRAPHIR_COVERAGE_(INCOMPLETE|INCONCLUSIVE)$|^REFINEMENT_AMBIGUOUS$|_ROLE_REQUIRED$/.test(code),
    guidance: { category: 'missing-information', title: 'Falta informação para montar o fluxo', message: 'A descrição ainda não diz tudo o que o fluxo precisa — por exemplo, quem executa uma etapa ou o que acontece depois de uma decisão. Complete a descrição com esse ponto e envie de novo.', actions: ['rephrase', 'answer'] },
  },
  {
    match: code => /_UNGROUNDED|_DIVERGENCE$|^GRAPHIR_ROLE_INVALID$|^GRAPHIR_COVERAGE_UNSUPPORTED$/.test(code),
    guidance: { category: 'interpretation-divergence', title: 'A IA propôs algo que você não descreveu', message: 'A proposta trazia uma etapa, papel ou campo que não aparece no seu texto, então ela foi descartada para não inventar regras. Se esse item deve existir, descreva-o explicitamente; caso contrário, tente novamente.', actions: ['rephrase', 'retry'] },
  },
  {
    match: exact('MODEL_REPEATED_QUESTION'),
    guidance: { category: 'interpretation-divergence', title: 'A IA repetiu uma pergunta já respondida', message: 'A resposta anterior já cobre esse ponto. Reformule a resposta de forma mais direta ou tente novamente.', actions: ['rephrase', 'retry'] },
  },
  {
    match: code => /^MODEL_(PLAN|RESULT)_INVALID$|^GRAPHIR_(SCHEMA_)?INVALID$|^PROCESSSPEC_INVALID$|^GRAPHIR_LOWERING_FAILED$|^ARTIFACT_GENERATION_FAILED$/.test(code),
    guidance: { category: 'model-output-invalid', title: 'A proposta da IA não passou na validação', message: 'A resposta da IA veio com uma estrutura que o sistema não aceita como processo válido. Nada foi salvo. Tente novamente; se persistir, simplifique a descrição em etapas mais diretas.', actions: ['retry', 'rephrase'] },
  },
  {
    match: code => /_LIMIT_EXCEEDED$|^AI_CONTEXT_CAPACITY_EXCEEDED$|^MESSAGE_SIZE_INVALID$/.test(code),
    guidance: { category: 'input-too-large', title: 'Descrição grande demais para uma etapa', message: 'O texto ou o processo ficou maior do que o limite de uma geração. Divida o pedido: descreva primeiro o fluxo principal e depois refine as partes restantes.', actions: ['shorten', 'rephrase'] },
  },
  {
    match: exact('PROVIDER_RATE_LIMITED'),
    guidance: { category: 'provider-unavailable', title: 'Limite de uso do provedor de IA', message: 'O provedor de IA pediu para aguardar antes de uma nova tentativa.', actions: ['wait', 'retry'] },
  },
  {
    match: code => /^PROVIDER_(TIMEOUT|UNAVAILABLE|INVALID_RESPONSE)$/.test(code),
    guidance: { category: 'provider-unavailable', title: 'O provedor de IA não respondeu como esperado', message: 'A IA demorou ou respondeu de forma inválida. Tente novamente em instantes.', actions: ['retry'] },
  },
  {
    match: code => /^PROVIDER_REJECTED$|^AI_(PROVIDER_NOT_APPROVED|CONFIGURATION_INVALID)$|^PERSISTENCE_NOT_CONFIGURED$|^EXTERNAL_DATA_CLASSIFICATION_REQUIRED$/.test(code),
    guidance: { category: 'configuration', title: 'Configuração da IA indisponível', message: 'A geração está bloqueada pela configuração ou pela política do servidor. Fale com o administrador do ambiente.', actions: ['contact-admin'] },
  },
  {
    match: exact('TURN_RATE_LIMITED'),
    guidance: { category: 'provider-unavailable', title: 'Muitas gerações em pouco tempo', message: 'Há um limite de gerações por minuto para cada pessoa. Aguarde um instante e tente de novo; seu texto foi mantido.', actions: ['wait', 'retry'] },
  },
  {
    match: exact('AUTH_REQUIRED', 'AUTH_INVALID', 'AUTH_TENANT_MISSING', 'FORBIDDEN'),
    guidance: { category: 'configuration', title: 'Acesso não autorizado', message: 'Sua sessão expirou ou seu perfil não tem permissão para esta ação. Entre novamente ou peça acesso ao administrador.', actions: ['reload', 'contact-admin'] },
  },
  {
    match: exact('REVISION_CONFLICT', 'OPERATION_ID_CONFLICT', 'QUESTION_SET_INVALID', 'QUESTION_SET_STALE'),
    guidance: { category: 'conflict', title: 'A sessão mudou enquanto você editava', message: 'Outra alteração foi salva antes desta. Recarregue a sessão para ver a versão atual e envie novamente.', actions: ['reload'] },
  },
  {
    match: code => /_INVALID$|_NOT_FOUND$/.test(code),
    guidance: { category: 'invalid-request', title: 'Pedido não pôde ser processado', message: 'Algum dado enviado não é válido para esta sessão. Recarregue e confira a mensagem.', actions: ['reload', 'rephrase'] },
  },
];

const fallback: Rule['guidance'] = { category: 'unexpected', title: 'Não foi possível concluir a geração', message: 'Ocorreu uma falha inesperada. Tente novamente.', actions: ['retry'] };

export function recoveryGuidance(code: string, retryAfterMs?: number): RecoveryGuidance {
  const guidance = rules.find(rule => rule.match(code))?.guidance ?? fallback;
  return { ...guidance, actions: [...guidance.actions], preserved: true, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

/** One-line chat message persisted in the session history for a failed turn. */
export function recoveryMessage(guidance: RecoveryGuidance): string {
  return `${guidance.title}. ${guidance.message} Seu texto e a revisão atual foram preservados.`;
}
