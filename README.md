# Process AI — Backend (nome provisório)

Bootstrap de **API de modelagem de processos**, independente do Unique e da cloud. Um repositório separado do frontend.

## Estado real
- ✅ API Fastify/TypeScript, health, exemplos estáticos BPMN/Form JSON, capabilities e validador parcial.
- ✅ Fundação anterior preservada em `specs/foundation/` (contratos, 2 cenários, gerador Python de referência, knowledge base).
- ❌ Ainda não há LLM, ProcessSpec generator TypeScript, banco, autenticação, execução de conectores nem integração real.
- ⚠️ **Desenvolvimento local somente**. Exemplos têm `isExecutable=false` e não são certificados para deploy no Flowable.

## Requisitos e comandos
Node.js 22 LTS; npm. Sem necessidade de PostgreSQL, Docker ou Ollama nesta fase.

```bash
cp .env.example .env
npm install
npm run dev
# outra sessão:
curl http://127.0.0.1:3333/health
curl http://127.0.0.1:3333/api/v1/examples
npm run verify
```

A primeira instalação gera `package-lock.json`. Revisar e versionar o lockfile ao criar o repositório. Não foi incluído lockfile fabricado; a rede do ambiente de preparação não permitiu instalar dependências.

## Rotas
- `GET /health`
- `GET /api/v1/capabilities`
- `GET /api/v1/examples`
- `GET /api/v1/examples/ferias`
- `GET /api/v1/examples/http-db`
- `POST /api/v1/validate` com ProcessSpec JSON.

## Organização
- `src/` — aplicação TS e módulos atuais.
- `tests/` — smoke e validação.
- `specs/active/` — decisões atuais.
- `specs/foundation/` — kit técnico anterior integral, referência e arquivos ouro.
- `specs/reference/` — SDD do produto e arquitetura histórica (não confundam OCI com dependência).
- `AGENTS.md`, `CLAUDE.md` e `specs/roles/` — regras para Codex/Claude.

## Segurança
Não publicar como está. Host padrão 127.0.0.1, CORS restrito para dev; falta autenticação, autorização e proteção de produção. Nunca colocar segredo ou dados reais no prompt, fixtures ou histórico.

**Não criar commits automaticamente.** Ver `specs/INDEX.md` e `specs/tasks/README.md`.
