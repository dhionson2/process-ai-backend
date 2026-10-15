# Knowledge — Exemplos sintéticos de intenções e perguntas de refinamento

**Objetivo:** ensinar o LLM a escolher BPMN apropriado e identificar informações realmente faltantes. Estes exemplos são fictícios, não regras oficiais de órgãos.

## 1. Pedido de férias

**Descrição:** “Servidor preenche férias, gestor aprova ou rejeita, RH registra se aprovado.”

**Plano:** Start+form → User Task Gestor+form → XOR → User Task RH+form (aprovado) / Notificação (rejeitado) → End.

**Orientação:** se a descrição não definir como localizar o gestor ou o grupo de RH, preserve o papel com atribuição pendente e bloqueie publicação. Isso não impede a prévia. Preserve qualquer resolução de papéis e regra de rejeição já declarada. Não pergunte sobre limites legais de dias quando o solicitante não pedir essa validação.

## 2. Aquisição de material

**Descrição:** “Solicitante pede material, almoxarifado verifica, se tiver entrega; se não, compras solicita cotação.”

**Plano:** Start/form → Almoxarifado → XOR estoque → entregar ou compras/cotação → End.

**Perguntas:** quem confirma disponibilidade, orçamento, prazo e autorização para compra?

## 3. Revisão paralela

**Descrição:** “Financeiro e jurídico precisam analisar ao mesmo tempo; conclusão depende dos dois.”

**Plano:** AND split → duas userTasks → AND join; rejeição requer condição de negócio adicional.

**Pergunta:** qualquer reprovação encerra imediatamente ou deve aguardar ambas? Sem essa resposta, não modelar união potencialmente bloqueante.

## 4. API pública

**Descrição:** “Ao abrir o pedido, consulte status do CNPJ numa API.”

**Plano:** serviceTask declarativa `http.request`; mapear `cnpj` para operationId autorizado, retorno validado em variável. HTTP 404, timeout e indisponibilidade exigem decisão de negócio.

**Pergunta:** operação aprovada no catálogo? Como tratar resposta não encontrada?

## 5. Update no banco

**Descrição:** “Quando aprovado, altere status do registro na tabela.”

**Plano:** gateway aprovado → serviceTask `database.record.update` apontando para operação previamente autorizada. Solicitar registro/chave, campos permitidos, controle de concorrência e confirmação.

**Pergunta:** existe operação registrada para isso? Não gerar SQL livre nem credenciais.

## 6. SLA e escalonamento

**Descrição:** “Se o gerente não responder em 48 horas, avise o diretor, mas mantenha a tarefa aberta.”

**Plano:** boundary timer **não interruptivo**, canal de notificação idempotente, time zone e calendário definidos.

**Pergunta:** horas corridas ou úteis? Qual o critério de início da contagem?

## 7. Correção e reenvio

**Descrição:** “Se faltar documento, servidor corrige e reenvia para análise.”

**Plano:** tarefa de revisão com loop e condição de saída explícita; impedir ciclo sem ponto de término.

**Pergunta:** quantas tentativas, expirabilidade e como registrar histórico?

## 8. Assinatura e documentos

**Descrição:** “Após aprovação, gere documento e peça assinatura do responsável.”

**Plano:** document.generate → document.sign.request ou tarefa humana de assinatura, dependendo do perfil real.

**Pergunta:** template autorizado, signatários, ordem e evidência exigida?

## 9. Subprocesso reutilizável

**Descrição:** “Para qualquer compra, execute o mesmo subprocesso de compliance já existente.”

**Plano:** callActivity apenas se ID/version e autorização do subprocesso existirem no catálogo.

**Pergunta:** qual processo e versão de referência?

## 10. Solicitação ambígua

**Descrição:** “Quando chegar o documento, aprove tudo automaticamente.”

**Conduta:** retornar `need_clarification`, identificar quem tem competência, quais regras objetivas validam a aprovação e exceções. Não substituir julgamento humano por LLM.
