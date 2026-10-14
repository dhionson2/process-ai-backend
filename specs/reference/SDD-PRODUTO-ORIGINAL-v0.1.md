# SDD-PROD-001 — Unique AI Designer
## Copiloto de Modelagem Conversacional de Processos e Formulários

**Versão:** 0.1 — Proposta inicial  
**Data:** 13/10/2026  
**Estado:** Draft para discovery, validação de Produto e POC  
**Iniciativa:** Proposta de inovação em IA para o ecossistema Unique / 1Doc  
**Tipo:** SDD de produto (especificação orientada a requisitos; **não** é documento de arquitetura)  
**Escopo:** Experiência, valor, regras, critérios de aceite, governança, provedores de IA configuráveis e avaliação de viabilidade

> **Premissa de governança:** este documento é uma proposta independente, ainda não aprovada pelo produto. Não altera o escopo, os compromissos ou o roadmap oficial do Unique; nenhuma publicação ou ação real em órgãos clientes é autorizada por esta especificação.

---

## 1. Visão executiva

O **Unique AI Designer** permitirá que um usuário autorizado descreva, em linguagem natural, um processo administrativo e obtenha um **rascunho de processo BPMN 2.0**, acompanhado dos **formulários de abertura e de tarefas**, regras de encaminhamento, atores propostos, decisões e questões pendentes.

A experiência será **conversacional e iterativa**: a IA interpreta a intenção, pergunta apenas o necessário, apresenta a prévia visual e permite pedidos como “inclua uma etapa de conferência do RH” ou “quando rejeitar, exija justificativa”. O usuário pode revisar, editar no Modeler, testar cenários e solicitar novas versões do rascunho. A IA **não publica nem executa automaticamente** o processo.

A solução deverá ser **independente de fornecedor de modelo**. O ambiente poderá utilizar modelos locais/privados (por exemplo, via Ollama) ou APIs externas autorizadas (OpenAI, Anthropic/Claude, Google/Gemini e outros no futuro), conforme política e configuração do administrador. **Modelo local não implica custo operacional zero**; provedores externos dependem de políticas de dados, custos e aprovação corporativa.

**Proposta de valor:** diminuir o esforço de transformar uma necessidade administrativa em um primeiro fluxo revisável, mantendo controle humano, rastreabilidade e governança.

## 2. Problema e oportunidade

**Dor atual:** modelar BPMN e construir formulários exige conhecimento da notação, entendimento do negócio e tempo de configuração. Analistas de negócio e equipes de implantação frequentemente partem de textos, reuniões e descrições informais para depois traduzir tudo em diagramas, variáveis, responsabilidades e campos.

**Oportunidade:** usar IA como interface de entrada para a modelagem, sem substituir os componentes canônicos do Unique e sem confundir o rascunho sugerido com um processo homologado.

**Resultados esperados (hipóteses, ainda não comprovadas):**
- Menor tempo até o primeiro rascunho utilizável.
- Menor esforço manual para tarefas e formulários recorrentes.
- Menor barreira de entrada para equipes não especialistas em BPMN.
- Maior padronização dos artefatos e das perguntas de descoberta.
- Possível ganho de produtividade na implantação pela Softplan e, futuramente, na autonomia dos órgãos.

## 3. Objetivos e não objetivos

### Objetivos

**OBJ-01:** Converter descrições textuais em fluxos BPMN visualizáveis e editáveis.  
**OBJ-02:** Propor formulários vinculados ao início e às tarefas humanas do processo.  
**OBJ-03:** Permitir esclarecimentos e refinamentos por conversa.  
**OBJ-04:** Evidenciar suposições, lacunas, avisos e decisões que precisam de validação.  
**OBJ-05:** Utilizar um mecanismo de IA configurável, com opção local/privada e APIs externas aprovadas.  
**OBJ-06:** Medir qualidade, economia de tempo e custo de geração.  
**OBJ-07:** Preservar compatibilidade conceitual com o ciclo de autoria, validação e publicação do Unique.

### Não objetivos da primeira POC

