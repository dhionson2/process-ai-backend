# SDD — Assistente conversacional no Modeler via extensão do Chrome

**Data:** 2026-10-23 · **Status:** proposta para aprovação · **Documento vivo:** https://claude.ai/artifact/N3pb5u3rA8HzYnSAdAtH4G

## 1. Contexto e objetivo

Uma extensão do Chrome leva o assistente conversacional do Process AI para dentro do Modeler **sem alterar o Modeler**: a pessoa descreve o processo num painel lateral e o fluxo aparece no editor pela mesma porta que o botão «Abrir» já usa. Ela revisa e salva no próprio Modeler.

A restrição que define o desenho é não comprometer o projeto Unique. O Modeler não expõe o editor (requisito TEC-9402), a ponte com o host aceita só uma mensagem de leitura (ADR-0012) e toda mudança nele passa por ADR e checkpoint humano. Uma extensão fica fora desse perímetro e usa o Modeler como uma pessoa usaria.

A base já existe: o Process AI gera BPMN 2.0 com diagrama e formulários validados, com placar de 13/14 cenários no Sonnet e custo de cerca de US$ 0,02 por processo.

Pedido à aprovação: o caminho pela porta de arquivo (opção B), a prova de conceito de 2 dias e a decisão sobre o formulário (seção 12).

## 2. Escopo

Dentro:
- Extensão Chrome Manifest V3: painel lateral com o chat, content script na origem do Modeler, service worker de mensagens.
- Gerador do Process AI compatível com o Modeler: namespaces limpos, `schemaVersion` 19 e `id` nos componentes do formulário.
- Backend Process AI: CORS para a origem da extensão e token OIDC já suportado.
- Prova de conceito, testes de ponta a ponta e roteiro de demonstração.

Fora:
- Alterar o Modeler. Única exceção possível: botão «Abrir» no editor de formulário (decisão D3).
- Gravar pela BPM Design API a partir da extensão. Salvar continua ação da pessoa no Modeler.
- Vínculo formulário ↔ tarefa: o Modeler não modela esse vínculo; `flowable:formKey` é carregado, não interpretado.
- Publicação e execução no Flowable; Chrome Web Store pública.

Premissas: Modeler local em `http://localhost:5173` para PoC e demo; só dados sintéticos até o piloto com OIDC; Chrome corporativo permite carregar extensão para demonstração.

## 3. Projetos envolvidos

| Projeto | Papel | Estado hoje (verificado no código) | O que muda |
| --- | --- | --- | --- |
| `unique/modeler` | Editor onde o fluxo aparece e é salvo | React 19 + Vite; bpmn-js 18.22; form-js 1.24.1 (fork, `schemaVersion` 19); workspace multi-abas; Gerenciador como landing; «Abrir» com validação em 4 camadas; editor não exposto; ponte com o host só de leitura; sem tenant no frontend | Nada. Opcional e separado: «Abrir» no editor de formulário |
| `process-ai-backend` | Conversa, pergunta, compila, valida, gera BPMN e formulários | Pipeline em etapas, placar 13/14, OpenAPI 1.5.0, SSE, providers Claude CLI e API Anthropic, OIDC, mascaramento | Gerador compatível; CORS para a extensão; critério «importável no Modeler» no placar |
| `process-ai-frontend` | Fonte do chat | React 19, tipos gerados do contrato, máquina de estados do turno, SSE por fetch | Extrair o chat para pacote reutilizado pelo painel lateral |
| `process-ai-extension` (novo) | Painel lateral + content script + service worker | Não existe | Criado nesta entrega |
| BPM Design API | Persistência, versões, publicação | Chamada pelo Modeler sem credencial, na mesma origem | Nada |
| 1Doc | Embute o Modeler em iframe | `frame-ancestors` gerido por Terraform externo | Nada; extensão usa `all_frames` |

## 4. Arquitetura da solução

```
Navegador (Chrome)
├── Extensão (Manifest V3)
│   ├── Painel lateral: o chat ──chrome.runtime──▶ Content script
│   │        │ HTTPS (só o texto da conversa)        │ preenche o input «Abrir», como a pessoa faria
│   │        ▼                                       ▼
│   │   Process AI backend                      Modeler (bpmn-js, form-js)
│   │   interpreta, pergunta, compila           Abrir → Validação (4 camadas, 10 MB, 10 mil nós) → Canvas (importXml)
│   │   gera BPMN e formulários                                                              │ Salvar, feito pela pessoa
│   │   mascara dados, audita                                                                ▼
│   │                                                                                  BPM Design API
```

