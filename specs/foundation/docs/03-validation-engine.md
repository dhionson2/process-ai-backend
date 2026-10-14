# 03 — Validation Engine: desenho orientado a regras

## Saída padronizada

```json
{
  "valid": false,
  "diagnostics": [
    {"code":"FLOW_TARGET_MISSING","severity":"error","path":"/flows/3/target","message":"Destino não existe","suggestion":"Selecione um nó válido"}
  ],
  "canPreview": false,
  "canApproveDraft": false,
  "canPublish": false
}
```

Severity: `error`, `warning`, `info`. `canPreview` significa prévia sem defeitos estruturais fatais; `canApproveDraft` significa revisão não bloqueada; `canPublish` exige validações de runtime, permissões e decisão humana que estão **fora da POC**.

## Pipeline

**V00 Parse:** JSON válido, limites de tamanho/profundidade, proteção contra payloads gigantes.

**V10 Schema:** versão conhecida, `additionalProperties:false` no núcleo, campos obrigatórios, tipos e enums; mensagens apontam JSON Pointer.

**V20 Identidade/referências:** ids únicos; flow source/target; role/form id; ações e variáveis referenciadas; IDs estáveis de revisão.

**V30 Grafo:** start/end, alcance do start, nós órfãos, caminho final alcançável; grau de gateways; caminhos sem saída; ciclos sem saída; junção AND potencialmente problemática (sujeita a análise formal em etapas avançadas).

**V40 Expressões:** todas as variáveis existem; tipos comparáveis; expressão booleana em flow; condições XOR exclusivas quando comprováveis; ramo default; check de exaustividade para enum/boolean; nunca interpolar código livre.

**V50 Formulários:** associações e tipos, enum, required/requiredWhen, formulários duplicados, dependências de campos e variáveis, tipos não suportados em form-js.

**V60 Capacidades:** compatibilidade com o perfil (`generic-bpmn2`, `flowable-oss`, `unique-future`) e plugins/conectores catalogados, distinguindo `modelable`, `renderable`, `runtimeExecutable`.

**V70 Segurança:** ações externas somente com connector/operation permitidos, bloqueio de SQL/código livre, controle SSRF/hosts no catálogo, writes com idempotência e políticas, dados sensíveis e tenant.

**V80 Geradores:** serialização BPMN e forms, round-trip XML do parser, verificação de BPMNDI, importação em bpmn-js/form-js no teste de navegador, compatibilidade do motor em integração.

**V90 Simulação:** caminho aprovado/rejeitado, expressão controlada e hipóteses, sem efeitos reais. Necessário testes de casos e QA humano: não fingir que é execução real do motor.

## Regras com códigos estáveis

| Código | Severidade | Condição |
| --- | --- | --- |
| `SCHEMA_INVALID` | error | JSON não cumpre contrato |
| `DUPLICATE_ID` | error | identificador repetido |
| `FLOW_TARGET_MISSING` | error | destino inexistente |
| `FLOW_SOURCE_MISSING` | error | origem inexistente |
| `START_COUNT_INVALID` | error | perfil POC não tem exatamente um start |
| `END_MISSING` | error | sem final |
| `UNREACHABLE_NODE` | error | nó órfão |
| `DEAD_END` | error | nó sem saída fora de end/espera suportada |
| `GATEWAY_ROUTE_MISSING` | error | XOR com saída não condicionada sem default |
| `GATEWAY_BRANCH_INCOMPLETE` | warning/error | domínio enum/boolean não coberto |
| `CONDITION_VAR_UNDEFINED` | error | campo/variável inexistente |
| `CONDITION_TYPE_MISMATCH` | error | tipos incompatíveis |
| `ROLE_UNRESOLVED` | error | responsável não identificado e sem resolução permitida |
| `FORM_UNDEFINED` | error | formId inexistente |
| `FIELD_VAR_UNDEFINED` | error | bindTo inexistente |
| `FORM_FIELD_UNSUPPORTED` | error | campo sem mapeamento para versão form-js |
| `OUTPUT_VAR_UNDEFINED` | error | saída da ação mapeada para variável ausente |
| `CAPABILITY_NOT_SUPPORTED` | error | nó/ação sem suporte no targetProfile |
| `CONNECTOR_NOT_APPROVED` | error | connector/operation não catalogada/autorizada |
| `SIDE_EFFECT_UNSAFE` | error | write sem política/idempotência exigida |
| `UNBOUNDED_LOOP` | warning/error | possível ciclo indefinido |
| `BLOCKING_QUESTION` | error | lacuna crítica para aceite/publicação |
| `STALE_REVISION` | error | tentativa de salvar baseRevision antigo |
| `DI_INCOMPLETE` | error | elemento visual sem shape/edge |
| `XML_IMPORT_FAILED` | error | importação do editor ou motor falhou |

## Gate de publicação

Publicação é responsabilidade futura do sistema integrado, **nunca do LLM**: `schema OK AND graph OK AND bindings OK AND capability verified AND tenant authorization OK AND no blocking questions AND human approval AND engine validation OK`.

## Testes mínimos

- Positivos: linear, XOR aprovado/reprovado, dois finais, form condicional, HTTP declarativo e DB update declarativo autorizado (todos preview-only).
- Negativos: destino inexistente, condição sem variável, gateway sem default, formulário órfão, enum fora do domínio, múltiplos starts POC, loop sem escape, SQL arbitrário, operação não autorizada, mudança de revisão concorrente, tentativas cross-tenant.
- Metamórficos: renomear rótulos não altera semântica, reordenar JSON não altera processo, mudar provedor não muda validação, regen idem sem alterar ProcessSpec.
- Golden snapshots: comparar ProcessSpec normalizado, BPMN XML canônico e forms JSON após cada mudança de geradores/knowledge.
