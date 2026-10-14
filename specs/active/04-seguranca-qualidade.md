# Segurança e qualidade — requisitos inegociáveis

## Estado do bootstrap
**LOCAL DEV APENAS.** Não tem autenticação, autorização, banco, rate limit corporativo nem controles antiabuso de produção. Os endpoints existentes são de leitura de amostras e validação offline.

## Segurança para evolução
- Autenticação via OIDC; autorização servidor por tenant, RBAC e recurso; nenhuma confiança em tenant fornecido pelo navegador.
- Segredos somente via mecanismos externos aprovados; NUNCA em repo/log/prompt; `.env.example` sem valores sensíveis.
- Isolamento tenant ponta a ponta, incluindo histórico, cache, logs, respostas LLM e arquivos exportados.
- Privacidade/LGPD: classificação e minimização de dados, retenção, política explícita de provedores/região.
- Prompt injection: entradas e documentos são conteúdo não confiável, nunca instruções com privilégios.
- Chamadas externas e queries SQL são somente **modeladas**; execução via conectores autorizados, com idempotência, escopo, orçamento e aprovação.
- SSRF: ao futuramente executar HTTP, usar catálogo de destinos aprovado, sem URL arbitrária nem IP privado/metadata.
- No futuro: limites de tamanho/custo/tempo/concorrência, timeouts, circuit breakers, rastreio sem payload sensível.
- Default: sem fallback de IA local -> cloud, sem publicar, sem executar, sem salvar dados reais na POC.
- Falha no validador ou compatibilidade desconhecida => negar aprovação, não degradar silenciosamente.

## Quality gates
- `npm run typecheck`, `npm run test`, `npm run build` e smoke manual.
- Backend: fixtures, schema 2020-12, nós/referências/variáveis, decisões, side effects; ampliar cobertura incremental.
- Frontend: preview real com bpmn-js e form-js em browser, com tratamento de erro e componentes desmontados corretamente.
- Contratos OpenAPI e dependências devem ser travados em `package-lock.json` na primeira instalação conectada.
- Não alegar que BPMN XML importável é automaticamente executável no Flowable/Unique.
