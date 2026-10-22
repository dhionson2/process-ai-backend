# Proposta: evolução do fluxo conversacional do Process AI Studio

**Status:** proposta para discussão e priorização. Este documento não altera os ADRs, contratos da API nem o roadmap aprovado.
**Data:** 2026-10-22

## Resumo executivo

O Process AI Studio já possui peças importantes para criar processos: sessões conversacionais, histórico, perguntas e respostas, revisões, validação determinística, compilação de ProcessSpec e geração de BPMN e formulários. A dor atual está na jornada: uma descrição ainda incompleta pode seguir cedo demais para uma interpretação estruturada complexa; se a interpretação divergir da evidência ou do contrato, a pessoa recebe um erro técnico e precisa tentar de novo.

A recomendação é evoluir a jornada de **geração de uma vez** para **levantamento conversacional de requisitos seguido de compilação revisável**. A IA ajuda a interpretar o pedido, expor lacunas e propor alterações. O backend mantém a autoridade sobre os fatos confirmados, a estrutura canônica, as validações e os artefatos. O usuário deve poder ver o que foi entendido, responder perguntas, gerar uma prévia, pedir alterações e comparar revisões sem perder o trabalho anterior.

A prioridade não é trocar o modelo ou adicionar uma plataforma de agentes. É tornar explícita a transição entre requisitos, perguntas, compilação e revisão e melhorar a recuperação quando uma etapa falhar.

## Avaliação do estado atual

O código atual já oferece uma boa base:

- `conversation.service.ts` persiste turnos, perguntas, respostas, propostas e revisões; usa `baseRevision` para proteger alterações concorrentes.
- `orchestrator.ts` coordena a interpretação, as validações e a geração de artefatos.
- `business-intent-evidence.ts` confere a fonte e o suporte das afirmações antes da compilação.
- `business-intent-v2-compiler.ts` compila a intenção para os modelos intermediários e ProcessSpec.
- `ConversationWorkspace.tsx` apresenta a conversa, o diagrama e formulários.
- Os endpoints atuais permitem mensagens, respostas, refinamentos e revisão manual; o contrato ativo descreve os turnos de conversa como síncronos.

A sequência atual ainda coloca bastante peso sobre uma resposta estruturada do modelo. O prompt, o schema, as evidências e as regras de compilação precisam concordar. Um erro em ator, atividade, campo ou resultado pode invalidar a proposta inteira. Isso protege contra invenções, mas não é uma boa interação quando o diagnóstico chega ao usuário como `BUSINESS_INTENT_EVIDENCE_INVALID` sem uma pergunta ou recuperação clara.

Os erros recentes também mostram dois problemas distintos que precisam de tratamento próprio:

1. **Falta de informação:** a pessoa ainda não informou quem inicia uma etapa ou quais dados uma decisão requer.
2. **Divergência de interpretação:** o modelo devolveu uma atividade, papel ou resultado que não corresponde à fonte ou ao contrato.

O primeiro caso normalmente pede esclarecimento. O segundo pode pedir revisão da interpretação, mas não deve ser contornado reduzindo a exigência de evidência.

## Experiência desejada

### 1. Entender o pedido e explicitar o que falta

Após a primeira descrição, o sistema deve resumir o que entendeu em termos de processo: objetivo, atores identificados, etapas, decisões e dados mencionados. Em seguida, faz poucas perguntas de alto valor, agrupadas por assunto. A pessoa deve poder responder em linguagem natural, corrigir o resumo ou dizer que ainda não sabe.

As perguntas devem distinguir:

- Informação necessária para compilar o fluxo.
- Informação necessária para desenhar os formulários.
- Regra de negócio que precisa ser definida por um responsável.
- Integração externa que ainda não está configurada.
- Sugestão opcional que não deve virar requisito automaticamente.

### 2. Manter um rascunho de requisitos rastreável

Cada requisito deve guardar seu conteúdo, origem, estado e relações com o processo. Estados possíveis incluem informado, confirmado, pendente, rejeitado e substituído. A interface pode exibir uma lista compacta de itens confirmados e pendentes e permitir corrigir um item sem reiniciar a conversa.

O rascunho não deve converter uma hipótese do modelo em fato. Quando houver informação insuficiente, o sistema pergunta; se a pessoa escolher prosseguir com uma prévia incompleta, as lacunas aparecem claramente como pendências.

### 3. Compilar e mostrar uma proposta

