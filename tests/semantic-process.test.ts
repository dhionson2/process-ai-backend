import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileProcessIntent, compileBusinessIntent, applySemanticRefinement, assertSemanticPlanBounds, SemanticPlanLimitError, semanticIntentSchema, semanticRefinementSchema } from '../src/modules/ai/semantic-process.js';
import { BUSINESS_PATTERN_LIBRARY } from '../src/modules/ai/business-patterns.js';
import { validateProcessSpec } from '../src/modules/validation/validation.service.js';
import { generateArtifacts } from '../src/modules/generation/artifact-generator.js';

const options = { targetProfile: 'generic-bpmn2' as const, knowledgeVersion: '1.0.0', model: 'manual-test' };
const vacationIntent = () => ({
  kind: 'process_intent', name: 'Solicitação de férias', purpose: 'Solicitar férias; o gestor decide, o RH registra aprovações e o servidor recebe o motivo da reprovação.',
  actors: [
    { name: 'Servidor solicitante', resolution: 'requester' },
    { name: 'Gestor aprovador', resolution: 'manager-of-requester' },
    { name: 'Equipe de RH', resolution: 'group', groupName: 'RH' },
  ],
  startFields: [
    { name: 'Data inicial', type: 'date', required: true },
    { name: 'Data final', type: 'date', required: true },
  ],
  steps: [{ kind: 'approval', name: 'Analisar solicitação', actor: 'Gestor aprovador', requiresRejectionReason: true,
    onApproved: [{ kind: 'task', name: 'Registrar férias', actor: 'Equipe de RH' }],
    onRejected: [{ kind: 'integration', name: 'Informar motivo ao servidor', connectorId: 'notification_mock', operationId: 'notify_rejection', inputs: [{ parameter: 'message', field: 'Motivo da rejeição' }], outputs: [] }],
  }],
});

async function compile(intent: any) {
  const spec = await compileProcessIntent(intent, options);
  const validation = await validateProcessSpec(spec);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  const artifacts = await generateArtifacts(spec);
  assert.ok(artifacts.bpmnXml.includes('<bpmn:definitions'));
  assert.equal(artifacts.diagnostics.some(item => item.severity === 'error'), false);
  assert.deepEqual(await generateArtifacts(spec), artifacts, 'compilation and artifacts must be deterministic');
  return { spec, artifacts };
}

test('contratos de intenção e refinamento omitem o grafo BPMN técnico', () => {
  const generation = JSON.stringify(semanticIntentSchema());
  assert.ok(generation.length < 7000, `schema chars=${generation.length}`);
  assert.match(generation, /business_intent/);
  assert.doesNotMatch(generation, /sequenceFlow|gatewayId|nodeId|flowId/);
  const refinement = JSON.stringify(semanticRefinementSchema());
  assert.match(refinement, /insertTaskAfter/);
  assert.match(refinement, /insertApprovalBefore/);
  assert.doesNotMatch(refinement, /afterNodeId|nodeId|roleId/);
});

test('contrato limita atividades e o plano recursivo falha fechado quando excede os limites', () => {
  const schema = semanticIntentSchema();
  const planSchema = schema.oneOf.find((item: any) => item.properties?.kind?.const === 'business_intent');
  assert.equal(planSchema.properties.activities.maxItems, 24);
  assert.doesNotThrow(() => assertSemanticPlanBounds({ steps: Array.from({ length: 24 }, () => ({ kind: 'task' })) }));
  assert.throws(() => assertSemanticPlanBounds({ steps: Array.from({ length: 61 }, () => ({ kind: 'task' })) }), SemanticPlanLimitError);
  const recursive = { steps: [{ kind: 'decision', alternatives: Array.from({ length: 8 }, () => ({ steps: Array.from({ length: 8 }, () => ({ kind: 'task' })) })) }] };
  assert.throws(() => assertSemanticPlanBounds(recursive), /60 atividades/);
});

function groundedIntent(text: string, activities: any[], actors: any[], startFields: any[] = []) {
  return { kind: 'business_intent', name: 'Processo de teste', purpose: text, actors, startFields, activities,
    rules: [], suggestions: [], pendingConfiguration: [] };
}

