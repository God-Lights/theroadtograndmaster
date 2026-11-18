import { Hono } from 'hono';
import {
  ROGUE_ABORT_COOLDOWN_FACTOR, ROGUE_DUNGEONS, computeStats, itemById, mobById, rogueById, rogueRoom, type RogueDungeon, type RogueEvent,
} from '@rtgm/data';
import { mulberry32, type BattleState } from '@rtgm/engine';
import type { AppEnv } from './auth';
import { announceStmts } from './announce';
import { equippedItems, getCharacter, getInventory } from './character';
import { createBattleState } from './combat';
import { activeCooldowns, cooldownUntil, setCooldownStmt } from './cooldowns';
import { guard } from './guard';

/**
 * 로그라이크 던전: 층마다 방이 하나씩 나온다 — 몬스터 / 보물 / 함정 / 빈 방. 마지막 층은 보스.
 * - HP는 층을 내려가도 이어진다 (전투 중 아이템으로만 회복).
 * - 얻은 것은 '전리품'으로 쌓이고, 완주하거나 후퇴해야 받는다. 쓰러지면 전리품을 잃는다 (숙련도만 조금).
 * - 끝나면 던전마다 대기시간이 걸린다 (완주 전체, 후퇴·사망 절반).
 */
export const runs = new Hono<AppEnv>();

export interface Loot { gold: number; proficiency: number; items: { itemId: string; quantity: number }[] }
interface RunRow {
  id: string; user_id: string; dungeon_id: string; floor: number; floors: number; hp: number; max_hp: number;
  status: 'idle' | 'battle' | 'done'; loot: string; events: string; battle_id: string | null; result: 'clear' | 'retreat' | 'dead' | null;
  created_at: number; finished_at: number | null;
}
export interface RoomLog { floor: number; kind: RogueEvent | 'clear'; text: string }

const parse = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };
const rand = () => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 1) / 4294967296;
const between = (rng: () => number, [a, b]: [number, number]) => a + Math.floor(rng() * (b - a + 1));
const runKey = (id: string) => `run:${id}`;

export function addLoot(loot: Loot, add: Partial<Loot>): Loot {
  const items = new Map(loot.items.map((i) => [i.itemId, i.quantity]));
  for (const it of add.items ?? []) items.set(it.itemId, (items.get(it.itemId) ?? 0) + it.quantity);
  return { gold: loot.gold + (add.gold ?? 0), proficiency: loot.proficiency + (add.proficiency ?? 0), items: [...items].map(([itemId, quantity]) => ({ itemId, quantity })) };
}

const activeRun = (db: D1Database, userId: string) =>
  db.prepare("SELECT * FROM dungeon_runs WHERE user_id = ? AND status != 'done' ORDER BY created_at DESC LIMIT 1").bind(userId).first<RunRow>();

async function view(db: D1Database, r: RunRow) {
  const d = rogueById(r.dungeon_id)!;
  const battle = r.status === 'battle' && r.battle_id
    ? await db.prepare('SELECT state, mob_id FROM battles WHERE id = ?').bind(r.battle_id).first<{ state: string; mob_id: string }>()
    : null;
  return {
    id: r.id, dungeonId: d.id, name: d.name, floor: r.floor, floors: r.floors, hp: r.hp, maxHp: r.max_hp, status: r.status, result: r.result,
    loot: parse<Loot>(r.loot, { gold: 0, proficiency: 0, items: [] }), events: parse<RoomLog[]>(r.events, []),
    battle: battle ? { id: r.battle_id!, mobId: battle.mob_id, state: JSON.parse(battle.state) as BattleState } : null,
  };
}

