# Knowledge — Padrões avançados, anti-padrões e desenho de integrações

Este módulo dá ao LLM exemplos de raciocínio sobre comportamentos mais avançados. **Conhecer** um padrão não implica **suportá-lo** no gerador/runtime inicial.

## Catálogo de padrões

| ID | Quando usar | Desenho BPMN sugerido | Validações | Status |
| --- | --- | --- | --- | --- |
| PAT-01 | Aprovação binária | userTask → XOR → 2 rotas | decisão enum, resultado e motivo | POC |
| PAT-02 | Duas aprovações sequenciais | userTask gestor → userTask diretor | atribuições, ordem, rejeição | POC ampliada |
| PAT-03 | Duas validações independentes | AND split → duas userTasks → AND join | deadlock, reaprovação, sincronização | futuro |
| PAT-04 | Aprovar se orçamento OU risco alto | OR split/join | booleanos e rotas ativas | futuro |
| PAT-05 | Aprovação por ordem de chegada | event-based gateway | tipos corretos de catch events | futuro |
| PAT-06 | Aguardar sistema externo | receiveTask/messageCatch | correlação, timeout, mensagem duplicada | futuro |
| PAT-07 | Escalar tarefa atrasada | boundary timer não interruptivo | duplicidade, calendário e escalonamento | futuro |
| PAT-08 | Cancelar tarefa por prazo | boundary timer interruptivo | caminho alternativo e limpeza | futuro |
| PAT-09 | Erro HTTP retentável | serviceTask → erro boundary/event | retries, idempotência e política de compensação | futuro |
| PAT-10 | Enviar pedido para N usuários | multi-instance userTask | cardinalidade, conclusão e permissão | futuro |
| PAT-11 | Repetir solicitação até corrigir | ciclo com XOR + revisão | condição de saída e limite | futuro |
| PAT-12 | Reutilizar aprovação padrão | callActivity | versão publicada, parâmetro, escopo | futuro |
| PAT-13 | Criar PDF e pedir assinatura | serviceTask doc → userTask assinatura | provedor, signatário, evidências | futuro |
| PAT-14 | Ler HTTP e atualizar banco | serviceTask GET → aprovação humana → serviceTask DB | allowlist, CAS/idempotência, auth | declarativo POC |
| PAT-15 | Manter sistemas consistentes | saga com compensação | side effects, compensação, indisponibilidade | futuro |
| PAT-16 | Decidir por tabela de regras | businessRuleTask / DMN | expressão/regra versionada, autorização | futuro |
| PAT-17 | Criar registro após início | serviceTask database.record.create | duplicidade, tenant, registro auditável | declarativo POC |
| PAT-18 | Atualizar status do pedido | serviceTask database.record.update | WHERE tenant + key, CAS, escopo | declarativo POC |
| PAT-19 | Filtrar/transformar resposta | serviceTask data.transform | expressão fechada, esquema de saída | futuro |
| PAT-20 | Emitir evento para fila | serviceTask queue.publish | schema, tópico, idempotência | futuro |

## Anti-padrões proibidos ou com bloqueio

1. Gateway XOR com duas saídas simultâneas que deveriam ser AND.
2. Gateway baseado em campo de formulário inexistente, ou ainda não produzido na ordem de execução.
3. Tarefa do servidor que implicitamente altera banco real sem perfil de autorização.
4. ServiceTask com endpoint arbitrário ou SQL arbitrário criado pela IA.
5. Falha HTTP ignorada e processo avançando como se houvesse sucesso.
6. Enviar notificação em retries sem chave de idempotência.
7. Misturar dados de solicitantes/tenants em variáveis globais ou contexto de prompt.
8. Reutilizar versão mutável de subprocesso sem pinning/contrato.
9. Usar scriptTask para contornar falta de conector homologado.
10. Declarar processo como publicável só porque o XML faz parse.
11. Confundir `Flowable Enterprise` com recursos comprovados do `Flowable OSS`.
12. Conectar pools diferentes com sequenceFlow; isso deve usar colaboração/messageFlow.
13. Criar 'formulário de gateway' quando a variável deve surgir de userTask anterior.

## Orientação sobre modelagem de ações

Na descrição “quando gestor aprovar, atualiza banco e avisa solicitante”, separar três elementos: gateway (regra), serviceTask update (efeito externo autorizado) e serviceTask notification (outro efeito externo autorizado), com política de erro e sequenciamento explícitos. A IA **não deve** presumir execução atômica entre banco e notificação.

Na descrição “consulta um endpoint”, perguntar por fonte autorizada, dado-chave, resultado esperado e tratamento de 404/erro/timeout se esses dados forem necessários à correção. Endereço exato/segredo não é exigido na conversa; operação real é configurada pelo administrador em catálogo.

Na descrição “atualiza qualquer tabela”, recusar especificação executável genérica, oferecer modelagem declarativa com `operationId` pendente para configuração segura.
