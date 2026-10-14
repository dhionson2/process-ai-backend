# Contrato entre frontend e backend

## Contrato atual — bootstrap
Base URL desenvolvimento: `http://127.0.0.1:3333`

| Método | Rota | Retorno | Estado |
| --- | --- | --- | --- |
| GET | `/health` | `{status, service, version}` | Implementado |
| GET | `/api/v1/capabilities` | perfil, tipos permitidos, restrições | Implementado |
| GET | `/api/v1/examples` | array de `{id, name, description}` | Implementado |
| GET | `/api/v1/examples/:id` | `{spec, bpmnXml, forms, manifest}` | Implementado; fixtures estáticas |
| POST | `/api/v1/validate` | `{valid, diagnostics}` | Parcial: JSON Schema + conjunto inicial de semântica |

O catálogo de exemplos está em `specs/foundation/examples/` no backend. São cenários fictícios e nunca são executados.

## Planejado, NÃO implementado
- `POST /api/v1/projects` e `GET /api/v1/projects/:id` — criar/ler rascunhos persistidos.
- `POST /api/v1/generations` — geração assíncrona; resposta com ID da job.
- `GET /api/v1/generations/:id/events` — SSE com estados progressivos.
- `POST /api/v1/projects/:id/revisions` — revisão com controle otimista da versão.
- `GET /api/v1/providers` — modelos disponíveis conforme política (sem expor secrets).
- `GET /openapi.json` — documentação formal (pendente).

## Convenções obrigatórias para evolução
- UTC ISO8601, versão explícita de esquema (`schemaVersion`), corpo limitado e erros com código + mensagem.
- Nunca enviar chave de API no browser; usar serviço backend.
- 401/403 para autenticação/autorização; 409 para conflito de revisão; 422 para validação.
- Prefixar rotas públicas em `/api/v1`; compatibilidade e versionamento negociados via contrato OpenAPI.
- `ProcessSpec` pertence ao backend; frontend apresenta documentos sem assumir regras de execução.