- Publicar automaticamente processos em produção.
- Executar processos administrativos reais ou enviar notificações verdadeiras.
- Aprovar férias, interpretar normas legais como parecer jurídico ou substituir RH/gestor.
- Descobrir, sem confirmação, quais pessoas/setores possuem autoridade legal.
- Criar um motor BPM, editor BPMN ou builder de formulários novos.
- Implementar Process Mining, DMN completo, marketplace ou agente autônomo com permissões irrestritas.
- Garantir que qualquer descrição ambígua produza um processo imediatamente publicável.

## 4. Alinhamento com o Unique e restrições de produto

O Unique/1Doc já prevê **Processos Inteligentes** com modelagem BPMN, formulários dinâmicos, publicação/versionamento, execução no motor e integração com tarefas, documentos, assinatura e histórico.

**Fatos documentados:** na V1 piloto, a **Softplan é a autora** dos fluxos; o órgão os utiliza, mas ainda não modela. A autoria pelo cliente aparece na V2. Recursos de IA para criação de fluxos/formulários constam do roadmap e não são requisito da V1. A especificação de integração M7 prevê formulário de emissão no início, formulários de tarefa, decisões do motor, despachos e encerramento.

**Consequência para a iniciativa:**
1. **POC:** demonstrador isolado, com dados fictícios, sem alterar repositórios ou operações oficiais.
2. **Adoção inicial possível:** recurso para autores autorizados da Softplan na “fábrica de fluxos”.
3. **Evolução futura:** recurso para modeladores/analistas autorizados dos órgãos, conforme V2 e decisões de produto.
4. **Servidor público executor:** continua utilizando tarefas e formulários na 1Doc; a autorização para **criar fluxos** não decorre do simples fato de ser servidor.

**Fonte de verdade dos requisitos oficiais:** PRD e especificações vigentes de Produto, Jira, protótipos UX e repositório canônico `unique-product`. Esta proposta não se sobrepõe a eles.

## 5. Personas e permissões

| Persona | Necessidade | Permissão proposta |
| --- | --- | --- |
| Autor Softplan (piloto) | Montar rapidamente fluxos para órgãos | Criar/revisar rascunhos habilitados para o tenant autorizado |
| Analista de negócio do órgão (futuro) | Descrever e refinar processos sem dominar BPMN | Criar e editar rascunhos, se autorizado |
| Administrador do órgão (futuro) | Controlar disponibilidade e governança | Habilitar recurso e escolher opções permitidas pela plataforma |
| Revisor de processo | Conferir regras, formulários, responsáveis e conformidade | Aprovar/rejeitar rascunho, conforme RBAC futuro |
| Servidor executor | Abrir solicitações e concluir tarefas | Executar somente processos publicados; não recebe automaticamente permissão de autoria |
| Operação/Segurança Softplan | Garantir controle de dados, custo e auditoria | Definir provedores autorizados, limites, monitoria e bloqueios |

**Regra:** autenticação e identidade devem continuar delegadas à 1Doc na eventual integração oficial. O recurso de IA não cria privilégios adicionais.

## 6. Jornadas de ponta a ponta

### Jornada J-01 — Criar processo por conversa

1. Autor abre a opção **Criar com IA** em contexto de autoria autorizado.
2. Informa em português a finalidade, as etapas e as condições conhecidas.
3. A IA confirma sua interpretação em termos simples.
4. Quando faltam informações que afetam o fluxo, pergunta antes de inventar regras.
5. O autor responde ou marca pontos como pendentes.
6. A solução monta o rascunho do BPMN e propõe formulários.
7. A interface exibe diagrama, lista de etapas, formulários, atores, suposições e pendências.
8. O autor escolhe **Aceitar rascunho**, **Pedir alteração**, **Editar manualmente** ou **Descartar**.
9. Quando a integração de persistência estiver autorizada, o rascunho poderá ser salvo no contexto do tenant, sem publicação automática.

### Jornada J-02 — Refinar o fluxo conversando

