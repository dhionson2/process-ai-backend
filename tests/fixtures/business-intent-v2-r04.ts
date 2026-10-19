import type { BusinessIntentV2 } from '../../src/modules/ai/semantic-process.js';

export const r04V2: BusinessIntentV2 = {
  schemaVersion:'2.0.0', kind:'business_intent', name:'R04 — Reembolso com correções', purpose:'Analisar, aprovar, corrigir e processar reembolso.',
  actors:[{name:'Colaborador',resolution:'requester'},{name:'Gestor',resolution:'manual'},{name:'Diretor',resolution:'manual'},{name:'Financeiro',resolution:'manual'}],
  startFields:[{name:'Valor',type:'decimal',required:true}],
  activities:[
    {ref:'registrar_solicitacao',kind:'task',name:'Registrar solicitação',actor:'Colaborador',next:{kind:'activity',activityRef:'analisar_solicitacao'}},
    {ref:'analisar_solicitacao',kind:'task',name:'Analisar solicitação',actor:'Gestor',fields:[{name:'Decisão do Gestor',type:'choice',required:true,choices:[{label:'Aprovar',value:'approved'},{label:'Reprovar',value:'rejected'},{label:'Solicitar correção',value:'correction'}]}],next:{kind:'decision',decisionRef:'resultado_gestor'}},
    {ref:'corrigir_solicitacao',kind:'task',name:'Corrigir solicitação',actor:'Colaborador',fields:[{name:'Valor',type:'decimal',required:true}],next:{kind:'activity',activityRef:'analisar_solicitacao'}},
    {ref:'aprovar_reembolso',kind:'task',name:'Aprovar reembolso',actor:'Diretor',fields:[{name:'Decisão do Diretor',type:'choice',required:true,choices:[{label:'Aprovar',value:'approved'},{label:'Reprovar',value:'rejected'}]}],next:{kind:'decision',decisionRef:'resultado_diretor'}},
    {ref:'conferir_processar',kind:'task',name:'Conferir e processar reembolso',actor:'Financeiro',fields:[{name:'Resultado Financeiro',type:'choice',required:true,choices:[{label:'Confirmar pagamento',value:'confirmed'},{label:'Solicitar correção',value:'correction'}]}],next:{kind:'decision',decisionRef:'resultado_financeiro'}},
    {ref:'corrigir_pagamento',kind:'task',name:'Corrigir dados de pagamento',actor:'Colaborador',next:{kind:'activity',activityRef:'conferir_processar'}},
  ],
  decisions:[
    {ref:'resultado_gestor',name:'Resultado da análise do Gestor',afterActivityRef:'analisar_solicitacao',outcomes:[
      {ref:'reprovado',label:'Reprovado',condition:{field:'Decisão do Gestor',operator:'eq',value:'rejected'},target:{kind:'end',name:'Reprovado'}},
      {ref:'correcao',label:'Correção solicitada',condition:{field:'Decisão do Gestor',operator:'eq',value:'correction'},target:{kind:'activity',activityRef:'corrigir_solicitacao'}},
      {ref:'aprovado',label:'Aprovado',condition:{field:'Decisão do Gestor',operator:'eq',value:'approved'},target:{kind:'decision',decisionRef:'limite_diretor'}},
    ]},
    {ref:'limite_diretor',name:'Valor exige aprovação do Diretor?',afterActivityRef:'analisar_solicitacao',outcomes:[
      {ref:'acima_2000',label:'Acima de 2000',condition:{field:'Valor',operator:'gt',value:2000},target:{kind:'activity',activityRef:'aprovar_reembolso'}},
      {ref:'ate_2000',label:'Até 2000',condition:{field:'Valor',operator:'lte',value:2000},target:{kind:'activity',activityRef:'conferir_processar'}},
    ]},
    {ref:'resultado_diretor',name:'Resultado da aprovação do Diretor',afterActivityRef:'aprovar_reembolso',outcomes:[
      {ref:'reprovado',label:'Reprovado',condition:{field:'Decisão do Diretor',operator:'eq',value:'rejected'},target:{kind:'end',name:'Reprovado'}},
      {ref:'aprovado',label:'Aprovado',condition:{field:'Decisão do Diretor',operator:'eq',value:'approved'},target:{kind:'activity',activityRef:'conferir_processar'}},
    ]},
    {ref:'resultado_financeiro',name:'Resultado do processamento financeiro',afterActivityRef:'conferir_processar',outcomes:[
      {ref:'concluido',label:'Pagamento confirmado',condition:{field:'Resultado Financeiro',operator:'eq',value:'confirmed'},target:{kind:'end',name:'Concluído'}},
      {ref:'correcao',label:'Correção solicitada',condition:{field:'Resultado Financeiro',operator:'eq',value:'correction'},target:{kind:'activity',activityRef:'corrigir_pagamento'}},
    ]},
  ],
  returns:[{fromActivityRef:'corrigir_solicitacao',toActivityRef:'analisar_solicitacao'},{fromActivityRef:'corrigir_pagamento',toActivityRef:'conferir_processar'}],
};
