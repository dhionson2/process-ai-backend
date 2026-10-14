# Instruções para agentes de desenvolvimento — Backend

Projeto independente, ainda sem marca definida. **Nunca presumir que o agente está autorizado a editar o Unique oficial.**

## Ordem obrigatória de leitura
1. `README.md` e `specs/INDEX.md`.
2. `specs/active/01-decisoes-arquiteturais.md` e `specs/active/02-plano-de-entregas.md`.
3. `specs/active/03-contrato-integracao.md` e `specs/active/04-seguranca-qualidade.md`.
4. `specs/reference/` para o histórico; no backend, `specs/foundation/` contém os contratos e o conhecimento canônico da POC.
5. `specs/roles/README.md` e role pertinente à tarefa.
6. `specs/tasks/` — trabalhar somente na tarefa solicitada.

## Regras de trabalho
- **Sem `git add`, commit, push, merge ou PR automático**. Sempre relatar arquivos, comandos, testes e pendências.
- Nunca executar alterações em ambiente real/tenant, SQL, notificações ou chamadas HTTP externas decorrentes de prompts da IA.
- Não colocar segredos em código, `.env.example`, logs, exemplos ou prompts.
- Quando faltar contrato, assinalar `PENDENTE` e bloquear comportamento perigoso; não inventar integração.
- Preferir incrementos testáveis com pequena superfície de mudança; não antecipar fases sem solicitação.
- `ProcessSpec` é o contrato canônico; XML BPMN e Form JSON são projeções.
- Modelo de IA não tem permissão de publicação nem execução; validação determinística independente.
- Não criar monorepo/terceiro repositório compartilhado; sincronizar contratos por OpenAPI versionada.
- Não criar dependências nativas AWS/OCI/Azure/GCP. Deployment pode rodar em Kubernetes/Rancher em qualquer nuvem.
- No estado atual: POC local sem autenticação nem dados pessoais reais; **não expor publicamente**.

## Responsabilidade deste repositório
Backend: domínio, contratos, validação, catálogo de conhecimento, geradores e adaptadores de provedores futuros.

## Checklist para cada entrega
- Confirmar critérios de aceite da tarefa.
- Adicionar testes proporcionais ao risco; executar checks disponíveis.
- Marcar explicitamente o que é mock, prévia, parcial ou produção.
- Relatar evidências e riscos residuais, **sem criar commits**.
