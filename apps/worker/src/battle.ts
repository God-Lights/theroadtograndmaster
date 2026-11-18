import { Hono } from 'hono';
import { START_AP, bossScriptFor, computeStats, dungeonById, entryCost, itemById, mobById, type MobData } from '@rtgm/data';
import {
  chooseEnemyAction,
  createBattle,
  mulberry32,
  resolveRound,
  type Action,
  type BattleState,
  type BossScript,
  canUseSkill,
} from '@rtgm/engine';
import type { AppEnv } from './auth';
import { activeBonus } from './events';
import { equippedItems, getCharacter, getInventory } from './character';
import { guard } from './guard';
import { battleSkills } from './skills';

export const battle = new Hono<AppEnv>();

const PLAYER_ID = 'player';
const ENEMY_ID = 'enemy';

/** 이벤트 보너스 배율 (1 = 없음) */
export interface BonusMults { gold: number; proficiency: number; drop: number }
const NO_BONUS: BonusMults = { gold: 1, proficiency: 1, drop: 1 };

export interface Rewards {
  gold: number;
  /** 이번 전투로 오른 숙련도 */
  proficiency: number;
  items: { itemId: string; name: string; quantity: number }[];
}

/** 시드로 재현 가능한 보상 굴림 */
export function rollRewards(mob: MobData, seed: number, bonus: BonusMults = NO_BONUS): Rewards {
  const rng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
  const [min, max] = mob.gold;
  const gold = Math.round((min + Math.floor(rng() * (max - min + 1))) * bonus.gold);
  const items = mob.drops
    .filter((d) => rng() < Math.min(1, d.chance * bonus.drop))
    .map((d) => ({ itemId: d.itemId, name: itemById(d.itemId)?.name ?? d.itemId, quantity: 1 }));
  return { gold, proficiency: Math.round(mob.profWin * bonus.proficiency), items };
}

/** 패배해도 소량의 숙련도는 얻는다 (EDRPG와 같음) */
export function defeatRewards(mob: MobData, bonus: BonusMults = NO_BONUS): Rewards {
  return { gold: 0, proficiency: Math.round(mob.profLose * bonus.proficiency), items: [] };
}

