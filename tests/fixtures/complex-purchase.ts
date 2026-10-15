export const complexPurchaseText = 'O funcionário preenche equipamento, quantidade, valor total estimado, justificativa e setor. Depois, a solicitação vai para o gestor do setor, que verifica as informações. Se estiverem incompletas, devolve ao funcionário com orientações; o funcionário corrige e reenvia ao gestor para nova análise. Se as informações estiverem completas, o gestor aprova ou reprova. Se reprovar, informa obrigatoriamente o motivo e o processo é encerrado. Se aprovar, compras de até R$ 5.000 seguem diretamente para Compras; acima de R$ 5.000 precisam de aprovação do Diretor. Se o Diretor reprovar, informa obrigatoriamente o motivo e o processo é encerrado. Se aprovar, segue para Compras. Compras registra fornecedor, número do pedido e data da compra. O Financeiro confere valores, registra a despesa e finaliza o processo como concluído.';

export function complexPurchaseIntent() {
  const text = complexPurchaseText;
  return {
    kind: 'business_intent', name: 'Solicitação de compra de equipamentos', purpose: text,
    actors: ['Funcionário', 'Gestor', 'Diretor', 'Compras', 'Financeiro'].map(name => ({ name, evidence: text.slice(text.indexOf(name), text.indexOf(name) + name.length) })),
    startFields: [
      { name: 'Equipamento', type: 'text', required: true, evidence: 'equipamento, quantidade' },
      { name: 'Quantidade', type: 'integer', required: true, evidence: 'quantidade, valor total' },
      { name: 'Valor total estimado', type: 'decimal', required: true, evidence: 'valor total estimado' },
      { name: 'Justificativa', type: 'paragraph', required: true, evidence: 'justificativa e setor' },
      { name: 'Setor solicitante', type: 'text', required: true, evidence: 'justificativa e setor' },
    ],
    activities: [
      { kind: 'task', name: 'Verificar completude da solicitação', actor: 'Gestor', evidence: 'o gestor do setor, que verifica as informações', fields: [
        { name: 'Solicitação completa?', type: 'boolean', required: true, evidence: 'verifica as informações' },
        { name: 'Orientações de correção', type: 'paragraph', required: true, evidence: 'devolve ao funcionário com orientações' },
      ] },
      { kind: 'decision', name: 'Decidir se a solicitação está completa', field: 'Solicitação completa?', evidence: 'Se as informações estiverem completas, o gestor aprova ou reprova', alternatives: [
        { label: 'Incompleta', value: false, steps: [{ kind: 'task', name: 'Corrigir e reenviar solicitação', actor: 'Funcionário', evidence: 'o funcionário corrige e reenvia ao gestor', fields: [{ name: 'Correções realizadas', type: 'paragraph', required: true, evidence: 'funcionário corrige e reenvia' }] }], returnTo: 'Verificar completude da solicitação' },
        { label: 'Completa', value: true, steps: [{ kind: 'approval', name: 'Aprovação do gestor', actor: 'Gestor', evidence: 'o gestor aprova ou reprova', requiresRejectionReason: true, onApproved: [
          { kind: 'decision', name: 'Escolher faixa de compra', field: 'Valor total estimado', evidence: 'compras de até R$ 5.000 seguem diretamente para Compras; acima de R$ 5.000 precisam de aprovação do Diretor', alternatives: [
            { label: 'Até R$ 5.000', operator: 'lte', value: 5000, steps: [] },
            { label: 'Acima de R$ 5.000', operator: 'gt', value: 5000, steps: [{ kind: 'approval', name: 'Aprovação do Diretor', actor: 'Diretor', evidence: 'precisam de aprovação do Diretor', requiresRejectionReason: true, onApproved: [], onRejected: [] }] },
          ] },
          { kind: 'task', name: 'Registrar compra', actor: 'Compras', evidence: 'Compras registra fornecedor, número do pedido e data da compra', fields: [
            { name: 'Fornecedor', type: 'text', required: true, evidence: 'registra fornecedor' },
            { name: 'Número do pedido', type: 'text', required: true, evidence: 'número do pedido' },
            { name: 'Data da compra', type: 'date', required: true, evidence: 'data da compra' },
          ] },
          { kind: 'task', name: 'Conferir valores', actor: 'Financeiro', evidence: 'O Financeiro confere valores' },
          { kind: 'task', name: 'Registrar despesa', actor: 'Financeiro', evidence: 'registra a despesa' },
        ], onRejected: [] }] },
      ] },
    ],
    rules: [], suggestions: [], pendingConfiguration: [],
  };
}
