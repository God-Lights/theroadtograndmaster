import { Hono } from 'hono';
import { computeStats, itemById, mobById, type MobData } from '@rtgm/data';
import {
  chooseEnemyAction,
  createBattle,
  mulberry32,
  resolveRound,
  type Action,
  type BattleState,
} from '@rtgm/engine';
import type { AppEnv } from './auth';
import { equippedItems, getInventory } from './character';

export const battle = new Hono<AppEnv>();

const PLAYER_ID = 'player';
const ENEMY_ID = 'enemy';

export interface Rewards {
  gold: number;
  /** 이번 전투로 오른 숙련도 */
  proficiency: number;
  items: { itemId: string; name: string; quantity: number }[];
}

/** 시드로 재현 가능한 보상 굴림 */
export function rollRewards(mob: MobData, seed: number): Rewards {
  const rng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
  const [min, max] = mob.gold;
  const gold = min + Math.floor(rng() * (max - min + 1));
  const items = mob.drops
    .filter((d) => rng() < d.chance)
    .map((d) => ({ itemId: d.itemId, name: itemById(d.itemId)?.name ?? d.itemId, quantity: 1 }));
  return { gold, proficiency: mob.profWin, items };
}

/** 패배해도 소량의 숙련도는 얻는다 (EDRPG와 같음) */
export function defeatRewards(mob: MobData): Rewards {
  return { gold: 0, proficiency: mob.profLose, items: [] };
}

battle.post('/battle', async (c) => {
  const userId = c.get('user').id;
  const { mobId } = await c.req.json<{ mobId?: string }>();
  const mob = mobId ? mobById(mobId) : undefined;
  if (!mob) return c.json({ error: 'unknown mob' }, 404);

  // 장착한 장비가 전투 스탯에 반영된다
  const stats = computeStats(equippedItems(await getInventory(c.env.DB, userId)));
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;

  const state = createBattle(
    [
      { id: PLAYER_ID, name: '모험가', side: 'player', hp: stats.maxHp, guardedLastRound: false, stats },
      {
        id: ENEMY_ID, name: mob.name, side: 'enemy', hp: mob.hp, guardedLastRound: false,
        stats: { maxHp: mob.hp, atk: mob.atk, def: mob.def, spd: mob.spd },
      },
    ],
    seed,
  );

  const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO battles (id, user_id, mob_id, state, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, userId, mob.id, JSON.stringify(state), Date.now())
    .run();
  return c.json({ id, state });
});

battle.post('/battle/:id/round', async (c) => {
  const userId = c.get('user').id;
  const id = c.req.param('id');
  const body = await c.req.json<{ action?: 'attack' | 'guard' | 'item'; itemId?: string }>();

  const row = await c.env.DB
    .prepare('SELECT state, mob_id, rewarded FROM battles WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first<{ state: string; mob_id: string; rewarded: number }>();
  // 남의 전투는 존재 여부도 알려주지 않는다
  if (!row) return c.json({ error: 'battle not found' }, 404);
  const state = JSON.parse(row.state) as BattleState;
  if (state.status !== 'ongoing') return c.json({ state, log: [] });

  let playerAction: Action;
  if (body.action === 'attack') {
    playerAction = { kind: 'attack', targetId: ENEMY_ID };
  } else if (body.action === 'guard') {
    playerAction = { kind: 'guard' };
  } else if (body.action === 'item') {
    const item = body.itemId ? itemById(body.itemId) : undefined;
    if (!item || item.type !== 'consumable' || item.heal <= 0) return c.json({ error: 'invalid item' }, 400);
    // 보유한 아이템만 쓸 수 있고, 쓰는 즉시 1개 소모한다
    const [used] = await c.env.DB.batch([
      c.env.DB
        .prepare('UPDATE inventory SET quantity = quantity - 1 WHERE user_id = ? AND item_id = ? AND quantity >= 1')
        .bind(userId, item.id),
      c.env.DB.prepare('DELETE FROM inventory WHERE user_id = ? AND quantity <= 0').bind(userId),
    ]);
    if (used?.meta.changes === 0) return c.json({ error: 'no_item' }, 400);
    playerAction = { kind: 'item', itemId: item.id, healHp: item.heal };
  } else {
    return c.json({ error: 'invalid action' }, 400);
  }

  const enemy = state.combatants.find((x) => x.id === ENEMY_ID)!;
  const enemyAction = chooseEnemyAction(state, enemy);
  const result = resolveRound(state, { [PLAYER_ID]: playerAction, [ENEMY_ID]: enemyAction });
  await c.env.DB.prepare('UPDATE battles SET state = ? WHERE id = ?').bind(JSON.stringify(result.state), id).run();

  // 승패 보상(골드·아이템·숙련도)은 전투당 한 번만 (rewarded 플래그를 먼저 선점한 요청만 지급)
  let rewards: Rewards | undefined;
  const mob = mobById(row.mob_id);
  const outcome = result.state.status;
  if (outcome !== 'ongoing' && mob && row.rewarded === 0) {
    const claim = await c.env.DB.prepare('UPDATE battles SET rewarded = 1 WHERE id = ? AND rewarded = 0').bind(id).run();
    if (claim.meta.changes === 1) {
      rewards = outcome === 'victory' ? rollRewards(mob, state.rngSeed) : defeatRewards(mob);
      await c.env.DB.batch([
        c.env.DB
          .prepare('UPDATE characters SET gold = gold + ?, proficiency = proficiency + ? WHERE user_id = ?')
          .bind(rewards.gold, rewards.proficiency, userId),
        ...rewards.items.map((it) =>
          c.env.DB
            .prepare(
              `INSERT INTO inventory (user_id, item_id, quantity, equipped) VALUES (?, ?, ?, 0)
               ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity`,
            )
            .bind(userId, it.itemId, it.quantity),
        ),
      ]);
    }
  }
  return c.json({ ...result, rewards });
});
