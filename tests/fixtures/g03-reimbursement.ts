type FieldDef = { key: string; label: string; type: string; required?: boolean; requiredWhen?: any };
type FormDef = { id: string; name: string; fields: FieldDef[] };

const formDefs: FormDef[] = [
  { id: 'form_request', name: 'Solicitação de reembolso', fields: [
    { key: 'employee_name', label: 'Nome', type: 'text', required: true },
    { key: 'department', label: 'Departamento', type: 'text', required: true },
    { key: 'expense_type', label: 'Tipo da despesa', type: 'text', required: true },
    { key: 'expense_date', label: 'Data', type: 'date', required: true },
    { key: 'requested_amount', label: 'Valor solicitado', type: 'decimal', required: true },
    { key: 'justification', label: 'Justificativa', type: 'textarea', required: true },
    { key: 'receipt_reference', label: 'Referência do comprovante fiscal', type: 'text', required: true },
  ] },
  { id: 'form_completeness', name: 'Verificar completude', fields: [
    { key: 'request_complete', label: 'Solicitação completa', type: 'boolean', required: true },
    { key: 'adjustments_needed', label: 'Ajustes necessários', type: 'textarea', requiredWhen: { op: 'eq', left: { var: 'request_complete' }, right: { literal: false } } },
  ] },
  { id: 'form_employee_adjust', name: 'Ajustar solicitação', fields: [ { key: 'adjustments_made', label: 'Ajustes realizados', type: 'textarea', required: true } ] },
  { id: 'form_manager_approval', name: 'Aprovação do gestor', fields: [
    { key: 'manager_approved', label: 'Aprovado', type: 'boolean', required: true },
    { key: 'manager_rejection_reason', label: 'Motivo da reprovação', type: 'textarea', requiredWhen: { op: 'eq', left: { var: 'manager_approved' }, right: { literal: false } } },
  ] },
  { id: 'form_director_approval', name: 'Aprovação do Diretor', fields: [
    { key: 'director_approved', label: 'Aprovado', type: 'boolean', required: true },
    { key: 'director_rejection_reason', label: 'Motivo da reprovação', type: 'textarea', requiredWhen: { op: 'eq', left: { var: 'director_approved' }, right: { literal: false } } },
  ] },
  { id: 'form_finance_check', name: 'Conferir documentação', fields: [
    { key: 'documents_correct', label: 'Documentação correta', type: 'boolean', required: true },
    { key: 'document_discrepancy', label: 'Divergência encontrada', type: 'textarea', requiredWhen: { op: 'eq', left: { var: 'documents_correct' }, right: { literal: false } } },
  ] },
  { id: 'form_employee_correct_docs', name: 'Corrigir documentação', fields: [ { key: 'document_correction', label: 'Correção realizada', type: 'textarea', required: true } ] },
  { id: 'form_reimbursability', name: 'Verificar reembolsabilidade', fields: [
    { key: 'reimbursable', label: 'Despesa reembolsável', type: 'boolean', required: true },
    { key: 'non_reimbursable_reason', label: 'Justificativa', type: 'textarea', requiredWhen: { op: 'eq', left: { var: 'reimbursable' }, right: { literal: false } } },
  ] },
  { id: 'form_register', name: 'Registrar reembolso', fields: [
    { key: 'approved_amount', label: 'Valor aprovado', type: 'decimal', required: true },
    { key: 'payment_date', label: 'Data prevista de pagamento', type: 'date', required: true },
    { key: 'finance_reference', label: 'Referência financeira', type: 'text', required: true },
    { key: 'finance_notes', label: 'Observações', type: 'textarea' },
  ] },
];

const variableTypes: Record<string, string> = { employee_name: 'string', department: 'string', expense_type: 'string', expense_date: 'date', requested_amount: 'decimal', justification: 'string', receipt_reference: 'string', request_complete: 'boolean', adjustments_needed: 'string', adjustments_made: 'string', manager_approved: 'boolean', manager_rejection_reason: 'string', director_approved: 'boolean', director_rejection_reason: 'string', documents_correct: 'boolean', document_discrepancy: 'string', document_correction: 'string', reimbursable: 'boolean', non_reimbursable_reason: 'string', approved_amount: 'decimal', payment_date: 'date', finance_reference: 'string', finance_notes: 'string' };
const formForVariable = new Map<string, { formId: string; fieldKey: string }>();
for (const form of formDefs) for (const field of form.fields) formForVariable.set(field.key, { formId: form.id, fieldKey: field.key });

const eq = (key: string, literal: boolean | number) => ({ op: 'eq', left: { var: key }, right: { literal } });

