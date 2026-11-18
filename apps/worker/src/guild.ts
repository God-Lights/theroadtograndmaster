import { Hono } from 'hono';
import type { AppEnv } from './auth';
import { guard } from './guard';
import { ONLINE_MS, UUID } from './social';

export const guilds = new Hono<AppEnv>();

export const GUILD_CAPACITY = 20;
export const GUILD_CREATE_COST = 1000;
export const GUILD_NAME_RE = /^[0-9A-Za-z가-힣 ]{2,12}$/;
/** 기부 누적액으로 정해지는 길드 레벨 (1000D당 제곱근) */
export const guildLevel = (gold: number): number => Math.floor(Math.sqrt(Math.max(0, gold) / 1000)) + 1;

interface Membership { guild_id: string; role: 'leader' | 'officer' | 'member' }
const membershipOf = (db: D1Database, userId: string) =>
  db.prepare('SELECT guild_id, role FROM guild_members WHERE user_id = ?').bind(userId).first<Membership>();

guilds.get('/guilds', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const { results } = await c.env.DB
    .prepare(
      `SELECT g.id, g.name, g.description, g.gold, COUNT(m.user_id) AS members FROM guilds g
       LEFT JOIN guild_members m ON m.guild_id = g.id
       WHERE g.name LIKE ? ESCAPE '\\' GROUP BY g.id ORDER BY members DESC, g.name LIMIT 30`,
    )
    .bind(like)
    .all<{ id: string; name: string; description: string; gold: number; members: number }>();
  return c.json({
    capacity: GUILD_CAPACITY,
    guilds: (results ?? []).map((g) => ({ id: g.id, name: g.name, description: g.description, level: guildLevel(g.gold), members: g.members })),
  });
});

/** 내 길드 (없으면 guild: null) */
guilds.get('/guild', async (c) => {
  const me = c.get('user').id;
  const mem = await membershipOf(c.env.DB, me);
  if (!mem) return c.json({ guild: null, createCost: GUILD_CREATE_COST });
  const g = await c.env.DB.prepare('SELECT id, name, description, gold FROM guilds WHERE id = ?').bind(mem.guild_id).first<{ id: string; name: string; description: string; gold: number }>();
  if (!g) return c.json({ guild: null, createCost: GUILD_CREATE_COST });
  const { results } = await c.env.DB
    .prepare(
      `SELECT m.user_id, m.role, m.contribution, p.nickname, p.last_seen, ch.proficiency FROM guild_members m
       LEFT JOIN profiles p ON p.user_id = m.user_id LEFT JOIN characters ch ON ch.user_id = m.user_id
       WHERE m.guild_id = ? ORDER BY CASE m.role WHEN 'leader' THEN 0 WHEN 'officer' THEN 1 ELSE 2 END, m.contribution DESC`,
    )
    .bind(g.id)
    .all<{ user_id: string; role: string; contribution: number; nickname: string | null; last_seen: number | null; proficiency: number | null }>();
  return c.json({
    createCost: GUILD_CREATE_COST,
    guild: {
      id: g.id, name: g.name, description: g.description, level: guildLevel(g.gold), gold: g.gold, capacity: GUILD_CAPACITY, myRole: mem.role,
      members: (results ?? []).map((m) => ({
        id: m.user_id, nickname: m.nickname ?? '알 수 없음', role: m.role, contribution: m.contribution,
        online: m.last_seen !== null && Date.now() - m.last_seen < ONLINE_MS, proficiency: m.proficiency ?? 0,
      })),
    },
  });
});

guilds.post('/guild/create', async (c) => {
  const me = c.get('user').id;
  const body = await c.req.json<{ name?: unknown; description?: unknown }>();
  const name = typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 100) : '';
  if (!GUILD_NAME_RE.test(name)) return c.json({ error: 'invalid_guild_name' }, 400);
  if (await membershipOf(c.env.DB, me)) return c.json({ error: 'already_in_guild' }, 409);
  if (await c.env.DB.prepare('SELECT 1 AS x FROM guilds WHERE name = ? COLLATE NOCASE').bind(name).first()) return c.json({ error: 'guild_name_taken' }, 409);

  const id = crypto.randomUUID();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE characters SET gold = gold - ? WHERE user_id = ? AND gold >= ?').bind(GUILD_CREATE_COST, me, GUILD_CREATE_COST),
      guard(c.env.DB),
      c.env.DB.prepare('INSERT INTO guilds (id, name, description, leader_id, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, name, description, me, Date.now()),
      c.env.DB.prepare("INSERT INTO guild_members (user_id, guild_id, role, joined_at) VALUES (?, ?, 'leader', ?)").bind(me, id, Date.now()),
    ]);
  } catch {
    return c.json({ error: 'not_enough_gold' }, 400);
  }
  return c.json({ ok: true, id });
});

