import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';

/** GL Account 연동 (docs: gl-account/docs/INTEGRATION.md). 서비스 키는 Worker 시크릿으로만 쓴다. */
export const ACCOUNT_ORIGIN = 'https://account.officialgl.com';
export const SESSION_COOKIE = 'gl_session';

/** 로그아웃 반영 지연을 줄이기 위해 캐시는 30초를 넘기지 않는다. */
const CACHE_TTL_MS = 30_000;
const MAX_CACHE = 500;

export interface GlUser {
  /** 사용자 식별자(UUID). 이메일·아이디·닉네임은 바뀔 수 있으므로 항상 이것만 키로 쓴다. */
  id: string;
  email: string;
  username: string;
  nickname: string;
  emailVerified: boolean;
}

export interface GlPublicUser {
  id: string;
  username: string;
  nickname: string;
}

export type AppEnv = {
  Bindings: { DB: D1Database; ASSETS: Fetcher; GL_ACCOUNT_KEY?: string };
  Variables: { user: GlUser };
};

/** GL Account가 5xx이거나 응답이 이상할 때. 비로그인과 구분해서 로그인 무한 반복을 막는다. */
export class AuthUpstreamError extends Error {}

export function loginUrl(returnTo: string): string {
  return `${ACCOUNT_ORIGIN}/?return=${encodeURIComponent(returnTo)}`;
}

const sessionCache = new Map<string, { user: GlUser; exp: number }>();
const publicCache = new Map<string, { user: GlPublicUser; exp: number }>();

export function clearAuthCache(): void {
  sessionCache.clear();
  publicCache.clear();
}

function remember<T>(map: Map<string, { user: T; exp: number }>, key: string, user: T): void {
  if (map.size >= MAX_CACHE) map.clear();
  map.set(key, { user, exp: Date.now() + CACHE_TTL_MS });
}

function isGlUser(v: unknown): v is GlUser {
  const u = v as GlUser | undefined;
  return !!u && typeof u.id === 'string' && typeof u.nickname === 'string' && typeof u.emailVerified === 'boolean';
}

/** 200 → 사용자, 401 → null(비로그인), 그 외 → AuthUpstreamError */
export async function verifySession(key: string, token: string): Promise<GlUser | null> {
  const hit = sessionCache.get(token);
  if (hit && hit.exp > Date.now()) return hit.user;

  let res: Response;
  try {
    res = await fetch(`${ACCOUNT_ORIGIN}/api/internal/verify-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    throw new AuthUpstreamError('verify-session unreachable');
  }
  if (res.status === 401) {
    sessionCache.delete(token);
    return null;
  }
  if (!res.ok) throw new AuthUpstreamError(`verify-session ${res.status}`);

  const body = (await res.json().catch(() => null)) as { user?: unknown } | null;
  if (!isGlUser(body?.user)) throw new AuthUpstreamError('verify-session bad payload');
  remember(sessionCache, token, body.user);
  return body.user;
}

/** 닉네임 표시용 조회. 이메일은 돌려받지 않는다. 없는 사용자는 null. */
export async function fetchPublicUser(key: string, id: string): Promise<GlPublicUser | null> {
  const hit = publicCache.get(id);
  if (hit && hit.exp > Date.now()) return hit.user;

  let res: Response;
  try {
    res = await fetch(`${ACCOUNT_ORIGIN}/api/internal/users/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch {
    throw new AuthUpstreamError('users lookup unreachable');
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new AuthUpstreamError(`users lookup ${res.status}`);
  const body = (await res.json().catch(() => null)) as { user?: GlPublicUser } | null;
  if (!body?.user || typeof body.user.id !== 'string') throw new AuthUpstreamError('users lookup bad payload');
  remember(publicCache, id, body.user);
  return body.user;
}

/** /api/health 만 공개. 나머지(페이지·정적 파일·API)는 모두 로그인이 필요하다. */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { pathname } = new URL(c.req.url);
  if (pathname === '/api/health') return next();

  const key = c.env.GL_ACCOUNT_KEY;
  if (!key) return c.json({ error: 'server misconfigured' }, 500);

  const token = getCookie(c, SESSION_COOKIE);
  let user: GlUser | null = null;
  if (token) {
    try {
      user = await verifySession(key, token);
    } catch {
      return c.text('인증 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.', 503);
    }
  }

  if (!user) {
    const isPage = !pathname.startsWith('/api/') && (c.req.method === 'GET' || c.req.method === 'HEAD');
    if (isPage) return c.redirect(loginUrl(c.req.url));
    return c.json({ error: 'unauthorized' }, 401);
  }

  c.set('user', user);
  await next();
};

/** 이메일 인증이 필요한 기능(거래·길드 생성 등)에 붙인다. */
export const requireVerifiedEmail: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user').emailVerified) return c.json({ error: 'email_not_verified' }, 403);
  await next();
};
