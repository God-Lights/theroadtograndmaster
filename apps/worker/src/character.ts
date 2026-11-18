import {
  DEFAULT_LOADOUT, STARTER_GOLD, STARTER_ITEMS, computeStats, itemById, type CombatStats, type ItemData,
} from '@rtgm/data';

export interface InventoryRow {
  item_id: string;
  quantity: number;
  equipped: number;
}

/** 기본 스킬을 넣고 '초기화 완료'를 표시한다 (이미 장착한 게 있어도 덮어쓰지 않는다) */
async function initSkills(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    ...DEFAULT_LOADOUT.map((id) =>
      db.prepare('INSERT OR IGNORE INTO skill_loadout (user_id, skill_id) VALUES (?, ?)').bind(userId, id),
    ),
    db.prepare('UPDATE characters SET skills_initialized = 1 WHERE user_id = ?').bind(userId),
  ]);
}

/**
 * 캐릭터가 없으면 만든다 (시작 골드 + 낡은 검·갑옷 장착 + 기본 스킬).
 * 이미 있고 스킬까지 초기화돼 있으면 SELECT 한 번으로 끝난다.
 */
export async function ensureCharacter(db: D1Database, userId: string): Promise<void> {
  const existing = await db
    .prepare('SELECT skills_initialized AS init FROM characters WHERE user_id = ?')
    .bind(userId)
    .first<{ init: number }>();
  if (existing) {
    if (existing.init === 0) await initSkills(db, userId);
    return;
  }

  const res = await db
    .prepare('INSERT OR IGNORE INTO characters (user_id, gold, created_at) VALUES (?, ?, ?)')
    .bind(userId, STARTER_GOLD, Date.now())
    .run();
  if (res.meta.changes === 1) {
    await db.batch(
      STARTER_ITEMS.map((id) =>
        db
          .prepare('INSERT OR IGNORE INTO inventory (user_id, item_id, quantity, equipped) VALUES (?, ?, 1, 1)')
          .bind(userId, id),
      ),
    );
    await initSkills(db, userId);
  }
}

export async function getCharacter(db: D1Database, userId: string): Promise<{ gold: number; proficiency: number }> {
  const row = await db
    .prepare('SELECT gold, proficiency FROM characters WHERE user_id = ?')
    .bind(userId)
    .first<{ gold: number; proficiency: number }>();
  return row ?? { gold: 0, proficiency: 0 };
}

export async function getInventory(db: D1Database, userId: string): Promise<InventoryRow[]> {
  const res = await db
    .prepare('SELECT item_id, quantity, equipped FROM inventory WHERE user_id = ? AND quantity > 0 ORDER BY item_id')
    .bind(userId)
    .all<InventoryRow>();
  return res.results;
}

export function equippedItems(rows: InventoryRow[]): ItemData[] {
  return rows.filter((r) => r.equipped === 1).flatMap((r) => itemById(r.item_id) ?? []);
}

export interface InventorySnapshot {
  gold: number;
  proficiency: number;
  items: { itemId: string; quantity: number; equipped: boolean }[];
  stats: CombatStats;
}

export async function snapshot(db: D1Database, userId: string): Promise<InventorySnapshot> {
  const [character, rows] = await Promise.all([getCharacter(db, userId), getInventory(db, userId)]);
  return {
    ...character,
    items: rows.map((r) => ({ itemId: r.item_id, quantity: r.quantity, equipped: r.equipped === 1 })),
    stats: computeStats(equippedItems(rows)),
  };
}