/** 끝난 런: 전리품 지급(완주 보너스 포함)과 대기시간을 한 트랜잭션으로. 이미 끝난 런이면 아무것도 하지 않는다. */
async function finish(
  db: D1Database, r: RunRow, result: 'clear' | 'retreat' | 'dead', loot: Loot, hp: number, events: RoomLog[], announceText?: string,
): Promise<boolean> {
  const d = rogueById(r.dungeon_id)!;
  const keep = result !== 'dead';
  const pay = keep ? loot : { gold: 0, proficiency: loot.proficiency > 0 ? Math.min(loot.proficiency, 5) : 0, items: [] }; // 사망: 전리품 소실, 숙련도만 소량
  const cooldown = d.cooldownMinutes * 60_000 * (result === 'clear' ? 1 : ROGUE_ABORT_COOLDOWN_FACTOR);
  const now = Date.now();
  try {
    await db.batch([
      db.prepare("UPDATE dungeon_runs SET status = 'done', result = ?, hp = ?, loot = ?, events = ?, battle_id = NULL, finished_at = ? WHERE id = ? AND status != 'done'")
        .bind(result, hp, JSON.stringify(pay), JSON.stringify(events), now, r.id),
      guard(db),
      db.prepare('UPDATE characters SET gold = gold + ?, proficiency = proficiency + ? WHERE user_id = ?').bind(pay.gold, pay.proficiency, r.user_id),
      ...pay.items.map((it) =>
        db.prepare('INSERT INTO inventory (user_id, item_id, quantity, equipped) VALUES (?, ?, ?, 0) ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity').bind(r.user_id, it.itemId, it.quantity),
      ),
      setCooldownStmt(db, r.user_id, runKey(d.id), now + cooldown),
      ...(announceText ? announceStmts(db, 'dungeon', announceText) : []),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** 전투가 끝났을 때 battle.ts 가 부른다. 이긴 전투의 보상은 전리품으로 쌓고, 졌으면 런이 끝난다. */
export async function onRunBattleEnd(
  db: D1Database, runId: string, battleId: string, outcome: 'victory' | 'defeat', state: BattleState,
  rewards: { gold: number; proficiency: number; items: { itemId: string; quantity: number }[] }, nickname: string,
): Promise<void> {
  const r = await db.prepare("SELECT * FROM dungeon_runs WHERE id = ? AND status = 'battle' AND battle_id = ?").bind(runId, battleId).first<RunRow>();
  if (!r) return;
  const d = rogueById(r.dungeon_id)!;
  const hp = Math.max(1, state.combatants.find((c) => c.id === 'player')?.hp ?? 1);
  const events = parse<RoomLog[]>(r.events, []);
  const loot = addLoot(parse<Loot>(r.loot, { gold: 0, proficiency: 0, items: [] }), rewards);
  if (outcome === 'defeat') {
    events.push({ floor: r.floor, kind: 'monster', text: '쓰러졌다… 전리품을 모두 잃었다.' });
    await finish(db, r, 'dead', { ...loot, proficiency: rewards.proficiency }, 1, events);
    return;
  }
  if (r.floor >= r.floors) {
    // 마지막 보스를 쓰러뜨려 완주: 완주 보너스를 더해 지급
    const rng = mulberry32((Date.now() ^ r.floor) >>> 0);
    const bonus: Partial<Loot> = {
      gold: between(rng, d.clearBonus.gold), proficiency: d.clearBonus.proficiency,
      items: d.clearBonus.items.filter((i) => rng() < i.chance).map((i) => ({ itemId: i.itemId, quantity: 1 })),
    };
    const total = addLoot(loot, bonus);
    const boss = mobById(d.finalBoss.mobId)!;
    events.push({ floor: r.floor, kind: 'clear', text: `${d.finalBoss.title} ${boss.name}을(를) 쓰러뜨리고 ${d.name}을(를) 완주했다!` });
    await finish(db, r, 'clear', total, hp, events, `🗝️ ${nickname}님이 ${d.name}을(를) 완주했다! (${d.finalBoss.title} ${boss.name} 격파)`);
    return;
  }
  events.push({ floor: r.floor, kind: 'monster', text: `전투에서 승리했다. (HP ${hp})` });
  await db.prepare("UPDATE dungeon_runs SET status = 'idle', hp = ?, loot = ?, events = ?, battle_id = NULL WHERE id = ? AND status = 'battle'").bind(hp, JSON.stringify(loot), JSON.stringify(events), r.id).run();
}

// ─── API ─────────────────────────────────────────────────────────────────────

runs.get('/run', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const { proficiency, gold } = await getCharacter(db, me);
  const cd = await activeCooldowns(db, me);
  const r = await activeRun(db, me);
  return c.json({
    proficiency, gold,
    dungeons: ROGUE_DUNGEONS.map((d) => ({ id: d.id, name: d.name, description: d.description, minProficiency: d.minProficiency, recommendedProficiency: d.recommendedProficiency, entryGold: d.entryGold, floors: d.floors, cooldownMinutes: d.cooldownMinutes, monsters: d.monsters, finalBoss: d.finalBoss, clearBonus: d.clearBonus, until: cd[runKey(d.id)] ?? 0 })),
    run: r ? await view(db, r) : null,
  });
});

runs.post('/run/start', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const { dungeonId } = await c.req.json<{ dungeonId?: string }>();
  const d = dungeonId ? rogueById(dungeonId) : undefined;
  if (!d) return c.json({ error: 'unknown_dungeon' }, 404);
  if (await activeRun(db, me)) return c.json({ error: 'already_in_run' }, 409);
  const ch = await getCharacter(db, me);
  if (ch.proficiency < d.minProficiency) return c.json({ error: 'dungeon_locked', required: d.minProficiency }, 403);
  const wait = await cooldownUntil(db, me, runKey(d.id));
  if (wait) return c.json({ error: 'run_cooldown', until: wait }, 429);
  if (ch.gold < d.entryGold) return c.json({ error: 'not_enough_gold', required: d.entryGold }, 400);

  const maxHp = computeStats(equippedItems(await getInventory(db, me))).maxHp;
  const id = crypto.randomUUID();
  try {
    await db.batch([
      ...(d.entryGold > 0 ? [db.prepare('UPDATE characters SET gold = gold - ? WHERE user_id = ? AND gold >= ?').bind(d.entryGold, me, d.entryGold), guard(db)] : []),
      db.prepare('INSERT INTO dungeon_runs (id, user_id, dungeon_id, floors, hp, max_hp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, me, d.id, d.floors, maxHp, maxHp, Date.now()),
    ]);
  } catch {
    return c.json({ error: 'entry_failed' }, 409);
  }
  return c.json(await view(db, (await activeRun(db, me))!));
});

/** 다음 방으로: 층이 하나 내려가고 그 층의 방이 열린다 */
runs.post('/run/advance', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const r = await activeRun(db, me);
  if (!r) return c.json({ error: 'no_run' }, 404);
  if (r.status !== 'idle') return c.json({ error: 'run_busy' }, 409);
  const d = rogueById(r.dungeon_id)!;
  const floor = r.floor + 1;
  const rng = mulberry32(crypto.getRandomValues(new Uint32Array(1))[0] ?? 1);
  const kind = rogueRoom(d, floor, rng());
  const events = parse<RoomLog[]>(r.events, []);
  let loot = parse<Loot>(r.loot, { gold: 0, proficiency: 0, items: [] });
  let hp = r.hp;
  let text = '';

  if (kind === 'monster') {
    const finalRoom = floor >= d.floors;
    const mob = mobById(finalRoom ? d.finalBoss.mobId : d.monsters[Math.floor(rng() * d.monsters.length)]!)!;
    const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;
    const state = await createBattleState(db, me, mob, { seed, hp: r.hp, mult: finalRoom ? d.finalBoss.mult : 1 });
    const battleId = crypto.randomUUID();
    text = finalRoom ? `최종 보스 — ${d.finalBoss.title} ${mob.name}이(가) 앞을 가로막는다!` : `${mob.name}이(가) 나타났다!`;
    events.push({ floor, kind, text });
    try {
      await db.batch([
        db.prepare("UPDATE dungeon_runs SET floor = ?, status = 'battle', battle_id = ?, events = ? WHERE id = ? AND status = 'idle' AND floor = ?").bind(floor, battleId, JSON.stringify(events), r.id, r.floor),
        guard(db),
        db.prepare('INSERT INTO battles (id, user_id, mob_id, state, created_at, run_id) VALUES (?, ?, ?, ?, ?, ?)').bind(battleId, me, mob.id, JSON.stringify(state), Date.now(), r.id),
      ]);
    } catch {
      return c.json({ error: 'run_busy' }, 409);
    }
  } else {
    if (kind === 'treasure') {
      const gold = Math.round(between(rng, d.treasure.gold) * (1 + 0.15 * (floor - 1)));
      const total = d.treasure.items.reduce((a, b) => a + b.weight, 0);
      let pick = rng() * total;
      const entry = d.treasure.items.find((i) => (pick -= i.weight) < 0) ?? d.treasure.items[0]!;
      const qty = between(rng, entry.qty);
      loot = addLoot(loot, { gold, items: [{ itemId: entry.itemId, quantity: qty }] });
      text = `보물 상자를 발견했다! ${gold.toLocaleString()}D와 ${itemById(entry.itemId)?.name ?? entry.itemId} ×${qty}을(를) 전리품에 담았다.`;
    } else if (kind === 'trap') {
      const pct = d.trapDamagePct[0] + rng() * (d.trapDamagePct[1] - d.trapDamagePct[0]);
      const dmg = Math.max(1, Math.round((r.max_hp * pct) / 100));
      hp = Math.max(1, r.hp - dmg); // 함정은 치명적이지 않다: 최소 HP 1
      text = `함정이다! ${dmg}의 피해를 입었다. (HP ${hp}/${r.max_hp})`;
    } else {
      text = ['아무것도 없는 빈 방이다.', '먼지만 쌓인 조용한 방이다.', '으스스한 바람만 불어온다.'][Math.floor(rng() * 3)]!;
    }
    events.push({ floor, kind, text });
    const res = await db
      .prepare("UPDATE dungeon_runs SET floor = ?, hp = ?, loot = ?, events = ? WHERE id = ? AND status = 'idle' AND floor = ?")
      .bind(floor, hp, JSON.stringify(loot), JSON.stringify(events), r.id, r.floor)
      .run();
    if (res.meta.changes === 0) return c.json({ error: 'run_busy' }, 409);
  }
  return c.json({ ...(await view(db, (await activeRun(db, me))!)), room: { kind, text } });
});

/** 후퇴: 지금까지의 전리품을 들고 나간다 (대기시간은 절반). 전투 중에는 할 수 없다. */
runs.post('/run/retreat', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const r = await activeRun(db, me);
  if (!r) return c.json({ error: 'no_run' }, 404);
  if (r.status !== 'idle') return c.json({ error: 'run_busy' }, 409);
  const events = parse<RoomLog[]>(r.events, []);
  const loot = parse<Loot>(r.loot, { gold: 0, proficiency: 0, items: [] });
  events.push({ floor: r.floor, kind: 'nothing', text: '전리품을 챙겨 던전을 빠져나왔다.' });
  if (!(await finish(db, r, 'retreat', loot, r.hp, events))) return c.json({ error: 'run_busy' }, 409);
  const done = await db.prepare('SELECT * FROM dungeon_runs WHERE id = ?').bind(r.id).first<RunRow>();
  return c.json(await view(db, done!));
});

/** 끝난 런의 결과 확인 후 닫기 (결과 화면을 한 번 보여 주기 위해 done 런을 돌려준다) */
runs.get('/run/last', async (c) => {
  const r = await c.env.DB.prepare("SELECT * FROM dungeon_runs WHERE user_id = ? AND status = 'done' ORDER BY finished_at DESC LIMIT 1").bind(c.get('user').id).first<RunRow>();
  return c.json({ run: r ? await view(c.env.DB, r) : null });
});