async function compileBusiness(text: string, intent: any) {
  const compiled = await compileBusinessIntent(intent, { ...options, sourceText: text, activitySourceText: text });
  const validation = await validateProcessSpec(compiled.spec);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  const artifacts = await generateArtifacts(compiled.spec);
  assert.equal(artifacts.diagnostics.some(item => item.severity === 'error'), false);
  assert.deepEqual(await generateArtifacts(compiled.spec), artifacts, 'BusinessIntent must compile deterministically');
  return { ...compiled, artifacts };
}

test('biblioteca de padrões é genérica e contém as composições determinísticas reutilizáveis', () => {
  assert.ok(BUSINESS_PATTERN_LIBRARY.approval.compilesTo.includes('exclusiveGateway'));
  assert.ok(BUSINESS_PATTERN_LIBRARY.declarativeIntegration.compilesTo.includes('catalog-operation'));
  assert.equal(BUSINESS_PATTERN_LIBRARY.recordUpdate.requiresApprovalAndIdempotency, true);
});

test('BusinessIntent gera férias sem inventar campos e mantém configuração do gestor pendente', async () => {
  const text = 'O servidor faz a solicitação de férias. O gestor aprova ou reprova. Se aprovado, o RH registra as férias. Se reprovado, o servidor deve ser informado do motivo.';
  const actors = [
    { name: 'servidor', resolution: 'requester', evidence: 'O servidor faz a solicitação de férias', resolutionEvidence: 'O servidor faz a solicitação' },
    { name: 'gestor', evidence: 'O gestor aprova ou reprova' },
    { name: 'RH', evidence: 'o RH registra as férias' },
  ];
  const activities = [{ kind: 'approval', name: 'Aprovar ou reprovar férias', actor: 'gestor', evidence: 'O gestor aprova ou reprova', requiresRejectionReason: true,
    onApproved: [{ kind: 'task', name: 'Registrar as férias', actor: 'RH', evidence: 'o RH registra as férias' }], onRejected: [{ kind: 'task', name: 'Receber motivo', actor: 'servidor', evidence: 'o servidor deve ser informado do motivo' }] }];
  const { spec, businessIntent, artifacts } = await compileBusiness(text, groundedIntent(text, activities, actors));
  const reason = spec.forms.flatMap((form: any) => form.fields).find((field: any) => field.label === 'Motivo da rejeição');
  assert.ok(reason?.requiredWhen);
  assert.equal(businessIntent.actors.find(actor => actor.name === 'gestor')?.resolution, 'unresolved');
  assert.ok(spec.pendingQuestions.some((question: any) => question.relatedNodeId === spec.nodes.find((node: any) => node.type === 'userTask').id));
  assert.equal(spec.status, 'needs-input');
  const decisionEvidence = spec.metadata.requirementProvenance.find((item: any) => item.path.startsWith('activities/') && item.name === 'Aprovar ou reprovar férias');
  assert.equal(decisionEvidence?.source, 'user');
  assert.equal(decisionEvidence?.confirmed, true);
  assert.match(decisionEvidence?.evidenceSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(decisionEvidence, 'evidence'), false, 'ProcessSpec armazena hash da evidência, sem copiar o texto bruto');
  assert.equal(artifacts.manifest.publication.eligible, false);
  assert.ok(artifacts.manifest.configuration.unresolvedRoles.length > 0);
  assert.ok(!/candidateGroups="[^"]+"/.test(artifacts.bpmnXml));
});

