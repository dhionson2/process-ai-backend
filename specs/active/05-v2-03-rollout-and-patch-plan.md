# V2-03 — rollout, migração e marcos seguintes

Status deste documento: plano técnico. Não ativa GraphIR em rotas, providers, persistência ou geração padrão.

## Estado entregue nesta execução

- GraphIR V1 é um contrato interno plano com schema executável, referências estáveis, requisitos e proveniência minimizada.
- O validator separa estrutura, semântica e cobertura. Condições numéricas de XOR reutilizam a validação determinística existente.
- O lowering para ProcessSpec V1 é uma biblioteca experimental explícita. Só certifica `generic-bpmn2`, exige papéis resolvidos e valida a saída pelo validador canônico.
- G03 é montado manualmente a partir da fixture determinística para provar equivalência estrutural, inclusive os dois ciclos independentes. Isso não mede interpretação por provider.
- O caminho legacy, OpenAPI e geração pública não mudaram. Shadow mode e geração de GraphIR por provider ainda não existem.

## Fronteiras de representação

| Representação | Responsabilidade | Identidade e evidência | Situação |
| --- | --- | --- | --- |
| `BusinessIntent` | Intenção de negócio interpretada, atores, regras, fatos e lacunas | Evidência semântica e proveniência de conversa | Entrada semântica atual |
| `ProcessPlan` | Plano atual produzido pelo provider | Ainda recursivo em `steps`; não é grafo canônico | Caminho atual de geração |
| `GraphIRV1` | Controle de fluxo plano, variáveis, papéis, formulários e requisitos | IDs estáveis; provenance sem texto bruto | Contrato interno validado |
| `ProcessSpec v1` | Contrato canônico de rascunho e geração | Chaves e referências exigidas pelos geradores | Contrato público atual |
| BPMN XML / Form JSON | Artefatos derivados para visualização e edição | Derivados de ProcessSpec validado | Projeções existentes |

O estado persistido da conversa (mensagens, respostas, pergunta pendente, runs e revisões) permanece no domínio de continuidade. Não deve ser duplicado no GraphIR. BPMNDI, permissões de execução e texto integral do usuário também não pertencem a essa representação.

## Matriz inicial de migração para saída estruturada de provider

| Campo | Fonte de verdade futura | Regra de migração |
| --- | --- | --- |
| IDs de processo, nós, arestas, papéis, variáveis e formulários | GraphIR | Estáveis e sem dependência de labels; não criar identidade a partir da posição no array |
| `requirementRefs` e requisito obrigatório | Requirement Ledger / BusinessIntent reconciliado | Cada atividade, decisão, loop, consequência e condição obrigatória deve manter vínculo verificável |
| `provenance` | Proveniência semântica validada | Permitir somente enums, referência opaca e hash; excluir texto bruto e segredos |
| condições AST | Fatos e regras confirmados | Operadores e valores tipados; sem alteração de `>` para `>=` ou inferência silenciosa |
| referências de variável | Declarações GraphIR | Condições usam IDs GraphIR; adapter converte para as chaves de ProcessSpec |
| papel `unresolved` | Resolução conversacional | Preservar como lacuna; não atribuir grupo arbitrário nem baixar enquanto faltar a pergunta de configuração exigida |
| `serviceTask` | Catálogo de conectores e políticas | Somente declarativa; validação do catálogo antes do lowering; nunca executar durante compilação |
| artefatos e estado de sessão | Backend | Permanecem sob validação, revisão e persistência existentes |

Um schema estruturado para provider deve ser derivado do schema interno fechado e versionado, mas não copiado sem adaptação. Limites de tamanho e profundidade precisam ser aceitos pelo provider escolhido e revalidados pelo AJV local. Resposta válida pelo JSON Schema não é prova de correção semântica ou cobertura.

## Estratégia proposta para feature flag, comparação shadow e rollback

1. Manter `GraphIR` desativado por padrão. O primeiro consumidor deve ser um opt-in de homologação por configuração local, sem rota pública adicional.
2. Alimentar o mesmo `BusinessIntent` confirmado aos dois caminhos, sem enviar texto a um segundo provider e sem executar integrações.
3. Rodar validator e lowering isolados. O caminho legacy continua sendo o único resultado entregue ao usuário.
4. Comparar projeções estruturais normalizadas: IDs/requisitos, tipos de elemento, papéis, bindings, condições, destinos de loops e ramos terminais. Não comparar XML bruto nem usar igualdade textual como critério.
5. Registrar apenas versão de schema, contagens, códigos de diagnóstico, resultado por regra e hashes não reversíveis. Nunca armazenar texto da conversa, valores de formulário ou saída integral no log shadow.
6. Separar métricas de `invalid`, `unsupported`, `incomplete`, `divergent` e `equivalent`. Um erro do shadow não deve alterar a geração legacy nem ser convertido em sucesso.
7. Exigir corpus golden, testes de contrato e revisão dos casos divergentes antes de qualquer experimento opt-in com provider estruturado.
8. Rollback consiste em desligar a flag local e remover o consumidor shadow. Como a saída shadow não é persistida nem publicada, não exige migração de dados.

