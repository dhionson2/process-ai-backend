# Placar de avaliação — Process AI Studio

Gerado em 2026-10-23T20:09:02.273Z. Corpus sintético de 18 cenários (`scripts/eval/scenarios.ts`). Cada linha é a execução mais recente de um provider/modelo.

| Provider | Modelo | Rótulo | Aprovados | Válidos | Importáveis no Modeler | Ajustes | Cobertura média | Invenções | Perguntas repetidas | Latência média | Tokens/cenário | Custo total | Custo por processo válido |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-cli | sonnet | replanejamento | 18/18 (100%) | 100% | 100% | 4/4 | 100% | 0 | 0 | 8.5 s | 9146 | US$ 0.3502 | US$ 0.0195 |

## Detalhe por cenário

### claude-cli / sonnet (replanejamento) — 2026-10-23T20:05:12.321Z

| Cenário | Resultado | Importável | Atividades | Papéis | Decisões | Perguntas | Chamadas | Latência | Falhas |
|---|---|---|---|---|---|---|---|---|---|
| S01-ferias | ✅ validated | ✅ | 2/2 | 3/3 | 1/1+ | 0 | 1 | 5.2 s | — |
| S02-compra | ✅ validated | ✅ | 2/2 | 3/3 | 1/1+ | 0 | 1 | 5.1 s | — |
| S03-reembolso-duas-aprovacoes | ✅ validated | ✅ | 3/3 | 4/4 | 2/2+ | 0 | 1 | 7.5 s | — |
| S04-ferias-incompleto | ✅ validated | ✅ | 1/1 | 1/1 | 1/1+ | 3 | 2 | 10.0 s | — |
| S05-correcao-ciclo | ✅ validated | ✅ | 3/3 | 2/2 | 1/1+ | 0 | 2 | 17.1 s | — |
| S06-contratacao | ✅ validated | ✅ | 3/3 | 3/3 | 2/2+ | 0 | 1 | 8.5 s | — |
| S07-viagem | ✅ validated | ✅ | 2/2 | 3/3 | 1/1+ | 0 | 1 | 5.7 s | — |
| S08-acesso-sistema | ✅ validated | ✅ | 2/2 | 3/3 | 1/1+ | 0 | 1 | 5.2 s | — |
| S09-sem-decisao | ✅ validated | ✅ | 2/2 | 2/2 | 0/0 (nenhuma) | 0 | 1 | 4.9 s | — |
| S10-compra-vaga | ✅ validated | ✅ | 1/1 | 1/1 | 1/1+ | 3 | 2 | 9.7 s | — |
| S11-manutencao | ✅ validated | ✅ | 3/3 | 3/3 | 1/1+ | 0 | 1 | 6.7 s | — |
| S12-treinamento | ✅ validated | ✅ | 2/2 | 2/2 | 1/1+ | 0 | 1 | 7.3 s | — |
| S13-orcamento-ajuste | ✅ validated | ✅ | 3/3 | 2/2 | 1/1+ | 3 | 3 | 29.4 s | — |
| S14-manutencao-predial | ✅ validated | ✅ | 3/3 | 3/3 | 1/1+ | 0 | 1 | 6.6 s | — |
| S15-ferias-pedir-ajuste | ✅ validated | ✅ | 2/2 | 3/3 | 1/1+ | 0 | 1 | 6.9 s | — |
| S16-reembolso-conferencia | ✅ validated | ✅ | 2/2 | 3/3 | 1/1+ | 0 | 1 | 5.5 s | — |
| S17-compra-remover-etapa | ✅ validated | ✅ | 3/3 | 4/4 | 1/1+ | 0 | 1 | 6.3 s | — |
| S18-viagem-renomear | ✅ validated | ✅ | 2/2 | 3/3 | 1/1+ | 0 | 1 | 6.2 s | — |