1. Autor visualiza um rascunho.
2. Solicita: “Se for reprovado, envie uma notificação com o motivo”.
3. A IA apresenta **quais elementos serão adicionados ou alterados**.
4. O autor confirma a alteração.
5. O produto atualiza a prévia e preserva as partes não afetadas.
6. O autor pode desfazer a alteração ou restaurar uma revisão anterior.

### Jornada J-03 — Revisar formulários

1. Autor abre os formulários sugeridos.
2. Confere tipo dos campos, rótulos, obrigatoriedade e vínculo com decisões.
3. Solicita ajustes: “A justificativa deve ser obrigatória apenas na reprovação”.
4. A solução atualiza a proposta e mostra as mudanças.
5. Campos e regras dependentes permanecem consistentes ou são marcados como pendentes.

### Jornada J-04 — Simular e entregar para revisão

1. Autor escolhe cenários de exemplo: aprovação, reprovação e falta de informação.
2. O sistema exibe a sequência esperada de tarefas e decisões **sem executar em produção**.
3. O autor revisa possíveis caminhos mortos, etapas sem responsável e campos ausentes.
4. O rascunho é entregue para revisão/aprovação pelo fluxo oficial, quando existir integração.

### Jornada J-05 — Falha ou indisponibilidade da IA

1. Produto informa que o provedor selecionado não respondeu ou não passou na validação.
2. Rascunho anteriormente aprovado permanece intacto.
3. Usuário pode tentar novamente ou continuar a edição manual.
4. Troca para outro provedor só ocorre quando a política autorizar e com aviso/consentimento correspondente.

## 7. Cenário de referência — Solicitação de férias

**Entrada do usuário:**

> “Preciso de um processo de solicitação de férias. O servidor informa o período e envia para seu gestor. O gestor aprova ou rejeita. Se aprovar, vai para o RH registrar as férias. Se rejeitar, o servidor recebe o motivo.”

**Interpretação proposta (sujeita à confirmação do órgão):**

- **Início:** servidor abre uma solicitação com formulário.
- **Tarefa 1:** gestor avalia pedido e informa decisão.
- **Decisão:** `aprovado` ou `reprovado`.
- **Rota aprovada:** RH recebe tarefa de registro; após conclusão, servidor recebe comunicação de encerramento.
- **Rota reprovada:** justificativa de rejeição obrigatória; servidor é comunicado e o processo é encerrado.
- **Fim:** processo termina após as etapas correspondentes.

**Formulário de abertura sugerido:** data inicial, data final, quantidade de dias (quando aplicável), observações/justificativa e eventuais anexos, todos revisáveis.

**Formulário de decisão do gestor:** decisão (aprovar/reprovar), observação e motivo obrigatório para reprovação.

**Formulário do RH:** confirmação de registro, data do registro e observações.

**Questões que a IA não pode presumir:** quem é o gestor responsável; disponibilidade de saldo de férias; regras legais do órgão; antecedência mínima; conflito de períodos; necessidade de assinatura; se RH pode devolver para correção; regra de ciência do servidor; prazos e escalonamentos.

**Resultado esperado da conversa:** um rascunho completo **dentro das regras que o autor confirmou**, com indicação explícita das questões ainda abertas. Não afirmar conformidade legal automática.

## 8. Artefatos gerados e contrato conceitual

Cada geração deverá produzir, no mínimo:

| Artefato | Conteúdo esperado |
| --- | --- |
| Especificação legível | Objetivo, etapas, atores, decisões, regras e exceções |
| Fluxo BPMN | Diagrama importável/editável, com eventos, tarefas, gateways e conexões suportadas |
| Formulário inicial | Campos para abertura da instância |
| Formulários de tarefa | Campos de ação e decisão por etapa humana |
| Mapeamento de dados | Relação conceitual entre campos, variáveis, condições e resultados |
| Catálogo de responsáveis | Papéis/setores **propostos**, não pessoas autorizadas presumidas |
| Pendências e suposições | O que foi informado, sugerido, inferido e precisa de confirmação |
| Relatório de validação | Erros bloqueantes, alertas e testes de caminhos básicos |
| Histórico de revisão | Quem alterou, solicitação usada, alterações aceitas e versão do rascunho |

