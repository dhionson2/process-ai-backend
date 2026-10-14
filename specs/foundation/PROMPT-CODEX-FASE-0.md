# Prompt para Codex — primeira implementação do núcleo (fase 0)

**Pré-condição:** executar na pasta do seu **novo repositório pessoal de backend**. Nunca executar automaticamente em repositórios oficiais do Unique/Softplan.

```text
Atue como arquiteto e desenvolvedor TypeScript sênior. Nossa iniciativa é uma ferramenta independente de modelagem de processos por IA. Os documentos no diretório `fundacao-processos-ia-v1` são a especificação inicial de domínio. Leia README.md, docs/01 a 08, knowledge/, contracts/ e examples/ ANTES de propor mudanças.

Objetivo desta rodada: implementar SOMENTE FASE 0 — contrato ProcessSpec v1, pacote versionado de conhecimento BPMN/Forms, Validation Engine mínimo e testes; NÃO implementar ainda front, provedores de IA, runtime, banco de dados ou infraestrutura.

Requisitos de implementação:
1. Criar no backend Fastify + TypeScript uma separação lógica domain/process-spec, knowledge, validation, capabilities, tests, sem monorepo.
2. Manter o JSON Schema ProcessSpec v1 como contrato formal; adicionar validação de schema com uma biblioteca adequada (AJV ou equivalente), relatório de erro com paths e códigos padronizados.
3. Implementar validações semânticas TDD: IDs, referências, start/end, alcance, grau e rotas de XOR, condições em AST com variáveis existentes e tipos comparáveis, formulários e bindings, operações do catálogo, tenant/policies e gate de preview/approval.
4. Os fixtures fornecidos são **rascunhos fictícios não executáveis**. Preservar suas intenções e escrever casos negativos adicionais; não importar conectores reais ou segredos.
5. Não permitir SQL livre, JavaDelegate arbitrário, scriptTask executável, conexão a endereço externo ou credenciais produzidas pelo LLM.
6. Sem depender de OCI/AWS. Essa fase deve rodar offline com testes.
7. Criar testes automáticos com cobertura dos diagnósticos exigidos e snapshots para casos ouro.
8. Entregar evidências: arquivos criados/modificados, comandos exatos de teste, resultados, limitações e próximos gaps.
9. Não executar `git add`, `git commit`, `git push`, deploy ou publicação. Não modificar repositórios corporativos.
10. Não alterar o contrato ou descaracterizar cenários silenciosamente. Se encontrar inconsistência, documentar e propor delta/versionamento antes de implementá-la.

Critério de aceite: os dois fixtures do kit são aceitos como drafts; mutações negativas são rejeitadas; saída de validação é estável, tipada e reproduzível. Nenhuma chamada real de IA, HTTP ou banco.
```

## Próxima fase, após o aceite da fase 0

Implementar Artifact Generator em TypeScript e testes de importação **real** no `bpmn-js` e `form-js` (usando as versões efetivas escolhidas), depois integrar o primeiro provedor de IA.