export const g03ReimbursementProcessSpec = {
  schemaVersion: '1.0.0', id: 'reembolso_corporativo_g03', name: 'Reembolso corporativo',
  description: 'Solicitação, aprovações, conferência financeira e registro determinísticos.',
  locale: 'pt-BR', targetProfile: 'generic-bpmn2', status: 'ready-for-review',
  roles: [
    { id: 'employee', label: 'Funcionário', resolution: 'requester' },
    { id: 'manager', label: 'Gestor', resolution: 'manual' },
    { id: 'director', label: 'Diretor', resolution: 'manual' },
    { id: 'finance', label: 'Financeiro', resolution: 'manual' },
  ],
  variables: Object.entries(variableTypes).map(([key, type]) => ({
    key, type, required: formDefs.flatMap(form => form.fields).find(field => field.key === key)?.required ?? false,
    sensitive: false, scope: 'process', source: { kind: 'form', ...formForVariable.get(key) },
  })),
  forms: formDefs.map(form => ({ id: form.id, name: form.name, usage: form.id === 'form_request' ? 'start' : 'task', fields: form.fields.map(field => ({
    key: field.key, label: field.label, type: field.type, required: field.required ?? false, bindTo: field.key,
    ...(field.requiredWhen ? { requiredWhen: field.requiredWhen } : {}),
  })) })),
  nodes: [
    { id: 'start', name: 'Solicitar reembolso', type: 'startEvent', formId: 'form_request' },
    { id: 'manager_check', name: 'Verificar completude da solicitação', type: 'userTask', roleId: 'manager', formId: 'form_completeness' },
    { id: 'completeness_gateway', name: 'Resultado da verificação de completude', type: 'exclusiveGateway' },
    { id: 'employee_adjust', name: 'Ajustar solicitação', type: 'userTask', roleId: 'employee', formId: 'form_employee_adjust' },
    { id: 'manager_approval', name: 'Aprovar solicitação', type: 'userTask', roleId: 'manager', formId: 'form_manager_approval' },
    { id: 'manager_decision_gateway', name: 'Resultado da aprovação do Gestor', type: 'exclusiveGateway' },
    { id: 'amount_gateway', name: 'Decisão de valor', type: 'exclusiveGateway' },
    { id: 'director_approval', name: 'Aprovar solicitação acima do limite', type: 'userTask', roleId: 'director', formId: 'form_director_approval' },
    { id: 'director_decision_gateway', name: 'Resultado da aprovação do Diretor', type: 'exclusiveGateway' },
    { id: 'finance_check', name: 'Conferir documentação', type: 'userTask', roleId: 'finance', formId: 'form_finance_check' },
    { id: 'documents_gateway', name: 'Resultado da conferência documental', type: 'exclusiveGateway' },
    { id: 'employee_correct_docs', name: 'Corrigir documentação', type: 'userTask', roleId: 'employee', formId: 'form_employee_correct_docs' },
    { id: 'finance_eligibility', name: 'Verificar se a despesa é reembolsável', type: 'userTask', roleId: 'finance', formId: 'form_reimbursability' },
    { id: 'reimbursability_gateway', name: 'Resultado da análise financeira', type: 'exclusiveGateway' },
    { id: 'finance_register', name: 'Registrar reembolso aprovado', type: 'userTask', roleId: 'finance', formId: 'form_register' },
    { id: 'end_manager_rejected', name: 'Reembolso reprovado pelo Gestor', type: 'endEvent' },
    { id: 'end_director_rejected', name: 'Reembolso reprovado pelo Diretor', type: 'endEvent' },
    { id: 'end_not_reimbursable', name: 'Despesa não reembolsável', type: 'endEvent' },
    { id: 'end_registered', name: 'Reembolso aprovado e registrado', type: 'endEvent' },
  ],
  flows: [
    { id: 'f_start_check', source: 'start', target: 'manager_check' },
    { id: 'f_check_result', source: 'manager_check', target: 'completeness_gateway' },
    { id: 'f_incomplete', source: 'completeness_gateway', target: 'employee_adjust', condition: eq('request_complete', false), label: 'Incompleta' },
    { id: 'f_complete', source: 'completeness_gateway', target: 'manager_approval', condition: eq('request_complete', true), label: 'Completa' },
    { id: 'f_adjust_return', source: 'employee_adjust', target: 'manager_check', label: 'Reenviar para conferência' },
    { id: 'f_manager_decision', source: 'manager_approval', target: 'manager_decision_gateway' },
    { id: 'f_manager_rejected', source: 'manager_decision_gateway', target: 'end_manager_rejected', condition: eq('manager_approved', false), label: 'Reprovada' },
    { id: 'f_manager_approved', source: 'manager_decision_gateway', target: 'amount_gateway', condition: eq('manager_approved', true), label: 'Aprovada' },
    { id: 'f_amount_low', source: 'amount_gateway', target: 'finance_check', condition: { op: 'lte', left: { var: 'requested_amount' }, right: { literal: 2000 } }, label: 'Até 2000' },
    { id: 'f_amount_high', source: 'amount_gateway', target: 'director_approval', condition: { op: 'gt', left: { var: 'requested_amount' }, right: { literal: 2000 } }, label: 'Acima de 2000' },
    { id: 'f_director_decision', source: 'director_approval', target: 'director_decision_gateway' },
    { id: 'f_director_rejected', source: 'director_decision_gateway', target: 'end_director_rejected', condition: eq('director_approved', false), label: 'Reprovada' },
    { id: 'f_director_approved', source: 'director_decision_gateway', target: 'finance_check', condition: eq('director_approved', true), label: 'Aprovada' },
    { id: 'f_finance_check_result', source: 'finance_check', target: 'documents_gateway' },
    { id: 'f_docs_incorrect', source: 'documents_gateway', target: 'employee_correct_docs', condition: eq('documents_correct', false), label: 'Documentação incorreta' },
    { id: 'f_docs_correct', source: 'documents_gateway', target: 'finance_eligibility', condition: eq('documents_correct', true), label: 'Documentação correta' },
    { id: 'f_docs_return', source: 'employee_correct_docs', target: 'finance_check', label: 'Retornar diretamente à conferência financeira' },
    { id: 'f_eligibility_result', source: 'finance_eligibility', target: 'reimbursability_gateway' },
    { id: 'f_not_reimbursable', source: 'reimbursability_gateway', target: 'end_not_reimbursable', condition: eq('reimbursable', false), label: 'Não reembolsável' },
    { id: 'f_reimbursable', source: 'reimbursability_gateway', target: 'finance_register', condition: eq('reimbursable', true), label: 'Reembolsável' },
    { id: 'f_register_end', source: 'finance_register', target: 'end_registered' },
  ],
  pendingQuestions: [], assumptions: [], policies: { manualApprovalRequired: true, allowExecution: false },
};

