# Demo — Process AI no Modeler pela extensão do Chrome (22/10/2026)

Entrega das fases 0–4 do SDD `docs/sdd/SDD-extensao-chrome-modeler.md` (opção B: entrega pela porta «Abrir»; D3 = formulário por download). O Modeler (`unique/modeler`) não foi alterado.

## O que foi provado

| Porta de saída (SDD §9) | Evidência |
| --- | --- |
| Fase 0 — Modeler importa `.bpmn` do Process AI; 14 BPMN e 30 formulários do placar passam as cadeias de validação | Vitest no worktree de scratch do Modeler: 44/44 (`validateBpmnXmlString`, `validarDefinicaoRemota`); importação real via Playwright: 27 elementos no canvas |
| Fase 1 — extensão com Playwright `--load-extension` verde; recusa, ausência de editor e descarte negado com mensagem | `process-ai-extension`: `npm test` 11/11 (jsdom), `npm run e2e` 1/1 (jornada pela UI do painel + recusa DTD + descarte negado/aceito + sem editor) |
| Fase 2 — critério «importável» no gate de replay, 100% importável | `npm run eval:replay`: 13/14 aprovados, 100% válidos, **100% importáveis**, cassete inalterada (`gate.json` minImportableRate=1) |
| Fase 3 — formulário | «Baixar formulário (.form.json)» no painel; schema com `schemaVersion: 19` e `id` |
| Fase 4 — ensaio real cronometrado | `node e2e/ensaio-real.mjs`: **9,6 s** da descrição ao canvas do Modeler; 1 chamada Sonnet 5.5, 6,1 mil tokens entrada / 627 saída, **US$ 0,0325** |

Capturas em `docs/demo/extensao-20261022/`: `ensaio-painel-revisao.png` (painel), `ensaio-modeler-importado.png` (canvas do Modeler com o reembolso), `ensaio-painel-formulario.png`, `painel-entregue.png` (E2E com fixture).

## Subir o ambiente da demo

```bash
# 1. Backend com a origem fixa da extensão no CORS
cd process-ai-backend
CORS_ORIGIN=http://127.0.0.1:5185,chrome-extension://lfmnkhajanjbdffodipmnakgppjhfjnk PORT=3346 \
  AI_PROVIDER=claude-cli EXTERNAL_AI_APPROVED=true AI_MODEL=sonnet DATABASE_URL=... npm run dev

# 2. Modeler local (worktree limpo de unique/modeler, sem alterações) com a Design API
DESIGN_API_DEV_PROXY_TARGET=http://127.0.0.1:3131 VITE_BPM_DESIGN_MOCK_SETORES=true node node_modules/vite/bin/vite.js --port 5193 --strictPort --host 127.0.0.1

# 3. Extensão
cd process-ai-extension && cp .env.example .env && npm install && npm run build
# chrome://extensions → Modo do desenvolvedor → Carregar sem compactação → dist/
```

## Roteiro (8 minutos)

1. **Contexto (1 min)** — Modeler aberto no Gerenciador. "O Modeler é o nosso editor; a IA não entra nele por API nem por script: entra pela mesma porta que uma pessoa usa, o «Abrir»."
2. **Fluxo vazio (30 s)** — «Novo» → Fluxo → nome → «Criar e abrir editor». Clique no ícone da extensão: o painel mostra `Modeler: editor de fluxo aberto`.
3. **Descrever (2 min)** — «＋ Novo projeto» → descrever o reembolso (texto do `ensaio-real.mjs`). Mostrar progresso por SSE e, se houver, a pergunta de esclarecimento; responder.
4. **Entender antes de desenhar (1 min)** — painel «O que entendi»: participantes, etapas e decisões com origem ("você descreveu"); custo e latência no painel de telemetria.
5. **Entregar (1 min)** — «Enviar para o Modeler». O canvas desenha; a mensagem diz para revisar e **salvar no Modeler** — a extensão nunca salva.
6. **Guardas (1,5 min)** — mover um elemento no Modeler e enviar de novo: o Modeler pergunta sobre descarte; cancelar → o painel diz que nada foi substituído. Voltar ao Gerenciador e enviar: "sem editor aberto".
7. **Formulário (30 s)** — aba Formulários → «Baixar formulário (.form.json)»: o form-js do Modeler aceita (allowlist, schemaVersion 19).
8. **Fecho (30 s)** — placar: 13/14, 100% importável, US$ 0,03 por processo; roadmap: «Abrir» no editor de formulário (D3 b, com ADR), OIDC no piloto.