Sequência de um uso:
1. A pessoa abre um fluxo no Modeler e o painel lateral; o content script avisa `modeler:state`.
2. Ela descreve o processo; o painel envia ao backend com `Prefer: respond-async` e mostra o progresso por SSE.
3. O backend pergunta o que falta, compila e valida; o painel exibe perguntas, prévia e custo.
4. Ela clica «Enviar para o Modeler»; o painel manda `assistant:deliver-bpmn` ao content script.
5. O content script preenche o input «Abrir»; o Modeler valida e desenha; `modeler:delivery-result` volta ao painel.
6. Ela revisa no canvas e clica «Salvar» no Modeler.

## 5. Encaixe no Modeler

A extensão entra pela única porta de escrita que o Modeler oferece a quem está fora dele: o seletor de arquivo do botão «Abrir» (`src/features/fluxos/EditorControlBar.tsx`, `validation/import-validation.ts`).

1. A pessoa abre um fluxo no Gerenciador («Novo fluxo» cria o template; a aba nasce com diagrama vazio, estado `pronta`).
2. O content script cria um `File` com o XML, coloca-o em `input.editor-file-input` por `DataTransfer` e dispara `change`.
3. `onArquivoEscolhido` confere `isDirty()` e pede confirmação de descarte se houver trabalho não salvo.
4. `validateBpmnFile`: DTD recusada, XML bem formado, `bpmn:definitions` na raiz, ensaio em modelador descartável; tetos de 10 MB e 10.000 elementos.
5. `importXml` substitui o diagrama; histórico zerado, vista inicial, foco no canvas.
6. A pessoa revisa e clica «Salvar» (`updateDraft`). A extensão nunca salva.

| Artefato | Situação | Ajuste no gerador |
| --- | --- | --- |
| BPMN XML com DI | Passa: `flowable:` atravessa a cadeia intacto | Remover `xmlns:process-ai` e o `targetNamespace` de prévia |
| Raiz do formulário | Passa: `{type:'default', components}` | Acrescentar `schemaVersion: 19` e `id` |
| Tipos de componente | Passam: `textfield`, `textarea`, `number`, `datetime`, `checkbox`, `select`, `button` (allowlist de 18) | Nenhum |

Formulário: o editor de formulário não tem seletor de arquivo; `carregarSchema` é interno. Na PoC o formulário fica no painel para download (ver D3). Dentro do 1Doc o Modeler é um iframe: `all_frames: true`; a CSP da página não bloqueia content scripts.

## 6. Contratos

Mensagens internas (`chrome.runtime`):

| Mensagem | Sentido | Conteúdo | Resposta |
| --- | --- | --- | --- |
| `modeler:state` | content script → painel | `{present, tab: 'fluxos' \| 'formularios', dirty}` | — |
| `assistant:deliver-bpmn` | painel → content script | `{xml, processName, revision, sessionId}` | `modeler:delivery-result` |
| `modeler:delivery-result` | content script → painel | `{status: 'imported' \| 'rejected' \| 'no-editor' \| 'discard-declined', reason?}` | — |
| `assistant:download-form` | painel → service worker | `{formId, json}` | arquivo `.form.json` |

Backend (sem mudança de contrato, API 1.5.0): `POST /api/v1/projects`; `POST /messages`, `/answers`, `/refinements` com `Prefer: respond-async`; `GET /generation-runs/{id}/events`; `GET /revisions/{n}`; `GET /understanding`, `/telemetry`; `PUT /requirements/{id}`.

Artefatos: BPMN 2.0 com `bpmndi`, `isExecutable="false"`, namespaces `bpmn`, `bpmndi`, `dc`, `di`, `flowable`; `targetNamespace` `http://bpmn.io/schema/bpmn`. Formulário `{type:'default', schemaVersion: 19, id, components:[...]}`, tipos da allowlist, profundidade ≤ 16, ≤ 1.000 componentes.

## 7. Segurança e privacidade

| Controle | Como |
| --- | --- |
| Permissões mínimas | `host_permissions` = origem do Modeler + origem do backend; `sidePanel`, `storage`. Sem `<all_urls>`, `tabs`, `cookies`, `webRequest` |
| Isolamento | Content script em mundo isolado; nenhum script injetado; nenhum acesso a `window` do Modeler |
| Validação | Todo artefato passa pelas 4 camadas do Modeler |
| Trabalho da pessoa | Confirmação de descarte do Modeler preservada |
| Dados | Texto vai só ao Process AI (mascaramento de CPF/CNPJ/e-mail/telefone, auditoria sem conteúdo, limite por pessoa) |
| Identidade | Demo com `AUTH_MODE=off` e dados sintéticos; piloto com OIDC (token no painel, nunca na URL) |
| CORS | Backend libera `chrome-extension://<id>` (id fixo pela chave no manifest) |
| Distribuição | Demo: carregada sem empacotar. Piloto: `ExtensionInstallForcelist` ou Web Store não listada |

