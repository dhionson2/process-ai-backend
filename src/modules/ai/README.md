# Módulo ai

Orquestração conversacional, seleção de conhecimento versionado, propostas, correções limitadas e refinamentos por operações tipadas. Não executa actions nem publica processos.

## Pipeline de um turno

`orchestrator.ts` só compõe; cada etapa fica em `pipeline/`:

```
turn-context  → monta histórico, fatos, conhecimento, schema e prompt (estável primeiro, volátil por último)
interpret     → chamada ao modelo + normalização + 1 correção estrutural
recoverRepeatedQuestion → pergunta já respondida volta ao modelo, nunca ao usuário
readiness     → gate determinístico antes da 1ª proposta (readiness.ts)
compile       → compilador; omissão do modelo recebe 1 correção dirigida
validate      → Validation Engine; 1 correção se nenhuma correção semântica rodou
finalize      → artefatos BPMN/Form ou pergunta orientada pelos diagnósticos
```

Todas as chamadas passam por `ModelCalls`, que acumula latência, tokens, cache e custo. A política de correções fica em `RepairBudget` (`pipeline/types.ts`), no máximo uma estrutural e uma semântica por turno. O GraphIR (`AI_GRAPH_IR_MODE=controlled`) é um caminho experimental e opt-in; o BusinessIntent é o caminho suportado.

## Gate de qualidade

`npm run eval:claude` roda o corpus sintético contra o modelo real e grava uma cassete em `reports/eval/cassettes/`. O `npm test` (`tests/eval-gate.test.ts`) e o `npm run eval:replay` reexecutam o corpus contra a cassete, de forma determinística e sem rede, e cobram os limites de `scripts/eval/gate.json`. Um prompt alterado torna a cassete desatualizada e reprova o gate até uma nova gravação real.

Geração usa uma saída estruturada interna `BusinessIntent`, com atores, atividades, decisões, campos, regras, sugestões, evidências e configuração pendente, sem IDs BPMN ou sequence flows. O backend verifica citações literais de pelo menos duas palavras informativas contra a mensagem do usuário ou respostas confirmadas; conhecimento e inferências nunca confirmam fatos do processo. Sugestões não são compiladas. Uma decisão descrita que não apareça como aprovação/decisão no plano bloqueia a prévia. A biblioteca genérica de padrões compõe o grafo BPMN, variáveis e formulários; ProcessSpec v1 segue sendo validado pelo Validation Engine canônico. Papéis conhecidos sem identidade ou grupo configurado podem compor uma prévia `needs-input`, com pergunta vinculada ao nó. BPMN omite `candidateGroups` nesse caso e a publicação permanece bloqueada. Regras condicionais explícitas, como motivo em caso de reprovação, permanecem no ProcessSpec e não dependem da validação do form-js. O contrato limita atores, campos e itens por ramo; o orquestrador também limita o plano inteiro a 60 atividades e oito níveis de decisão.

Refinamentos usam operações de domínio permitidas, preservam o restante do ProcessSpec e aceitam `baseRevision`. `insertApprovalBefore` exige uma atividade-alvo e um destino explícito para reprovação. Quando a segunda aprovação exige justificativa e o destino notifica o usuário, o compilador preserva a notificação anterior e cria uma projeção declarativa ligada à nova justificativa.

Respostas a perguntas são persistidas em `process_ai_sessions.confirmed_facts`, com migration aditiva e escopo tenant/session. O histórico confirmado tem limite de tamanho antes de entrar no contexto do modelo. Uma pergunta repetida literal ou semanticamente semelhante permite uma tentativa corretiva; nova repetição falha sem criar revisão.

Persistência conversacional usa `beginTurn` para gravar mensagem do usuário, fatos respondidos, limpeza das perguntas, estado `generating` e generation run numa transação curta antes da chamada externa. A conclusão grava proposta, mensagem do assistente, estado, perguntas e run numa segunda transação; provider nunca roda dentro de transação. `operationId` opcional é vinculado por SHA-256 ao tipo e payload da operação e fica único por tenant/sessão; replay devolve o resultado persistido, run ativo não inicia outra chamada e payload diferente retorna conflito. `provider_started_at` é gravado e commitado antes de cada chamada ao provider: falha sem esse marcador é comprovadamente anterior ao provider e pode retomar o mesmo run/operationId; run marcado ou interrompido é incerto e nunca chama provider automaticamente. A recuperação de um estado incerto exige nova operação explícita. Isso evita duplicação pelo backend, mas não promete exactly-once nem comprova o processamento remoto pelo provider. `questionSetId` é derivado das identidades estáveis já contidas no JSONB de perguntas. Runs ativos sem atualização por cinco minutos são reconciliados como `failed` com `GENERATION_INTERRUPTED`; fatos confirmados permanecem no histórico.

O schema usa migrations SQL versionadas em `migrations/`, aplicadas somente pelo comando explícito `npm run db:migrate` com `MIGRATION_DATABASE_URL` no mesmo processo. O runner serializa por advisory lock, verifica checksums e estrutura, grava histórico e falhas; runtime verifica schema/versão e não executa DDL. A V1 adota schema legado somente após verificar colunas, tipos/nullability, constraints e índices; instalações incompatíveis falham fechadas. `npm test` não carrega `.env`; testes PostgreSQL só conectam se `TEST_DATABASE_URL` vier no processo de teste, apontar ao destino local descartável e diferir de `DATABASE_URL`.

Grounding semântico controlado é opt-in via `AI_SEMANTIC_GROUNDING_MODE=controlled`; `legacy` continua sendo o padrão para comparação. O modo controlado exige proveniência literal válida e compara ação, objeto, papel explicitamente citado e polaridade. Só morfologia de ação comum pode normalizar (por exemplo, infinitivo/nominalização); sinônimos não são assumidos. Casos não analisáveis falham fechados como inconclusivos. Perguntas persistem internamente com `questionId`, `requirementId`, `semanticSlot` e estado, e respostas associam `sourceId` ao turno salvo; esses metadados não integram a resposta pública atual. Correção numérica entre turnos é reconciliada somente quando há exatamente um limite explicitamente identificado; com vários candidatos, o resultado é ambíguo e nenhum valor é promovido. Eventos numéricos reconciliados são adicionados ao array `confirmed_facts` JSONB existente com estados `superseded`/`confirmed` e referências de origem; o histórico original continua armazenado. Não há nova tabela ou migration. A reconciliação linguística fora dos slots controlados segue inconclusiva e a reconciliação ampla/durável fica para V2-02C.

O contrato REST público mantém OpenAPI 1.2.0 (aditiva sobre 1.1.0: recovery, understanding, telemetry e evaluation/scoreboard); os schemas de intenção/refinamento são internos ao AI Gateway e não substituem nem enfraquecem o ProcessSpec. Integrações permanecem declarativas e publicação continua bloqueada. Uma saída estruturalmente válida não basta: os testes com Ollama e a fidelidade ao pedido são gates de aceite separados dos testes simulados. Para desenvolvimento local, `AI_MAX_OUTPUT_TOKENS=2048` reduz o custo máximo por resposta estruturada; aumente apenas se medições com o modelo e hardware de destino mostrarem truncamento legítimo.
