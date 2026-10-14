# 08 — Plano de execução por fatias verticais

## Fase 0 — domínio e fixtures (1º marco)

- JSON Schema ProcessSpec v1, generation-result, knowledge pack v1.
- Exemplos: férias aprovado/rejeitado; serviço HTTP consulta externa; atualização controlada de registro.
- Validador de referências, grafo, variáveis e conector.
- Sem chamada real ao LLM, sem deploy em produção.

**Aceite:** `check_examples.py` verde; cenários negativos devidamente rejeitados; schema aprovado após review.

## Fase 1 — Artefatos editáveis (2º marco)

- Gerador TypeScript BPMN XML+BPMNDI para subset inicial.
- Gerador Form JSON importável em form-js.
- Testes em navegador real: bpmn-js import/saveXML e form-js viewer/editor import.
- Snapshots estáveis; nenhum side effect.

**Aceite:** cenário de férias abre/editável em ambas interfaces, mantendo ligações/variáveis.

## Fase 2 — Conversa com IA (3º marco)

- Provider gateway com Ollama e **um** segundo provedor autorizado (não quatro integrações simultâneas no dia 1).
- Saída JSON Schema, perguntas e proposta, tentativa limitada de reparo, diff e revisão.
- Medir custo por processo revisável; evitar RAG e fine-tuning.

**Aceite:** usuário cria fluxo de férias, responde lacuna, solicita alteração e aceita revisão sem perder estado.

## Fase 3 — Conectores declarativos + simulação (4º marco)

- CapabilityCatalog mock com HTTP GET/POST e DB record update.
- Validação de side effects, contrato de operação, idempotência e revisão humana.
- Simulador sem rede nem banco real; registra ações que **seriam** executadas.

**Aceite:** caso de integração exibe o request planejado e seu status simulado; nenhuma conexão externa acontece na POC.

## Fase 4 — Integração autorizada futura

- Comparar versões reais do `modeler`, `form-js`, `bpm-design-api`, engine Flowable e contratos de publicação.
- Adapter de export/import e perfil específico; teste de deploy não produtivo e revisões RBAC/tenant.
- Só após acordo de Produto/Segurança habilitar workers de execução; OCI/Kubernetes ficam fora do domínio.

## Indicadores

- Fidelidade da modelagem a requisitos explícitos: checklist humano + automação.
- Importação correta BPMN/Form: buscar 100% **no subset suportado**.
- Erros bloqueantes do validator antes da revisão humana.
- Tempo total até rascunho revisável, não apenas segundos de LLM.
- Custo por rascunho revisável (CPU/GPU, memória, API, retrabalho).
- Resultado de segurança: 0 efeitos reais não autorizados, 0 vazamentos intertenant.

**Observação:** os marcos são sequência técnica, não estimativas de prazo ou entregas aprovadas pela Softplan.
