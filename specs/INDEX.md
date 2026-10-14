# Índice das especificações — Backend

## Fonte de verdade e precedência
1. Decisões ativas em `active/` (mais recentes, substituem recomendações conflitantes em referências históricas).
2. Contratos e políticas da fundação técnica v1; backend: `foundation/` completo; frontend: amostras em `reference/foundation/`.
3. SDD de produto e documento de arquitetura **históricos** em `reference/`.
4. Tarefas em `tasks/` detalham somente uma entrega e não alteram decisões globais implicitamente.

## Atenção à infraestrutura
O documento de arquitetura original menciona a OCI pelo contexto da época. A decisão atual é **neutralidade total de provedor**: Kubernetes/Rancher é somente um alvo de implantação; nenhum serviço OCI/AWS é dependência funcional.

## Navegação
- `active/01-decisoes-arquiteturais.md` — ADRs confirmadas e pendentes.
- `active/02-plano-de-entregas.md` — 3 fases backend, 2 frontend, 3 marcos integrados.
- `active/03-contrato-integracao.md` — endpoints atuais e planejados.
- `active/04-seguranca-qualidade.md` — proibições, aceites, gates.
- `active/05-conceitos-produto.md` — vocabulário, jornadas, fronteira design/execução.
- `tasks/README.md` — como iniciar a implementação sem abrir muitas etapas.
- `roles/` — responsabilidades de produto, arquitetura, AI, desenvolvimento e QA.
- `reference/` — documentos integrais anteriores e contratos de referência.
- `foundation/` — 34 arquivos originais preservados (ignorando cache bytecode).
