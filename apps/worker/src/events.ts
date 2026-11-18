import { Hono } from 'hono';
import { itemById } from '@rtgm/data';
import { requireAdmin } from './admin';
import type { AppEnv } from './auth';
import { guard } from './guard';
import { UUID } from './social';

export type EventKind = 'notice' | 'bonus' | 'gift';
export interface BonusConfig { gold?: number; proficiency?: number; drop?: number }
export interface GiftConfig { gold?: number; items?: { itemId: string; quantity: number }[] }

export const MAX_EVENT_DAYS = 60;
export const MAX_BONUS = 5;
export const MAX_GIFT_GOLD = 1_000_000;
export const MAX_GIFT_ITEMS = 5;
export const MAX_GIFT_QTY = 999;
const DAY = 86_400_000;

export interface EventInput {
  title: string; description: string; kind: EventKind; config: BonusConfig | GiftConfig | Record<string, never>; startsAt: number; endsAt: number;
}

/** 관리자가 보낸 값을 검증하고 정리한다. 문제가 있으면 error 코드를 돌려준다. */
export function validateEvent(raw: Record<string, unknown>, now = Date.now()): { ok: true; value: EventInput } | { ok: false; error: string } {
  const title = typeof raw.title === 'string' ? raw.title.replace(/\s+/g, ' ').trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (title.length < 2 || title.length > 40) return { ok: false, error: 'invalid_title' };
  if (description.length > 300) return { ok: false, error: 'invalid_description' };
  const kind = raw.kind;
  if (kind !== 'notice' && kind !== 'bonus' && kind !== 'gift') return { ok: false, error: 'invalid_kind' };
  const startsAt = Number(raw.startsAt), endsAt = Number(raw.endsAt);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt || endsAt <= now) return { ok: false, error: 'invalid_period' };
  if (endsAt - startsAt > MAX_EVENT_DAYS * DAY || startsAt > now + 90 * DAY) return { ok: false, error: 'invalid_period' };

  const cfg = (raw.config ?? {}) as Record<string, unknown>;
  if (kind === 'bonus') {
    const out: BonusConfig = {};
    for (const k of ['gold', 'proficiency', 'drop'] as const) {
      if (cfg[k] === undefined || cfg[k] === null || cfg[k] === '') continue;
      const v = Number(cfg[k]);
      if (!Number.isFinite(v) || v < 1 || v > MAX_BONUS) return { ok: false, error: 'invalid_bonus' };
      out[k] = Math.round(v * 10) / 10;
    }
    if (Object.keys(out).length === 0 || Object.values(out).every((v) => v === 1)) return { ok: false, error: 'invalid_bonus' };
    return { ok: true, value: { title, description, kind, config: out, startsAt, endsAt } };
  }
  if (kind === 'gift') {
    const out: GiftConfig = {};
    const gold = Number(cfg.gold ?? 0);
    if (!Number.isInteger(gold) || gold < 0 || gold > MAX_GIFT_GOLD) return { ok: false, error: 'invalid_gift' };
    if (gold > 0) out.gold = gold;
    const items = Array.isArray(cfg.items) ? cfg.items : [];
    if (items.length > MAX_GIFT_ITEMS) return { ok: false, error: 'invalid_gift' };
    const merged = new Map<string, number>();
    for (const it of items as { itemId?: unknown; quantity?: unknown }[]) {
      const q = Number(it?.quantity);
      if (typeof it?.itemId !== 'string' || !itemById(it.itemId) || !Number.isInteger(q) || q < 1 || q > MAX_GIFT_QTY) return { ok: false, error: 'invalid_gift' };
      merged.set(it.itemId, (merged.get(it.itemId) ?? 0) + q);
    }
    if ([...merged.values()].some((q) => q > MAX_GIFT_QTY)) return { ok: false, error: 'invalid_gift' };
    if (merged.size > 0) out.items = [...merged].map(([itemId, quantity]) => ({ itemId, quantity }));
    if (!out.gold && !out.items) return { ok: false, error: 'invalid_gift' };
    return { ok: true, value: { title, description, kind, config: out, startsAt, endsAt } };
  }
  return { ok: true, value: { title, description, kind, config: {}, startsAt, endsAt } };
}

interface EventRow {
  id: string; title: string; description: string; kind: EventKind; config: string; starts_at: number; ends_at: number; cancelled: number; created_by: string; created_at: number;
}
const status = (e: EventRow, now: number): 'cancelled' | 'upcoming' | 'active' | 'ended' =>
  e.cancelled ? 'cancelled' : now < e.starts_at ? 'upcoming' : now >= e.ends_at ? 'ended' : 'active';
const view = (e: EventRow, now: number, claimed?: boolean) => ({
  id: e.id, title: e.title, description: e.description, kind: e.kind, config: JSON.parse(e.config) as BonusConfig | GiftConfig,
  startsAt: e.starts_at, endsAt: e.ends_at, status: status(e, now), claimed,
});

