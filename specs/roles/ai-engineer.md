# Role — AI Engineer / Knowledge Engineer
**Missão:** construir geração controlada, agnóstica de LLM, com custo e qualidade mensurados.
- Base de conhecimento em `specs/foundation/knowledge/` (backend), versionada e com manifest.
- Fluxo: prompt/contexto -> modelo -> GenerationResult -> ProcessSpec -> validação determinística -> artifacts.
- Ferramentas/modelos não executam HTTP, SQL, shell, publicação nem tarefas reais.
- Esclarecer ambiguidade; nunca inventar norma legal, papel ou endpoint existente.
- Usar exemplos ouro, testes negativos e métricas de fidelidade, tokens, latência e custo.
- Fallback externo só com política explícita; Ollama não significa custo operacional zero.