Quando os requisitos mínimos estiverem presentes, o backend compila o rascunho para ProcessSpec e gera BPMN e formulários. A interface mostra a prévia e um resumo da proposta, incluindo atividades, responsáveis, decisões e campos de cada formulário. A proposta continua sujeita à revisão explícita do usuário.

### 4. Refinar sem reconstruir tudo

Pedidos como “remova a etapa de RH”, “inclua a data de retorno” ou “a reprovação encerra o processo” devem ser interpretados como alterações localizadas sobre uma revisão conhecida. O backend aplica a alteração ao rascunho, valida a estrutura resultante, regenera os artefatos e devolve uma comparação compreensível. A revisão anterior permanece recuperável e deve existir uma ação de desfazer.

O modelo não deve reescrever livremente o BPMN XML nem substituir todo o ProcessSpec sem necessidade. O ProcessSpec permanece a fonte canônica; BPMN e formulários são projeções reprodutíveis.

## Exemplo: solicitação de férias

Uma descrição inicial como “quero criar uma solicitação de férias para aprovação do gestor” não deve produzir automaticamente um processo completo com regras inventadas. O sistema poderia confirmar o entendimento inicial e perguntar, por exemplo:

1. Quem pode solicitar férias?
2. Quais dados a pessoa informa? O período pode ser representado por data de início e data final, calculando a quantidade de dias, ou a empresa exige também informar a quantidade?
3. Quais informações o gestor precisa consultar para decidir?
4. De onde vêm saldo de férias e elegibilidade: preenchimento manual, consulta por RH ou integração com um sistema existente?
5. A aprovação ou reprovação encerra o processo? Existe alguma etapa posterior?
6. Há regras internas de antecedência, períodos bloqueados ou alçada que precisam ser configuradas?

As respostas definem os campos, atores, atividades e decisões. O cálculo de elegibilidade e as regras legais ou internas não devem ser inventados pela LLM. Precisam vir de política aprovada pela empresa ou de uma integração autorizada, com responsável, origem, versão e data de vigência. Sem essa fonte, o sistema pode registrar a regra como pendente e pedir configuração.

## Arquitetura proposta

### Responsabilidades

- **Frontend React:** conversa, resumo de requisitos, perguntas, estados de processamento, prévia BPMN/form-js, comparação entre revisões e ações de aceitar/desfazer.
- **Backend Fastify:** persistência, controle de revisão, política de dados, validação de entrada e saída, orquestração, compilação e geração de artefatos.
- **LLM via AI Gateway existente:** interpretação, classificação de lacunas, formulação de perguntas e proposta de operações tipadas. Não publica, não executa conectores e não substitui os validadores.
- **PostgreSQL existente:** sessões, mensagens, requisitos, estados de geração, versões e propostas recuperáveis.
- **ProcessSpec:** contrato canônico validado; BPMN XML e Form JSON permanecem artefatos gerados.

### Contratos pequenos e tipados

Em vez de pedir um grande objeto final em todo turno, separar a saída conversacional em resultados explícitos, por exemplo:

- `clarification`: resumo do entendimento e perguntas prioritárias;
- `requirements_update`: fatos propostos, cada um com origem e estado;
- `proposal_ready`: indicação de que os critérios de compilação foram atendidos;
- `change_set`: operações tipadas sobre uma revisão, com referências e justificativa.

O backend valida o schema e a semântica de cada resultado, confirma que referências existem e aplica alterações sobre uma versão-base. A validação completa do ProcessSpec e dos artefatos continua obrigatória depois de cada proposta.

### Processamento e estados

Os turnos atuais são síncronos segundo o contrato ativo. Para conversas mais longas, vale adicionar estados de geração persistidos e progresso consultável. Uma primeira versão pode usar polling do `generationRunId` que já existe; SSE pode ser adicionado para enviar eventos de progresso ao navegador sem exigir WebSocket.

