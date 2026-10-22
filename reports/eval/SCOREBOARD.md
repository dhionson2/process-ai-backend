# Placar de avaliação — Process AI Studio

Gerado em 2026-10-22T23:02:16.772Z. Corpus sintético de 12 cenários (`scripts/eval/scenarios.ts`). Cada linha é a execução mais recente de um provider/modelo.

| Provider | Modelo | Rótulo | Aprovados | Válidos | Cobertura média | Invenções | Perguntas repetidas | Latência média | Tokens/cenário | Custo total | Custo por processo válido |
|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-cli | sonnet | depois | 12/12 (100%) | 100% | 100% | 0 | 0 | 9.8 s | 9289 | US$ 0.2686 | US$ 0.0224 |
| claude-cli | sonnet | antes | 10/12 (83%) | 100% | 92% | 0 | 0 | 7.7 s | 8071 | US$ 0.1836 | US$ 0.0153 |
| claude-cli | claude-haiku-5-5 | depois | 9/12 (75%) | 83% | 83% | 0 | 2 | 22.2 s | 22145 | US$ 1.7465 | US$ 0.1747 |

## Detalhe por cenário

### claude-cli / sonnet (depois) — 2026-10-22T23:00:16.786Z

| Cenário | Resultado | Atividades | Papéis | Decisões | Perguntas | Chamadas | Latência | Falhas |
|---|---|---|---|---|---|---|---|---|
| S01-ferias | ✅ validated | 2/2 | 3/3 | 1/1+ | 0 | 1 | 5.3 s | — |
| S02-compra | ✅ validated | 2/2 | 3/3 | 1/1+ | 0 | 1 | 5.2 s | — |
| S03-reembolso-duas-aprovacoes | ✅ validated | 3/3 | 4/4 | 2/2+ | 0 | 1 | 8.7 s | — |
| S04-ferias-incompleto | ✅ validated | 1/1 | 1/1 | 1/1+ | 3 | 2 | 9.7 s | — |
| S05-correcao-ciclo | ✅ validated | 3/3 | 2/2 | 1/1+ | 1 | 2 | 17.1 s | — |
| S06-contratacao | ✅ validated | 3/3 | 3/3 | 2/2+ | 0 | 1 | 9.8 s | — |
| S07-viagem | ✅ validated | 2/2 | 3/3 | 1/1+ | 0 | 1 | 7.2 s | — |
| S08-acesso-sistema | ✅ validated | 2/2 | 3/3 | 1/1+ | 0 | 1 | 6.8 s | — |
| S09-sem-decisao | ✅ validated | 2/2 | 2/2 | 0/0 (nenhuma) | 0 | 1 | 7.4 s | — |
| S10-compra-vaga | ✅ validated | 1/1 | 1/1 | 1/1+ | 4 | 2 | 13.4 s | — |
| S11-manutencao | ✅ validated | 3/3 | 3/3 | 1/1+ | 0 | 1 | 8.4 s | — |
| S12-treinamento | ✅ validated | 2/2 | 2/2 | 1/1+ | 1 | 2 | 18.4 s | — |

### claude-cli / sonnet (antes) — 2026-10-22T20:30:49.350Z

| Cenário | Resultado | Atividades | Papéis | Decisões | Perguntas | Chamadas | Latência | Falhas |
|---|---|---|---|---|---|---|---|---|
| S01-ferias | ✅ validated | 2/2 | 3/3 | 1/1+ | 0 | 1 | 5.3 s | — |
| S02-compra | ✅ validated | 2/2 | 3/3 | 1/1+ | 0 | 1 | 5.2 s | — |
| S03-reembolso-duas-aprovacoes | ✅ validated | 3/3 | 4/4 | 2/2+ | 0 | 1 | 9.1 s | — |
| S04-ferias-incompleto | ❌ validated | 1/1 | 1/1 | 1/1+ | 0 | 1 | 3.5 s | não perguntou antes de gerar |
| S05-correcao-ciclo | ✅ validated | 3/3 | 2/2 | 1/1+ | 0 | 1 | 8.2 s | — |
| S06-contratacao | ✅ validated | 3/3 | 3/3 | 2/2+ | 0 | 1 | 10.3 s | — |
| S07-viagem | ✅ validated | 2/2 | 3/3 | 1/1+ | 0 | 1 | 5.6 s | — |
| S08-acesso-sistema | ✅ validated | 2/2 | 3/3 | 1/1+ | 0 | 1 | 5.7 s | — |
| S09-sem-decisao | ✅ validated | 2/2 | 2/2 | 0/0 (nenhuma) | 0 | 1 | 4.7 s | — |
| S10-compra-vaga | ❌ validated | 0/1 | 0/1 | 0/1+ | 3 | 2 | 10.2 s | cobertura incompleta |
| S11-manutencao | ✅ validated | 3/3 | 3/3 | 1/1+ | 1 | 2 | 18.2 s | — |
| S12-treinamento | ✅ validated | 2/2 | 2/2 | 1/1+ | 0 | 1 | 6.9 s | — |

### claude-cli / claude-haiku-5-5 (depois) — 2026-10-22T21:24:48.123Z

| Cenário | Resultado | Atividades | Papéis | Decisões | Perguntas | Chamadas | Latência | Falhas |
|---|---|---|---|---|---|---|---|---|
| S01-ferias | ✅ validated | 2/2 | 3/3 | 1/1+ | 0 | 1 | 13.6 s | — |
| S02-compra | ✅ validated | 2/2 | 3/3 | 1/1+ | 0 | 1 | 8.8 s | — |
| S03-reembolso-duas-aprovacoes | ✅ validated | 3/3 | 4/4 | 2/2+ | 1 | 2 | 35.0 s | — |
| S04-ferias-incompleto | ✅ validated | 1/1 | 1/1 | 1/1+ | 3 | 2 | 18.8 s | — |
| S05-correcao-ciclo | ❌ validated | 3/3 | 2/2 | 1/1+ | 2 | 3 | 50.5 s | 1 pergunta(s) repetida(s) |
| S06-contratacao | ✅ validated | 3/3 | 3/3 | 2/2+ | 0 | 1 | 14.1 s | — |
| S07-viagem | ✅ validated | 2/2 | 3/3 | 1/1+ | 0 | 1 | 10.1 s | — |
| S08-acesso-sistema | ✅ validated | 2/2 | 3/3 | 1/1+ | 0 | 1 | 13.4 s | — |
| S09-sem-decisao | ✅ validated | 2/2 | 2/2 | 0/0 (nenhuma) | 0 | 1 | 6.1 s | — |
| S10-compra-vaga | ✅ validated | 1/1 | 1/1 | 1/1+ | 4 | 2 | 13.5 s | — |
| S11-manutencao | ❌ needs-input | - | - | - | 2 | 3 | 44.2 s | resultado needs-input |
| S12-treinamento | ❌ needs-input | - | - | - | 2 | 3 | 38.1 s | resultado needs-input; 1 pergunta(s) repetida(s) |