test('BusinessIntent gera aprovação administrativa com os dois ramos', async () => {
  const text = 'O solicitante envia uma solicitação administrativa. O responsável aprova ou reprova. Se aprovar, o protocolo registra a solicitação.';
  const intent = groundedIntent(text, [{ kind: 'approval', name: 'Aprovar ou reprovar solicitação', actor: 'responsável', evidence: 'O responsável aprova ou reprova',
      onApproved: [{ kind: 'task', name: 'Registrar a solicitação', actor: 'protocolo', evidence: 'o protocolo registra a solicitação' }], onRejected: [] }], [
      { name: 'solicitante', resolution: 'requester', evidence: 'O solicitante envia uma solicitação administrativa', resolutionEvidence: 'O solicitante envia' },
      { name: 'responsável', evidence: 'O responsável aprova ou reprova' },
      { name: 'protocolo', evidence: 'o protocolo registra a solicitação' },
    ]);
  const { spec } = await compileBusiness(text, intent);
  assert.equal(spec.nodes.filter((node: any) => node.type === 'exclusiveGateway').length, 1);
  assert.deepEqual(spec.flows.filter((flow: any) => flow.condition).map((flow: any) => flow.condition.right.literal).sort(), ['approved', 'rejected']);
});

test('BusinessIntent compõe duas aprovações em série sem especializar o cenário', async () => {
  const text = 'O solicitante envia o pedido. O gestor aprova. Se aprovado, o diretor também aprova.';
  const intent = groundedIntent(text, [
    { kind: 'approval', name: 'Aprovação do gestor', actor: 'gestor', evidence: 'O gestor aprova', onApproved: [{ kind: 'approval', name: 'Aprovação do diretor', actor: 'diretor', evidence: 'o diretor também aprova', onApproved: [], onRejected: [] }], onRejected: [] },
  ], [
    { name: 'solicitante', resolution: 'requester', evidence: 'O solicitante envia o pedido', resolutionEvidence: 'O solicitante envia' },
    { name: 'gestor', evidence: 'O gestor aprova' }, { name: 'diretor', evidence: 'o diretor também aprova' },
  ]);
  const { spec } = await compileBusiness(text, intent);
  assert.equal(spec.nodes.filter((node: any) => node.type === 'exclusiveGateway').length, 2);
  assert.equal(spec.nodes.filter((node: any) => node.type === 'userTask').length, 2);
});

