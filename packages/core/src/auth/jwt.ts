import { createHmac, timingSafeEqual } from 'node:crypto';

/** HS256 JWT for the API (15-minute access tokens). Sessions in `auth_sessions` handle refresh/logout-everywhere. */
export interface JwtClaims { sub: string; sid: string; sch: string; epoch: number; typ?: string; iat?: number; exp?: number; [k: string]: unknown }

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export function signJwt(claims: Omit<JwtClaims, 'iat' | 'exp'>, secret: string, ttlSeconds = 900): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64(JSON.stringify({ ...claims, iat: now, exp: now + ttlSeconds }));
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export function verifyJwt(token: string, secret: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  if (expected.length !== s.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(s))) return null;
  try {
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as JwtClaims;
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch { return null; }
}
