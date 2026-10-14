# ADR-INDEX — Decisões de arquitetura (ativas)

| ID | Decisão | Estado |
| --- | --- | --- |
| ADR-001 | Dois repositórios Git independentes, backend e frontend, sem monorepo | Adotada |
| ADR-002 | Backend Node.js + TypeScript + Fastify; frontend React + TypeScript + Vite | Adotada para bootstrap |
| ADR-003 | `ProcessSpec v1` canônico; BPMN/Form como projeções reprodutíveis | Adotada |
| ADR-004 | LLM só interpreta, propõe e revisa; validadores não confiam em saída do modelo | Adotada |
| ADR-005 | Catálogo de capacidades autoriza tarefas e conectores; sem HTTP/SQL arbitrário | Adotada |
| ADR-006 | AI Gateway configurável: Ollama e APIs externas sob política, sem fallback externo oculto | Diretriz adotada; implementações pendentes |
| ADR-007 | Infra cloud-agnostic; Kubernetes/Rancher são alvo de deploy opcional, sem SDK cloud nativo | Adotada |
| ADR-008 | PostgreSQL previsto para persistência/revisões; **não necessário no bootstrap** | Proposta futura |
| ADR-009 | Contrato entre repos via REST + OpenAPI e SSE quando houver geração longa | Adotada em princípio; SSE pendente |
| ADR-010 | Sem publicação, runtime, conectores reais ou dados reais na POC | Adotada |
| ADR-011 | Identidade OIDC/RBAC/tenant e auditoria antes de qualquer exposição corporativa | Obrigatória antes de piloto real |

## O que existe no bootstrap
API somente leitura dos exemplos, `/health` e POST de validação inicial, sem banco, provider ou geração LLM.

## O que NÃO está pronto
- Integração Unique/Flowable; autenticação corporativa; publicação; persistência; provedor de IA; simulador.
- A compatibilidade com Flowable ou importação de versões específicas do editor deve ser medida em CI/E2E.
- Não existe escolha definitiva de marca, infraestrutura ou fornecedor de IA.