**Princípio de qualidade:** distinguir claramente **informação fornecida pelo usuário**, **sugestão da IA** e **configuração confirmada**. O produto não deve apresentar inferências como requisitos aprovados.

## 9. Requisitos funcionais

### Captura e interpretação

- **RF-01 [MVP]:** aceitar descrição de processo em português natural.
- **RF-02 [MVP]:** extrair etapas, participantes, decisões, documentos, formulários e caminhos de exceção.
- **RF-03 [MVP]:** identificar lacunas críticas e fazer perguntas de esclarecimento objetivas.
- **RF-04 [MVP]:** exibir resumo da interpretação antes ou junto da geração.
- **RF-05 [Evolução]:** importar textos de procedimentos/documentos autorizados para auxiliar a descrição, sem presumir veracidade normativa.

### Geração

- **RF-06 [MVP]:** gerar BPMN com elementos suportados pelo escopo inicial.
- **RF-07 [MVP]:** gerar esquema de formulário de abertura e de tarefas.
- **RF-08 [MVP]:** vincular respostas de formulários a decisões e caminhos.
- **RF-09 [MVP]:** visualizar o diagrama e pré-visualizar os formulários.
- **RF-10 [MVP]:** informar erros/avisos e impedir aceite técnico de artefato estruturalmente inválido.
- **RF-11 [Evolução]:** sugerir notificações, assinatura, anexos, prazos e regras de escalonamento conforme capacidades oficiais disponíveis.

### Edição, revisão e salvamento

- **RF-12 [MVP]:** permitir alterações por nova mensagem em linguagem natural.
- **RF-13 [MVP]:** destacar diferenças relevantes propostas entre revisões.
- **RF-14 [MVP]:** exigir confirmação antes de substituir um rascunho considerado válido.
- **RF-15 [MVP]:** oferecer edição manual e descarte.
- **RF-16 [MVP]:** disponibilizar exportação dos artefatos da POC.
- **RF-17 [Evolução]:** salvar rascunho por tenant no Gerenciador existente, quando autorizado e integrado.
- **RF-18 [Evolução]:** manter revisão de autoria e submissão ao fluxo oficial de publicação/versionamento.
- **RF-19 [Evolução]:** executar simulação mais rica, alinhada ao validador/runtime quando estiver disponível.

### Administração e provedores

- **RF-20 [MVP]:** permitir configuração do provedor e modelo em ambiente controlado da POC, sem credenciais no navegador.
- **RF-21 [MVP]:** registrar qual provedor/modelo produziu cada geração e dados básicos de consumo/latência.
- **RF-22 [Evolução]:** política de provedores permitidos por instalação/tenant, respeitando autorização central.
- **RF-23 [Evolução]:** limites, cotas, telemetria de custo e bloqueios por política.
- **RF-24 [Evolução]:** teste de conexão, disponibilidade e compatibilidade do modelo configurado.
- **RF-25 [Evolução]:** possibilidade de desativar completamente o recurso de IA por configuração.

## 10. Regras de negócio

- **RN-01:** a IA cria **propostas**, nunca processos publicados automaticamente.
- **RN-02:** somente usuários com direito de autoria podem gerar ou salvar rascunhos no contexto oficial.
- **RN-03:** atividades geradas não podem produzir ações reais enquanto não houver publicação autorizada no Unique.
- **RN-04:** regras sobre competência, prazos legais, direitos trabalhistas e aprovação dependem de confirmação humana e das políticas do órgão.
- **RN-05:** setor/usuário responsável sugerido precisa ser mapeado para identidades válidas antes de uma futura publicação.
- **RN-06:** alterações por conversa não podem sobrescrever silenciosamente ajustes manuais posteriores.
- **RN-07:** caminhos sem saída, decisões sem condição válida e referência a campos ausentes devem ser tratados como erros.
- **RN-08:** a troca de modelo/provedor não pode alterar dados de outros tenants nem publicar conteúdo.
- **RN-09:** falha ou ausência de IA não bloqueia o uso convencional do Modeler.
- **RN-10:** as decisões de execução seguem pertencendo ao BPM, não ao LLM em tempo de execução.
- **RN-11:** regras sugeridas pelo modelo devem ser revisadas, sem afirmar que foram validadas juridicamente ou operacionalmente.
- **RN-12:** fluxos já publicados e instâncias em execução não são alterados pela geração/revisão conversacional.

