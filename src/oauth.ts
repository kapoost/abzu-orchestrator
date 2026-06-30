import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface OAuthConfig {
  issuer: string;
  jwks_uri: string;
  audience: string;
}

export interface VerifiedToken {
  client_id: string;
  scope?: string;
  jti?: string;
  payload: JWTPayload;
}

export function createOAuthVerifier(config: OAuthConfig) {
  const JWKS = createRemoteJWKSet(new URL(config.jwks_uri), {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30 * 1000,
  });

  return async function verifyBearer(authHeader: string | null | undefined): Promise<VerifiedToken | { error: string; status: number }> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { error: 'Missing bearer token.', status: 401 };
    }
    const token = authHeader.substring('Bearer '.length).trim();
    if (token.length === 0) return { error: 'Empty bearer token.', status: 401 };

    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['RS256'],
      });
      const client_id = typeof payload.client_id === 'string' ? payload.client_id : typeof payload.sub === 'string' ? payload.sub : 'unknown';
      return {
        client_id,
        ...(typeof payload.scope === 'string' ? { scope: payload.scope } : {}),
        ...(typeof payload.jti === 'string' ? { jti: payload.jti } : {}),
        payload,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { error: `Invalid token: ${message}`, status: 401 };
    }
  };
}
