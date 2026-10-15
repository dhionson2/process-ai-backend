# 02 — ProcessSpec v1: contrato canônico do domínio

**O JSON Schema executável está em `contracts/process-spec.v1.schema.json`.** O schema valida estrutura; regras semânticas ficam no Validation Engine. Em produção, tipos TypeScript podem ser gerados do schema.

## Raiz

`schemaVersion`, `id`, `name`, `description`, `locale`, `targetProfile`, `status`, `roles`, `variables`, `forms`, `nodes`, `flows`, `pendingQuestions`, `assumptions`, `policies`, `metadata`.

- `targetProfile`: `generic-bpmn2`, `flowable-oss`, `unique-future`. Apenas `generic-bpmn2` para prévia POC; os outros são **alvos de compatibilidade a certificar**, não aprovação para publicação.
- `status`: `draft`, `needs-input`, `invalid`, `ready-for-review`, `approved`.
- `roles[].resolution: unresolved` representa papel de negócio conhecido sem mapeamento de identidade/grupo no runtime. Uma pergunta bloqueante relacionada à tarefa mantém o processo em `needs-input`; BPMN/Form podem ser gerados para prévia, mas `candidateGroups` é omitido e publicação é bloqueada. Não significa atribuição manual.
- Identificadores estáveis (ASCII, `[A-Za-z][A-Za-z0-9_\-]*`); não derive IDs do texto do rótulo a cada regeneração.
- `metadata.provenance`: versão do KnowledgePack, prompt template, modelo/provedor e hash do input, sem armazenar segredos.
- `metadata.requirementProvenance` (opcional): índice por entidade de fonte/confirmação e SHA-256 da citação de evidência. O texto bruto da conversa não é copiado para o ProcessSpec.

## Nós

Cada nó contém `id`, `type`, `name`, `documentation` e propriedades específicas:

- `startEvent`: pode ter `formId` para formulário inicial.
- `endEvent`: variante (none, error, terminate) conforme perfil.
- `userTask`: `roleId`, `formId` (quando aplicável), prazo e comportamento de conclusão.
- `serviceTask`: `action`, normalmente com `connectorId + operationId` aprovados.
- `exclusiveGateway`, `parallelGateway`, `inclusiveGateway`, `eventBasedGateway`: requerem validação própria de roteamento; `defaultFlowId` opcional apenas quando suportado.
- `intermediateCatchEvent`, `intermediateThrowEvent`, `boundaryEvent`: têm `eventDefinition`; boundary referencia `attachedToNodeId`.
- `subProcess`, `callActivity`, `businessRuleTask`, `sendTask`, `receiveTask`, `manualTask`, `scriptTask`: reservados no schema, mas por perfil podem ser desabilitados. Suporte semântico e serialização completos são histórias posteriores.

## Ligações (flows)

`id`, `source`, `target`, `condition?`, `isDefault?`, `label?`. Cada conexão refere IDs existentes. Gateway XOR precisa rotas condicionadas ou default e sem condição conflitante. Uma `condition` é árvore tipada, nunca texto arbitrário gerado pelo LLM.

## Expressão AST permitida

```json
{ "op": "eq", "left": { "var": "decision" }, "right": { "literal": "approved" } }
```

Nós da árvore: `var`, `literal`, `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `not`, `isSet`. Proibidos chamadas de função, texto SQL, eval, scripts e interpolação arbitrária.

## Variáveis

`key`, `type` (`string`, `integer`, `decimal`, `boolean`, `date`, `datetime`, `object`, `array`), `required`, `sensitive`, `source` (`form`, `action`, `constant`, `system`), `enumValues?` e `scope` (`process`/`task`).

A origem deve apontar para formulários/campos ou saídas de ações existentes; não aceitar variáveis implícitas não declaradas. `system` só em catálogo aprovado.

## Formulários

`id`, `name`, `usage` (`start`/`task`), `fields`, campos com `key`, `label`, `type`, `required`, `bindTo`, `options?`, `visibleWhen?`, `requiredWhen?`, `sensitive?`. Tipos desconhecidos são erro; o tradutor form-js deve reconhecer todos os tipos usados, ou devolver erro bloqueante.

## Ações

`capability`, `connectorId`, `operationId`, `inputMapping`, `outputMapping`, `timeoutMs`, `retryPolicy`, `idempotencyKey`, `sideEffectLevel`. Conectores existem em catálogo **administrado pelo runtime**, e não são cadastrados pela IA.

## Questões em aberto

`pendingQuestions`: `id`, `question`, `blocking`, `relatedNodeId?`. Se há questão `blocking`, o estado não deve passar para `ready-for-review` de publicação.

## Invariantes principais

1. IDs de nós/flows/forms/papéis únicos no seu escopo.
2. Um único start simples no perfil POC; pelo menos um endEvent; todos alcançáveis.
3. Toda ligação usa nós existentes e expressões booleanas tipadas.
4. Toda userTask tem responsável explícito ou pendência bloqueante.
5. Formulário de início ligado ao start; formulário de tarefa ligado à userTask.
6. Saída de integração definida deve mapear para variável existente.
7. Ações com escrita externa não podem existir sem `operationId` autorizado e idempotência/revisão.
8. Exportação para runtime exige compatibilidade com perfil de destino **comprovada**.

## Planejado para v2 do ProcessSpec

Colaboração/pools, lanes com governança de atores, nested subprocess, eventos por escopo, multi-instância, SLA/calendário, correlação de mensagens, compensação, versionamento de processos chamados, arrays dinâmicos e regras DMN. A v1 reconhece tipos, mas não promete serialização/executabilidade dos avançados.