guilds.post('/guild/join', async (c) => {
  const me = c.get('user').id;
  const { guildId } = await c.req.json<{ guildId?: string }>();
  if (!guildId || !UUID.test(guildId)) return c.json({ error: 'invalid_request' }, 400);
  if (await membershipOf(c.env.DB, me)) return c.json({ error: 'already_in_guild' }, 409);
  const res = await c.env.DB
    .prepare(
      `INSERT INTO guild_members (user_id, guild_id, role, joined_at)
       SELECT ?, ?, 'member', ? WHERE EXISTS (SELECT 1 FROM guilds WHERE id = ?)
       AND (SELECT COUNT(*) FROM guild_members WHERE guild_id = ?) < ?`,
    )
    .bind(me, guildId, Date.now(), guildId, guildId, GUILD_CAPACITY)
    .run();
  if (res.meta.changes === 0) return c.json({ error: 'guild_full_or_missing' }, 400);
  return c.json({ ok: true });
});

async function disband(db: D1Database, guildId: string) {
  await db.batch([
    db.prepare('DELETE FROM guild_members WHERE guild_id = ?').bind(guildId),
    db.prepare('DELETE FROM guilds WHERE id = ?').bind(guildId),
    db.prepare('DELETE FROM chat_messages WHERE channel = ?').bind(`guild:${guildId}`),
  ]);
}

guilds.post('/guild/leave', async (c) => {
  const me = c.get('user').id;
  const mem = await membershipOf(c.env.DB, me);
  if (!mem) return c.json({ error: 'not_in_guild' }, 400);
  if (mem.role === 'leader') {
    const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM guild_members WHERE guild_id = ?').bind(mem.guild_id).first<{ n: number }>();
    if ((n?.n ?? 0) > 1) return c.json({ error: 'leader_must_transfer' }, 400);
    await disband(c.env.DB, mem.guild_id);
    return c.json({ ok: true, disbanded: true });
  }
  await c.env.DB.prepare('DELETE FROM guild_members WHERE user_id = ?').bind(me).run();
  return c.json({ ok: true });
});

guilds.post('/guild/disband', async (c) => {
  const mem = await membershipOf(c.env.DB, c.get('user').id);
  if (!mem || mem.role !== 'leader') return c.json({ error: 'not_allowed' }, 403);
  await disband(c.env.DB, mem.guild_id);
  return c.json({ ok: true });
});

guilds.post('/guild/kick', async (c) => {
  const me = c.get('user').id;
  const { userId } = await c.req.json<{ userId?: string }>();
  const mem = await membershipOf(c.env.DB, me);
  if (!mem || mem.role === 'member' || !userId || !UUID.test(userId) || userId === me) return c.json({ error: 'not_allowed' }, 403);
  const target = await membershipOf(c.env.DB, userId);
  if (!target || target.guild_id !== mem.guild_id) return c.json({ error: 'not_allowed' }, 403);
  // 간부는 일반 길드원만 내보낼 수 있다
  if (mem.role === 'officer' && target.role !== 'member') return c.json({ error: 'not_allowed' }, 403);
  await c.env.DB.prepare('DELETE FROM guild_members WHERE user_id = ?').bind(userId).run();
  return c.json({ ok: true });
});

/** 길드장이 간부 임명/해임 또는 길드장 위임 */
guilds.post('/guild/role', async (c) => {
  const me = c.get('user').id;
  const { userId, role } = await c.req.json<{ userId?: string; role?: string }>();
  const mem = await membershipOf(c.env.DB, me);
  if (!mem || mem.role !== 'leader' || !userId || !UUID.test(userId) || userId === me) return c.json({ error: 'not_allowed' }, 403);
  const target = await membershipOf(c.env.DB, userId);
  if (!target || target.guild_id !== mem.guild_id) return c.json({ error: 'not_allowed' }, 403);
  if (role === 'officer' || role === 'member') {
    await c.env.DB.prepare('UPDATE guild_members SET role = ? WHERE user_id = ?').bind(role, userId).run();
  } else if (role === 'leader') {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE guild_members SET role = 'leader' WHERE user_id = ?").bind(userId),
      c.env.DB.prepare("UPDATE guild_members SET role = 'officer' WHERE user_id = ?").bind(me),
      c.env.DB.prepare('UPDATE guilds SET leader_id = ? WHERE id = ?').bind(userId, mem.guild_id),
    ]);
  } else return c.json({ error: 'invalid_request' }, 400);
  return c.json({ ok: true });
});

guilds.post('/guild/donate', async (c) => {
  const me = c.get('user').id;
  const { amount } = await c.req.json<{ amount?: unknown }>();
  if (!Number.isInteger(amount) || (amount as number) < 1 || (amount as number) > 10_000_000) return c.json({ error: 'invalid_request' }, 400);
  const mem = await membershipOf(c.env.DB, me);
  if (!mem) return c.json({ error: 'not_in_guild' }, 400);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE characters SET gold = gold - ? WHERE user_id = ? AND gold >= ?').bind(amount as number, me, amount as number),
      guard(c.env.DB),
      c.env.DB.prepare('UPDATE guilds SET gold = gold + ? WHERE id = ?').bind(amount as number, mem.guild_id),
      c.env.DB.prepare('UPDATE guild_members SET contribution = contribution + ? WHERE user_id = ?').bind(amount as number, me),
    ]);
  } catch {
    return c.json({ error: 'not_enough_gold' }, 400);
  }
  return c.json({ ok: true });
});
