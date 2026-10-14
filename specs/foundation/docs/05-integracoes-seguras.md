# 05 — Conectores de execução, API e banco (projeto de domínio)

## Modelo de integração

- **Autor/LLM:** descreve que precisa fazer, sem autoridade para executar.
- **Capability Catalog:** expõe ao LLM apenas nomes e assinaturas de ações que a organização autorizou modelar.
- **Connector Registry:** administrado por operador (endpoint base, autenticação, query template, quotas, schemas de entrada/saída), sem credenciais em ProcessSpec.
- **Runtime Worker (futuro):** executa ações somente em instâncias autorizadas, auditadas e publicadas; valida tenant, usuário-ator e permissões downstream.

## Endpoints HTTP

Contrato pré-cadastrado: `operationId=people.lookup`, `method=GET`, `baseUrlKey=people-service`, `pathTemplate=/people/{id}`, `inputSchema`, `outputSchema`, `timeout`, `allowedStatusCodes`, `retry/idempotency`, `authPolicy`.

LLM apenas modela `http.request + people-service + people.lookup + inputMapping`. Não escolhe hostname/IP livre; saída `httpResponse` deve ser normalizada, limitada e tratada como não confiável.

## Banco de dados

Contrato pré-cadastrado: `operationId=vacation.setStatus`, datasource `hr-db`, tabela lógica `vacation_requests`, `allowedColumns=[status]`, filtro obrigatório por `tenantId` e `requestId`, CAS por `version`, statement parametrizado controlado pelo backend.

LLM modela parâmetros `{requestId: <var>, status: <literal approved>}`. O worker controla conexão, transação, isolamento, auditoria, erros e commits. Nada de `SELECT *`, `DROP TABLE`, query arbitrária, schema discovery do banco ou acesso ao catálogo de tabelas sensíveis.

**Por que isso importa:** SQL parametrizado protege injeção de valor, mas não autoriza automaticamente tabelas, colunas, operação nem tenant. Precisamos de **allowlist de operação inteira**, privilégios mínimos e verificação de autorização no destino.

## Side-effects e reentrância

- GET/read: pode ser repetível, mas limite e dados sensíveis importam.
- POST/create: idempotency-key gerada do `processInstanceId + nodeId + logicalAttempt`; saída com externalResourceId.
- PATCH/UPDATE: condição version/CAS e garantia de operação em linha do tenant; repetição controlada.
- DELETE: bloqueada na primeira versão; política explicitamente configurada no futuro.
- E-mail/notificação: evitar envios duplicados após retry, de preferência com outbox idempotente.
- Timeouts: distinguir sucesso incerto de falha; antes de reenviar writes consultar estado/idempotency log.
- Compensação: modelar explicitamente para efeitos não transacionais, sem prometer rollback global.

## Regras não delegáveis ao LLM

Autorização, credenciais, namespaces, seleção de conectores reais, política de saída de rede, limites de payload, rate limits, retries, proteção SSRF, circuit breaker, idempotência, rastreabilidade e publicação.

## Relação com a 1Doc

A integração oficial futura precisa seguir a fronteira definida pelo produto: o motor orquestra e a 1Doc executa operações documentais/autorização. Não assumir que o AI Designer terá direito de escrever diretamente na base de dados da 1Doc. APIs oficiais e adaptadores homologados são preferíveis a SQL direto.
