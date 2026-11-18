import { Hono } from 'hono';
import { itemById } from '@rtgm/data';
import type { AppEnv } from './auth';
import { guard } from './guard';
import { UUID } from './social';

/**
 * 교환소: 아이템을 달런트 가격으로 올려 두면 다른 플레이어가 산다. (지정 거래: 특정 플레이어만 살 수 있게 올리기)
 * 등록하는 순간 아이템이 인벤토리에서 빠져 에스크로되므로, 복제·이중 판매가 생기지 않는다.
 */
export const exchange = new Hono<AppEnv>();

export const FEE_RATE = 0.05;
export const MAX_ACTIVE_LISTINGS = 20;
export const MAX_PRICE = 99_999_999;
export const MAX_LIST_QTY = 9999;
/** 판매자가 받는 금액 (수수료 5%, 작은 거래는 수수료 없음) */
export const proceeds = (price: number): number => price - Math.floor(price * FEE_RATE);

interface ListingRow {
  id: string; seller_id: string; item_id: string; quantity: number; price: number;
  buyer_only: string | null; status: string; buyer_id: string | null; created_at: number; closed_at: number | null;
  seller_name?: string | null; buyer_name?: string | null;
}
const view = (l: ListingRow) => ({
  id: l.id, sellerId: l.seller_id, seller: l.seller_name ?? '알 수 없음', itemId: l.item_id, quantity: l.quantity, price: l.price,
  private: l.buyer_only !== null, status: l.status, buyer: l.buyer_name ?? undefined, createdAt: l.created_at, closedAt: l.closed_at ?? undefined,
});

const SELECT = `SELECT l.*, ps.nickname AS seller_name, pb.nickname AS buyer_name FROM listings l
  LEFT JOIN profiles ps ON ps.user_id = l.seller_id LEFT JOIN profiles pb ON pb.user_id = COALESCE(l.buyer_id, l.buyer_only)`;

/** 살 수 있는 목록 (공개 + 나에게 지정된 것). 내가 올린 것은 mine 에서 본다. */
exchange.get('/exchange', async (c) => {
  const me = c.get('user').id;
  const itemId = c.req.query('item');
  const { results } = await c.env.DB
    .prepare(`${SELECT} WHERE l.status = 'active' AND l.seller_id != ? AND (l.buyer_only IS NULL OR l.buyer_only = ?)
      ${itemId ? 'AND l.item_id = ?' : ''} ORDER BY l.created_at DESC LIMIT 60`)
    .bind(...(itemId ? [me, me, itemId] : [me, me]))
    .all<ListingRow>();
  return c.json({ feeRate: FEE_RATE, listings: (results ?? []).map(view) });
});

exchange.get('/exchange/mine', async (c) => {
  const me = c.get('user').id;
  const { results } = await c.env.DB
    .prepare(`${SELECT} WHERE l.seller_id = ? AND l.status != 'cancelled' ORDER BY (l.status = 'active') DESC, COALESCE(l.closed_at, l.created_at) DESC LIMIT 40`)
    .bind(me)
    .all<ListingRow>();
  return c.json({ feeRate: FEE_RATE, listings: (results ?? []).map((l) => ({ ...view(l), proceeds: proceeds(l.price) })) });
});

