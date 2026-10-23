# Placar de avaliação — Process AI Studio

Gerado em 2026-10-23T00:12:37.030Z. Corpus sintético de 14 cenários (`scripts/eval/scenarios.ts`). Cada linha é a execução mais recente de um provider/modelo.

| Provider | Modelo | Rótulo | Aprovados | Válidos | Cobertura média | Invenções | Perguntas repetidas | Latência média | Tokens/cenário | Custo total | Custo por processo válido |
|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-cli | sonnet | depois | 13/14 (93%) | 100% | 99% | 0 | 0 | 12.3 s | 12055 | US$ 0.4515 | US$ 0.0323 |

## Detalhe por cenário

### claude-cli / sonnet (depois) — 2026-10-23T00:09:44.691Z

| Cenário | Resultado | Atividades | Papéis | Decisões | Perguntas | Chamadas | Latência | Falhas |
|---|---|---|---|---|---|---|---|---|
| S01-ferias | ✅ validated | 2/2 | 3/3 | 1/1+ | 0 | 1 | 5.2 s | — |
| S02-compra | ✅ validated | 2/2 | 3/3 | 1/1+ | 0 | 1 | 5.7 s | — |
| S03-reembolso-duas-aprovacoes | ✅ validated | 3/3 | 4/4 | 2/2+ | 0 | 1 | 8.4 s | — |
| S04-ferias-incompleto | ✅ validated | 1/1 | 1/1 | 1/1+ | 3 | 2 | 9.6 s | — |
| S05-correcao-ciclo | ✅ validated | 3/3 | 2/2 | 1/1+ | 0 | 2 | 15.6 s | — |
| S06-contratacao | ✅ validated | 3/3 | 3/3 | 2/2+ | 0 | 1 | 8.9 s | — |
| S07-viagem | ✅ validated | 2/2 | 3/3 | 1/1+ | 0 | 1 | 5.3 s | — |
| S08-acesso-sistema | ✅ validated | 2/2 | 3/3 | 1/1+ | 0 | 1 | 5.9 s | — |
| S09-sem-decisao | ✅ validated | 2/2 | 2/2 | 0/0 (nenhuma) | 0 | 1 | 5.0 s | — |
| S10-compra-vaga | ✅ validated | 1/1 | 1/1 | 1/1+ | 3 | 2 | 17.1 s | — |
| S11-manutencao | ✅ validated | 3/3 | 3/3 | 1/1+ | 2 | 4 | 30.5 s | — |
| S12-treinamento | ✅ validated | 2/2 | 2/2 | 1/1+ | 0 | 2 | 13.8 s | — |
| S13-orcamento-ajuste | ❌ validated | 2/3 | 2/2 | 1/1+ | 2 | 3 | 33.7 s | cobertura incompleta |
| S14-manutencao-predial | ✅ validated | 3/3 | 3/3 | 1/1+ | 0 | 1 | 6.9 s | — |