test('BusinessIntent compila ciclo de correção, limite numérico, reprovações terminais e tarefas humanas', async () => {
  const text = 'O funcionário preenche equipamento, quantidade, valor total estimado, justificativa e setor. O gestor verifica se a solicitação está completa. Se incompleta, devolve ao funcionário com orientações; o funcionário corrige e reenvia ao gestor para nova análise. Se as informações estiverem completas, o gestor aprova ou reprova. Se reprovar, informa obrigatoriamente o motivo e o processo é encerrado. Se aprovar, compras de até R$ 5.000 seguem diretamente para Compras; acima de R$ 5.000 precisam de aprovação do Diretor. Se o Diretor reprovar, informa obrigatoriamente o motivo e o processo é encerrado. Se aprovar, segue para Compras. Compras registra fornecedor, número do pedido e data da compra. O Financeiro confere valores, registra a despesa e finaliza o processo como concluído.';
  const intent = groundedIntent(text, [
    { kind: 'task', name: 'Verificar completude da solicitação', actor: 'Gestor', evidence: 'O gestor verifica se a solicitação está completa', fields: [{ name: 'Solicitação completa?', type: 'boolean', required: true, evidence: 'verifica se a solicitação está completa' }, { name: 'Orientações de correção', type: 'paragraph', required: true, evidence: 'devolve ao funcionário com orientações' }] },
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
  ], ['Funcionário', 'Gestor', 'Diretor', 'Compras', 'Financeiro'].map(name => ({ name, evidence: text.slice(text.indexOf(name), text.indexOf(name) + name.length) })), [
    { name: 'Equipamento', type: 'text', required: true, evidence: 'equipamento, quantidade' },
    { name: 'Quantidade', type: 'integer', required: true, evidence: 'quantidade, valor total' },
    { name: 'Valor total estimado', type: 'decimal', required: true, evidence: 'valor total estimado' },
    { name: 'Justificativa', type: 'paragraph', required: true, evidence: 'justificativa e setor' },
    { name: 'Setor solicitante', type: 'text', required: true, evidence: 'justificativa e setor' },
  ]);
  const { spec, artifacts } = await compileBusiness(text, intent);
  const allFieldLabels = spec.forms.flatMap((form: any) => form.fields.map((field: any) => field.label));
  for (const label of ['Equipamento', 'Quantidade', 'Valor total estimado', 'Justificativa', 'Setor solicitante', 'Solicitação completa?', 'Correções realizadas', 'Fornecedor', 'Número do pedido', 'Data da compra']) assert.ok(allFieldLabels.includes(label), `missing required business field: ${label}; actual=${JSON.stringify(allFieldLabels)}`);
  const verify = spec.nodes.find((node: any) => node.name === 'Verificar completude da solicitação');
  const correction = spec.nodes.find((node: any) => node.name === 'Corrigir e reenviar solicitação');
  assert.ok(spec.flows.some((flow: any) => flow.source === correction.id && flow.target === verify.id), 'correction returns to manager review');
  const thresholds = spec.flows.filter((flow: any) => flow.condition?.left?.var === spec.variables.find((variable: any) => variable.key.includes('valor_total_estimado'))?.key);
  assert.ok(spec.flows.some((flow: any) => flow.condition?.op === 'lte' && flow.condition?.right?.literal === 5000));
  assert.ok(spec.flows.some((flow: any) => flow.condition?.op === 'gt' && flow.condition?.right?.literal === 5000));
  assert.ok(thresholds.length >= 2);
  for (const name of ['Aprovação do gestor', 'Aprovação do Diretor']) {
    const approval = spec.nodes.find((node: any) => node.name === name && node.type === 'userTask');
    const gateway = spec.nodes.find((node: any) => node.name === name && node.type === 'exclusiveGateway');
    const form = spec.forms.find((item: any) => item.id === approval.formId);
    assert.ok(form.fields.some((field: any) => /motivo/i.test(field.label) && field.requiredWhen), `${name} requires a rejection reason conditionally`);
    const rejected = spec.flows.find((flow: any) => flow.source === gateway.id && flow.label === 'Rejeitado');
    assert.equal(spec.nodes.find((node: any) => node.id === rejected.target)?.type, 'endEvent', `${name} rejection terminates`);
  }
  assert.equal(spec.nodes.filter((node: any) => node.type === 'serviceTask').length, 0, 'Compras and Financeiro remain human tasks');
  assert.ok(spec.nodes.some((node: any) => node.name === 'Registrar compra' && node.type === 'userTask'));
  assert.ok(spec.nodes.some((node: any) => node.name === 'Conferir valores' && node.type === 'userTask'));
  assert.ok(spec.nodes.some((node: any) => node.name === 'Registrar despesa' && node.type === 'userTask'));
  assert.equal(spec.nodes.filter((node: any) => node.type === 'endEvent').length, 1);
  assert.ok(artifacts.bpmnXml.includes('<bpmn:definitions'));
  assert.ok(artifacts.forms.length >= 6);
});

test('BusinessIntent compõe leitura HTTP declarativa do catálogo', async () => {
  const text = 'O solicitante informa o identificador do pedido. Consultar o estado do pedido pela integração aprovada people_api lookup_request.';
  const intent = groundedIntent(text, [{ kind: 'integration', name: 'Consultar estado do pedido', connectorId: 'people_api', operationId: 'lookup_request', evidence: 'Consultar o estado do pedido pela integração aprovada people_api lookup_request',
    inputs: [{ parameter: 'requestId', field: 'Identificador do pedido' }], outputs: [{ parameter: 'status', name: 'Estado atual', type: 'text' }] }],
    [{ name: 'solicitante', resolution: 'requester', evidence: 'O solicitante informa o identificador do pedido', resolutionEvidence: 'O solicitante informa' }],
    [{ name: 'Identificador do pedido', type: 'text', required: true, evidence: 'O solicitante informa o identificador do pedido' }]);
  const { spec } = await compileBusiness(text, intent);
  const service = spec.nodes.find((node: any) => node.type === 'serviceTask');
  assert.equal(service.action.connectorId, 'people_api');
  assert.equal(service.action.sideEffectLevel, 'read');
  assert.equal(spec.policies.allowExecution, false);
});