Critérios para considerar um futuro shadow útil: cobertura explícita do corpus e métricas agregadas; divergências reproduzíveis sem conteúdo sensível; nenhuma chamada extra a provider; nenhuma mudança no resultado legacy; rota de desligamento exercitada.

## V2-04 GraphPatch — plano de testes

GraphPatch deve ser uma lista tipada de operações com precondições, IDs estáveis e revisão base. O patch é aplicado em cópia, validado integralmente e aceito de forma atômica. Operação desconhecida, referência ausente, conflito de revisão ou cobertura quebrada deve rejeitar todo o patch.

Casos mínimos:

- inserir, renomear e remover nó sem apagar requisitos ou conexões implicitamente;
- adicionar e remover aresta com validação de origem, destino, gateway e requisito;
- mover tarefa e preservar ambos os extremos de ciclos;
- editar condição numérica mantendo operador e domínio;
- rejeitar IDs duplicados, referências dangling, gateways inválidos e desconexão de start/end;
- rejeitar remoção de requisito obrigatório e provar que nó inventado fica sem cobertura;
- duas operações concorrentes na mesma revisão: uma aplica; a outra recebe conflito sem efeito parcial;
- aplicação repetida por `operationId` é idempotente;
- comparar requisito, grafo normalizado e artefatos gerados antes/depois;
- nenhuma operação executa `serviceTask` ou publica BPMN.

Não introduzir GraphPatch antes de estabilizar a identidade e cobertura GraphIR V1 e decidir como os requisitos são atualizados em correções confirmadas pelo usuário.

## V2-05 FormPatch — plano de testes

FormPatch deve usar identidade estável `formRef + fieldKey`, preservar bindings GraphIR e passar pelo validador canônico de formulários após aplicação atômica.

Casos mínimos:

- incluir, editar e remover campo com binding existente;
- manter `required`, `visibleWhen`, `requiredWhen`, opções, tipo e sensibilidade;
- validar que uma condição referencia variável e operador compatíveis;
- rejeitar remoção de campo usado em gateway, ação, obrigação ou condição de outro campo;
- rejeitar chave duplicada, binding inexistente e enum incompatível;
- preservar respostas já registradas como revisão imutável; alteração exige nova proposta e nova revisão;
- serializar operações concorrentes pela revisão base e dar idempotência por operação;
- importar em form-js e validar JSON Schema gerado;
- nenhuma execução de integração ou publicação como efeito da alteração do formulário.

FormPatch pode evoluir separadamente do GraphPatch se a superfície de referência a campos estiver estável, mas ambos precisam compartilhar o mesmo modelo de revisão e auditoria.

## V2-06 — processos grandes e chunking

Não dividir o grafo apenas por contagem de nós. Primeiro medir limites de tokens, tamanho JSON, profundidade, cardinalidade de requisitos, tempo do validator e importação de artefatos no corpus. Qualquer chunking futuro precisa particionar por fronteiras semânticas com interfaces explícitas e IDs globais preservados.

Plano de prova:

- gerar grafos sintéticos determinísticos em tamanhos crescentes, sem provider pago;
- verificar estabilidade de IDs e de normalização ao particionar e recompor;
- cobrir nós/arestas que cruzam fronteiras, gateway e loop entre chunks, variáveis compartilhadas e formulários;
- rejeitar chunks omitidos, duplicados ou fora de ordem quando a recomposição muda o grafo;
- medir pico de memória, latência local, bytes, tamanho de diagnóstico e importação BPMN/Form;
- impor limites seguros antes de aceitar uma geração; falhar explicitamente quando excedidos.

## Backlog priorizado

| Prioridade | Item | Critério para iniciar |
| --- | --- | --- |
| P0 | Regressões de GraphIR para IDs, cobertura, condição, loop e adapter | Manter a suíte atual verde e ampliar casos negativos conforme fixtures |
| P1 | Matriz de equivalência semântica para mais fixtures golden além de G03 | Cada fixture convertida manualmente com requisito rastreável; declarar que não mede provider |
| P1 | Mensagem/configuração de papéis `unresolved` no contrato GraphIR | Definir localização, identidade e ciclo de resposta sem alterar ProcessSpec público |
| P2 | Auditoria shadow local, sem provider adicional | Métricas minimizadas, caminho legacy invariável e desligamento testado |
| P2 | Projeção de schema estruturado compatível com provider escolhido | Validar schema e limites em modo local; provider permanece opt-in |
| P3 | GraphPatch tipado e atômico | Identidade/revisão/cobertura estabilizadas e testes acima aprovados |
| P3 | FormPatch tipado e atômico | Identidade de campo, bindings e política de revisão aprovados |
| P4 | Avaliação de chunking por fronteira semântica | Baseline de escala e corpus sintético medidos |

## Gates para mudar o caminho padrão

O GraphIR não deve substituir o caminho atual até haver: conversão de fixtures representativas com cobertura integral; corpus de regressão independente; evidência de interpretação do provider medida separadamente da construção manual; plano aprovado de compatibilidade e migração; observabilidade sem dados sensíveis; e feature flag com rollback exercitado. Nenhum desses gates é declarado aprovado apenas pelos testes locais do adapter.
