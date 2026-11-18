import { Hono } from 'hono';
import { CRAFT_PROFICIENCY_GAIN, itemById, recipeById } from '@rtgm/data';
import type { AppEnv } from './auth';
import { getCharacter, getInventory, snapshot } from './character';
import { guard } from './guard';

export const craft = new Hono<AppEnv>();

craft.post('/craft', async (c) => {
  const userId = c.get('user').id;
  const { recipeId } = await c.req.json<{ recipeId?: string }>();
  const recipe = recipeId ? recipeById(recipeId) : undefined;
  const result = recipe ? itemById(recipe.resultId) : undefined;
  if (!recipe || !result) return c.json({ error: 'unknown_recipe' }, 400);

  const { gold, proficiency } = await getCharacter(c.env.DB, userId);
  if (proficiency < recipe.unlockProficiency) {
    return c.json({ error: 'recipe_locked', required: recipe.unlockProficiency }, 403);
  }
  if (gold < recipe.gold) return c.json({ error: 'not_enough_gold', required: recipe.gold }, 400);

  // 장착 중인 아이템은 재료로 쓸 수 없다 (EDRPG 규칙): 장착한 1개를 뺀 수량만 쓸 수 있다
  const owned = new Map((await getInventory(c.env.DB, userId)).map((r) => [r.item_id, r]));
  for (const m of recipe.materials) {
    const row = owned.get(m.itemId);
    const usable = row ? row.quantity - row.equipped : 0;
    if (usable < m.quantity) {
      const equippedOnly = !!row && row.quantity >= m.quantity;
      return c.json({ error: equippedOnly ? 'material_equipped' : 'not_enough_material', itemId: m.itemId }, 400);
    }
  }

  // 위 검사는 사전 안내용이고, 실제 보장은 아래 가드 + 트랜잭션이 한다 (동시 요청·장착 변경 대비)
  const db = c.env.DB;
  const stmts = [];
  if (recipe.gold > 0) {
    stmts.push(
      db.prepare('UPDATE characters SET gold = gold - ? WHERE user_id = ? AND gold >= ?').bind(recipe.gold, userId, recipe.gold),
      guard(db),
    );
  }
  for (const m of recipe.materials) {
    stmts.push(
      db
        .prepare('UPDATE inventory SET quantity = quantity - ? WHERE user_id = ? AND item_id = ? AND quantity - equipped >= ?')
        .bind(m.quantity, userId, m.itemId, m.quantity),
      guard(db),
    );
  }
  stmts.push(
    db.prepare('DELETE FROM inventory WHERE user_id = ? AND quantity <= 0').bind(userId),
    db
      .prepare(
        `INSERT INTO inventory (user_id, item_id, quantity, equipped) VALUES (?, ?, ?, 0)
         ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity`,
      )
      .bind(userId, result.id, recipe.resultQty),
    db.prepare('UPDATE characters SET proficiency = proficiency + ? WHERE user_id = ?').bind(CRAFT_PROFICIENCY_GAIN, userId),
  );

  try {
    await db.batch(stmts);
  } catch {
    return c.json({ error: 'craft_failed' }, 409);
  }
  return c.json({
    ...(await snapshot(db, userId)),
    crafted: { itemId: result.id, name: result.name, quantity: recipe.resultQty },
    proficiencyGained: CRAFT_PROFICIENCY_GAIN,
  });
});