test('BusinessIntent mantém escrita declarativa sujeita ao catálogo, aprovação e idempotência', async () => {
  const text = 'O solicitante informa o identificador e o novo estado. O analista revisa a solicitação. Depois da revisão, atualizar o estado do pedido pela integração aprovada hr_db set_request_status.';
  const intent = groundedIntent(text, [
    { kind: 'task', name: 'Revisar solicitação', actor: 'analista', evidence: 'O analista revisa a solicitação' },
    { kind: 'integration', name: 'Atualizar estado do pedido', connectorId: 'hr_db', operationId: 'set_request_status', evidence: 'atualizar o estado do pedido pela integração aprovada hr_db set_request_status',
      inputs: [{ parameter: 'requestId', field: 'Identificador' }, { parameter: 'status', field: 'Novo estado' }], outputs: [] },
  ], [{ name: 'solicitante', resolution: 'requester', evidence: 'O solicitante informa o identificador', resolutionEvidence: 'O solicitante informa' }, { name: 'analista', evidence: 'revisão humana' }], [
    { name: 'Identificador', type: 'text', required: true, evidence: 'O solicitante informa o identificador' },
    { name: 'Novo estado', type: 'text', required: true, evidence: 'o novo estado' },
  ]);
  const { spec } = await compileBusiness(text, intent);
  const service = spec.nodes.find((node: any) => node.type === 'serviceTask');
  assert.equal(service.action.connectorId, 'hr_db');
  assert.equal(service.action.approvalRequired, true);
  assert.ok(service.action.idempotencyKey);
  assert.equal(spec.policies.allowExecution, false);
});

test('BusinessIntent sem atividade confirmada pergunta em vez de gerar falso fluxo vazio', async () => {
  const text = 'Solicitar férias e obter decisão do gestor.';
  const intent = groundedIntent(text, [], [{ name: 'Gestor', evidence: 'decisão do gestor' }]);
  await assert.rejects(() => compileBusinessIntent(intent, { ...options, sourceText: text, activitySourceText: text }), /nenhuma atividade.*confirmada/i);
});

test('BusinessIntent não mascara decisão descrita que o modelo omitiu do fluxo', async () => {
  const text = 'O gestor aprova ou reprova o pedido e, se aprovado, o RH registra.';
  const intent = groundedIntent(text, [{ kind: 'task', name: 'O RH registra', actor: 'RH', evidence: 'o RH registra' }], [
    { name: 'gestor', evidence: 'O gestor aprova ou reprova' }, { name: 'RH', evidence: 'o RH registra' },
  ]);
  await assert.rejects(() => compileBusinessIntent(intent, { ...options, sourceText: text, activitySourceText: text }), /decisão explícita.*não a representou/i);
});

test('evidência de uma palavra não confirma atividade só por coincidência literal', async () => {
  const text = 'O gestor aprova ou reprova o pedido.';
  const intent = groundedIntent(text, [{ kind: 'approval', name: 'Gestor aprova ou reprova', actor: 'gestor', evidence: 'Gestor' }], [{ name: 'gestor', evidence: 'O gestor aprova ou reprova' }]);
  await assert.rejects(() => compileBusinessIntent(intent, { ...options, sourceText: text, activitySourceText: text }), /não aparece com essas palavras no seu pedido/i);
});

test('flag de motivo condicional do modelo não cria regra de negócio sem evidência', async () => {
  const text = 'O gestor analisa a solicitação.';
  const intent = groundedIntent(text, [{ kind: 'approval', name: 'Analisar solicitação', actor: 'gestor', evidence: 'O gestor analisa a solicitação', requiresRejectionReason: true, onApproved: [], onRejected: [] }], [{ name: 'gestor', evidence: 'O gestor analisa a solicitação' }]);
  const { spec, businessIntent } = await compileBusiness(text, intent);
  assert.equal(businessIntent.activities[0].requiresRejectionReason, false);
  assert.equal(spec.forms.flatMap((form: any) => form.fields).some((field: any) => field.label === 'Motivo da rejeição'), false);
  assert.ok(spec.assumptions.some((item: any) => /obrigatoriedade de motivo/.test(item.text)));
});