## 11. Experiência e interface propostas

**Entrada principal:** “Descreva o processo que deseja criar”. Oferecer exemplo curto, sem exigir terminologia BPMN.

**Área de conversa:** mensagens contextualizadas com perguntas de esclarecimento; indicação de quais premissas estão pendentes.

**Prévia lado a lado:** diagrama BPMN, formulários e lista de regras/variáveis; navegação acessível em telas menores.

**Ações principais:** Gerar rascunho, Ajustar com IA, Visualizar formulário, Comparar alterações, Desfazer, Editar manualmente, Exportar, Salvar como rascunho (na etapa integrada).

**Estados:** vazio, interpretando, perguntas pendentes, gerando, rascunho disponível, validação com erro, revisão pendente, alteração aceita, falha de provedor, limitação por cota e integração indisponível.

**Linguagem:** PT-BR, explicações simples ao analista e detalhes técnicos disponíveis sob demanda. Erros devem explicar **o que falta corrigir**, não apenas um código.

**Transparência:** quando o usuário disser “envie mensagem”, distinguir se foi gerada uma etapa de notificação proposta ou se a infraestrutura real da 1Doc já suporta aquela ação.

## 12. Política de IA configurável e controle de custos

### Modalidades de execução suportadas como requisito de produto

| Modalidade | Exemplo | Valor | Limites e cuidados |
| --- | --- | --- | --- |
| **Local/privada** | Modelo servido por Ollama | Maior controle de onde o processamento ocorre; sem tarifa por chamada ao provedor externo | Exige máquina/infraestrutura, memória, capacidade, manutenção e avaliação de qualidade; não é custo zero |
| **API externa gerenciada** | OpenAI, Claude, Gemini | Permite avaliar modelos diferentes sem hospedar pesos | Consumo cobrado conforme serviço/plano, análise jurídica, privacidade e política de retenção |
| **IA desativada** | Sem provedor habilitado | Continuidade do Modeler convencional | Geração conversacional indisponível |

**Requisitos da configuração:**
- Escolha de **provedor e modelo** por administrador autorizado, dentro da lista permitida pela plataforma.
- **Configuração de credenciais protegida** e mantida fora da interface pública.
- Controle de quais tipos de dados podem ser transmitidos para cada modalidade.
- Exibição de disponibilidade, limite e custo **estimado**, quando mensurável.
- Medição de chamadas, unidades de consumo informadas pelo provedor, erros e tempo de resposta.
- Possibilidade de definir teto de uso e impedir gerações ao atingi-lo.
- Registro da modalidade usada, sem revelar segredos.
- **Sem fallback silencioso** de um provedor privado para uma API externa.
- Política explícita de tenant para uso, retenção, região de processamento e transferência de dados.
- Comparação de custo, latência e qualidade entre alternativas antes da escolha de padrão.

**Preferência inicial da POC:** avaliar **Ollama como candidato econômico/privado**, lado a lado com pelo menos um provedor externo aprovado, **sem determinar antecipadamente qual será o padrão**. Os nomes comerciais são exemplos de integrações possíveis, não fornecedores contratados.

## 13. Segurança, privacidade, compliance e auditoria

