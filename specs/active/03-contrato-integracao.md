# Contrato entre frontend e backend

## Contrato atual — backend
Base URL desenvolvimento: `http://127.0.0.1:3333`

| Método | Rota | Retorno | Estado |
| --- | --- | --- | --- |
| GET | `/health` | `{status, service, version}` | Implementado |
| GET | `/api/v1/capabilities` | perfil, tipos permitidos, restrições | Implementado |
| GET | `/api/v1/examples` | array de `{id, name, description}` | Implementado |
| GET | `/api/v1/examples/:id` | `{spec, bpmnXml, forms, manifest}` | Implementado; fixtures estáticas |
| POST | `/api/v1/validate` | `{valid, diagnostics}` | JSON Schema 2020-12 e semântica v1 para o subset POC |
| POST | `/api/v1/generate` | `{bpmnXml, forms, manifest, diagnostics}` | Implementado; BPMN/Form determinísticos e preview-only; aviso para regras externas |
| POST | `/api/v1/validate-form` | `{valid, diagnostics}` | Aplica regras required/requiredWhen canônicas do ProcessSpec |
| POST | `/api/v1/publication/validate` | `{publishable, checks, blockers}` | Simulação; 422 se runtime não garantir regras condicionais; não publica |
| POST | `/api/v1/projects` | `{projectId, sessionId, status, currentRevision}` | Cria projeto e sessão em PostgreSQL |
| GET | `/api/v1/design-sessions/:id` | estado, revisão atual, questões | Implementado |
| POST | `/api/v1/design-sessions/:id/messages` | pergunta ou proposta, `generationRunId` | Síncrono; provider configurado no backend; `baseRevision` obrigatório |
| POST | `/api/v1/design-sessions/:id/answers` | resultado do turno conversacional | Responde questões pendentes |
| POST | `/api/v1/design-sessions/:id/refinements` | resultado do turno conversacional | Propõe revisão sem substituir a atual |
| GET | `/api/v1/design-sessions/:id/history` | `{messages}` | Histórico persistido |
| GET/PUT | `/api/v1/design-sessions/:id/draft` | sessão, revisão, ProcessSpec e artefatos | PUT cria proposta manual validada, exige `baseRevision` |
| GET | `/api/v1/design-sessions/:id/revisions` | `{revisions}` | Lista revisões |
| GET | `/api/v1/design-sessions/:id/revisions/:revision` | ProcessSpec e artefatos | Recupera revisão |
| POST | `/api/v1/design-sessions/:id/revisions/:revision/accept` | revisão aceita | Controle otimista; 409 se `baseRevision` ficou obsoleta |
| GET | `/api/v1/generation-runs/:id` | estado, resultado e métricas | Geração e uso persistidos |
| GET | `/api/v1/design-sessions/:id/understanding` | fatos confirmados, perguntas pendentes, visão de negócio da revisão mais recente | Somente leitura (1.2.0); origem de cada item via `requirementProvenance` |
| GET | `/api/v1/design-sessions/:id/telemetry` | custo, tokens, cache, latência e etapas por turno | Somente leitura (1.2.0); sem prompts; `costUsd` null quando o provedor não informa |
| GET | `/api/v1/evaluation/scoreboard` | placar da avaliação offline por provider/modelo | Somente leitura (1.2.0); 404 sem avaliação; specs omitidos |
| GET | `/api/v1/generation-runs/:id/events` | SSE: `stage`, depois `result` ou `error` | 1.3.0; usado com `Prefer: respond-async` nos POSTs de turno (202); barramento em processo, instância única |
| PUT | `/api/v1/design-sessions/:id/requirements/:requirementId` | item do ledger | 1.4.0; veredito `confirmed`/`rejected`/`proposed` |
| GET | `/api/v1/design-sessions/:id/revisions/:revision/diff` | `{from, to, changes, totals}` | 1.4.0; diff de negócio; `?against=` opcional |
| POST | `/api/v1/design-sessions/:id/revisions/:revision/restore` | nova revisão proposta | 1.4.0; desfazer sem apagar histórico; exige `baseRevision` |
| GET | `/openapi.json` | OpenAPI 3.1, `info.version=1.4.0` | Fonte em `specs/contracts/process-ai-api.v1.openapi.json`; injeta schema ProcessSpec canônico |

`POST /api/v1/generate` retorna 200 para ProcessSpec válido e gera prévia mesmo quando há `requiredWhen`: o Form JSON mantém o campo opcional para form-js e aplica `conditional.hide` apenas à apresentação. A resposta inclui aviso `EXTERNAL_FORM_VALIDATION_REQUIRED` e manifest que marca artefato válido para prévia, validação externa necessária e publicação inelegível. A regra canônica continua em ProcessSpec e deve ser aplicada por `POST /api/v1/validate-form` antes de aceitar cada submissão. `@bpmn-io/form-js-viewer` 2.1.1 não garante `requiredWhen`.

Desde 1.3.0, `POST /messages`, `/answers` e `/refinements` aceitam `Prefer: respond-async`: respondem 202 `{generationRunId, status: 'generating'}` assim que o run existe e o progresso segue por SSE. Sem o cabeçalho continuam síncronos.

Desde 1.2.0, erros (`ApiError`) e turnos `validation-failed` trazem `recovery` opcional: categoria, título, mensagem para a pessoa usuária e ações sugeridas (`answer`, `rephrase`, `retry`, `wait`, `shorten`, `reload`, `contact-admin`). O campo `code` continua sendo o contrato para máquinas.

`POST /api/v1/publication/validate` é somente uma simulação de guarda. Recebe `spec` e `runtimeCapabilities.conditionalFormValidation`; responde 422 se houver regra `requiredWhen` sem garantia declarada pelo runtime. Não publica processos. A publicação real está desabilitada nesta fase.

O catálogo de exemplos está em `specs/foundation/examples/` no backend. São cenários fictícios e nunca são executados.

## Ainda não implementado
- `GET /api/v1/projects/:id` — leitura de projeto por ID.
- Geração assíncrona e SSE (`/api/v1/generation-runs/:id/events`). Turnos atuais são síncronos e limitados por timeout.
- `GET /api/v1/providers` — capacidade/modelos sem expor secrets.
- Autenticação OIDC, autorização e resolução de tenant por identidade; configuração atual usa tenant local do servidor.

## Convenções obrigatórias para evolução
- UTC ISO8601, versão explícita de esquema (`schemaVersion`), corpo limitado e erros com código + mensagem.
- Nunca enviar chave de API no browser; usar serviço backend.
- 401/403 para autenticação/autorização; 409 para conflito de revisão; 422 para validação.
- Prefixar rotas públicas em `/api/v1`; compatibilidade e versionamento negociados via contrato OpenAPI.
- `ProcessSpec` pertence ao backend; frontend apresenta documentos sem assumir regras de execução.
- CORS de desenvolvimento vem de `CORS_ORIGIN` no backend; padrão `http://localhost:5173`.
- Com `openai-compatible`, mensagens/respostas/refinamentos exigem `dataClassification` igual a `synthetic` ou `public`. O modo padrão continua sem provider externo.