test('plano manual de férias compila aprovação, requiredWhen e integração declarativa', async () => {
  const { spec, artifacts } = await compile(vacationIntent());
  const reason = spec.forms.flatMap((form: any) => form.fields).find((field: any) => field.label === 'Motivo da rejeição');
  assert.ok(reason?.requiredWhen);
  assert.equal(reason.required, false);
  const notify = spec.nodes.find((node: any) => node.name === 'Informar motivo ao servidor');
  assert.equal(notify.type, 'serviceTask');
  assert.equal(notify.action.connectorId, 'notification_mock');
  assert.equal(notify.action.approvalRequired, true);
  assert.equal(spec.policies.allowExecution, false);
  assert.ok(artifacts.forms.length > 0);
});

test('plano manual de aprovação administrativa preserva os dois ramos e atinge um único fim', async () => {
  const { spec } = await compile({ kind: 'process_intent', name: 'Aprovação administrativa', purpose: 'Aprovar solicitação administrativa.',
    actors: [{ name: 'Solicitante', resolution: 'requester' }, { name: 'Responsável', resolution: 'manual' }], startFields: [{ name: 'Descrição da solicitação', type: 'paragraph', required: true }],
    steps: [{ kind: 'approval', name: 'Decidir solicitação', actor: 'Responsável', onApproved: [{ kind: 'task', name: 'Registrar aprovação', actor: 'Solicitante' }], onRejected: [] }],
  });
  assert.equal(spec.nodes.filter((node: any) => node.type === 'endEvent').length, 1);
  assert.deepEqual(spec.flows.filter((flow: any) => flow.condition).map((flow: any) => flow.condition.right.literal).sort(), ['approved', 'rejected']);
});

test('integração HTTP e banco é declarativa, tipada e nunca executada pelo compilador', async () => {
  const intent = { kind: 'process_intent', name: 'Consultar e atualizar solicitação', purpose: 'Consultar estado e registrar o novo estado após revisão humana.',
    actors: [{ name: 'Solicitante', resolution: 'requester' }, { name: 'Analista', resolution: 'manual' }], startFields: [{ name: 'Identificador', type: 'text', required: true }],
    steps: [{ kind: 'integration', name: 'Consultar solicitação', connectorId: 'people_api', operationId: 'lookup_request', inputs: [{ parameter: 'requestId', field: 'Identificador' }], outputs: [{ parameter: 'status', name: 'Estado atual', type: 'text' }] },
      { kind: 'task', name: 'Revisar solicitação', actor: 'Analista' },
      { kind: 'integration', name: 'Atualizar estado', connectorId: 'hr_db', operationId: 'set_request_status', inputs: [{ parameter: 'requestId', field: 'Identificador' }, { parameter: 'status', field: 'Estado atual' }], outputs: [] }],
  };
  const { spec } = await compile(intent);
  assert.equal(spec.nodes.filter((node: any) => node.type === 'serviceTask').length, 2);
  assert.ok(spec.nodes.filter((node: any) => node.type === 'serviceTask').every((node: any) => node.action.retryPolicy.maxAttempts === 0));
});

test('refinamento semântico insere tarefa linear sem alterar outras partes manuais', async () => {
  const { spec } = await compile({ kind: 'process_intent', name: 'Solicitação simples', purpose: 'Descrição manual deve permanecer.',
    actors: [{ name: 'Servidor', resolution: 'requester' }, { name: 'Analista', resolution: 'manual' }], startFields: [],
    steps: [{ kind: 'task', name: 'Receber solicitação', actor: 'Analista' }],
  });
  const originalNodes = structuredClone(spec.nodes);
  const next = applySemanticRefinement(spec, { kind: 'refinement', changeSummary: 'Segunda aprovação', operations: [{ kind: 'insertTaskAfter', afterActivity: 'Receber solicitação', task: { name: 'Segunda aprovação', actor: { name: 'Servidor', resolution: 'requester' }, fields: [] } }] });
  assert.equal(next.description, 'Descrição manual deve permanecer.');
  assert.ok(next.nodes.some((node: any) => node.name === 'Receber solicitação'));
  assert.ok(next.nodes.some((node: any) => node.name === 'Segunda aprovação'));
  for (const node of originalNodes) assert.deepEqual(next.nodes.find((candidate: any) => candidate.id === node.id), node);
  assert.equal((await validateProcessSpec(next)).valid, true);
  assert.throws(() => applySemanticRefinement(spec, { kind: 'refinement', changeSummary: 'ambíguo', operations: [{ kind: 'insertTaskAfter', afterActivity: 'inexistente', task: { name: 'Tarefa', actor: { name: 'Analista', resolution: 'manual' } } }] }), /atividade/);
});

