import { Hono } from 'hono';
import { ITEMS, MAX_BUY_QUANTITY, isEquipType, itemById } from '@rtgm/data';
import type { AppEnv } from './auth';
import { getCharacter, snapshot } from './character';

export const inventory = new Hono<AppEnv>();

const toQuantity = (v: unknown, max = MAX_BUY_QUANTITY): number | null =>
  Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max ? (v as number) : null;

inventory.get('/inventory', async (c) => c.json(await snapshot(c.env.DB, c.get('user').id)));

inventory.post('/inventory/equip', async (c) => {
  const userId = c.get('user').id;
  const { itemId } = await c.req.json<{ itemId?: string }>();
  const item = itemId ? itemById(itemId) : undefined;
  if (!item || !isEquipType(item.type)) return c.json({ error: 'not_equippable' }, 400);

  const owned = await c.env.DB
    .prepare('SELECT quantity FROM inventory WHERE user_id = ? AND item_id = ? AND quantity >= 1')
    .bind(userId, item.id)
    .first();
  if (!owned) return c.json({ error: 'not_owned' }, 404);

  const { proficiency } = await getCharacter(c.env.DB, userId);
  if (proficiency < item.minProficiency) {
    return c.json({ error: 'proficiency_too_low', required: item.minProficiency }, 403);
  }

  // 같은 슬롯(종류)의 장비를 모두 해제하고 선택한 것만 장착한다. 한 트랜잭션.
  const sameSlot = ITEMS.filter((i) => i.type === item.type).map((i) => i.id);
  await c.env.DB.batch([
    c.env.DB
      .prepare(`UPDATE inventory SET equipped = 0 WHERE user_id = ? AND item_id IN (${sameSlot.map(() => '?').join(',')})`)
      .bind(userId, ...sameSlot),
    c.env.DB.prepare('UPDATE inventory SET equipped = 1 WHERE user_id = ? AND item_id = ?').bind(userId, item.id),
  ]);
  return c.json(await snapshot(c.env.DB, userId));
});

inventory.post('/inventory/unequip', async (c) => {
  const userId = c.get('user').id;
  const { itemId } = await c.req.json<{ itemId?: string }>();
  const item = itemId ? itemById(itemId) : undefined;
  if (!item) return c.json({ error: 'unknown_item' }, 400);
  await c.env.DB.prepare('UPDATE inventory SET equipped = 0 WHERE user_id = ? AND item_id = ?').bind(userId, item.id).run();
  return c.json(await snapshot(c.env.DB, userId));
});

inventory.post('/inventory/sell', async (c) => {
  const userId = c.get('user').id;
  const body = await c.req.json<{ itemId?: string; quantity?: unknown }>();
  const item = body.itemId ? itemById(body.itemId) : undefined;
  const qty = toQuantity(body.quantity ?? 1, 9999);
  if (!item || item.sell <= 0 || !qty) return c.json({ error: 'invalid_request' }, 400);

  // 1) 보유 수량 차감 (장착 중인 마지막 1개는 팔 수 없음)
  // 2) 실제로 차감됐을 때만 골드 지급: changes() 가 0이면 0골드
  // 3) 수량 0 행 정리 — 모두 한 트랜잭션
  const [deducted] = await c.env.DB.batch([
    c.env.DB
      .prepare(
        'UPDATE inventory SET quantity = quantity - ? WHERE user_id = ? AND item_id = ? AND quantity >= ? AND (equipped = 0 OR quantity > ?)',
      )
      .bind(qty, userId, item.id, qty, qty),
    c.env.DB.prepare('UPDATE characters SET gold = gold + ? * changes() WHERE user_id = ?').bind(item.sell * qty, userId),
    c.env.DB.prepare('DELETE FROM inventory WHERE user_id = ? AND quantity <= 0').bind(userId),
  ]);
  if (deducted?.meta.changes === 0) return c.json({ error: 'cannot_sell' }, 400);
  return c.json(await snapshot(c.env.DB, userId));
});

inventory.post('/shop/buy', async (c) => {
  const userId = c.get('user').id;
  const body = await c.req.json<{ itemId?: string; quantity?: unknown }>();
  const item = body.itemId ? itemById(body.itemId) : undefined;
  const qty = toQuantity(body.quantity ?? 1);
  if (!item || item.buy === null || !qty) return c.json({ error: 'invalid_request' }, 400);

  const { proficiency } = await getCharacter(c.env.DB, userId);
  if (proficiency < item.minProficiency) {
    return c.json({ error: 'proficiency_too_low', required: item.minProficiency }, 403);
  }

  // 골드가 충분할 때만 차감되고(changes()=1), 그때만 아이템이 들어간다. 한 트랜잭션.
  const [paid] = await c.env.DB.batch([
    c.env.DB
      .prepare('UPDATE characters SET gold = gold - ? WHERE user_id = ? AND gold >= ?')
      .bind(item.buy * qty, userId, item.buy * qty),
    c.env.DB
      .prepare(
        `INSERT INTO inventory (user_id, item_id, quantity, equipped)
         SELECT ?, ?, ?, 0 WHERE changes() = 1
         ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity`,
      )
      .bind(userId, item.id, qty),
  ]);
  if (paid?.meta.changes === 0) return c.json({ error: 'not_enough_gold' }, 400);
  return c.json(await snapshot(c.env.DB, userId));
});
