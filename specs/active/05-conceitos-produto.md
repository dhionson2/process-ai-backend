# Modelo mental e vocabulário do produto

- **Processo:** representação de uma rotina; possui nome, atividades, atores, dados e fluxos.
- **ProcessSpec:** contrato estruturado canônico, com versão e alvo.
- **Artifact:** projeção BPMN XML / Form JSON; editável na ferramenta adequada, mas não substitui o ProcessSpec canônico sem importador bidirecional implementado.
- **Rascunho:** proposta sem execução e sem publicação.
- **Formulário de início:** captura de dados no Start Event.
- **Formulário de tarefa:** captura de decisão/ação humana na User Task.
- **Gateway:** roteador semântico de decisões/concorrência. Condições são expressões AST, não JavaScript arbitrário.
- **Service task:** declaração de integração com catálogo autorizado; não executa na POC.
- **Conector:** identidade e operação versionadas, associadas a políticas de segurança.
- **Perfil alvo:** `generic-bpmn2` somente preview; `flowable-oss`/`unique-future` exigem homologação de runtime.

## Jornada alvo
Usuário descreve -> IA pede esclarecimentos -> gera ProcessSpec -> valida -> compila BPMN/forms -> revisa manualmente/por chat -> exporta ou submete a aprovação futura.

## Produto e postura
Ferramenta reutilizável, nome próprio PENDENTE. Não chamar a aplicação nem repositório de Unique. Docs originais com nome Unique permanecem apenas como **contexto histórico**.