- **SEG-01:** isolamento por tenant de prompts, respostas, histórico, rascunhos, caches, custos e registros.
- **SEG-02:** na POC, usar **dados fictícios**, sem dados pessoais reais, credenciais, documentos sigilosos ou procedimentos internos sensíveis.
- **SEG-03:** em produção, aplicar LGPD e política interna de classificação, minimização e retenção de dados; obter aprovação para provedores externos.
- **SEG-04:** entradas do usuário, documentos importados e respostas do modelo são **dados não confiáveis**; não podem autorizar ações administrativas por si só.
- **SEG-05:** rejeitar instruções de contornar permissões, acessar outros tenants ou acionar recursos não permitidos.
- **SEG-06:** bloquear segredos e credenciais em prompts e logs; tratar configuração do provedor como dado sensível.
- **SEG-07:** registrar geração, revisão, aceite, exportação e eventual salvamento conforme política de auditoria.
- **SEG-08:** exigir confirmação humana antes de mudanças de rascunhos e manter publicação sob o processo normal de governança.
- **SEG-09:** considerar acessibilidade e mensagens claras de erro, inclusive para pessoas sem experiência em BPMN.
- **SEG-10:** não enviar definições reais de clientes para provedor diferente daquele autorizado pela política de dados.

## 14. Qualidade, validação e tratamento de falhas

A aceitação do resultado exige **mais que JSON/XML válido**. Validar em camadas:

1. **Estrutura:** formato bem formado, IDs/referências válidos, formulários legíveis e artefatos importáveis.
2. **Semântica suportada:** elementos BPMN dentro do subconjunto reconhecido; transições e decisões coerentes com variáveis.
3. **Consistência cruzada:** tarefas humanas possuem formulários quando necessários; campos de decisão existem; caminhos e responsáveis são explícitos.
4. **Fidelidade ao pedido:** revisão do usuário comparando cada requisito solicitado com os elementos gerados.
5. **Governança:** alertas para regras ou responsabilidades sugeridas, não confirmadas ou incompatíveis com permissões.

**Falhas previstas:** descrição vaga, instruções contraditórias, saída truncada, modelo não compatível, tempo esgotado, limite de consumo, formulário inválido, solicitação impossível no escopo atual, indisponibilidade do serviço.

**Conduta:** apresentar explicação objetiva, manter rascunho íntegro, indicar passos manuais ou novo pedido. Nunca ocultar erro crítico nem declarar que um fluxo está “pronto para produção” apenas porque passou em validação sintática.

## 15. Escopo da POC e roadmap incremental

### POC demonstrável — ciclo inicial

**Inclui:** descrição em PT-BR; perguntas de esclarecimento; geração de fluxo BPMN básico (início, fim, tarefas humanas, gateway exclusivo e conexões); formulários simples; decisão aprovação/reprovação; prévia; pedido de ajuste; comparação de revisões; validação básica; exportação; configuração de 1 provedor local e comparação opcional com API externa aprovada; métricas de geração.

**Não inclui:** integração produtiva com 1Doc, acesso a tenants reais, publicação, execução no Flowable, notificações reais, leitura de sistemas de RH, integrações externas ou compliance automatizado.

### Evolução E1 — Piloto interno Softplan

Autoria integrada ao fluxo de trabalho aprovado; rascunhos do Gerenciador; papéis e permissões; catálogo de ações e formulários aceitos; testes de modelos/custos mais amplos.

### Evolução E2 — Autoria assistida no órgão

Disponibilização controlada a modeladores do cliente quando a funcionalidade de autoria prevista para V2 estiver apta; políticas de provedores, aprovação e auditoria completas.

### Evolução E3 — Assistência contextual e governança avançada

Reuso de padrões/templates aprovados; sugestão de melhoria de fluxos existentes; assistência baseada em documentação autorizada; suporte a recursos BPMN mais complexos; simulações mais profundas e métricas de qualidade.

**Importante:** esses estágios são **proposta desta iniciativa**, e não substituem a ordem, os compromissos ou as datas do roadmap oficial Unique.

## 16. Critérios de aceite em Gherkin (nível produto)

**CA-01 — Criar proposta**
- **Dado** um usuário autorizado e uma descrição simples de aprovação com duas rotas,
- **Quando** ele solicitar a geração,
- **Então** o sistema deve apresentar um rascunho de fluxo e formulários correspondentes.

**CA-02 — Ambiguidade**
- **Dado** que a descrição não define quem aprova,
- **Quando** a IA identificar que essa decisão é necessária,
- **Então** deve perguntar ou marcar como pendência, sem atribuir autoridade arbitrariamente.

