import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { RequestPrincipal } from './request-context.js';

export type OidcSettings = { issuer: string; audience: string; jwksUrl?: string; tenantClaim: string; rolesClaim: string };
export class AuthFailure extends Error {
  constructor(readonly code: 'AUTH_REQUIRED' | 'AUTH_INVALID' | 'AUTH_TENANT_MISSING', message: string) { super(message); this.name = 'AuthFailure'; }
}

/**
 * Verifies bearer tokens issued by the configured OIDC provider (signature via JWKS, issuer, audience, expiry).
 * The tenant comes only from a token claim — never from the browser — and roles from `rolesClaim`.
 */
export function createOidcAuthenticator(settings: OidcSettings, keys?: JWTVerifyGetKey) {
  let resolvedKeys: Promise<JWTVerifyGetKey> | undefined = keys ? Promise.resolve(keys) : undefined;
  const jwks = () => resolvedKeys ??= (async () => {
    if (settings.jwksUrl) return createRemoteJWKSet(new URL(settings.jwksUrl));
    const discovery = await fetch(new URL('.well-known/openid-configuration', settings.issuer.endsWith('/') ? settings.issuer : `${settings.issuer}/`));
    if (!discovery.ok) throw new AuthFailure('AUTH_INVALID', 'Configuração OIDC do emissor indisponível');
    const { jwks_uri: jwksUri } = await discovery.json() as { jwks_uri?: string };
    if (!jwksUri) throw new AuthFailure('AUTH_INVALID', 'Emissor OIDC sem jwks_uri');
    return createRemoteJWKSet(new URL(jwksUri));
  })().catch(error => { resolvedKeys = undefined; throw error; });

  return async function authenticate(authorization: string | undefined): Promise<RequestPrincipal> {
    const token = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1];
    if (!token) throw new AuthFailure('AUTH_REQUIRED', 'Autenticação obrigatória');
    let payload: Record<string, unknown>;
    try { ({ payload } = await jwtVerify(token, await jwks(), { issuer: settings.issuer, audience: settings.audience })); }
    catch (error) { if (error instanceof AuthFailure) throw error; throw new AuthFailure('AUTH_INVALID', 'Token inválido ou expirado'); }
    const tenant = payload[settings.tenantClaim];
    if (typeof tenant !== 'string' || !tenant.trim()) throw new AuthFailure('AUTH_TENANT_MISSING', 'Token sem tenant autorizado');
    const rolesValue = payload[settings.rolesClaim];
    const roles = Array.isArray(rolesValue) ? rolesValue.filter((role): role is string => typeof role === 'string') : typeof rolesValue === 'string' ? rolesValue.split(/[\s,]+/).filter(Boolean) : [];
    return { tenantId: tenant, subject: typeof payload.sub === 'string' ? payload.sub : 'unknown', roles };
  };
}
