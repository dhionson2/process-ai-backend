# Process AI — Backend (nome provisório)

API TypeScript/Fastify para modelagem declarativa de processos. O backend mantém ProcessSpec como contrato canônico, valida o domínio e gera artefatos BPMN 2.0 e Form JSON determinísticos. Não executa os conectores descritos nos fluxos e não publica processos.

## Estado da Fase 2

- AI Gateway configurável com Ollama e adaptador compatível com OpenAI. O adaptador externo exige habilitação explícita e nunca é fallback automático.
- Knowledge Engine seleciona trechos versionados de BPMN, formulários, políticas e exemplos.
- Orquestração gera um plano BPMN estruturado compacto, compõe ProcessSpec v1 determinísticamente, valida pelo Validation Engine e permite no máximo uma correção. Refinamentos usam operações tipadas e pontuais; ambiguidades são encaminhadas como perguntas.
- A extração usa BusinessIntent interno com evidências/proveniência; o ProcessSpec guarda apenas fonte, estado de confirmação e hash SHA-256 da evidência. Padrões de processo são compostos pelo backend. Pendências de identidade podem gerar prévias `needs-input`, nunca publicação.
- A geração conversacional opcional por GraphIR é ativada por `AI_GRAPH_IR_MODE=controlled`; `off` permanece como default. O provider recebe uma projeção plana, GraphIR é validado, reduzido ao ProcessSpec v1 e passa pelos mesmos validadores e geradores BPMN/Form. Refinamentos continuam temporariamente no caminho ProcessSpec; `shadow` registra a comparação como pendente sem chamada extra. A projeção inicial não inclui serviceTask, gateways não-XOR nem expressões arbitrárias.
- Projetos, sessões, mensagens, runs e revisões são persistidos em PostgreSQL. Aceitar uma revisão usa `baseRevision` para detectar concorrência; propostas não substituem o rascunho atual antes do aceite.
- Testes automáticos incluem providers simulados, PostgreSQL real local, API, cenários de falha e importação/serialização de BPMN e formulários em Chromium. O teste real de 2026-10-14 com Ollama 0.40.4 e `qwen2.5:3b-instruct` comprovou perguntas e persistência, mas o modelo não produziu ProcessSpec semanticamente válido após uma correção; um refinamento sobre revisão válida também falhou e deixou a revisão atual intacta. A Fase 2 continua aberta.
- Desenvolvimento local somente: não há autenticação, autorização multiusuário, execução de conectores nem publicação.

## Requisitos e comandos

Node.js 22 LTS, npm e Docker Desktop para PostgreSQL local de desenvolvimento. A API conversacional requer também Ollama com o modelo configurado.

```bash
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npm run generate:examples
npm run evaluate:ollama
npm run evaluate:business-intent
npm run benchmark:groq
```

Configure as variáveis a partir de `.env.example`. Para habilitar conversas locais, inicie o Ollama, execute `ollama pull qwen2.5:3b-instruct` e defina `DATABASE_URL`, `AI_PROVIDER=ollama` e `AI_MODEL=qwen2.5:3b-instruct`; Ollama usa por padrão `http://127.0.0.1:11434`. A configuração inicial mantém IA desabilitada e não usa fallback externo. A API de modelagem e os exemplos continuam disponíveis com IA desabilitada.

`npm run evaluate:business-intent` executa exatamente uma chamada local por cenário (férias e aprovação simples), sem reparos ou respostas simuladas, e passa a saída pelo compilador/validador.

`npm run benchmark:groq` inicia uma instância temporária da API em porta local livre, usa PostgreSQL configurado em `DATABASE_URL`, chama `https://api.groq.com/openai/v1` com `openai/gpt-oss-120b` em Structured Outputs estrito e importa artefatos gerados em Chromium. Exige `EXTERNAL_AI_API_KEY` no `.env`, apenas dados fictícios e respeita limites cumulativos de 15 chamadas e 50 mil tokens por execução. Uma única repetição após HTTP 429 só ocorre quando `Retry-After` informa até 60 segundos. Para continuar uma avaliação parcial, informe os totais já consumidos em `GROQ_BENCHMARK_CALLS_ALREADY_SPENT` e `GROQ_BENCHMARK_TOKENS_ALREADY_SPENT`; o script reduz o orçamento restante. Não há fallback de provider.