battle.post('/battle', async (c) => {
  const userId = c.get('user').id;
  const { mobId } = await c.req.json<{ mobId?: string }>();
  const mob = mobId ? mobById(mobId) : undefined;
  if (!mob) return c.json({ error: 'unknown mob' }, 404);

  // 던전 입장 조건: 숙련도(하드 제한), 입장 골드, 보스는 열쇠 1개
  const dungeon = dungeonById(mob.dungeon);
  const character = await getCharacter(c.env.DB, userId);
  if (dungeon && character.proficiency < dungeon.minProficiency) {
    return c.json({ error: 'dungeon_locked', required: dungeon.minProficiency }, 403);
  }
  const cost = entryCost(mob);
  if (character.gold < cost.gold) return c.json({ error: 'not_enough_gold', required: cost.gold }, 400);
  if (cost.key) {
    const key = (await getInventory(c.env.DB, userId)).find((r) => r.item_id === cost.key);
    if (!key || key.quantity < 1) return c.json({ error: 'key_missing', itemId: cost.key }, 400);
  }

  // 장착한 장비가 전투 스탯에 반영된다
  const stats = computeStats(equippedItems(await getInventory(c.env.DB, userId)));
  const { proficiency } = character;
  // 장착한 스킬(숙련도가 충분한 것)을 전투 상태에 담아 간다
  const skillDefs = await battleSkills(c.env.DB, userId, proficiency);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;

  // 보스는 패턴 스크립트(영혼함·충전기·하수인 소환 등)를 적용하고, 일반 몹은 기본 AI를 쓴다
  const raw = bossScriptFor(mob.id);
  const script = raw ? ({ ...raw, bossId: ENEMY_ID } as unknown as BossScript) : undefined;

  const state = createBattle(
    [
      {
        id: PLAYER_ID, name: '모험가', side: 'player', hp: stats.maxHp, guardedLastRound: false, stats,
        ap: START_AP, gauge: 0, cooldowns: {},
      },
      {
        id: ENEMY_ID, name: mob.name, side: 'enemy', hp: mob.hp, guardedLastRound: false,
        stats: { maxHp: mob.hp, atk: mob.atk, def: mob.def, spd: mob.spd },
      },
    ],
    seed,
    script,
    skillDefs,
  );

  // 입장 비용 차감과 전투 생성을 한 트랜잭션으로 묶는다 (위 사전 검사는 안내용, 실제 보장은 가드)
  const id = crypto.randomUUID();
  const db = c.env.DB;
  const stmts = [];
  if (cost.gold > 0) {
    stmts.push(
      db.prepare('UPDATE characters SET gold = gold - ? WHERE user_id = ? AND gold >= ?').bind(cost.gold, userId, cost.gold),
      guard(db),
    );
  }
  if (cost.key) {
    stmts.push(
      db.prepare('UPDATE inventory SET quantity = quantity - 1 WHERE user_id = ? AND item_id = ? AND quantity >= 1').bind(userId, cost.key),
      guard(db),
      db.prepare('DELETE FROM inventory WHERE user_id = ? AND quantity <= 0').bind(userId),
    );
  }
  stmts.push(
    db.prepare('INSERT INTO battles (id, user_id, mob_id, state, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, userId, mob.id, JSON.stringify(state), Date.now()),
  );
  try {
    await db.batch(stmts);
  } catch {
    return c.json({ error: 'entry_failed' }, 409);
  }
  return c.json({ id, state, paid: { gold: cost.gold, key: cost.key } });
});

battle.post('/battle/:id/round', async (c) => {
  const userId = c.get('user').id;
  const id = c.req.param('id');
  const body = await c.req.json<{ action?: 'attack' | 'guard' | 'item' | 'skill'; itemId?: string; skillId?: string; targetId?: string }>();

  const row = await c.env.DB
    .prepare('SELECT state, mob_id, rewarded FROM battles WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first<{ state: string; mob_id: string; rewarded: number }>();
  // 남의 전투는 존재 여부도 알려주지 않는다
  if (!row) return c.json({ error: 'battle not found' }, 404);
  const state = JSON.parse(row.state) as BattleState;
  if (state.status !== 'ongoing') return c.json({ state, log: [] });

  const player = state.combatants.find((x) => x.id === PLAYER_ID)!;
  const isLiveEnemy = (id: string) => state.combatants.some((x) => x.id === id && x.side === 'enemy' && x.hp > 0);

  let playerAction: Action;
  if (player.pending && player.pending.fireRound === state.round) {
    // 충전해 둔 스킬이 이번 라운드에 발동한다. 다른 선택은 무시된다.
    playerAction = { kind: 'guard' };
  } else if (body.action === 'skill') {
    const check = body.skillId ? canUseSkill(state, player, body.skillId) : ({ ok: false, reason: 'unknown' } as const);
    if (!check.ok) return c.json({ error: 'skill_unavailable', reason: check.reason }, 400);
    let targetId: string | undefined;
    if (check.skill.target === 'enemy') {
      targetId = body.targetId ?? ENEMY_ID;
      if (!isLiveEnemy(targetId)) return c.json({ error: 'invalid_target' }, 400);
    }
    playerAction = { kind: 'skill', skillId: check.skill.id, targetId };
  } else if (body.action === 'attack') {
    // 공격 대상: 지정하지 않으면 주 적. 살아 있는 적만 고를 수 있다 (영혼함·하수인 포함)
    const targetId = body.targetId ?? ENEMY_ID;
    if (!isLiveEnemy(targetId)) return c.json({ error: 'invalid_target' }, 400);
    playerAction = { kind: 'attack', targetId };
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

  // 보스전의 적 행동은 엔진이 예고(intent)대로 실행한다. 일반 전투만 기본 AI로 고른다.
  const actions: Record<string, Action> = { [PLAYER_ID]: playerAction };
  if (!state.boss) actions[ENEMY_ID] = chooseEnemyAction(state, state.combatants.find((x) => x.id === ENEMY_ID)!);
  const result = resolveRound(state, actions);
  await c.env.DB.prepare('UPDATE battles SET state = ? WHERE id = ?').bind(JSON.stringify(result.state), id).run();

  // 승패 보상(골드·아이템·숙련도)은 전투당 한 번만 (rewarded 플래그를 먼저 선점한 요청만 지급)
  let rewards: Rewards | undefined;
  const mob = mobById(row.mob_id);
  const outcome = result.state.status;
  if (outcome !== 'ongoing' && mob && row.rewarded === 0) {
    const claim = await c.env.DB.prepare('UPDATE battles SET rewarded = 1 WHERE id = ? AND rewarded = 0').bind(id).run();
    if (claim.meta.changes === 1) {
      const bonus = await activeBonus(c.env.DB);
      rewards = outcome === 'victory' ? rollRewards(mob, state.rngSeed, bonus) : defeatRewards(mob, bonus);
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
