import { Hono } from 'hono';
import type { AppEnv, GlUser } from './auth';

/**
 * 디스코드 봇 연동.
 * - 게임(웹)에서 연동 코드를 만들고, 디스코드에서 봇에게 그 코드를 입력하면 계정이 1:1로 묶인다.
 * - 봇은 서비스 키(BOT_API_KEY)와 X-Discord-User 헤더로 연동된 사용자 '대신' 게임 API를 호출한다.
 *   (인증 처리는 auth.ts 의 authenticate — 연동 안 된 사용자·관리자 API는 막힌다.)
 */
export const LINK_CODE_TTL_MS = 10 * 60_000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const DISCORD_ID_RE = /^\d{15,22}$/;

/** 봇이 사용자 없이 호출할 수 있는 경로: 헬스체크, 전체 알림 목록, 연동, 게임 데이터 */
export const BOT_OPEN_PATHS = /^\/api\/(health|announcements|bot\/(link|publish)|data\/[a-z]+)$/;

/** 길이가 달라도 시간 차이가 새지 않게 비교한다 */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** 연동된 디스코드 사용자를 게임 사용자로 바꾼다 (이메일은 저장하지 않으므로 빈 값) */
export async function userForDiscord(db: D1Database, discordId: string): Promise<GlUser | null> {
  const row = await db
    .prepare('SELECT l.user_id, l.email_verified, p.nickname, p.username FROM discord_links l JOIN profiles p ON p.user_id = l.user_id WHERE l.discord_id = ?')
    .bind(discordId)
    .first<{ user_id: string; email_verified: number; nickname: string; username: string }>();
  return row ? { id: row.user_id, email: '', username: row.username, nickname: row.nickname, emailVerified: !!row.email_verified } : null;
}

const makeCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');

export const discord = new Hono<AppEnv>();

/** 웹에서만: 봇이 대신 호출하는 요청으로는 연동 코드를 만들거나 해제할 수 없다 */
discord.use('/discord/*', async (c, next) => {
  if (c.get('viaBot')) return c.json({ error: 'forbidden' }, 403);
  await next();
});

discord.get('/discord/status', async (c) => {
  const uid = c.get('user').id;
  const [row, kk] = await Promise.all([
    c.env.DB.prepare('SELECT linked_at FROM discord_links WHERE user_id = ?').bind(uid).first<{ linked_at: number }>(),
    c.env.DB.prepare('SELECT linked_at FROM kakao_links WHERE user_id = ?').bind(uid).first<{ linked_at: number }>(),
  ]);
  return c.json({ linked: !!row, linkedAt: row?.linked_at ?? null, botEnabled: !!c.env.BOT_API_KEY, kakaoLinked: !!kk, kakaoLinkedAt: kk?.linked_at ?? null, kakaoEnabled: !!c.env.KAKAO_BOT_KEY });
});

discord.post('/discord/kakao-unlink', async (c) => {
  await c.env.DB.prepare('DELETE FROM kakao_links WHERE user_id = ?').bind(c.get('user').id).run();
  return c.json({ ok: true });
});

discord.post('/discord/link-code', async (c) => {
  const user = c.get('user');
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    const code = makeCode();
    try {
      // 사용자당 코드는 하나만: 새로 만들면 이전 코드는 사라진다
      await c.env.DB.batch([
        c.env.DB.prepare('DELETE FROM discord_link_codes WHERE user_id = ? OR expires_at < ?').bind(user.id, now),
        c.env.DB.prepare('INSERT INTO discord_link_codes (code, user_id, email_verified, expires_at) VALUES (?, ?, ?, ?)').bind(code, user.id, user.emailVerified ? 1 : 0, now + LINK_CODE_TTL_MS),
      ]);
      return c.json({ code, expiresAt: now + LINK_CODE_TTL_MS });
    } catch { /* 코드 충돌 */ }
  }
  return c.json({ error: 'try_again' }, 500);
});

discord.post('/discord/unlink', async (c) => {
  await c.env.DB.prepare('DELETE FROM discord_links WHERE user_id = ?').bind(c.get('user').id).run();
  return c.json({ ok: true });
});

/** 봇 전용(서비스 키 필요): 코드를 확인하고 디스코드 사용자와 묶는다 */
discord.post('/bot/link', async (c) => {
  if (!c.get('viaBot')) return c.json({ error: 'not_found' }, 404); // 웹 세션으로는 호출할 수 없다
  const { code, discordId } = await c.req.json<{ code?: unknown; discordId?: unknown }>().catch(() => ({} as { code?: unknown; discordId?: unknown }));
  if (typeof code !== 'string' || typeof discordId !== 'string' || !DISCORD_ID_RE.test(discordId)) return c.json({ error: 'invalid_request' }, 400);
  const now = Date.now();
  // 코드는 한 번만 쓸 수 있다 (지우면서 사용자 id 를 받는다)
  const row = await c.env.DB
    .prepare('DELETE FROM discord_link_codes WHERE code = ? AND expires_at > ? RETURNING user_id, email_verified')
    .bind(code.trim().toUpperCase(), now)
    .first<{ user_id: string; email_verified: number }>();
  if (!row) return c.json({ error: 'invalid_code' }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM discord_links WHERE user_id = ? OR discord_id = ?').bind(row.user_id, discordId),
    c.env.DB.prepare('INSERT INTO discord_links (discord_id, user_id, email_verified, linked_at) VALUES (?, ?, ?, ?)').bind(discordId, row.user_id, row.email_verified, now),
  ]);
  const prof = await c.env.DB.prepare('SELECT nickname FROM profiles WHERE user_id = ?').bind(row.user_id).first<{ nickname: string }>();
  return c.json({ ok: true, nickname: prof?.nickname ?? null });
});

/**
 * 봇 전용: 게임 결과를 전체 공개로 올릴 때 같은 결과가 두 번 올라가지 않게 한다 (먼저 부른 쪽만 first=true).
 * 키는 하루 뒤에 정리한다.
 */
discord.post('/bot/publish', async (c) => {
  if (!c.get('viaBot')) return c.json({ error: 'not_found' }, 404);
  const { key } = await c.req.json<{ key?: unknown }>().catch(() => ({} as { key?: unknown }));
  if (typeof key !== 'string' || key.length < 3 || key.length > 80) return c.json({ error: 'invalid_request' }, 400);
  const now = Date.now();
  const res = await c.env.DB.prepare("INSERT OR IGNORE INTO bot_state (key, value) VALUES (?, ?)").bind(`pub:${key}`, String(now)).run();
  if (res.meta.changes === 1) await c.env.DB.prepare("DELETE FROM bot_state WHERE key LIKE 'pub:%' AND CAST(value AS INTEGER) < ?").bind(now - 86_400_000).run();
  return c.json({ first: res.meta.changes === 1 });
});
