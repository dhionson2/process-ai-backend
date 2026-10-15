# Marco 2 — recuperação da geração conversacional

Execução em 14/10/2026, usando somente descrições fictícias e o endpoint Groq OpenAI-compatible com `openai/gpt-oss-120b`. Foram feitas cinco chamadas sequenciais, sem retries ou fallback, totalizando 21.781 tokens informados pelo provedor. Nenhuma configuração de billing/upgrade foi alterada; o estado comercial da conta Groq não é exposto pela resposta da API e não foi verificado no console.

## Causas confirmadas

1. O material de conhecimento e a saída exigida misturavam interpretação de negócio com configuração operacional e ProcessSpec. O modelo era levado a perguntar por identidades/grupos antes de entregar uma prévia.
2. O orquestrador confiava em `pendingConfiguration.blocking` produzido pelo modelo e podia retornar antes de executar o compilador e o Validation Engine.
3. O fluxo antigo de respostas podia persistir a pergunta do assistente junto com a resposta do usuário sob o papel `user`. Isso contaminava a reconstrução de evidências. Respostas de modelo não devem ser tratadas como declarações do usuário.
4. O compilador de refinamento aceitava apenas nomes de atividades, embora a saída estruturada também referencie IDs canônicos do ProcessSpec. A primeira resposta de refinamento real usou IDs e foi rejeitada como incompleta.
5. O gerador de BPMN serializava IDs de papéis não resolvidos/solicitantes como `candidateGroups`, criando uma atribuição de runtime que não havia sido definida.

## Correções aplicadas

- Interpretação separada em módulo versionado no Knowledge Engine; catálogos técnicos entram somente quando a descrição pede API, HTTP, SQL, banco ou conector explicitamente.
- O compilador deriva perguntas e pendências; flags do modelo não decidem elegibilidade. Papéis sem binding compõem prévias e mantêm publicação bloqueada.
- Resolução determinística de atividade por nome único ou ID canônico. Ambiguidades continuam gerando esclarecimento.
- A resposta estruturada real do quarto passo de C, que expôs o uso de IDs canônicos, virou fixture sanitizada e passou em replay determinístico após a correção.
- BPMN só contém `candidateGroups` para resolução explícita `group` com `groupKey` concreto.
- Histórico legado é apresentado por uma projeção: remove-se a pergunta exata da IA de uma mensagem de usuário quando a resposta confirmada correspondente também está nessa mensagem. Registros do PostgreSQL não são alterados ou apagados.
- O contrato REST/OpenAPI permanece na versão 1.1.0; as 20 operações documentadas estão registradas no Fastify e `/openapi.json` corresponde ao arquivo versionado.

## Evidências reais

| Cenário | Resultado | Chamadas / latência / tokens |
| --- | --- | --- |
| A — férias | BusinessIntent compilado e validado; aprovação encaminha ao RH; reprovação comunica motivo ao servidor; identidade de Servidor/Gestor/RH pendente; publicação bloqueada | 1 / 3.449 ms / 3.684 tokens |
| B — compra administrativa | Funcionário solicita; gestor decide; aprovado chega ao setor de compras; reprovado comunica justificativa ao funcionário; bindings pendentes; publicação bloqueada | 1 / 3.432 ms / 3.552 tokens |
| C — segunda aprovação | Modelo perguntou o papel e a rota de rejeição. Após esclarecimento, uma resposta estruturada usou IDs e revelou a incompatibilidade acima; corrigida a resolução, a nova chamada persistiu revisão 2 sem perder a revisão 1. Diretor ficou sem binding e publicação bloqueada | 3 / 1.452, 2.803 e 2.679 ms / 14.545 tokens |

Todas as propostas passaram no Validation Engine. Os artefatos de A, B e C foram gerados/validados pela API REST real e `/generate` reproduziu BPMN e Form JSON idênticos. A e B criaram revisão 1; C criou revisão 2 com `baseRevision: 1`.

No Chromium, os três BPMNs foram importados e serializados por bpmn-js com zero avisos e diagrama presente. Os seis formulários passaram por form-js Viewer, Editor, exportação e reimportação, sem avisos e preservando as propriedades verificadas.

O PostgreSQL local estava healthy. Após reiniciar a API, draft, histórico, especificações e artefatos foram recuperados; os cinco generation runs foram lidos por endpoint REST. A revisão 1 permaneceu intacta, todos os nós/formulários originais permaneceram idênticos em C, e tentar aceitar com `baseRevision` obsoleto retornou HTTP 409 sem alterar a revisão atual.

## Gates

- `npm run typecheck`: passou.
- `npm test`: 59/59 passaram, incluindo integração histórica, contexto/capacidades, fidelidade dos ramos, replay da resposta Groq real e importações de editor.
- `npm run build`: passou.
- `npm run generate:examples`: passou.
- `npm audit`: zero vulnerabilidades.
- `git diff --check`: passou.
- TypeScript adicional do script de benchmark/testes: passou.

Não foram executadas integrações HTTP/SQL descritas nos processos nem publicação.

## Veredito

- Geração por IA real: **APROVADA** para A, B e C testados.
- Fidelidade semântica: **APROVADA** para os ramos e tarefas explícitos destes cenários; isso não substitui avaliação de linguagem mais ampla.
- Refinamento conversacional: **APROVADO** com esclarecimento, controle de revisão e preservação do conteúdo anterior.
- Integração PostgreSQL: **APROVADA** para persistência/recuperação verificadas.
- Marco 2: **CONCLUÍDO para o escopo desta recuperação**. Publicação dos processos continua bloqueada enquanto papéis não tiverem configuração de runtime garantida.

Os arquivos `report.json`, `chromium-real-import.json`, `persistence-restart.json`, `generation-runs-persistence.json`, `semantic-evidence.json`, os snapshots das cinco respostas estruturadas e os BPMN/Form JSON estão nesta pasta. Os prompts completos não são guardados nos snapshots; eles são representados por tamanhos e hashes.