**CA-03 — Reprovação com motivo**
- **Dado** um fluxo de férias com aprovação/reprovação,
- **Quando** o autor exigir justificativa na reprovação,
- **Então** o formulário e o caminho de rejeição devem refletir essa regra.

**CA-04 — Editabilidade**
- **Dado** um rascunho gerado e válido,
- **Quando** ele for aberto no editor previsto,
- **Então** deverá continuar editável sem reconstrução manual total.

**CA-05 — Consistência**
- **Dado** um gateway baseado em campo de decisão,
- **Quando** o campo não existir no formulário,
- **Então** deve ocorrer erro bloqueante de validação.

**CA-06 — Revisão conversacional**
- **Dado** um rascunho gerado,
- **Quando** o usuário pedir uma mudança pontual,
- **Então** a solução deve mostrar a diferença e preservar as partes não relacionadas.

**CA-07 — Sem publicação**
- **Dado** qualquer geração ou aceite na POC,
- **Quando** o usuário confirmar o rascunho,
- **Então** nenhuma instância deve ser iniciada nem publicada na 1Doc.

**CA-08 — Falha**
- **Dado** um provedor indisponível,
- **Quando** o usuário gerar/editar,
- **Então** a aplicação deve informar a falha sem perder a revisão anterior.

**CA-09 — Provedor privado**
- **Dado** um ambiente configurado para processamento privado,
- **Quando** a geração ocorrer,
- **Então** não deve haver envio de conteúdo a serviços externos não autorizados.

**CA-10 — API externa**
- **Dado** um provedor externo habilitado por política,
- **Quando** uma geração ocorrer,
- **Então** o uso deve ser auditável e respeitar limites de consumo e dados.

**CA-11 — Tenant**
- **Dado** dois tenants distintos,
- **Quando** usuários acessarem históricos ou rascunhos,
- **Então** nenhum poderá visualizar conteúdo ou configuração pertencente ao outro.

**CA-12 — Informação sensível**
- **Dado** um pedido contendo material não permitido para o provedor configurado,
- **Quando** houver tentativa de geração,
- **Então** o envio deve ser bloqueado conforme política e o usuário orientado sobre a restrição.

## 17. Métricas, experimentos e evidências para o PDI

### Pergunta principal do experimento

**A criação assistida por IA reduz o tempo para obter um primeiro rascunho revisável, sem comprometer a qualidade e o controle humano?**

### Desenho de avaliação

- Preparar um conjunto fixo de **10 cenários fictícios**, de simples a moderados (férias, compra, autorização de acesso, solicitação de material, manutenção etc.).
- Modelar os mesmos cenários manualmente e com assistência, preservando condições comparáveis.
- Avaliar os artefatos às cegas, quando possível, com checklist fixo de requisitos e regras.
- Registrar tempo total **incluindo perguntas, retrabalho e correções**, não apenas tempo de geração do LLM.
- Comparar pelo menos uma modalidade local e, se autorizada, uma API externa.
- Guardar evidências reproduzíveis: casos, critérios, capturas, artefatos, versões e medidas.

| Indicador | Definição | Meta inicial sugerida para debate, não compromisso |
| --- | --- | --- |
| Tempo até rascunho revisável | Minutos do início à proposta aceita para revisão | Investigar redução mediana de ≥30% frente à modelagem manual |
| Taxa de importação | % de artefatos que abrem nos editores usados | Buscar 100% no subconjunto declarado da POC |
| Fidelidade funcional | % de critérios do cenário refletidos corretamente | Buscar ≥90%, medido por checklist humano |
| Ajustes manuais | Alterações necessárias após geração | Medir e reduzir progressivamente |
| Perguntas úteis | Lacunas críticas detectadas sem inventar regras | Contabilizar acertos, omissões e perguntas irrelevantes |
| Custo por rascunho | Custo variável de API ou custo operacional estimado do privado / volume | Medir, sem presumir “grátis” |
| Latência percebida | Tempo até prévia utilizável | Definir alvo após benchmark local |
| Segurança | Publicações indevidas, vazamentos ou envios não autorizados | Tolerância zero |

