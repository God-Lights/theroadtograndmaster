import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import { BOT_OPEN_PATHS, DISCORD_ID_RE, safeEqual, userForDiscord } from './discord';
import { userForKakao } from './kakao/link';

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
  Bindings: { DB: D1Database; ASSETS: Fetcher; GL_ACCOUNT_KEY?: string; ADMIN_USER_IDS?: string; BOT_API_KEY?: string; DISCORD_PUBLIC_KEY?: string; DISCORD_BOT_TOKEN?: string; DISCORD_ANNOUNCE_CHANNEL_ID?: string; DISCORD_PUBLIC_GUILD_ID?: string; DISCORD_PUBLIC_CHANNEL_ID?: string; KAKAO_BOT_KEY?: string; KAKAO_PUBLIC_ROOM?: string; KAKAO_INTERNAL?: boolean };
  Variables: { user: GlUser; viaBot?: boolean };
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

/**
 * 로그인 없이 받을 수 있는 경로: 헬스체크, 앱 아이콘·매니페스트(홈 화면 추가 시 브라우저가
 * 쿠키 없이 요청하기도 한다). 민감한 정보가 없는 정적 파일만 허용한다.
 */
const PUBLIC_PATHS = /^\/(api\/health|discord\/interactions|bot\/bars\.png|manifest\.webmanifest|icon\.svg|icons\/[\w.-]+)$/;

/** 위 공개 경로를 제외한 모든 요청(페이지·정적 파일·API)은 로그인이 필요하다. */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { pathname } = new URL(c.req.url);
  if (PUBLIC_PATHS.test(pathname)) return next();

  const key = c.env.GL_ACCOUNT_KEY;
  if (!key) return c.json({ error: 'server misconfigured' }, 500);

  // 카카오톡 봇(메신저봇R): 폰의 스크립트는 전용 키로 /api/kakao/* 만 부를 수 있다. 게임 API는 서버가 안에서 대신 부른다.
  if (pathname.startsWith('/api/kakao/')) {
    const kakaoKey = c.env.KAKAO_BOT_KEY;
    if (!kakaoKey) return c.json({ error: 'kakao_disabled' }, 503);
    const given = c.req.header('Authorization');
    if (!given?.startsWith('Bearer ') || !safeEqual(given.slice(7).trim(), kakaoKey)) return c.json({ error: 'unauthorized' }, 401);
    return next();
  }
  // 서버 안에서만 쓰는 호출(KAKAO_INTERNAL 은 런타임 환경 값이라 밖에서 흉내 낼 수 없다): 연동된 카톡 사용자로 게임 API 호출
  if (c.env.KAKAO_INTERNAL === true) {
    let kakaoUser = '';
    try { kakaoUser = decodeURIComponent(c.req.header('X-Kakao-User') ?? ''); } catch { /* 잘못된 값 */ }
    if (!pathname.startsWith('/api/') || pathname.startsWith('/api/admin/') || pathname.startsWith('/api/kakao/')) return c.json({ error: 'not_found' }, 404);
    if (BOT_OPEN_PATHS.test(pathname)) { c.set('viaBot', true); return next(); }
    const linked = await userForKakao(c.env.DB, kakaoUser);
    if (!linked) return c.json({ error: 'not_linked' }, 403);
    c.set('user', linked);
    c.set('viaBot', true);
    return next();
  }

  // 디스코드 봇: 서비스 키로 인증하고, 연동된 사용자 대신 게임 API를 호출한다 (페이지·관리자 API는 불가)
  const bearer = c.req.header('Authorization');
  if (bearer?.startsWith('Bearer ')) {
    const botKey = c.env.BOT_API_KEY;
    if (!botKey || !safeEqual(bearer.slice(7).trim(), botKey)) return c.json({ error: 'unauthorized' }, 401);
    if (!pathname.startsWith('/api/') || pathname.startsWith('/api/admin/')) return c.json({ error: 'not_found' }, 404);
    if (BOT_OPEN_PATHS.test(pathname)) { c.set('viaBot', true); return next(); }
    const discordId = c.req.header('X-Discord-User') ?? '';
    if (!DISCORD_ID_RE.test(discordId)) return c.json({ error: 'discord_user_required' }, 400);
    const linked = await userForDiscord(c.env.DB, discordId);
    if (!linked) return c.json({ error: 'not_linked' }, 403);
    c.set('user', linked);
    c.set('viaBot', true);
    return next();
  }

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