No PowerShell, comece com `Copy-Item .env.example .env` e substitua as credenciais de desenvolvimento local. Os scripts `dev` e `start` carregam `.env`; `test` recebe as variáveis do processo chamador. Execute `npm run db:up` para iniciar PostgreSQL (volume persistente; porta limitada a localhost) e `npm run db:down` para pará-lo sem apagar dados. Aplique o schema explicitamente antes de iniciar a API: `$env:MIGRATION_DATABASE_URL=$env:DATABASE_URL; npm run db:migrate`. Esse comando não carrega `.env`; a URL deve ser fornecida no processo PowerShell que o executa. Migrations versionadas ficam em `migrations/`, registram checksum e versão em `process_ai_schema_migrations`, são serializadas por advisory lock e mantêm tentativas com falha em `process_ai_schema_migration_failures`. O runtime apenas confere tabelas, colunas, constraints, índices e versão aplicada; não executa DDL e não precisa de permissões DDL.

## API

- `GET /health`, `/api/v1/capabilities`, `/api/v1/examples` e `/api/v1/examples/{id}`.
- `POST /api/v1/validate`, `/api/v1/validate-form`, `/api/v1/publication/validate` e `/api/v1/generate`.
- `POST /api/v1/projects` cria projeto e sessão.
- `/api/v1/design-sessions/{sessionId}` oferece mensagens, respostas a perguntas, refinamentos, rascunho, histórico e revisões.
- `POST /api/v1/design-sessions/{sessionId}/revisions/{revision}/accept` aceita uma proposta mediante `baseRevision`.
- `GET /api/v1/generation-runs/{runId}` consulta estado e métricas.
- `GET /openapi.json` serve o contrato versionado em `specs/contracts/process-ai-api.v1.openapi.json` e o schema ProcessSpec canônico.

`POST /api/v1/generate` cria artefatos válidos para prévia. A validação de submissão aplica `required` e `requiredWhen` do ProcessSpec fora do form-js. O manifesto mantém a publicação bloqueada quando o runtime não garante validação condicional.

O provedor externo é bloqueado por padrão. Para habilitá-lo, o operador deve definir `AI_PROVIDER=openai-compatible`, `EXTERNAL_AI_APPROVED=true`, `EXTERNAL_AI_BASE_URL`, `EXTERNAL_AI_API_KEY` e `AI_MODEL`. A credencial permanece no backend. Envie ao provedor externo apenas dados sintéticos ou públicos. Nenhuma chamada HTTP, SQL ou serviço declarados pelo usuário é executada. `EXTERNAL_AI_STRUCTURED_OUTPUT=json-schema-strict` ativa Structured Outputs estrito no adaptador compatível com OpenAI; o schema enviado é uma projeção técnica e o contrato interno e seus validadores continuam sendo a autoridade. O modo padrão continua `json-object` para compatibilidade. `AI_MAX_PROVIDER_CALLS` e `AI_MAX_PROVIDER_TOKENS` aplicam limites cumulativos locais por instância; `0` mantém sem limite local.

O inicializador de desenvolvimento `D:\dev\Process\iniciar-process-ai-v2.ps1 -EnableGroq` seleciona Groq, `openai/gpt-oss-120b`, JSON Object, GraphIR controlado e limites locais de chamadas/tokens iguais a zero. Esses limites podem ser habilitados para uma sessão com `-ProviderMaxCalls N` e `-ProviderMaxTokens N`; sem esses parâmetros, a conta Groq aplica suas próprias cotas. O formato JSON Object é validado localmente pelo parser, GraphIR, Coverage Gate e ProcessSpec antes de qualquer proposta ser persistida. `GET /api/v1/providers/status` mostra configuração efetiva sanitizada; detalhes de falha ficam disponíveis em `GET /api/v1/generation-runs/:id`. HTTP 400 não é repetido automaticamente; HTTP 429 só pode ser repetido uma vez quando `Retry-After` explicita espera de até 60 segundos.

`AI_GRAPH_IR_MODE=off|shadow|controlled` mantém `off` como padrão. `controlled` só altera novas gerações iniciais; propostas inválidas falham sem fallback automático. Refinamentos usam o mecanismo ProcessSpec atual, sem GraphPatch. `shadow` não faz uma segunda chamada paga e permanece diagnóstico pendente até existir comparação independente.

## Estrutura

- `src/` — aplicação e módulos TypeScript.
- `tests/` — testes automatizados, incluindo importação em Chromium.
- `specs/active/` — decisões e planejamento atuais.
- `specs/foundation/` — contratos, conhecimento e cenários de referência.
- `npm run generate:examples` — atualiza BPMN/Form/manifest dos exemplos usando o gerador TypeScript.

Não usar em produção sem autenticação/autorização, política operacional para dados, migrações geridas e configuração segura dos serviços. Não criar commits automaticamente.
