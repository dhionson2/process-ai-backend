/**
 * Synthetic evaluation corpus. Every text is fictitious; no tenant, person or real policy is described.
 * Expectations use accent-free lowercase stems: a requirement is met when any stem appears in the
 * corresponding ProcessSpec element (userTask names, role labels).
 */
export type EvalScenario = {
  id: string;
  title: string;
  /** Incomplete requests where a clarification turn is the correct first behaviour. */
  expectsClarification?: boolean;
  text: string;
  /** Answers for clarification questions; first matching `when` wins, otherwise `fallback`. */
  answers?: Array<{ when: RegExp; answer: string }>;
  fallback?: string;
  expect: {
    activities: string[][];
    roles: string[][];
    minDecisions: number;
    /** Stems that must not appear in any task name: rules or steps the requester never mentioned. */
    forbidden?: string[];
  };
};

const noExtraRule = 'Não há regra adicional além do que já foi descrito.';

export const scenarios: EvalScenario[] = [
  {
    id: 'S01-ferias',
    title: 'Férias com aprovação do gestor e registro no RH',
    text: 'O servidor solicita férias informando a data inicial e a data final. O gestor aprova ou reprova. Se aprovado, o RH registra as férias. Se reprovado, o servidor é informado do motivo.',
    expect: { activities: [['aprov', 'analis', 'decid'], ['registr']], roles: [['servidor'], ['gestor'], ['rh', 'recursos humanos']], minDecisions: 1, forbidden: ['saldo', 'pagamento', 'folha'] },
  },
  {
    id: 'S02-compra',
    title: 'Compra de material com decisão do gestor',
    text: 'Um funcionário solicita compra de material, informando o material solicitado e a quantidade. O gestor analisa a solicitação. Se aprovar, o setor de compras providencia a compra. Se reprovar, o funcionário recebe a justificativa.',
    expect: { activities: [['analis', 'aprov', 'decid'], ['compra', 'provid']], roles: [['funcionario'], ['gestor'], ['compras']], minDecisions: 1, forbidden: ['pagamento', 'cotacao', 'licitacao'] },
  },
  {
    id: 'S03-reembolso-duas-aprovacoes',
    title: 'Reembolso com duas aprovações em série',
    text: 'O colaborador solicita reembolso de despesa informando o valor e a descrição. O gestor aprova ou reprova. Se o gestor aprovar, o diretor faz uma segunda aprovação. Se o diretor aprovar, o financeiro paga o reembolso. Qualquer reprovação encerra o processo informando o colaborador.',
    expect: { activities: [['gestor', 'aprov'], ['diretor', 'segunda'], ['pag', 'reembols']], roles: [['colaborador'], ['gestor'], ['diretor'], ['financeiro']], minDecisions: 2, forbidden: ['auditoria', 'nota fiscal'] },
  },
  {
    id: 'S04-ferias-incompleto',
    title: 'Pedido vago de férias (deve perguntar antes)',
    expectsClarification: true,
    text: 'Quero criar uma solicitação de férias para aprovação do gestor.',
    answers: [
      { when: /depois|após|apos|acontece/i, answer: 'Se aprovado, o RH registra as férias. Se reprovado, o servidor é informado do motivo e o processo termina.' },
      { when: /dados|informa|campos/i, answer: 'O servidor informa a data inicial e a data final das férias.' },
      { when: /quem|solicit|inicia/i, answer: 'O servidor solicita as férias.' },
      { when: /reprov|rejei|recus/i, answer: 'Se reprovado, o servidor é informado do motivo e o processo termina.' },
    ],
    fallback: 'O servidor solicita informando data inicial e final; o gestor aprova ou reprova; se aprovado o RH registra; se reprovado o servidor é informado do motivo. Não há outras regras.',
    expect: { activities: [['aprov', 'analis', 'decid']], roles: [['gestor']], minDecisions: 1, forbidden: ['saldo', 'pagamento'] },
  },
  {
    id: 'S05-correcao-ciclo',
    title: 'Devolução para correção antes da aprovação',
    text: 'O requerente envia um pedido de certidão informando o tipo de certidão. O atendente confere os dados. Se os dados estiverem incompletos, o pedido volta ao requerente para correção e depois retorna ao atendente. Se estiverem completos, o atendente emite a certidão.',
    expect: { activities: [['confer', 'analis', 'verific'], ['corrig', 'correc', 'ajust'], ['emit', 'certid']], roles: [['requerente'], ['atendente']], minDecisions: 1, forbidden: ['pagamento', 'taxa'] },
  },
  {
    id: 'S06-contratacao',
    title: 'Abertura de vaga com RH e diretoria',
    text: 'O gestor solicita a abertura de uma vaga informando o cargo e a justificativa. O RH analisa e, se estiver de acordo, encaminha para a diretoria decidir. Se a diretoria aprovar, o RH publica a vaga. Se o RH ou a diretoria reprovarem, o gestor é comunicado.',
    expect: { activities: [['analis', 'rh'], ['diretoria', 'decid', 'aprov'], ['public']], roles: [['gestor'], ['rh', 'recursos humanos'], ['diretoria', 'diretor']], minDecisions: 2, forbidden: ['entrevista', 'salario'] },
  },
  {
    id: 'S07-viagem',
    title: 'Viagem a serviço com aprovação e compra de passagem',
    text: 'O servidor solicita uma viagem a serviço informando destino, data de ida e data de volta. A chefia imediata aprova ou reprova. Se aprovar, o setor de viagens compra a passagem. Se reprovar, o servidor é avisado.',
    expect: { activities: [['aprov', 'analis', 'decid'], ['passagem', 'compr']], roles: [['servidor'], ['chefia'], ['viagens', 'viagem']], minDecisions: 1, forbidden: ['diaria', 'hotel', 'reembolso'] },
  },
  {
    id: 'S08-acesso-sistema',
    title: 'Pedido de acesso a sistema',
    text: 'O colaborador pede acesso a um sistema informando o nome do sistema e o motivo. O gestor aprova ou reprova. Se aprovado, a equipe de suporte concede o acesso. Se reprovado, o colaborador recebe a negativa.',
    expect: { activities: [['aprov', 'analis', 'decid'], ['conced', 'liber', 'acesso']], roles: [['colaborador'], ['gestor'], ['suporte']], minDecisions: 1, forbidden: ['senha', 'auditoria'] },
  },
  {
    id: 'S09-sem-decisao',
    title: 'Fluxo linear sem decisão',
    text: 'O cidadão envia uma sugestão informando o assunto e a descrição. A ouvidoria registra a sugestão e depois responde ao cidadão.',
    expect: { activities: [['registr'], ['respond', 'respost']], roles: [['cidadao'], ['ouvidoria']], minDecisions: 0, forbidden: ['aprov', 'reprov'] },
  },
  {
    id: 'S10-compra-vaga',
    title: 'Compra vaga (deve perguntar antes)',
    expectsClarification: true,
    text: 'Preciso de um processo de compras.',
    answers: [
      { when: /depois|após|apos|acontece/i, answer: 'Se o gestor aprovar, o setor de compras providencia a compra. Se reprovar, o funcionário recebe a justificativa e o processo termina.' },
      { when: /dados|informa|campos/i, answer: 'O funcionário informa o item e a quantidade.' },
      { when: /quem|solicit|inicia/i, answer: 'Um funcionário solicita a compra.' },
      { when: /aprov|decid|decis/i, answer: 'O gestor aprova ou reprova a solicitação.' },
    ],
    fallback: 'Um funcionário solicita a compra informando item e quantidade; o gestor aprova ou reprova; se aprovar, o setor de compras providencia; se reprovar, o funcionário recebe a justificativa. Não há outras regras.',
    expect: { activities: [['aprov', 'analis', 'decid']], roles: [['gestor']], minDecisions: 1, forbidden: ['licitacao', 'pagamento'] },
  },
  {
    id: 'S11-manutencao',
    title: 'Chamado de manutenção com triagem',
    text: 'O usuário abre um chamado de manutenção informando o local e o problema. A triagem classifica o chamado. Se for urgente, a equipe de manutenção atende imediatamente. Se não for urgente, o chamado entra na fila e a equipe de manutenção atende depois. Ao final, o usuário confirma a solução.',
    expect: { activities: [['triag', 'classific'], ['atend'], ['confirm']], roles: [['usuario'], ['triagem'], ['manutencao']], minDecisions: 1, forbidden: ['orcamento', 'compra'] },
  },
  {
    id: 'S12-treinamento',
    title: 'Inscrição em treinamento com vagas',
    text: 'O servidor se inscreve em um treinamento informando o curso desejado. A escola de governo verifica se há vagas. Se houver vaga, a inscrição é confirmada ao servidor. Se não houver, o servidor entra em lista de espera.',
    expect: { activities: [['verific', 'vaga', 'analis'], ['confirm', 'inscri']], roles: [['servidor'], ['escola']], minDecisions: 1, forbidden: ['pagamento', 'certificado'] },
  },
].map(scenario => ({ fallback: noExtraRule, ...scenario }));