exchange.post('/exchange/list', async (c) => {
  const me = c.get('user').id;
  const body = await c.req.json<{ itemId?: string; quantity?: unknown; price?: unknown; to?: string | null }>();
  const item = body.itemId ? itemById(body.itemId) : undefined;
  const qty = body.quantity;
  const price = body.price;
  if (!item || !Number.isInteger(qty) || (qty as number) < 1 || (qty as number) > MAX_LIST_QTY) return c.json({ error: 'invalid_request' }, 400);
  if (!Number.isInteger(price) || (price as number) < 1 || (price as number) > MAX_PRICE) return c.json({ error: 'invalid_price' }, 400);
  const to = body.to ?? null;
  if (to !== null && (!UUID.test(to) || to === me)) return c.json({ error: 'invalid_request' }, 400);
  if (to !== null && !(await c.env.DB.prepare('SELECT 1 AS x FROM profiles WHERE user_id = ?').bind(to).first())) return c.json({ error: 'player_not_found' }, 404);

  const active = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM listings WHERE seller_id = ? AND status = 'active'").bind(me).first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_ACTIVE_LISTINGS) return c.json({ error: 'too_many_listings' }, 400);

  const id = crypto.randomUUID();
  try {
    await c.env.DB.batch([
      // 장착 중인 마지막 1개는 올릴 수 없다
      c.env.DB
        .prepare('UPDATE inventory SET quantity = quantity - ? WHERE user_id = ? AND item_id = ? AND quantity >= ? AND (equipped = 0 OR quantity > ?)')
        .bind(qty as number, me, item.id, qty as number, qty as number),
      guard(c.env.DB),
      c.env.DB
        .prepare('INSERT INTO listings (id, seller_id, item_id, quantity, price, buyer_only, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, me, item.id, qty as number, price as number, to, Date.now()),
      c.env.DB.prepare('DELETE FROM inventory WHERE user_id = ? AND quantity <= 0').bind(me),
    ]);
  } catch {
    return c.json({ error: 'cannot_list' }, 400);
  }
  return c.json({ ok: true, id });
});

exchange.post('/exchange/buy', async (c) => {
  const me = c.get('user').id;
  const { listingId } = await c.req.json<{ listingId?: string }>();
  if (!listingId || !UUID.test(listingId)) return c.json({ error: 'invalid_request' }, 400);
  const l = await c.env.DB.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").bind(listingId).first<ListingRow>();
  if (!l || (l.buyer_only !== null && l.buyer_only !== me)) return c.json({ error: 'listing_unavailable' }, 404);
  if (l.seller_id === me) return c.json({ error: 'own_listing' }, 400);

  try {
    await c.env.DB.batch([
      // 1) 아직 팔리지 않았을 때만 내 것으로 확정
      c.env.DB
        .prepare("UPDATE listings SET status = 'sold', buyer_id = ?, closed_at = ? WHERE id = ? AND status = 'active' AND seller_id != ? AND (buyer_only IS NULL OR buyer_only = ?)")
        .bind(me, Date.now(), listingId, me, me),
      guard(c.env.DB),
      // 2) 골드가 충분할 때만 차감
      c.env.DB.prepare('UPDATE characters SET gold = gold - ? WHERE user_id = ? AND gold >= ?').bind(l.price, me, l.price),
      guard(c.env.DB),
      // 3) 판매자에게 지급 (수수료 제외), 구매자에게 아이템
      c.env.DB.prepare('UPDATE characters SET gold = gold + ? WHERE user_id = ?').bind(proceeds(l.price), l.seller_id),
      c.env.DB
        .prepare('INSERT INTO inventory (user_id, item_id, quantity, equipped) VALUES (?, ?, ?, 0) ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity')
        .bind(me, l.item_id, l.quantity),
    ]);
  } catch {
    // 실패 원인: 그 사이 팔렸거나 골드가 부족
    const now = await c.env.DB.prepare("SELECT 1 AS x FROM listings WHERE id = ? AND status = 'active'").bind(listingId).first();
    return c.json({ error: now ? 'not_enough_gold' : 'listing_unavailable' }, now ? 400 : 409);
  }
  return c.json({ ok: true });
});

exchange.post('/exchange/cancel', async (c) => {
  const me = c.get('user').id;
  const { listingId } = await c.req.json<{ listingId?: string }>();
  if (!listingId || !UUID.test(listingId)) return c.json({ error: 'invalid_request' }, 400);
  const l = await c.env.DB.prepare("SELECT * FROM listings WHERE id = ? AND seller_id = ? AND status = 'active'").bind(listingId, me).first<ListingRow>();
  if (!l) return c.json({ error: 'listing_unavailable' }, 404);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE listings SET status = 'cancelled', closed_at = ? WHERE id = ? AND seller_id = ? AND status = 'active'").bind(Date.now(), listingId, me),
      guard(c.env.DB),
      c.env.DB
        .prepare('INSERT INTO inventory (user_id, item_id, quantity, equipped) VALUES (?, ?, ?, 0) ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity')
        .bind(me, l.item_id, l.quantity),
    ]);
  } catch {
    return c.json({ error: 'listing_unavailable' }, 409);
  }
  return c.json({ ok: true });
});
