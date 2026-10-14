# 07 — Contrato HTTP/SSE para frontend e backend separados

## Autorização

API expõe identidade do autor, tenant e permissões provenientes de autenticador aprovado. Para a POC local, usuário de desenvolvimento fictício; não promover bypass para produção.

## Endpoints sugeridos (v1)

| Endpoint | Requisição | Resposta |
| --- | --- | --- |
| `POST /v1/design-sessions` | targetProfile, projectId? | sessionId, revision=0 |
| `POST /v1/design-sessions/:id/messages` | text, baseRevision, idempotencyKey | generationRunId, status |
| `GET /v1/generation-runs/:runId` | - | pending/generating/validated/needs-input/failed |
| `GET /v1/generation-runs/:runId/events` | SSE opcional | state/progress/completed/error, sem dados sensíveis |
| `GET /v1/design-sessions/:id/draft` | - | ProcessSpec + revision + ETag |
| `POST /v1/design-sessions/:id/revisions` | baseRevision, reviewedProposalId | accepted revision / 409 conflict |
| `POST /v1/process-spec/validate` | ProcessSpec, targetProfile | diagnostics, gates |
| `POST /v1/process-spec/preview` | ProcessSpec, targetProfile | BPMN XML, Form JSON, manifest |
| `GET /v1/ai/providers` | - | provedores permitidos e estado sem segredos |
| `GET /v1/capabilities` | targetProfile | recursos e limites efetivos |

**Notas:** Request/response OpenAPI detalhado virá na implementação. Nunca permitir cliente selecionar outro tenant via body. `idempotencyKey` único por sessão/operação, limite de payload e `If-Match`/baseRevision no aceite. SSE serve a eventos de status; não transmitir raw prompt/secret em logs/streams.

## Estados de geração

`queued -> interpreting -> needs-input OR proposing -> validating -> preview-ready OR validation-failed`; cancelamento preserva última revisão estável. Novas mensagens retomam com histórico resumido e último ProcessSpec aprovado.

## Erros previsíveis

400 input inválido; 401/403 auth; 404 sessão inacessível; 409 revisão concorrente; 413 payload; 422 regras inválidas; 429 cota; 502 provedor; 503 indisponível; 504 timeout. Respostas com `code`, `message`, `diagnostics`, `correlationId` (sem detalhes sensíveis).

## Contratos de preview

Frontend usa artefatos como leitura/edição em componentes bpmn-js e form-js; backend mantém histórico e revisões. Download e exportação identificam `specRevision`, `generatorVersion`, `targetProfile` e checksum para reprodutibilidade.