/** 지금 진행 중인 보너스 이벤트의 배율 (같은 종류는 가장 큰 것 하나만 적용 — 겹쳐서 곱해지지 않는다) */
export async function activeBonus(db: D1Database, now = Date.now()): Promise<Required<BonusConfig>> {
  const { results } = await db
    .prepare("SELECT config FROM events WHERE kind = 'bonus' AND cancelled = 0 AND starts_at <= ? AND ends_at > ?")
    .bind(now, now)
    .all<{ config: string }>();
  const out = { gold: 1, proficiency: 1, drop: 1 };
  for (const r of results ?? []) {
    const c = JSON.parse(r.config) as BonusConfig;
    for (const k of ['gold', 'proficiency', 'drop'] as const) out[k] = Math.max(out[k], Math.min(MAX_BONUS, c[k] ?? 1));
  }
  return out;
}

export const events = new Hono<AppEnv>();

/** 진행 중·예정 이벤트 (내가 선물을 받았는지 포함) */
events.get('/events', async (c) => {
  const me = c.get('user').id;
  const now = Date.now();
  const { results } = await c.env.DB
    .prepare('SELECT * FROM events WHERE cancelled = 0 AND ends_at > ? ORDER BY starts_at LIMIT 30')
    .bind(now)
    .all<EventRow>();
  const claimed = new Set(((await c.env.DB.prepare('SELECT event_id FROM event_claims WHERE user_id = ?').bind(me).all<{ event_id: string }>()).results ?? []).map((r) => r.event_id));
  return c.json({ events: (results ?? []).map((e) => view(e, now, claimed.has(e.id))), bonus: await activeBonus(c.env.DB, now) });
});

events.post('/events/:id/claim', async (c) => {
  const me = c.get('user').id;
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json({ error: 'invalid_request' }, 400);
  const now = Date.now();
  const e = await c.env.DB.prepare("SELECT * FROM events WHERE id = ? AND kind = 'gift' AND cancelled = 0 AND starts_at <= ? AND ends_at > ?").bind(id, now, now).first<EventRow>();
  if (!e) return c.json({ error: 'event_unavailable' }, 404);
  const gift = JSON.parse(e.config) as GiftConfig;
  try {
    await c.env.DB.batch([
      // 이벤트가 열려 있을 때만, 한 사람당 한 번 (기본키 충돌이면 전체 취소)
      c.env.DB
        .prepare("INSERT INTO event_claims (event_id, user_id, claimed_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM events WHERE id = ? AND cancelled = 0 AND starts_at <= ? AND ends_at > ?)")
        .bind(id, me, now, id, now, now),
      guard(c.env.DB),
      ...(gift.gold ? [c.env.DB.prepare('UPDATE characters SET gold = gold + ? WHERE user_id = ?').bind(gift.gold, me)] : []),
      ...(gift.items ?? []).map((it) =>
        c.env.DB
          .prepare('INSERT INTO inventory (user_id, item_id, quantity, equipped) VALUES (?, ?, ?, 0) ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity')
          .bind(me, it.itemId, it.quantity),
      ),
    ]);
  } catch {
    return c.json({ error: 'already_claimed' }, 409);
  }
  return c.json({ ok: true, gift });
});

// ─── 관리자 ──────────────────────────────────────────────────────────────────

export const adminEvents = new Hono<AppEnv>();
adminEvents.use('*', requireAdmin);

/** 관리자 확인용 (화면에서 관리자 메뉴를 보일지 정한다. 권한 검사는 서버가 매번 한다) */
adminEvents.get('/admin/ping', (c) => c.json({ admin: true }));

adminEvents.get('/admin/events', async (c) => {
  const now = Date.now();
  const { results } = await c.env.DB.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT 50').all<EventRow>();
  const counts = new Map(((await c.env.DB.prepare('SELECT event_id, COUNT(*) AS n FROM event_claims GROUP BY event_id').all<{ event_id: string; n: number }>()).results ?? []).map((r) => [r.event_id, r.n]));
  return c.json({ events: (results ?? []).map((e) => ({ ...view(e, now), claims: counts.get(e.id) ?? 0 })) });
});

adminEvents.post('/admin/events', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const v = validateEvent(body);
  if (!v.ok) return c.json({ error: v.error }, 400);
  const id = crypto.randomUUID();
  const { title, description, kind, config, startsAt, endsAt } = v.value;
  await c.env.DB
    .prepare('INSERT INTO events (id, title, description, kind, config, starts_at, ends_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, title, description, kind, JSON.stringify(config), startsAt, endsAt, c.get('user').id, Date.now())
    .run();
  return c.json({ ok: true, id });
});

/** 진행 중이거나 예정인 이벤트를 중단한다 (이미 받은 선물은 그대로) */
adminEvents.post('/admin/events/:id/cancel', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json({ error: 'invalid_request' }, 400);
  const res = await c.env.DB.prepare('UPDATE events SET cancelled = 1 WHERE id = ? AND cancelled = 0').bind(id).run();
  if (res.meta.changes === 0) return c.json({ error: 'event_unavailable' }, 404);
  return c.json({ ok: true });
});