**Evidência executiva para o PDI:** relatório de benchmark, demonstração gravada, rascunhos gerados, resultados comparativos e parecer de produto/arquitetura sobre prosseguir ou não. Métricas oficiais dependem de baseline e validação da liderança.

## 18. Riscos, decisões abertas e referências

### Riscos e mitigação proposta

| Risco | Efeito | Mitigação de produto |
| --- | --- | --- |
| Modelo local fraco ou lento | Baixa qualidade/UX ruim | Benchmark antes de escolher padrão; delimitar escopo |
| Alucinação de regra administrativa | Fluxo inadequado | Perguntas, suposições explícitas, revisão e proibição de publicação automática |
| Provedor externo sem aprovação | Exposição indevida de informação | Allowlist, política de dados, bloqueio por modalidade |
| Custo variável imprevisível | Estouro de orçamento | Medição, limite e configuração central |
| Confusão entre modelagem e execução | Usuário acha que criou uma rotina ativa | Estados e mensagens explícitas de “rascunho não publicado” |
| Modificação de conteúdo editado manualmente | Perda de trabalho | Confirmação, comparação e reversão |
| Divergência do roadmap | Retrabalho ou conflito organizacional | POC isolada e revisão com Produto/Arquitetura antes da integração |
| Dependências futuras da 1Doc | Recurso não integrável imediatamente | Foco inicial no artefato BPMN/Form editável e exportável |

### Decisões que **não** devem ser antecipadas neste SDD

1. Qual modelo local oferece qualidade suficiente e qual hardware/custo o suporta.
2. Qual API externa, se alguma, será aprovada e contratada.
3. Quais dados e regiões são autorizados em cada modalidade.
4. Quem define o provedor: administração Softplan, tenant ou ambos, sujeito à política central.
5. Quais elementos BPMN e componentes form-js formam o subconjunto suportado inicialmente.
6. Como será o contrato técnico entre conversa, representação intermediária, validadores e geradores.
7. Como integrar de forma oficial ao Modeler, `bpm-design-api`, identidade, versionamento e publicação.
8. Como diferenciar rascunhos pessoais, rascunhos da Softplan e rascunhos vinculados ao tenant.
9. Qual será o processo formal de revisão, homologação e eventual comercialização.
10. Como a iniciativa se harmoniza com os requisitos futuros de acessibilidade, governança e custo da 1Doc.

### Critério de entrada para a próxima etapa (arquitetura/POC)

Esta proposta estará pronta para decomposição técnica quando existirem: (a) escopo de POC aceito, (b) exemplos de entrada/saída com casos de teste, (c) lista de elementos BPMN/forms suportados, (d) restrições de dados e fornecedores, (e) métricas e (f) concordância sobre manter tudo isolado dos ambientes oficiais inicialmente.

### Referências

**Documentos de produto Unique / 1Doc**
- [PRD — Módulo Processos Inteligentes](https://1doc.atlassian.net/wiki/spaces/TECK/pages/3113484291)
- [V1 — Primeira Entrega do BPM Nativo na 1Doc](https://1doc.atlassian.net/wiki/spaces/TECK/pages/3113385992)
- [M7 — Integração com a 1Doc](https://1doc.atlassian.net/wiki/spaces/TECK/pages/3305046022)
- [Requisitos BPM](https://1doc.atlassian.net/wiki/spaces/TECK/pages/3306422275)

**Documentação de capacidades de provedores (referência, não seleção técnica)**
- [Ollama — Structured Outputs](https://github.com/ollama/ollama/blob/main/docs/capabilities/structured-outputs.mdx)
- [OpenAI — Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Claude — Structured Outputs](https://platform.claude.com/docs/pt-BR/build-with-claude/structured-outputs)
- [Gemini — Structured Outputs](https://ai.google.dev/gemini-api/docs/structured-output?hl=pt-br)

---

**Situação final:** documento de **visão/requisitos de produto**, apto a orientar discovery e uma POC isolada. **Ainda não contém** decisão de arquitetura, ADR, desenho de componentes, escolha de modelo, contratos API, estimativa fechada, cronograma comprometido ou aprovação corporativa.
