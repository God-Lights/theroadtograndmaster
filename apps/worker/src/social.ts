import { Hono } from 'hono';
import type { AppEnv } from './auth';

/** 친구·프로필·채팅. 닉네임은 GL Account가 공개하는 값만 저장한다 (이메일은 저장하지 않는다). */
export const social = new Hono<AppEnv>();

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ONLINE_MS = 2 * 60 * 1000;
export const MAX_FRIENDS = 50;
export const CHAT_MAX_LEN = 200;
export const CHAT_MIN_GAP_MS = 1500;

/** 접속할 때마다 닉네임·마지막 접속을 갱신한다 (1분에 한 번만 쓴다). */
export async function touchProfile(db: D1Database, user: { id: string; nickname: string; username: string }): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO profiles (user_id, nickname, username, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET nickname = excluded.nickname, username = excluded.username, last_seen = excluded.last_seen
       WHERE last_seen < ? OR nickname != excluded.nickname`,
    )
    .bind(user.id, user.nickname, user.username, now, now - 60_000)
    .run();
}

interface PersonRow { user_id: string; nickname: string; last_seen: number; proficiency: number | null }
const person = (r: PersonRow) => ({
  id: r.user_id,
  nickname: r.nickname,
  online: Date.now() - r.last_seen < ONLINE_MS,
  proficiency: r.proficiency ?? 0,
});

export type Relation = 'none' | 'friend' | 'sent' | 'received';
/** 나와 상대의 관계 */
export async function relationOf(db: D1Database, me: string, other: string): Promise<Relation> {
  const row = await db
    .prepare('SELECT requester, status FROM friendships WHERE (requester = ? AND addressee = ?) OR (requester = ? AND addressee = ?)')
    .bind(me, other, other, me)
    .first<{ requester: string; status: string }>();
  if (!row) return 'none';
  if (row.status === 'accepted') return 'friend';
  return row.requester === me ? 'sent' : 'received';
}

social.get('/friends', async (c) => {
  const me = c.get('user').id;
  const { results } = await c.env.DB
    .prepare(
      `SELECT f.requester, f.status, p.user_id, p.nickname, p.last_seen, ch.proficiency
       FROM friendships f
       JOIN profiles p ON p.user_id = CASE WHEN f.requester = ? THEN f.addressee ELSE f.requester END
       LEFT JOIN characters ch ON ch.user_id = p.user_id
       WHERE f.requester = ? OR f.addressee = ?
       ORDER BY p.nickname`,
    )
    .bind(me, me, me)
    .all<PersonRow & { requester: string; status: string }>();
  const rows = results ?? [];
  return c.json({
    friends: rows.filter((r) => r.status === 'accepted').map(person),
    incoming: rows.filter((r) => r.status === 'pending' && r.requester !== me).map(person),
    outgoing: rows.filter((r) => r.status === 'pending' && r.requester === me).map(person),
  });
});

/** 닉네임으로 플레이어 찾기 (RTGM에 접속한 적 있는 사람) */
social.get('/players/search', async (c) => {
  const me = c.get('user').id;
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 2) return c.json({ players: [] });
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const { results } = await c.env.DB
    .prepare(
      `SELECT p.user_id, p.nickname, p.last_seen, ch.proficiency FROM profiles p
       LEFT JOIN characters ch ON ch.user_id = p.user_id
       WHERE p.nickname LIKE ? ESCAPE '\\' AND p.user_id != ? ORDER BY p.nickname LIMIT 10`,
    )
    .bind(like, me)
    .all<PersonRow>();
  const players = await Promise.all(
    (results ?? []).map(async (r) => ({ ...person(r), relation: await relationOf(c.env.DB, me, r.user_id) })),
  );
  return c.json({ players });
});

social.post('/friends/request', async (c) => {
  const me = c.get('user').id;
  const { userId } = await c.req.json<{ userId?: string }>();
  if (!userId || !UUID.test(userId) || userId === me) return c.json({ error: 'invalid_request' }, 400);
  const target = await c.env.DB.prepare('SELECT 1 AS ok FROM profiles WHERE user_id = ?').bind(userId).first();
  if (!target) return c.json({ error: 'player_not_found' }, 404);

  const rel = await relationOf(c.env.DB, me, userId);
  if (rel === 'friend') return c.json({ error: 'already_friends' }, 409);
  if (rel === 'sent') return c.json({ error: 'already_requested' }, 409);
  const count = await c.env.DB
    .prepare("SELECT COUNT(*) AS n FROM friendships WHERE status = 'accepted' AND (requester = ? OR addressee = ?)")
    .bind(me, me)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_FRIENDS) return c.json({ error: 'friends_full' }, 400);

  if (rel === 'received') {
    // 상대가 이미 보낸 요청이 있으면 바로 친구가 된다
    await c.env.DB.prepare("UPDATE friendships SET status = 'accepted' WHERE requester = ? AND addressee = ?").bind(userId, me).run();
    return c.json({ ok: true, status: 'friend' });
  }
  await c.env.DB.prepare("INSERT INTO friendships (requester, addressee, status, created_at) VALUES (?, ?, 'pending', ?)").bind(me, userId, Date.now()).run();
  return c.json({ ok: true, status: 'sent' });
});

social.post('/friends/accept', async (c) => {
  const me = c.get('user').id;
  const { userId } = await c.req.json<{ userId?: string }>();
  if (!userId || !UUID.test(userId)) return c.json({ error: 'invalid_request' }, 400);
  const count = await c.env.DB
    .prepare("SELECT COUNT(*) AS n FROM friendships WHERE status = 'accepted' AND (requester = ? OR addressee = ?)")
    .bind(me, me)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_FRIENDS) return c.json({ error: 'friends_full' }, 400);
  const res = await c.env.DB
    .prepare("UPDATE friendships SET status = 'accepted' WHERE requester = ? AND addressee = ? AND status = 'pending'")
    .bind(userId, me)
    .run();
  if (res.meta.changes === 0) return c.json({ error: 'request_not_found' }, 404);
  return c.json({ ok: true });
});

/** 거절·요청 취소·친구 끊기를 모두 처리한다 */
social.post('/friends/remove', async (c) => {
  const me = c.get('user').id;
  const { userId } = await c.req.json<{ userId?: string }>();
  if (!userId || !UUID.test(userId)) return c.json({ error: 'invalid_request' }, 400);
  await c.env.DB
    .prepare('DELETE FROM friendships WHERE (requester = ? AND addressee = ?) OR (requester = ? AND addressee = ?)')
    .bind(me, userId, userId, me)
    .run();
  return c.json({ ok: true });
});

// ─── 채팅 ────────────────────────────────────────────────────────────────────

/** 채널 이름을 저장 키로 바꾼다. 볼 권한이 없으면 null. */
async function channelKey(db: D1Database, me: string, channel: string): Promise<string | null> {
  if (channel === 'global') return 'global';
  if (channel === 'guild') {
    const m = await db.prepare('SELECT guild_id FROM guild_members WHERE user_id = ?').bind(me).first<{ guild_id: string }>();
    return m ? `guild:${m.guild_id}` : null;
  }
  if (channel.startsWith('dm:')) {
    const other = channel.slice(3);
    if (!UUID.test(other) || other === me) return null;
    if ((await relationOf(db, me, other)) !== 'friend') return null;
    return `dm:${[me, other].sort().join(':')}`;
  }
  return null;
}

social.get('/chat/:channel', async (c) => {
  const me = c.get('user').id;
  const key = await channelKey(c.env.DB, me, c.req.param('channel'));
  if (!key) return c.json({ error: 'no_channel' }, 403);
  const after = Math.max(0, Number.parseInt(c.req.query('after') ?? '0', 10) || 0);
  const { results } = await c.env.DB
    .prepare(
      after > 0
        ? 'SELECT id, user_id, nickname, body, created_at FROM chat_messages WHERE channel = ? AND id > ? ORDER BY id LIMIT 50'
        : 'SELECT * FROM (SELECT id, user_id, nickname, body, created_at FROM chat_messages WHERE channel = ? AND id > ? ORDER BY id DESC LIMIT 50) ORDER BY id',
    )
    .bind(key, after)
    .all<{ id: number; user_id: string; nickname: string; body: string; created_at: number }>();
  return c.json({ messages: (results ?? []).map((m) => ({ id: m.id, userId: m.user_id, nickname: m.nickname, body: m.body, at: m.created_at })) });
});

social.post('/chat/:channel', async (c) => {
  const user = c.get('user');
  const key = await channelKey(c.env.DB, user.id, c.req.param('channel'));
  if (!key) return c.json({ error: 'no_channel' }, 403);
  if (key === 'global' && !user.emailVerified) return c.json({ error: 'email_required' }, 403);
  const { body } = await c.req.json<{ body?: unknown }>();
  const text = typeof body === 'string' ? body.replace(/\s+/g, ' ').trim() : '';
  if (!text || text.length > CHAT_MAX_LEN) return c.json({ error: 'invalid_message' }, 400);

  const now = Date.now();
  const last = await c.env.DB
    .prepare('SELECT created_at FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT 1')
    .bind(user.id)
    .first<{ created_at: number }>();
  if (last && now - last.created_at < CHAT_MIN_GAP_MS) return c.json({ error: 'slow_down' }, 429);

  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO chat_messages (channel, user_id, nickname, body, created_at) VALUES (?, ?, ?, ?, ?)').bind(key, user.id, user.nickname, text, now),
    // 채널마다 최근 300개만 남긴다
    c.env.DB
      .prepare('DELETE FROM chat_messages WHERE channel = ? AND id <= (SELECT id FROM chat_messages WHERE channel = ? ORDER BY id DESC LIMIT 1 OFFSET 300)')
      .bind(key, key),
  ]);
  return c.json({ ok: true });
});