## 8. Mudanças por projeto

| Projeto | Mudança | Arquivos principais |
| --- | --- | --- |
| `process-ai-extension` (novo) | manifest MV3, painel lateral React, content script de entrega, service worker, build Vite | `manifest.json`, `src/sidepanel/`, `src/content/deliver.ts`, `src/background.ts` |
| `process-ai-frontend` | Extrair chat para `@process-ai/chat-ui`; botão «Enviar para o Modeler» | `src/components/`, `src/services/` |
| `process-ai-backend` | Gerador compatível; CORS; critério «importável» no placar | `artifact-generator.ts`, `app.ts`, `scripts/eval/` |
| `unique/modeler` | Nenhuma (opcional: «Abrir» no editor de formulário, com ADR) | `FormEditorControlBar.tsx` |

## 9. Plano de entrega

| Fase | Duração | Porta de saída |
| --- | --- | --- |
| 0 · PoC | 2 dias | Modeler local importa `.bpmn` entregue pelo content script; 14 BPMN do placar passam `validateBpmnXmlString`; formulários passam `validarFormaDaRaiz` e allowlist |
| 1 · Extensão | 1 semana | Playwright com extensão carregada verde; recusa, ausência de editor e descarte negado com mensagem no painel |
| 2 · Gerador | 3 dias | critério «importável» no gate de replay; cassete regravada; 100% importável |
| 3 · Formulário | a decidir | conforme D3; se «Abrir» no Modeler, ADR + MR com `verify:bundle` verde |
| 4 · Demo | 1 dia | ensaio real cronometrado; roteiro de 8 minutos; capturas em `docs/demo/` |

Nada depois da fase 0 começa sem a porta dela aberta.

## 10. Testes e qualidade

| Nível | O que prova | Como |
| --- | --- | --- |
| Unidade (extensão) | Content script monta o `File`, preenche o input, trata recusa/ausência/descarte | Vitest + jsdom |
| Placar (backend) | Cada BPMN e formulário passam as regras do Modeler | Critério «importável» com `validateBpmnXmlString`, `validarFormaDaRaiz`, `percorrerDefinicao` e ensaio (bpmn-js 18.22, form-js 1.24.1) |
| Ponta a ponta | Entrega real no Modeler local | Playwright `--load-extension` |
| Ensaio real | Jornada da demo com o Claude | `demo-e2e` adaptado |

## 11. Riscos e mitigações

| Risco | Efeito | Mitigação |
| --- | --- | --- |
| React não reage ao `change` sintético | Porta não abre | PoC de 2 dias; saída: download + «Abrir» manual, ou opção C |
| Seletor do input muda | Entrega quebra | E2E fixado à versão do Modeler; `no-editor` avisa a pessoa |
| Formulário sem porta | Metade entregue por download | D3 antes da fase 3 |
| Artefato recusado | Erro técnico | Critério «importável»; recusa com orientação |
| Modeler em iframe (1Doc) | Content script não alcança | `all_frames`; confirmar URL de HML |
| Política corporativa bloqueia extensões | Demo não carrega | Confirmar com TI |
| Modelo inventa etapa | Diagrama diverge | Gate de evidência, correção dirigida, placar |
| Latência/custo | Pausas de 5–15 s | Progresso por SSE; ~US$ 0,02 por sessão |

## 12. Decisões, pendências e perguntas

- **D1** — Entrega pela porta de arquivo (opção B). Integração nativa (C) fica como evolução com ADR.
- **D2** — A extensão nunca salva.
- **D3** — Formulário: (a) download pelo painel; (b) «Abrir» no editor de formulário do Modeler; (c) Design API (não recomendada). Recomendação: (a) na demo, (b) no piloto.
- **D4** — Dados sintéticos até o piloto com OIDC.

Pendências: URL do Modeler em HML; política de extensões do Chrome corporativo; dono do «Abrir» de formulário se D3 = (b); chave da API Anthropic para o piloto.

Perguntas para aprovação: aprovar D1 e a PoC? qual saída da D3? demo com Modeler local ou HML?
