# Knowledge — Formulários, campos, validações e vínculos

## Princípio

**FormSpec de domínio** é independente de biblioteca; **Form JSON** é gerado por um adaptador `form-js`. Não assumimos que qualquer controle imaginado pela IA seja suportado pela versão instalada.

## Componentes de domínio

| Tipo de campo de domínio | Tradução potencial no form-js | Verificar na versão real |
| --- | --- | --- |
| text | textfield | maxlength, pattern, readonly |
| textarea | textarea | limite, sanitização e formatação |
| integer/decimal | number | min/max, precisão e localização |
| boolean | checkbox | default, required, semântica de opção não marcada |
| select | select | valores estáveis, opção vazia |
| date/datetime | datetime | subtipo, fuso e serialização |
| email | textfield + validação | validador de email da versão atual |
| attachment | componente de arquivo/adaptador | upload e armazenamento exigem contrato próprio |
| group/repeating/table | se suportado no perfil | arrays e dados aninhados; não presumir suporte |
| markdown/info | text | evitar XSS e links injetados |

## Campos e variáveis

- `field.key`: estável e única no formulário.
- `field.bindTo`: referencia variável existente do ProcessSpec; igualar tipo do campo e variável ou declarar conversor explícito.
- `required`: validação visual e **servidor**; condicionalidade requer reevaluar obrigatoriedade em cenários distintos.
- `options`: valores tipados e estáveis; label pode ser traduzido, valor não deve mudar sem migração.
- `visibleWhen`: AST de expressão; não escrever string de código da IA diretamente na condição de form-js.
- `writeScope`: início do processo, conclusão da tarefa ou escopo local; diferenciar dados do formulário e metadados de execução.
- Campo sensível: mascaramento, minimização de logs e controle de acesso, nunca copiar automaticamente para prompt externo.
- Campos de resultado de serviceTask não devem ser editáveis pelo usuário se são de origem de sistema.

## Ligação ao BPMN

- Formulário de abertura: associado ao evento de início no contrato de aplicação.
- Formulário humano: associado a cada `userTask` com `formId`.
- Formulário do gateway? **Não**; a decisão deve derivar de variável produzida por tarefa/formulário/serviço anterior.
- Formulário opcional somente onde previsto pelo processo, não por conveniência.
- Formulário para integração HTTP não é necessário; serviço recebe dados por input mapping.

## Exemplo de regra de aprovação

`decision` é enum `approved | rejected`; `reason` é campo texto com validação condicional obrigatória quando `decision == rejected`. Essa condição **não pode ser exigida apenas pela IA**; deve existir também na camada de validação de domínio/runtime.

## Geração de schema

O gerador mapeia FormSpec para `{"type":"default","components":[...]}` compatível com a versão-alvo; IDs/keys estáveis; propriedades desconhecidas produzem `UNSUPPORTED_FORM_FIELD` e não são omitidas silenciosamente. Validar importação em `FormEditor` e viewer em testes de integração.

**Referência técnica:** https://github.com/bpmn-io/form-js/blob/develop/docs/FORM_SCHEMA.md
