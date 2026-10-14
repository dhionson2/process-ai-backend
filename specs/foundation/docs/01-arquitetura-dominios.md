# 01 — Arquitetura do núcleo de modelagem

## Visão de alto nível

```text
[React: chat/diagram/forms] <--- REST + SSE ---> [Fastify API]
                                                  | auth/RBAC/tenant
                                                  | draft/revisions/concurrency
                                                  v
   [Knowledge Pack versionado] -> [AI Orchestrator + Model Gateway]
                                                  | structured result
                                                  v
                                        [ProcessSpec v1 + provenance]
                                                  |
                                        [Validation Engine]
                                          |     |     |
                                syntax+graph  forms  policy/capability
                                                  |
                                        [Artifact Generator]
                                          |           |
                                     BPMN+DI      Forms JSON
                                          \           /
                                           [Preview/editor]
                                                  |
                                          [Human review]
                                                  |
                               [Future adapter to Unique, guarded]
```

## Agregados e fronteiras

**DesignSession:** mensagens, intenção do usuário, referências, tenant, provedor/modelo, custo, `sessionId`, estado e revisão corrente. Nunca confundir uma mensagem nova com autorização para sobrescrever revisão anterior.

**ProcessDraft:** ProcessSpec canônico, `revision`, checksum, estado (`draft/needs-input/invalid/ready-for-review/approved`) e metadados de proveniência das sugestões. Atualizações com controle otimista por `baseRevision` e diff tipado.

**KnowledgePack:** corpus curado, `knowledgeVersion`, regras normativas, perfis de destino, exemplos ouro e decisões editoriais. Muda com review e testes de regressão, não como efeito colateral de uma conversa.

**ProviderConfig:** provider/model, limites, capacidades declaradas (JSON schema/tool use/contexto), credenciais referenciadas no secret manager genérico, política de transferência de dados e custo medido.

**CapabilityCatalog:** ações possíveis de modelar; um subconjunto aprovado pode ser materializado em operações de runtime depois. Operações diferentes (e.g., `http.request` e `database.record.update`) têm contratos e autorizações diferentes.

**GenerationRun:** pedido, resposta estruturada, métricas, erros, custos, hashes de artefatos, `knowledgeVersion`, `modelId`, `targetProfile` e validações.

## Fluxo de geração (previsível)

1. API autoriza autor e tenant e seleciona política de provedor.
2. Sanitiza/metadados da descrição; escolhe fragmentos do KnowledgePack por intenção, complexidade e perfil de destino.
3. LLM retorna `need_clarification` ou `proposed_spec` conforme schema tipado.
4. Backend valida JSON/ProcessSpec; se houver erro reparável, faz **no máximo 1** tentativa de reparo com diagnósticos minimizados.
5. Validador produz `blockers`, `warnings`, `information` e `requiresHumanReview`.
6. Geradores produzem BPMN XML/DI + forms JSON somente se estrutura mínima válida.
7. Backend armazena proposta imutável e diff; frontend apresenta ao autor.
8. Autor revisa/aprova; nada é publicado nem executado neste núcleo.

## Fluxo de ajuste conversacional

- LLM produz proposta de modificação de ProcessSpec (preferência por patch tipado com IDs estáveis) + resumo das alterações.
- Backend verifica `baseRevision` e precondições do patch; aplica em cópia.
- Valida todo grafo e regeneração de artefatos. Se inválido, revisão anterior permanece canônica.
- Mostra comparação semântica: tarefas adicionadas/removidas, responsáveis, campos e condições modificadas, conectores e efeitos externos.
- Aprovação humana grava nova revisão. Edições manuais no editor requerem importação/reconciliação ou mecanismo explícito de fonte de verdade para evitar perda de alterações.

## Decisão sobre edição manual

**Estratégia proposta:** ProcessSpec é a fonte de verdade para conteúdos modelados; edições diretas do BPMN/Form JSON não podem ser sobrescritas silenciosamente. Para a POC, permitir importação reversa apenas do subconjunto suportado, ou tratar mudança visual como revisão com aviso de incompatibilidade. A implementação de round-trip universal de BPMN é uma fase separada.

## Operação de baixo custo

- API stateless, PostgreSQL para rascunhos e jobs se processamento assíncrono tornar-se necessário.
- Não instalar RAG vetorial antes de provar necessidade; conhecimento com módulos curtos e seleção determinística.
- Separar inferência Ollama por capacidade, sem colocar pesos no pod da API.
- Sem GPU/worker dedicado obrigatório para desenvolvimento.
- Provedores por adaptador, sem lock-in de cloud.
