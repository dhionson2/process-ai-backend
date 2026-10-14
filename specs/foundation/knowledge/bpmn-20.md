# Knowledge — BPMN 2.0.2 (normativo e prática de modelagem)

**Hierarquia de verdade:** OMG BPMN 2.0.2 (semântica) → perfil de suporte do motor escolhido (executabilidade) → perfil de integração ao produto (componentes e extensões suportados) → convenções do órgão. **Nunca confundir um desenho BPMN válido com algo implantável no runtime.**

## Fundamentos

- `Process`: define uma sequência de atividades, eventos e decisões. `isExecutable` define intenção de execução, mas não substitui validação do motor.
- `SequenceFlow`: controle de sequência **dentro de um processo**, não atravessa participantes/pools. Para comunicação entre participantes distintos, `MessageFlow` em colaboração.
- `Participant/Pool`: entidade/participante do processo; `Lane`: organização de responsabilidades. Lane não concede permissão por si só.
- `DataObject`, `DataStore`, `DataAssociation`: representação visual/documental de dados; não criam automaticamente persistência nem conexões em banco.
- `TextAnnotation/Association`: documentação, não fluxo de execução.
- `BPMNDiagram/BPMNPlane/BPMNShape/BPMNEdge/DC/DI`: projeção visual, exigida para prévia em editores como bpmn-js.

## Eventos

| Elemento | Semântica | Cuidados |
| --- | --- | --- |
| startEvent (none) | início do processo | associar formulário de abertura na plataforma, sem presumir que formKey BPMN é portável |
| messageStartEvent | inicia ao receber mensagem | canal/correlação precisam existir no runtime |
| timerStartEvent | inicia em data/ciclo | timezone, fuso e tratamento de calendário |
| endEvent (none) | encerra caminho | múltiplos end events podem representar finais distintos |
| terminateEndEvent | encerra escopo/instâncias de execução relacionadas | semântica perigosa; revisão especial |
| intermediateCatchEvent (message/timer/signal) | aguarda evento | vínculo de mensagem/correlação e timeouts |
| intermediateThrowEvent | publica sinal/mensagem | nem todo runtime suporta todas combinações |
| boundaryEvent interrupting | interrompe atividade em evento | preserve caminhos de exceção |
| boundaryEvent non-interrupting | evento cria caminho paralelo | pode disparar múltiplas vezes; prevenir duplicidade |
| errorEndEvent | propaga erro BPMN | tratamento explícito com boundary/event subprocess |
| escalation/compensation/link | alternativas de execução | só gerar se perfil de motor declarar suporte |

## Gateways

- **Exclusive (XOR):** seleciona exatamente uma rota válida; condições mutuamente exclusivas ou default definido. Nunca usar XOR para enviar a RH e financeiro simultaneamente.
- **Parallel (AND):** ativa todas as rotas; junção aguarda as necessárias. Não misturar branches incompatíveis ou produzir deadlock por join incompleto.
- **Inclusive (OR):** pode ativar uma ou mais rotas; convergência depende das rotas ativas. Exige análise além do XOR.
- **Event-based:** escolha conforme primeiro evento ocorrido; diferentes de gateways por expressão de variável; alvos precisam ser eventos de captura/recebimento compatíveis.
- **Complex gateway:** somente mediante capacidade explícita e revisão técnica, pois lógica é mais difícil de validar.

## Atividades

| Tipo | Propósito | Produção |
| --- | --- | --- |
| userTask | ação humana | ator/grupo autorizado, formulário e regras de conclusão |
| serviceTask | ação automatizada | serviço/connector aprovado, input/output mapeado |
| businessRuleTask | avaliação de decisão | DMN/regra autorizada; não presumir DMN na V1 |
| sendTask/receiveTask | interação com mensagem | canal, correlação, retries e eventos |
| manualTask | trabalho sem apoio do motor | não exige formulário/sistema |
| scriptTask | execução de código | **desabilitado por padrão**; não permitir script gerado por LLM |
| callActivity | invoca processo reutilizável | versão, mapeamento de variáveis e autorização |
| subProcess embedded | encapsula lógica e escopo | modelo recursivo; limites de profundidade |
| eventSubProcess | resposta a eventos no escopo | necessidade de suporte verificado do destino |
| multiInstance | tarefa em série ou paralelo | cardinalidade, coleção, conclusão antecipada e carga |
| transaction/compensation | controle transacional de processo | não equivale a transação ACID entre múltiplos serviços |

## Regras de qualidade

- Todo caminho de término deve ser explícito ou justificar espera/evento de longa duração.
- Todo nó referenciado precisa existir, e todos os nós não auxiliares precisam ser alcançáveis da entrada.
- Condições devem depender de variáveis definidas e compatíveis em tipo; usar default somente quando regra de negócio prevê.
- Loops precisam de condição de saída e limite ou mecanismo de contenção; detectar possíveis ciclos infinitos.
- Subprocessos, eventos e gateways devem ser modelados conforme suportados, nunca convertidos silenciosamente em tarefas genéricas.
- Retries, timeouts, idempotência e compensação precisam ser explicitados para toda operação com efeito externo.

## Status de suporte inicial

**Gerável POC:** start/end simples, userTask, serviceTask *declarativa e não executável*, exclusiveGateway, sequenceFlow e formulários simples.

**Conhecido, mas só habilitar por perfil de destino:** parallel/inclusive/event gateways; intermediate/boundary events; timer/message/signal; businessRuleTask; send/receive; callActivity; subprocess; multi-instance; compensação e pools/lanes.

**Nunca habilitado por padrão:** scriptTask arbitrária, JavaDelegate/class/expression textual criada pelo LLM, execução de SQL livre, importação de extensões desconhecidas como código executável.

**Fonte normativa:** https://www.omg.org/spec/BPMN/ ; documentação do Flowable OSS: https://www.flowable.com/open-source/docs/bpmn/ch07b-BPMN-Constructs/