A documentação atual da Groq informa que Structured Outputs em modo estrito não oferece streaming. Portanto, o progresso pode mostrar etapas (“interpretando”, “checando requisitos”, “compilando”, “validando”), sem transmitir JSON parcial do modelo. Isso mantém o contrato estrito e evita acoplar a UX a tokens incompletos. Consulte [Groq Structured Outputs](https://console.groq.com/docs/structured-outputs).

## Tecnologia: aproveitar o que já existe

Recomenda-se manter inicialmente TypeScript, Fastify, PostgreSQL, React, AI Gateway, AJV e ProcessSpec. Não há necessidade imediata de introduzir LangGraph, uma plataforma de agentes, Redis ou um motor de workflow distribuído. O estado de conversa e geração já é persistido no PostgreSQL; uma fila dedicada só deve entrar quando volume, concorrência ou execução resiliente justificarem esse custo.

O frontend já usa tecnologias adequadas para a prévia e edição visual: [bpmn-js](https://github.com/bpmn-io/bpmn-js) para diagramas BPMN e [form-js](https://github.com/bpmn-io/form-js) para formulários. A evolução deve integrar melhor essas prévias à conversa, não criar renderizadores paralelos.

## Plano de evolução sugerido

### Etapa A — reduzir frustração imediatamente

- Traduzir falhas de validação em mensagens orientadas à ação: requisito sem evidência, conflito de papel, campo sem suporte ou caminho não especificado.
- Preservar o texto e o rascunho em todos os erros; oferecer continuar, corrigir ou refazer apenas a etapa afetada.
- Exibir o estado do turno e o identificador recuperável da execução.
- Garantir que erros semânticos não acionem chamadas adicionais silenciosas.

### Etapa B — levantamento guiado

- Tornar visível o resumo do que foi entendido e a lista de requisitos confirmados/pendentes.
- Priorizar perguntas bloqueantes e evitar perguntar novamente o que já foi respondido.
- Registrar origem, confirmação e substituição dos requisitos.
- Definir critérios de “pronto para gerar” e permitir prévia incompleta apenas com pendências explícitas.

### Etapa C — revisão por operações

- Definir operações permitidas para criar, remover, renomear ou alterar atividades, campos e decisões.
- Aplicar operações contra `baseRevision`, validar o resultado completo e gerar diff.
- Adicionar comparação visual, aceitar, desfazer e recuperação de versões.
- Manter edição manual e alterações por chat consistentes sobre o mesmo ProcessSpec.

### Etapa D — regras empresariais e integrações

- Criar catálogo versionado de políticas internas, fontes e responsáveis por domínio.
- Modelar integrações somente após identificar sistemas, contratos, autenticação e responsáveis.
- Manter chamadas externas desativadas até passarem pelas políticas de segurança e aprovação empresarial.
- Validar compatibilidade com o runtime alvo separadamente da validade BPMN genérica.

## Qualidade, segurança e métricas

Antes de ampliar uso na empresa, formar um conjunto de cenários sintéticos representativos: pedidos incompletos, aprovações simples, compras, férias, múltiplos aprovadores, campos condicionais, respostas contraditórias e edições por chat. Cada cenário deve ter critérios verificáveis e exemplos negativos.

Medir pelo menos:

- Percentual de conversas que chegam a uma proposta válida sem reiniciar.
- Número de perguntas necessárias e repetidas.
- Fidelidade entre requisitos confirmados e atividades, decisões e campos gerados.
- Taxa de campos, atores, regras ou atividades sem suporte (meta: zero aceitos).
- Taxa de correção após prévia e preservação de alterações anteriores.
- Latência por etapa, tokens/custo e falhas por código de validação.
- Importação BPMN e formulários em browser, além da compatibilidade com o runtime pretendido.

A POC atual ainda é local e sem autenticação corporativa. Antes de piloto com usuários, dados ou processos reais, implementar identidade, autorização por projeto/tenant, política de retenção, classificação/minimização de dados, limites de uso, observabilidade sanitizada e governança dos provedores. Isso segue as restrições ativas em `specs/active/04-seguranca-qualidade.md`.

## Decisões para priorização

1. Aprovar a separação explícita entre levantamento de requisitos e compilação?
2. Qual cenário empresarial será o primeiro caso de aceite além do smoke técnico atual?
3. Quem define e mantém as políticas de férias, elegibilidade e exceções?
4. O primeiro alvo é BPMN genérico ou um runtime específico que exigirá homologação própria?
5. Quais dados podem ser enviados a provedores externos no piloto e sob qual aprovação?

## Referências do repositório e documentação externa

- Backend: `src/modules/ai/conversation.service.ts`, `src/modules/ai/orchestrator.ts`, `src/modules/ai/business-intent-evidence.ts` e `src/modules/graph-ir/business-intent-v2-compiler.ts`.
- Frontend: `src/components/ConversationWorkspace.tsx` no repositório frontend.
- Contrato e decisões atuais: `specs/active/01-decisoes-arquiteturais.md`, `02-plano-de-entregas.md`, `03-contrato-integracao.md`, `04-seguranca-qualidade.md` e `05-conceitos-produto.md`.
- [Groq Structured Outputs](https://console.groq.com/docs/structured-outputs).
- [bpmn-js](https://github.com/bpmn-io/bpmn-js) e [form-js](https://github.com/bpmn-io/form-js).
