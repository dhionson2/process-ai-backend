# Fundação Técnica v1 — Modelagem de Processos com IA

**Data:** 2026-10-14 · **Estado:** proposta de arquitetura de domínio e contratos, NÃO implementação aprovada nem integração oficial ao Unique.

Este kit especifica os **quatro pilares** da solução: Knowledge Engine, ProcessSpec, Validation Engine e Artifact Generator. Inclui requisitos para automações HTTP, operações de registros em banco, notificações, eventos e processos complexos, sem permitir que o LLM execute efeitos reais.

## Navegação

| Leitura | Conteúdo |
| --- | --- |
| `docs/01-arquitetura-dominios.md` | Fronteiras, módulos, responsabilidades e ciclo de alteração |
| `docs/02-processspec-v1.md` | Contrato de domínio, versionamento, nós, expressões, formulários |
| `docs/03-validation-engine.md` | Pipeline de validação, códigos de erro e matrizes de testes |
| `docs/04-artifact-generator.md` | Geração BPMN XML/BPMNDI, form-js JSON, adapters de runtime |
| `docs/05-integracoes-seguras.md` | Catálogo de conectores para HTTP, banco de dados e automações |
| `docs/06-ia-conhecimento-custo.md` | Injeção de conhecimento, provedores e otimização de tokens |
| `docs/07-api-e-jornadas.md` | API REST, SSE, estados, revisão e concorrência |
| `docs/08-mvp-e-avaliacao.md` | Fases de implementação e evidência de qualidade |
| `knowledge/bpmn-20.md` | Conhecimento semântico dos elementos BPMN 2.0.2 |
| `knowledge/forms.md` | Conhecimento form-js, formulários e vínculos com variáveis |
| `knowledge/integrations.md` | Conhecimento de ações, regras e exceções |
| `knowledge/system-policy.md` | Política de raciocínio/saída para qualquer provedor de IA |
| `contracts/process-spec.v1.schema.json` | JSON Schema para ProcessSpec v1 |
| `contracts/generation-result.v1.schema.json` | Contrato de resposta de IA para esclarecimento/proposta |
| `examples/*.json` | Cenários ouro de férias, HTTP e atualização autorizada em registro |
| `scripts/check_examples.py` | Verificação básica offline de schema e semântica (referência) |
| `scripts/reference_generator.py` | Geração experimental offline de BPMN + form JSON para fixtures (não é produção) |

## Princípios inegociáveis

1. **Projetar ≠ executar**: o LLM não possui credenciais, SQL, shell, rede ou permissão para executar ações.
2. O ProcessSpec é a **única representação editável de domínio**; BPMN XML/Form JSON são projeções geradas.
3. Fluxo gerado é **rascunho**, não executável até passar em validação e publicação humana/autorizada.
4. Formulários, expressões, configurações e conectores são checados fora do LLM.
5. Suporte a capacidades é **por perfil de destino e versão**; um elemento BPMN existir na norma não prova que o runtime atual o execute.
6. Sem dependências obrigatórias de OCI/AWS; distribuição por contêineres, dois repositórios futuros independentes (frontend e backend).
7. A POC usa dados fictícios e não interage com infraestrutura de clientes.

## Como explorar os exemplos

```bash
python -m pip install jsonschema
python scripts/check_examples.py
python scripts/reference_generator.py
```

Isso testa apenas os contratos de exemplo e gera artefatos de **prévia**. Não valida importação no browser nem execução Flowable; estes são testes obrigatórios na implementação TypeScript.

## Referências

- OMG BPMN 2.0.2: https://www.omg.org/spec/BPMN/
- Flowable OSS BPMN: https://www.flowable.com/open-source/docs/bpmn/ch07b-BPMN-Constructs/
- form-js schema: https://github.com/bpmn-io/form-js/blob/develop/docs/FORM_SCHEMA.md
- form-js viewer/editor: https://github.com/bpmn-io/form-js
- OWASP LLM06 Excessive Agency: https://genai.owasp.org/llmrisk/llm062025-excessive-agency/
- PRD Unique (contexto, não contrato de implementação): https://1doc.atlassian.net/wiki/spaces/TECK/pages/3113484291
- M7 Unique: https://1doc.atlassian.net/wiki/spaces/TECK/pages/3305046022

## Início do desenvolvimento

- Consulte `PROMPT-CODEX-FASE-0.md` para a implementação da primeira rodada no backend, sem commits automáticos.
- O próximo repositório frontend poderá consumir um contrato OpenAPI gerado pelo backend; não crie repositório compartilhado/monorepo.

## Evidências geradas neste kit

- Dois ProcessSpecs de exemplo passam no **JSON Schema Draft 2020-12** e nas checagens semânticas parciais do script.
- Seis mutações negativas são rejeitadas com códigos esperados.
- Cada exemplo gera BPMN XML **bem formado** com BPMNDI para todos os nós e fluxos, e formulários JSON preliminares.
- **Lacunas declaradas:** a obrigatoriedade condicional de `reason` no formulário de gestor ainda não é compilada na referência; o manifest sinaliza isso. Nenhum arquivo foi testado dentro do editor bpmn-js/form-js em browser nem submetido à engine Flowable. **Não utilizar em produção.**
