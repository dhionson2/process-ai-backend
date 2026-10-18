# GraphIR V1 — contrato interno e lowering

`GraphIRV1` é uma representação interna e plana de controle de processo. Ela não altera o OpenAPI nem o contrato público `ProcessSpec v1`; o modo `AI_GRAPH_IR_MODE=off` mantém o pipeline anterior como default. O schema JSON Schema 2020-12 executável é exportado por `graphIrV1Schema` em `graph-ir.ts`.

## Fronteira

- `BusinessIntent` expressa atividades, atores, decisões e regras interpretadas da linguagem de negócio, com evidência e contexto semântico.
- `ProcessPlan` é o plano compacto atual produzido pelo provider. Ainda contém `steps` recursivos e não é um grafo canônico.
- `GraphIRV1` expressa nós, arestas, variáveis, papéis e formulários em listas planas, com referências estáveis a requisitos.
- `ProcessSpec v1` continua sendo o contrato canônico validado pelo backend. Também contém estado de rascunho, perguntas, premissas e políticas exigidas pelo fluxo atual.
- BPMN XML e Form JSON continuam sendo projeções geradas do ProcessSpec.
- A persistência conversacional guarda mensagens, respostas, perguntas, runs e revisões; esse estado não pertence ao GraphIR.

O GraphIR não guarda XML BPMN, coordenadas BPMNDI, texto bruto de conversa nem permissões para executar integrações. Ações `serviceTask` são declarações tipadas e continuam sujeitas ao catálogo do ProcessSpec.

## Identidades e rastreabilidade

IDs técnicos (`node.id`, `edge.id`, `role.id`, `variable.id`, `formRef.id` e `requirement.id`) são estáveis, ASCII e independentes de labels. Reordenar nós, arestas, papéis, variáveis, formulários ou requisitos não altera referências. A identidade da variável (`id`) fica separada da chave de dado (`key`); condições usam `variable.id` e o adapter as converte para `ProcessSpec.variables[].key`.

No contrato de transporte GraphIR ao provider, `gatewayId` é omitido: após parse, a normalização preenche somente quando `edge.source` resolve a um único nó existente `exclusiveGateway`. O GraphIR canônico continua exigindo essa associação semanticamente; um `gatewayId` explícito divergente, fonte inexistente ou fonte não gateway não é corrigido e permanece erro.

O schema de transporte mantém `requirements[].id` e `requirementRefs`: uma declaração feita pelo provider não constitui evidência independente do Ledger. A normalização não cria requisitos nem preenche refs ausentes; o Coverage Gate valida os vínculos explícitos e rejeita elemento sem rastreabilidade. A associação de obrigações do Ledger ao GraphIR só é aceita pelos gates com evidência e estrutura verificáveis. Condições e `field.bindTo` podem usar `variable.id` ou uma `variable.key` que identifique exatamente uma variável; chaves ambíguas ou inexistentes continuam inválidas.

Atividades, gateways, ações, rotas condicionais e ciclos exigem `requirementRefs`. Requisitos obrigatórios sem cobertura, referências a requisitos inexistentes e ciclos/atores/condições divergentes são rejeitados pelo Coverage Gate. `provenance` contém apenas origem, confirmação, referência técnica e hash opcional; o validador não recebe nem tenta reconstruir a evidência original.

Para requisito `actor` do Ledger sem `nodeId`/`roleId`, o gate do orquestrador só o associa se uma única role cujo label aparece literalmente na evidência estiver atribuída a exatamente uma tarefa humana. Tarefas e papéis continuam sujeitos ao grounding individual contra a evidência do pedido. Papel ausente ou divergente falha; mais de uma tarefa para a role permanece inconclusiva. Requisitos `actor` explícitos dentro do GraphIR continuam obrigados a declarar e referenciar as identidades técnicas completas; a validação não os completa.

## Subconjunto da geração controlada

GraphIR V1 aceita `start`, `end`, `humanTask`, `serviceTask` declarativa e `exclusiveGateway`. Arestas aceitam condição AST tipada, associação ao gateway, uma saída default e marcação `loop-back`. Form refs preservam campos, bindings, obrigatoriedade, opções e condições `visibleWhen`/`requiredWhen`.

Parallel/inclusive/event gateways, subprocessos, eventos, timers, BPMNDI, FormPatch e GraphPatch permanecem fora do contrato. A projeção enviada ao provider aceita somente `start`, `end`, `humanTask` e `exclusiveGateway`, e condições atômicas tipadas. Ela exclui serviceTask até que a projeção transporte referências verificáveis ao catálogo. O adapter certifica `generic-bpmn2`. Papéis `unresolved` geram prévia `needs-input` e pergunta bloqueante vinculada à tarefa; não atribuem responsável nem habilitam publicação.

## Validação e compilação

1. `validateGraphIRStructure` aplica versão, campos obrigatórios, tipos e limites JSON Schema.
2. `validateGraphIRSemantics` verifica identidades, referências, papéis, variáveis, formulários, condições, conectividade, destinos de loops e XOR numérico. Reusa o analisador determinístico existente para conflitos de faixas numéricas; não chama LLM.
3. `validateGraphIRCoverage` separa requisitos omitidos e elementos sem vínculo de requisito da validade estrutural/semântica.
4. `lowerGraphIRToProcessSpec` rejeita GraphIR inválido, ordena coleções sem alterar campos de formulário, mapeia IDs de variável, mantém regras condicionais e gera provenance em formato aceito pelo metadata de ProcessSpec.
5. O ProcessSpec resultante passa por `validateProcessSpec`. Apenas resultado válido é retornado; não se removem fluxos, criam finais, escolhem ramos, alteram operadores nem atribuem papéis.

### JSON Object Mode e diagnósticos estruturais

No provider OpenAI-compatible em `json-object`, o schema de transporte completo é incluído no prompt porque `response_format` leva somente `{ type: "json_object" }`. Condições de transporte usam `{ op, variableId, value }` e são convertidas deterministicamente para a AST interna. A normalização resolve aliases de chave única e deriva `gatewayId` somente da identidade do nó fonte; não cria variáveis, requisitos ou `requirementRefs`, nem preenche elementos, papéis, valores, operadores ou destinos. Ela também omite apenas propriedades opcionais não anuláveis que chegaram como `null`; não apaga propriedades extras, tipos ou enums inválidos.

`diagnoseGraphIRSchema` mapeia os erros AJV em até 25 entradas sem valores da instância: caminho JSON sanitizado, keyword, caminho do schema, propriedade ausente/adicional, tipos/valores esperados pelo contrato e índices de arrays. Em falhas GraphIR, o run persiste até 25 metadados sanitizados de schema, semântica e Coverage Gate: código, estágio, tipo, path estrutural e `requirementId` quando seguro. IDs de nós/arestas e valores do payload não são persistidos. A API pública não inclui o JSON do modelo, prompt ou resposta bruta. Strict continua enviando `json_schema`; o schema canônico e a validação estrutural permanecem inalterados.

O modo `controlled` usa uma única chamada ao provider na geração inicial, valida o GraphIR, faz lowering, valida o ProcessSpec e chama os geradores existentes. Falhas não recorrem automaticamente ao pipeline legacy. Refinamentos seguem temporariamente o caminho ProcessSpec atual. O modo `shadow` apenas registra diagnóstico pendente; não duplica chamadas. Os testes simulados comprovam integração de código, mas não substituem a validação semântica com modelo real.