test('refinamento adiciona segunda aprovação no ramo indicado e preserva o restante do grafo', async () => {
  const { spec } = await compile({ kind: 'process_intent', name: 'Aprovação administrativa', purpose: 'A solicitação só é registrada depois de aprovada.',
    actors: [{ name: 'Solicitante', resolution: 'requester' }, { name: 'Analista', resolution: 'manual' }], startFields: [],
    steps: [{ kind: 'approval', name: 'Primeira aprovação', actor: 'Analista', onApproved: [{ kind: 'task', name: 'Registrar solicitação', actor: 'Solicitante' }], onRejected: [] }],
  });
  const before = structuredClone(spec.nodes);
  const refined = applySemanticRefinement(spec, { kind: 'refinement', changeSummary: 'Adicionar aprovação sequencial', operations: [{ kind: 'insertApprovalBefore', beforeActivity: 'Registrar solicitação', rejectedTargetActivity: 'Processo encerrado', approval: { name: 'Segunda aprovação', actor: { name: 'Diretor', resolution: 'manual' } } }] });
  const validation = await validateProcessSpec(refined);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  assert.deepEqual(refined.nodes.filter((node: any) => before.some((old: any) => old.id === node.id)), before);
  assert.ok(refined.nodes.some((node: any) => node.name === 'Segunda aprovação' && node.type === 'userTask'));
  assert.equal(refined.flows.filter((flow: any) => flow.condition && flow.source === refined.nodes.find((node: any) => node.name === 'Segunda aprovação' && node.type === 'exclusiveGateway')?.id).length, 2);
});

test('refinamento resolve referências de atividade por ID canônico emitido no ProcessSpec', async () => {
  const { spec } = await compileBusinessIntent(groundedIntent('O solicitante envia o pedido. O gestor aprova. Se aprovado, o RH registra.', [
    { kind: 'approval', name: 'Aprovação do gestor', actor: 'gestor', evidence: 'O gestor aprova', onApproved: [{ kind: 'task', name: 'Registrar pedido', actor: 'RH', evidence: 'o RH registra' }], onRejected: [] },
  ], [
    { name: 'solicitante', resolution: 'requester', evidence: 'O solicitante envia o pedido', resolutionEvidence: 'O solicitante envia' },
    { name: 'gestor', evidence: 'O gestor aprova' }, { name: 'RH', evidence: 'o RH registra' },
  ]), { ...options, sourceText: 'O solicitante envia o pedido. O gestor aprova. Se aprovado, o RH registra.' });
  const target = spec.nodes.find((node: any) => node.name === 'Registrar pedido');
  const gateway = spec.nodes.find((node: any) => node.type === 'exclusiveGateway');
  const end = spec.nodes.find((node: any) => node.type === 'endEvent');
  const refined = applySemanticRefinement(spec, { kind: 'refinement', operations: [{ kind: 'insertApprovalBefore', beforeActivity: target.id, rejectedTargetActivity: end.id, approval: { name: 'Segunda aprovação', actor: { name: 'Diretor' } } }] }, { sourceText: 'O diretor fará a segunda aprovação.' });
  assert.equal(refined.nodes.filter((node: any) => node.type === 'exclusiveGateway').length, 2);
  assert.deepEqual(refined.nodes.find((node: any) => node.id === gateway.id), gateway);
});

