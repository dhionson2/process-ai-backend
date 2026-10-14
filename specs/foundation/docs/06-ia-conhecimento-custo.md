# 06 — Conhecimento, RAG opcional, adaptadores de LLM e custo

## Knowledge Engine v1

O repositório do backend contém módulos versionados com fontes e testes: `bpmn-20.md`, `forms.md`, `integrations.md`, `system-policy.md`, exemplos ouro e catálogo efetivo de capacidades.

**Carregamento por intenção:** classificar requisitos em elementos (aprovação, integração, decisão, timer, SLA, formulário etc.), selecionar módulos relevantes, acrescentar exemplos ouro pequenos, construir contexto + schema de saída. Limitar tamanho por token budget, antes de chamar o provider.

**Não fazer no início:** treinamento de modelo, vetor db, busca semântica, múltiplos agentes especialistas chamando uns aos outros ou loops automáticos de reparo longos. Adotar somente quando benchmark mostrar ganho real.

## Interface agnóstica de provedor

```ts
interface ModelProvider {
  id: string;
  capabilities(): { jsonSchema: boolean; contextLimit?: number };
  generateStructured(args: {
    model: string;
    instructions: string;
    context: string;
    jsonSchema: object;
    budget: { maxOutputTokens: number; timeoutMs: number };
  }): Promise<{ value: unknown; usage?: unknown; latencyMs: number }>;
}
```

Adaptações específicas são responsabilidade de `OllamaProvider`, `OpenAIProvider`, `AnthropicProvider`, `GeminiProvider`; capacidade JSON schema pode variar entre modelos/versionamentos, então capability negotiation + benchmark é essencial.

## Sequência econômica sugerida

1. **Sem IA** para validação de campos, compilação AST, BPMN XML, form JSON, layout básico e cálculos.
2. **Uma chamada de geração estruturada** para requisitos claros; perguntas objetivas antes de gerar quando faltar regra crítica.
3. **Uma tentativa máxima de reparo** com diagnósticos reduzidos.
4. Ajustes conversacionais preferencialmente em **patch de ProcessSpec** e com contexto resumido, sem regenerar tudo na IA.
5. Seleção de provedor conforme qualidade por benchmark, orçamento e política; não escolher Ollama só por ausência de cobrança por token.
6. Métricas por `generationRun`: latência, taxa de sucesso, tokens/uso, custo variável, número de reparos, custo total até revisão aprovada e qualidade pós-humano.
7. Cache apenas de artefatos determinísticos e prompts reutilizáveis sem dados de clientes; não compartilhar cache de conversas entre tenants.

## Critérios para RAG no futuro

Corpus com centenas/milhares de padrões aprovados, versões, anexos e exemplos distintos; benchmark demonstrando ganho de aderência; filtros por tenant/ACL e controle de vazamento. Começar com seleção estruturada por tags, mais barata e auditável.

## Avaliação multi-modelo

Conjunto de 30 casos: simples, aprovações, múltiplos caminhos, loops, integrações, exceções, formulários condicionais, descrições ambíguas e ataques de prompt injection. Julgar saída por schema, semântica, validação, fidelidade por rubrica humana e custo por processo revisável. Sem prometer mesmo resultado para todos os modelos.
