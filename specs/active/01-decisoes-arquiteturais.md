# ADR-INDEX — Decisões de arquitetura (ativas)

| ID | Decisão | Estado |
| --- | --- | --- |
| ADR-001 | Dois repositórios Git independentes, backend e frontend, sem monorepo | Adotada |
| ADR-002 | Backend Node.js + TypeScript + Fastify; frontend React + TypeScript + Vite | Adotada para bootstrap |
| ADR-003 | `ProcessSpec v1` canônico; BPMN/Form como projeções reprodutíveis | Adotada |
| ADR-004 | LLM só interpreta, propõe e revisa; validadores não confiam em saída do modelo | Adotada |
| ADR-005 | Catálogo de capacidades autoriza tarefas e conectores; sem HTTP/SQL arbitrário | Adotada |
| ADR-006 | AI Gateway configurável: Ollama e APIs externas sob política, sem fallback externo oculto | Adotada; Ollama e adaptador compatível com OpenAI implementados, externo exige aprovação explícita |
| ADR-007 | Infra cloud-agnostic; Kubernetes/Rancher são alvo de deploy opcional, sem SDK cloud nativo | Adotada |
| ADR-008 | PostgreSQL para persistência/revisões; desnecessário para endpoints de geração determinística | Adotada para conversas e revisões |
| ADR-009 | Contrato entre repos via REST + OpenAPI e SSE quando houver geração longa | Adotada em princípio; SSE pendente |
| ADR-010 | Sem publicação, runtime, conectores reais ou dados reais na POC | Adotada |
| ADR-011 | Identidade OIDC/RBAC/tenant e auditoria antes de qualquer exposição corporativa | Obrigatória antes de piloto real |
| ADR-012 | Extração de BusinessIntent com proveniência e compilação por padrões determinísticos; papéis sem binding podem gerar prévia `needs-input`, nunca publicação | Adotada; extensão aditiva de ProcessSpec v1 com `unresolved` e índice de proveniência por hash, sem evidência textual bruta |

## Estado de implementação
Além das APIs determinísticas da Fase 1, a Fase 2 adiciona gateway de providers, seleção de conhecimento versionado, conversas, revisões e persistência PostgreSQL. A aplicação continua local e sem autenticação corporativa.

## O que NÃO está pronto
- Integração Unique/Flowable; autenticação corporativa; publicação; simulador; teste de aceitação com instância/modelo Ollama real.
- A compatibilidade com Flowable ou importação de versões específicas do editor deve ser medida em CI/E2E.
- Não existe escolha definitiva de marca, infraestrutura ou fornecedor de IA.