test('reprovação na segunda aprovação informa o motivo produzido nessa própria etapa', async () => {
  const { spec } = await compile(vacationIntent());
  const refined = applySemanticRefinement(spec, { kind: 'refinement', changeSummary: 'Segunda aprovação com motivo', operations: [{ kind: 'insertApprovalBefore', beforeActivity: 'Registrar férias', rejectedTargetActivity: 'Informar motivo ao servidor', approval: { name: 'Aprovação do diretor', actor: { name: 'Diretor', resolution: 'manual' }, requiresRejectionReason: true } }] });
  assert.equal((await validateProcessSpec(refined)).valid, true);
  const originalNotification = refined.nodes.find((node: any) => node.name === 'Informar motivo ao servidor');
  const secondNotification = refined.nodes.find((node: any) => node.name === 'Informar motivo ao servidor (Aprovação do diretor)');
  assert.ok(originalNotification && secondNotification);
  const originalReason = originalNotification.action.inputMapping.message.var;
  const secondReason = secondNotification.action.inputMapping.message.var;
  assert.notEqual(originalReason, secondReason);
  assert.ok(refined.variables.find((variable: any) => variable.key === secondReason));
});

test('ambiguidade de atribuição vira erro explícito em vez de assumir um responsável', async () => {
  const intent = { ...vacationIntent(), actors: [{ name: 'Servidor solicitante', resolution: 'requester' }, { name: 'Gestor aprovador' }] };
  await assert.rejects(() => compileProcessIntent(intent, options), /runtime deve atribuir/);
});

test('compilador exige evidência de atribuição e preserva motivo condicional explícito', async () => {
  const sourceText = 'O servidor solicitante envia o pedido. O gestor aprova ou reprova; o operador autorizado o seleciona manualmente. Se reprovado, o servidor deve receber o motivo.';
  const intent = { kind: 'process_intent', name: 'Pedido', purpose: 'Solicitar e decidir pedido.',
    actors: [{ name: 'Servidor', resolution: 'requester', resolutionEvidence: 'O servidor solicitante envia o pedido' }, { name: 'Gestor', resolution: 'manual' }], startFields: [],
    steps: [{ kind: 'approval', name: 'Aprovar ou reprovar', actor: 'Gestor', evidence: 'O gestor aprova ou reprova', requiresRejectionReason: false, onApproved: [], onRejected: [] }],
  };
  await assert.rejects(() => compileProcessIntent(intent, { ...options, sourceText, activitySourceText: sourceText }), /não confirma a resolução/);
  intent.actors[1].resolutionEvidence = 'o operador autorizado o seleciona manualmente';
  const spec = await compileProcessIntent(intent, { ...options, sourceText, activitySourceText: sourceText });
  const reason = spec.forms.flatMap((form: any) => form.fields).find((field: any) => field.label === 'Motivo da rejeição');
  assert.ok(reason?.requiredWhen, 'explicit conditional request must survive even if the model omits the flag');
  assert.equal(reason.required, false);
  assert.equal((await validateProcessSpec(spec)).valid, true);
});

test('compilador reconhece solicitante quando o próprio texto diz que inicia o pedido', async () => {
  const spec = await compileProcessIntent({ kind: 'process_intent', name: 'Pedido', purpose: 'O servidor abre o pedido.', actors: [{ name: 'Servidor', resolution: 'manual' }], startFields: [], steps: [{ kind: 'task', name: 'Fazer solicitação', actor: 'Servidor', evidence: 'O servidor faz a solicitação' }] }, { ...options, sourceText: 'O servidor faz a solicitação.' });
  assert.equal(spec.roles[0].resolution, 'requester');
  assert.equal((await validateProcessSpec(spec)).valid, true);
  const mixed = { kind: 'process_intent', name: 'Pedido', purpose: 'Aprovar pedido.', actors: [{ name: 'Servidor', resolution: 'requester' }, { name: 'Gestor', resolution: 'requester' }], startFields: [], steps: [{ kind: 'approval', name: 'Aprovar pedido', actor: 'Gestor', evidence: 'O servidor faz o pedido e o gestor aprova' }] };
  await assert.rejects(() => compileProcessIntent(mixed, { ...options, sourceText: 'O servidor faz o pedido e o gestor aprova.' }), /não confirma a resolução/);
});

