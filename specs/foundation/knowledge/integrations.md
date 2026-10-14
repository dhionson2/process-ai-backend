# Knowledge — Conectores, ações técnicas e efeitos externos

## Separação inegociável

A camada de autoria da IA pode **modelar** ações externas. Ela NÃO pode executá-las. Cada ação do ProcessSpec referencia uma operação registrada num catálogo autorizado. A execução, no futuro, acontece por workers/adaptadores integrados ao motor BPM, após publicação e autorização.

## Catálogo lógico extensível

| Capacidade | Exemplo | Riscos e regras |
| --- | --- | --- |
| `http.request` | GET cadastro; POST solicitação; PATCH status | URL/host permitido, método e rota por operationId, auth em secret store, SSRF, retries e idempotência |
| `database.record.read` | Buscar registro por chave | datasource registrado, tenant/row scope, projeção de campos e limite de linhas |
| `database.record.create` | Incluir item em tabela de negócio | template de operação parametrizado, validação de payload, idempotência |
| `database.record.update` | Atualizar status de pedido | operação nominada, colunas autorizadas, pré-condição/version/CAS, nenhuma instrução SQL livre |
| `database.record.delete` | Excluir ou remover item | **desabilitado por padrão**; aprovação específica, soft-delete quando aplicável |
| `notification.send` | E-mail/aviso 1Doc | canal de saída autorizado, destinatário validado, dados sensíveis filtrados |
| `document.generate` | Gerar PDF/documento | template permitido, proveniência e versão; não inventar assinatura digital |
| `document.sign.request` | Solicitar assinatura | provedor e identidade autorizados, revisão obrigatória |
| `queue.publish` | Enviar evento | tópico autorizado, schema validado, chave de idempotência |
| `data.transform` | Formatar/agrupar valores | expressão declarativa fechada, sem eval/script arbitrário |
| `process.call` | Invocar outro fluxo | versão alvo conhecida, controle de ciclos e permissões |
| `rules.evaluate` | Avaliar tabela de regras | motor/regra versionado; opção DMN só se suportada |
| `timer.schedule` | Aguardar prazo | relógio, fuso, DST, calendário e cancelamento |
| `file.store` | Salvar anexo | classificação, antivírus, tamanho, retenção e permissões |
| `human.approval` | Tarefa de aceite humano | RBAC, forma de rejeição, deadlines e trilha auditável |

## Contrato de ação

`action = { capability, connectorId, operationId, inputMapping, outputMapping, timeoutMs, retryPolicy, idempotencyKey, sideEffectLevel }`.

`connectorId + operationId` identifica **operação aprovada previamente**. Não é endereço URL arbitrário, nome de tabela arbitrário nem texto SQL.

Exemplo: `database.record.update` para `rh/vacationRequests.setStatus` recebe `{requestId, status}` e devolve `{updated, version}`. O runtime sabe a fonte, credencial, statement parametrizado e isolamento do tenant. O LLM só recebe o nome, parâmetros tipados e resumo não sensível.

## Política para efeitos externos

1. POC modela serviços em BPMN não executável, sem credenciais.
2. Runtime futuro verifica publicação e autorização por tenant e operação.
3. Side effects sensíveis requerem aprovação administrativa na configuração e, quando apropriado, tarefa humana no fluxo.
4. `DELETE`, pagamento, assinatura, alterações de autoridade, transferência de dados e integrações sensíveis requerem policy específica.
5. Timeouts e retries somente para operações idempotentes; write deve carregar idempotency key, verificação CAS, outbox ou mecanismo equivalente.
6. Nunca interpolar entradas do usuário em SQL executável, URL/headers arbitrários ou shell.
7. Endpoint allowlist e proteção SSRF, inclusive bloqueio de metadados de nuvem, IPs privados não autorizados e redirects externos.
8. Falhas geram evento de erro/compensação/tarefa humana, não sucesso silencioso.
9. Runtime BPMN de destino precisa comprovar implementações disponíveis, especialmente Flowable OSS vs enterprise.