## Pendências e riscos

- Falhas pré-existentes fora do escopo: `tests/ai-phase2.test.ts` (1 caso, reproduz no tree anterior) e os 5 testes Chromium do frontend quando outra instância ocupa a porta 5173.
- Seletores da extensão presos à versão atual do Modeler (`input.editor-file-input`, `.editor-control-status`, `.editor-dialog-backdrop`, `indicadorNaoSalvo`); o E2E é o alarme.
- `attachment` do ProcessSpec vira `filepicker`, que o Modeler não admite; o critério «importável» acusa se um cenário gerar esse tipo (nenhum do corpus gera).
- URL do Modeler em HML, política corporativa de extensões e chave da API Anthropic continuam pendentes (SDD §12).


---

## Atualização 23/10/2026 — chat flutuante, ajuste por replanejamento e canal do Modeler

| Onda | O que mudou | Evidência |
| --- | --- | --- |
| A · Extensão | Chat ↔ aba do Modeler por `postMessage` (sem service worker no caminho) | fim do «Crio um para você?» repetido |
| B · Backend | Ajuste = replanejamento completo com preservação (nada some sem pergunta); citação tolera erro de digitação; confirmações em UMA rodada; decisão «Aprovado/Rejeitado» conta como aprovação | placar **18/18**, ajustes **4/4**, 100% importável, US$ 0,35; `tests/refinement-replan.test.ts` |
| C · Backend | Layout automático com ELK (layered), setas ortogonais, rótulos de data/hora corretos no form-js | exemplos regenerados; replay verde |
| D · Modeler (branch `feat/process-ai-assistant-bridge`, commit `1fbb16a`, SEM merge) | ADR-0019: canal do assistente na própria janela — `get-state`, `get-xml`, `apply-xml`, `apply-form`, `apply-patch` (renomear/documentar/remover com Ctrl+Z); flag `VITE_BPM_DESIGN_ASSISTANT_CHANNEL=on` | 2.523 testes, lint, build com `verify:bundle`; gates emendados nominalmente (G-8, build-env, premature-consumer-guard) |
| E · Extensão | Cliente próprio tipado pelo OpenAPI (sem importar o frontend), `npm run pack`, README de distribuição (`ExtensionInstallForcelist`) e identidade | `verify` verde; `release/process-ai-extension-0.2.0.zip` |

Ensaio real com o Claude pelo canal do Modeler (23/10): descrição → fluxo criado pelo chat e desenhado (9,9 s) → ajuste «antes do pagamento, o financeiro confere a justificativa» redesenhado no mesmo fluxo, sem pergunta (18,9 s no total; 17 → 19 elementos). Capturas em `process-ai-extension/e2e/capturas/`.

Para a demo com o canal: Modeler da branch com `VITE_BPM_DESIGN_ASSISTANT_CHANNEL=on` (ex.: porta 5194) e `VITE_MODELER_ORIGINS` da extensão incluindo essa origem. Sem a flag, tudo funciona pela porta «Abrir» (formulário por download).

Pendências: MR da branch do Modeler para o time revisar (ADR-0019); rollout da flag; `apply-patch` com inserção/ligação (vocabulário de posição); identidade 1Doc no backend (ADC-154 do lado do Process AI).
