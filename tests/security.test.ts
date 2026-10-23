import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildApp } from '../src/app.js';
import { readEnvironment } from '../src/config/env.js';
import { maskPersonalData } from '../src/modules/security/pii.js';
import { InMemoryConversationRepository } from '../src/modules/projects/conversation.repository.js';
import type { ModelProvider, StructuredRequest, StructuredResponse } from '../src/modules/providers/model-provider.js';

const issuer = 'https://idp.example.invalid/realms/process-ai';
const audience = 'process-ai-backend';
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] });
const token = (claims: Record<string, unknown>, overrides: { audience?: string; expired?: boolean } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience(overrides.audience ?? audience)
    .setSubject(String(claims.sub ?? 'pessoa-1')).setIssuedAt().setExpirationTime(overrides.expired ? '-1m' : '10m').sign(privateKey);

class Clarifier implements ModelProvider {
  readonly id = 'clarifier';
  readonly prompts: string[] = [];
  async generateStructured(request: StructuredRequest): Promise<StructuredResponse> {
    this.prompts.push(request.prompt);
    return { value: { kind: 'need_clarification', questions: [{ question: 'Quem aprova?', blocking: true }], summary: 'Falta o aprovador.' }, usage: {}, latencyMs: 1, model: request.model };
  }
}

async function oidcApp(extra: NodeJS.ProcessEnv = {}) {
  const repository = new InMemoryConversationRepository();
  const provider = new Clarifier();
  const app = await buildApp(readEnvironment({ LOG_LEVEL: 'silent', AUTH_MODE: 'oidc', OIDC_ISSUER: issuer, OIDC_AUDIENCE: audience, OIDC_WRITE_ROLE: 'process-designer', ...extra }), { conversationRepository: repository, modelProvider: provider, authKeys: jwks });
  return { app, repository, provider };
}
const bearer = async (claims: Record<string, unknown>, overrides?: { audience?: string; expired?: boolean }) => ({ authorization: `Bearer ${await token(claims, overrides)}` });

test('mascaramento de dados pessoais na entrada', () => {
  const masked = maskPersonalData('Servidor 123.456.789-09, e-mail ana.silva@orgao.gov.br, tel (48) 99876-5432, CNPJ 12.345.678/0001-90.');
  assert.equal(masked.text, 'Servidor [CPF], e-mail [E-MAIL], tel [TELEFONE], CNPJ [CNPJ].');
  assert.equal(masked.masked, 4);
  assert.deepEqual(maskPersonalData('O gestor aprova em até 5 dias úteis.'), { text: 'O gestor aprova em até 5 dias úteis.', masked: 0 });
});

test('OIDC: sem token, token inválido ou de outra audiência dão 401 com orientação; saúde e contrato continuam públicos', async () => {
  const { app } = await oidcApp();
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/openapi.json' })).statusCode, 200);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.json().code, 'AUTH_REQUIRED');
    assert.equal(missing.json().recovery.title, 'Acesso não autorizado');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/capabilities', headers: await bearer({ tenant: 't1' }, { audience: 'outra-api' }) })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/capabilities', headers: await bearer({ tenant: 't1' }, { expired: true }) })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/capabilities', headers: await bearer({ roles: ['process-designer'] }) })).json().code, 'AUTH_TENANT_MISSING');
  } finally { await app.close(); }
});

test('OIDC: o tenant vem do token, isola sessões entre tenants e o papel de escrita é exigido', async () => {
  const { app, repository } = await oidcApp();
  try {
    const designerA = await bearer({ tenant: 'orgao-a', sub: 'ana', roles: ['process-designer'] });
    const readerA = await bearer({ tenant: 'orgao-a', sub: 'leitor', roles: [] });
    const designerB = await bearer({ tenant: 'orgao-b', sub: 'bruno', roles: ['process-designer'] });
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/projects', headers: readerA, payload: { name: 'X', targetProfile: 'generic-bpmn2' } })).statusCode, 403);
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: designerA, payload: { name: 'Férias', targetProfile: 'generic-bpmn2' } });
    assert.equal(created.statusCode, 201);
    const { sessionId } = created.json();
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}`, headers: readerA })).statusCode, 200, 'leitura sem papel de escrita');
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}`, headers: designerB })).statusCode, 404, 'outro tenant não enxerga a sessão');
    const audit = await repository.listAudit('orgao-a', 10);
    assert.ok(audit.some(event => event.subject === 'ana' && event.action === 'POST /api/v1/projects' && event.statusCode === 201));
    assert.ok(audit.some(event => event.subject === 'leitor' && event.statusCode === 403), 'tentativa negada também é auditada');
    assert.deepEqual(await repository.listAudit('orgao-b', 10), []);
    assert.doesNotMatch(JSON.stringify(audit), /Férias/, 'auditoria não guarda conteúdo');
  } finally { await app.close(); }
});

test('turno assíncrono continua no tenant de quem pediu; dados pessoais nunca chegam ao modelo nem ao histórico', async () => {
  const { app, provider } = await oidcApp();
  try {
    const designerA = await bearer({ tenant: 'orgao-a', sub: 'ana', roles: ['process-designer'] });
    const designerB = await bearer({ tenant: 'orgao-b', sub: 'bruno', roles: ['process-designer'] });
    const { sessionId } = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers: designerA, payload: { name: 'Férias', targetProfile: 'generic-bpmn2' } })).json();
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, headers: { ...designerA, prefer: 'respond-async' }, payload: { text: 'O servidor CPF 123.456.789-09 (ana@orgao.gov.br) solicita férias.', baseRevision: 0, dataClassification: 'synthetic' } });
    assert.equal(accepted.statusCode, 202);
    const events = (await app.inject({ method: 'GET', url: `/api/v1/generation-runs/${accepted.json().generationRunId}/events`, headers: designerA })).body;
    assert.match(events, /event: result/);
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/generation-runs/${accepted.json().generationRunId}`, headers: designerB })).statusCode, 404, 'run invisível para outro tenant');
    assert.doesNotMatch(provider.prompts.join('\n'), /123\.456|ana@orgao/);
    assert.match(provider.prompts[0], /\[CPF\]/);
    const history = JSON.stringify((await app.inject({ method: 'GET', url: `/api/v1/design-sessions/${sessionId}/history`, headers: designerA })).json());
    assert.doesNotMatch(history, /123\.456|ana@orgao/);
  } finally { await app.close(); }
});

test('limite de gerações por pessoa responde 429 com orientação e não afeta outra pessoa', async () => {
  const { app } = await oidcApp({ TURN_RATE_LIMIT_PER_MINUTE: '2' });
  try {
    const ana = await bearer({ tenant: 'orgao-a', sub: 'ana', roles: ['process-designer'] });
    const bia = await bearer({ tenant: 'orgao-a', sub: 'bia', roles: ['process-designer'] });
    const { sessionId } = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers: ana, payload: { name: 'Limite', targetProfile: 'generic-bpmn2' } })).json();
    const send = (headers: Record<string, string>) => app.inject({ method: 'POST', url: `/api/v1/design-sessions/${sessionId}/messages`, headers, payload: { text: 'Pedido.', baseRevision: 0, dataClassification: 'synthetic' } });
    await send(ana); await send(ana);
    const limited = await send(ana);
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().code, 'TURN_RATE_LIMITED');
    assert.deepEqual(limited.json().recovery.actions, ['wait', 'retry']);
    assert.notEqual((await send(bia)).statusCode, 429, 'o limite é por pessoa');
  } finally { await app.close(); }
});
