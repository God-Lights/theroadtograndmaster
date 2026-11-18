import { Hono } from 'hono';
import {
  RAID_BOSSES, RAID_MIN_PARTY, RAID_MISS_LIMIT, RAID_ROLES, RAID_ROLE_IDS, START_AP, computeStats, itemById,
  raidBossHp, raidKit, raidRoleCap, raidSkillById, raidStats, type RaidBossData, type RaidRole,
} from '@rtgm/data';
import {
  canUseSkill, createBattle, mulberry32, resolveRound,
  type Action, type BattleState, type BossScript, type Combatant, type LogEntry, type SkillDef,
} from '@rtgm/engine';
import type { AppEnv } from './auth';
import { equippedItems, getCharacter, getInventory } from './character';
import { announceStmts } from './announce';
import { activeBonus, type BonusConfig } from './events';
import { guard } from './guard';

/**
 * 레이드(별 1~5개): 2명 이상, 최대 4명(8인 레이드는 8명). 역할(탱커·딜러·힐러·서포터)은 4인 레이드는 하나씩, 8인 레이드는 둘까지.
 * PvP와 같은 동시 선택 방식 — 모두 행동을 숨겨서 내면 서버가 한꺼번에 처리한다. 60초 제한, 3회 연속 미제출이면 쓰러진 것으로 본다.
 */
export const raid = new Hono<AppEnv>();

export const RAID_ROUND_MS = 60_000;
export const RAID_MAX_ROUNDS = 60;
/** 대기실은 만든 지 30분이 지나면 사라진다 */
export const LOBBY_TTL_MS = 30 * 60_000;
/** 패배하면 대기시간이 절반 */
export const DEFEAT_COOLDOWN_FACTOR = 0.5;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BOSS = 'enemy';

interface RoomRow {
  id: string; code: string; boss_id: string; leader_id: string; status: 'lobby' | 'active' | 'done'; state: string | null; round_no: number;
  deadline: number; last_log: string; result: 'victory' | 'defeat' | null; created_at: number; finished_at: number | null;
}
interface MemberRow {
  room_id: string; user_id: string; role: RaidRole | null; ready: number; slot: string | null; action: string | null; miss: number; rewards: string | null; joined_at: number;
  nickname?: string | null;
}

export interface RaidRewards { gold: number; proficiency: number; items: { itemId: string; name: string; quantity: number }[] }

/** 시드로 재현되는 레이드 보상 굴림 (이벤트 보너스 배율 반영) */
export function rollRaidRewards(boss: RaidBossData, seed: number, victory: boolean, bonus?: Partial<Record<keyof BonusConfig, number>>): RaidRewards {
  const b = { gold: bonus?.gold ?? 1, proficiency: bonus?.proficiency ?? 1, drop: bonus?.drop ?? 1 };
  if (!victory) return { gold: 0, proficiency: Math.round(boss.profLose * b.proficiency), items: [] };
  const rng = mulberry32((seed ^ 0x2545f491) >>> 0);
  const [min, max] = boss.gold;
  return {
    gold: Math.round((min + Math.floor(rng() * (max - min + 1))) * b.gold),
    proficiency: Math.round(boss.profWin * b.proficiency),
    items: boss.drops.filter((d) => rng() < Math.min(1, d.chance * b.drop)).map((d) => ({ itemId: d.itemId, name: itemById(d.itemId)?.name ?? d.itemId, quantity: 1 })),
  };
}

async function membersOf(db: D1Database, roomId: string): Promise<MemberRow[]> {
  const { results } = await db
    .prepare('SELECT m.*, p.nickname FROM raid_members m LEFT JOIN profiles p ON p.user_id = m.user_id WHERE m.room_id = ? ORDER BY m.joined_at, m.user_id')
    .bind(roomId)
    .all<MemberRow>();
  return results ?? [];
}

/** 내가 속한 방 (끝난 방은 결과를 한 번 볼 수 있게 남겨 두되, 새 방을 만들거나 들어가면 벗어난다) */
const myRoom = (db: D1Database, userId: string) =>
  db.prepare('SELECT r.* FROM raid_rooms r JOIN raid_members m ON m.room_id = r.id WHERE m.user_id = ? ORDER BY r.created_at DESC LIMIT 1').bind(userId).first<RoomRow>();

const leaveDone = (db: D1Database, userId: string) =>
  db.prepare("DELETE FROM raid_members WHERE user_id = ? AND room_id IN (SELECT id FROM raid_rooms WHERE status = 'done')").bind(userId);

const needsAction = (state: BattleState, id: string): boolean => {
  const c = state.combatants.find((x) => x.id === id);
  return !!c && c.hp > 0 && !(c.pending && c.pending.fireRound === state.round);
};

const defOf = (id: string): SkillDef => {
  const s = raidSkillById(id)!;
  return { id: s.id, name: s.name, ultimate: s.ultimate, apCost: s.apCost, cooldown: s.cooldown, priority: s.priority, target: s.target, effects: s.effects };
};

async function startState(db: D1Database, room: RoomRow, members: MemberRow[]): Promise<{ state: BattleState; slots: Map<string, string> }> {
  const boss = RAID_BOSSES[room.boss_id]!;
  const skills: Record<string, SkillDef> = {};
  const slots = new Map<string, string>();
  const players: Combatant[] = [];
  for (const [i, m] of members.entries()) {
    const role = m.role!;
    const stats = raidStats(role, computeStats(equippedItems(await getInventory(db, m.user_id))));
    for (const id of raidKit(role)) skills[id] = defOf(id);
    const slot = `p${i + 1}`;
    slots.set(m.user_id, slot);
    players.push({ id: slot, name: m.nickname ?? '모험가', side: 'player', hp: stats.maxHp, guardedLastRound: false, stats, ap: START_AP, gauge: 0, cooldowns: {} });
  }
  const hp = raidBossHp(boss.id, members.length);
  const bossC: Combatant = { id: BOSS, name: boss.name, side: 'enemy', hp, guardedLastRound: false, stats: { maxHp: hp, atk: boss.atk, def: boss.def, spd: boss.spd } };
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;
  return { state: createBattle([...players, bossC], seed, { ...boss.script, bossId: BOSS } as unknown as BossScript, skills), slots };
}

/**
 * 모두 냈거나 제한 시간이 지났으면 라운드를 처리한다. round_no 로 한 요청만 처리를 선점한다.
 * 끝나면 같은 트랜잭션에서 보상을 지급한다.
 */
export async function advance(db: D1Database, room: RoomRow): Promise<RoomRow> {
  if (room.status !== 'active' || !room.state) return room;
  const state = JSON.parse(room.state) as BattleState;
  const members = await membersOf(db, room.id);
  const now = Date.now();
  const alive = members.filter((m) => needsAction(state, m.slot!));
  const missing = alive.filter((m) => m.action === null);
  if (missing.length > 0 && now < room.deadline) return room;

  const actions: Record<string, Action> = {};
  for (const m of members) if (m.action) actions[m.slot!] = JSON.parse(m.action) as Action;
  const missSet = new Set(missing.map((m) => m.user_id));
  const result = resolveRound(state, actions);
  const next = result.state;
  const log: LogEntry[] = [...result.log];

  // 연속 미제출이 한도에 닿으면 쓰러진 것으로 본다
  const newMiss = new Map(members.map((m) => [m.user_id, missSet.has(m.user_id) ? m.miss + 1 : needsAction(state, m.slot!) ? 0 : m.miss]));
  for (const m of members) {
    const c = next.combatants.find((x) => x.id === m.slot);
    if (c && c.hp > 0 && (newMiss.get(m.user_id) ?? 0) >= RAID_MISS_LIMIT) {
      c.hp = 0;
      log.push({ round: state.round, type: 'down', actorId: c.id, text: `${c.name}은(는) 오랫동안 움직이지 않아 쓰러진 것으로 처리됐다.` });
    }
  }
  const playersAlive = next.combatants.some((c) => c.side === 'player' && c.hp > 0);
  if (!playersAlive && next.status === 'ongoing') next.status = 'defeat';
  if (next.status === 'ongoing' && next.round > RAID_MAX_ROUNDS) next.status = 'defeat';

  const logJson = JSON.stringify(log);
  const clear = (m: MemberRow) => db.prepare('UPDATE raid_members SET action = NULL, miss = ? WHERE room_id = ? AND user_id = ?').bind(newMiss.get(m.user_id) ?? 0, room.id, m.user_id);

  try {
    if (next.status === 'ongoing') {
      await db.batch([
        db.prepare("UPDATE raid_rooms SET state = ?, round_no = round_no + 1, deadline = ?, last_log = ? WHERE id = ? AND round_no = ? AND status = 'active'")
          .bind(JSON.stringify(next), now + RAID_ROUND_MS, logJson, room.id, room.round_no),
        guard(db),
        ...members.map(clear),
      ]);
    } else {
      const victory = next.status === 'victory';
      const boss = RAID_BOSSES[room.boss_id]!;
      const bonus = await activeBonus(db, now);
      const stmts: D1PreparedStatement[] = [];
      const rewardMap = new Map<string, RaidRewards>();
      for (const m of members) {
        const afk = (newMiss.get(m.user_id) ?? 0) >= RAID_MISS_LIMIT;
        const r = afk ? { gold: 0, proficiency: 0, items: [] } : rollRaidRewards(boss, state.rngSeed ^ (m.joined_at & 0xffff) ^ m.user_id.charCodeAt(0) * 131, victory, bonus);
        rewardMap.set(m.user_id, r);
        stmts.push(
          db.prepare('UPDATE raid_members SET action = NULL, miss = ?, rewards = ? WHERE room_id = ? AND user_id = ?').bind(newMiss.get(m.user_id) ?? 0, JSON.stringify(r), room.id, m.user_id),
          db.prepare('UPDATE characters SET gold = gold + ?, proficiency = proficiency + ? WHERE user_id = ?').bind(r.gold, r.proficiency, m.user_id),
          ...r.items.map((it) =>
            db.prepare('INSERT INTO inventory (user_id, item_id, quantity, equipped) VALUES (?, ?, ?, 0) ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity').bind(m.user_id, it.itemId, it.quantity),
          ),
          db.prepare('INSERT INTO raid_cooldowns (user_id, boss_id, until) VALUES (?, ?, ?) ON CONFLICT (user_id, boss_id) DO UPDATE SET until = excluded.until')
            .bind(m.user_id, boss.id, now + boss.cooldownMinutes * 60_000 * (victory ? 1 : DEFEAT_COOLDOWN_FACTOR)),
        );
      }
      await db.batch([
        db.prepare("UPDATE raid_rooms SET state = ?, status = 'done', result = ?, last_log = ?, finished_at = ? WHERE id = ? AND round_no = ? AND status = 'active'")
          .bind(JSON.stringify(next), victory ? 'victory' : 'defeat', logJson, now, room.id, room.round_no),
        guard(db),
        ...stmts,
        ...(victory ? announceStmts(db, 'raid', `🛡️ ${members.map((m) => m.nickname ?? '모험가').join(', ')} 파티가 ${'★'.repeat(boss.star)} ${boss.name} 레이드를 클리어했다!`) : []),
      ]);
    }
  } catch {
    /* 다른 요청이 먼저 처리했다 */
  }
  return (await db.prepare('SELECT * FROM raid_rooms WHERE id = ?').bind(room.id).first<RoomRow>())!;
}

async function roomView(db: D1Database, room: RoomRow, me: string) {
  const members = await membersOf(db, room.id);
  const mine = members.find((m) => m.user_id === me);
  const boss = RAID_BOSSES[room.boss_id]!;
  const state = room.state ? (JSON.parse(room.state) as BattleState) : null;
  let publicState: Omit<BattleState, 'rngSeed'> | null = null;
  if (state) { const { rngSeed: _s, ...rest } = state; void _s; publicState = rest; }
  const kit = mine?.role ? raidKit(mine.role) : [];
  return {
    id: room.id, code: room.code, status: room.status, bossId: boss.id, bossName: boss.name, leaderId: room.leader_id,
    maxParty: boss.maxParty, recParty: boss.recParty, star: boss.star, roleCap: raidRoleCap(boss.id), minParty: RAID_MIN_PARTY, roundSeconds: RAID_ROUND_MS / 1000,
    members: members.map((m) => ({
      userId: m.user_id, nickname: m.nickname ?? '알 수 없음', role: m.role, ready: !!m.ready, slot: m.slot, submitted: m.action !== null, miss: m.miss,
      rewards: m.rewards ? (JSON.parse(m.rewards) as RaidRewards) : undefined,
    })),
    mySlot: mine?.slot ?? null, myRole: mine?.role ?? null,
    round: state?.round ?? 0, deadline: room.deadline, serverNow: Date.now(),
    needsAction: !!(state && mine?.slot && room.status === 'active' && needsAction(state, mine.slot)),
    state: publicState,
    skills: Object.fromEntries(kit.map((id) => [id, state?.skills?.[id] ?? defOf(id)])),
    log: JSON.parse(room.last_log) as LogEntry[],
    result: room.result ?? undefined,
  };
}

/** 이 사람의 보스별 재입장 가능 시각 (지난 것은 제외) */
async function cooldownsOf(db: D1Database, userId: string): Promise<Record<string, number>> {
  const { results } = await db.prepare('SELECT boss_id, until FROM raid_cooldowns WHERE user_id = ? AND until > ?').bind(userId, Date.now()).all<{ boss_id: string; until: number }>();
  return Object.fromEntries((results ?? []).map((r) => [r.boss_id, r.until]));
}

/** 오래된 대기실을 정리한다 (요청이 올 때 한 번씩) */
async function sweepLobbies(db: D1Database): Promise<void> {
  const cutoff = Date.now() - LOBBY_TTL_MS;
  await db.batch([
    db.prepare("DELETE FROM raid_members WHERE room_id IN (SELECT id FROM raid_rooms WHERE status = 'lobby' AND created_at < ?)").bind(cutoff),
    db.prepare("DELETE FROM raid_rooms WHERE status = 'lobby' AND created_at < ?").bind(cutoff),
  ]);
}

const makeCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');

raid.get('/raid', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  await sweepLobbies(db);
  let room = await myRoom(db, me);
  if (room?.status === 'active') room = await advance(db, room);
  const { proficiency } = await getCharacter(db, me);
  const { results: open } = await db
    .prepare(
      `SELECT r.code, r.boss_id, p.nickname, (SELECT COUNT(*) FROM raid_members x WHERE x.room_id = r.id) AS n FROM raid_rooms r
       JOIN profiles p ON p.user_id = r.leader_id
       JOIN friendships f ON f.status = 'accepted' AND ((f.requester = ? AND f.addressee = r.leader_id) OR (f.addressee = ? AND f.requester = r.leader_id))
       WHERE r.status = 'lobby' ORDER BY r.created_at DESC LIMIT 10`,
    )
    .bind(me, me)
    .all<{ code: string; boss_id: string; nickname: string; n: number }>();
  return c.json({
    proficiency,
    bosses: Object.values(RAID_BOSSES).sort((a, b) => a.star - b.star).map((b) => ({ id: b.id, name: b.name, star: b.star, maxParty: b.maxParty, recParty: b.recParty, minProficiency: b.minProficiency, note: b.note, cooldownMinutes: b.cooldownMinutes, hp: b.hp, gold: b.gold, drops: b.drops })),
    roles: Object.fromEntries(RAID_ROLE_IDS.map((r) => [r, { label: RAID_ROLES[r].label, desc: RAID_ROLES[r].desc, skills: raidKit(r).map((id) => raidSkillById(id)) }])),
    friendRooms: (open ?? []).map((o) => ({ code: o.code, leader: o.nickname, members: o.n, max: RAID_BOSSES[o.boss_id]?.maxParty ?? 4, bossName: RAID_BOSSES[o.boss_id]?.name ?? o.boss_id })),
    cooldowns: await cooldownsOf(db, me),
    lobbyMinutes: LOBBY_TTL_MS / 60_000,
    room: room ? await roomView(db, room, me) : null,
  });
});

raid.post('/raid/create', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const { bossId } = await c.req.json<{ bossId?: string }>();
  const boss = bossId ? RAID_BOSSES[bossId] : undefined;
  if (!boss) return c.json({ error: 'unknown_boss' }, 404);
  if ((await getCharacter(db, me)).proficiency < boss.minProficiency) return c.json({ error: 'proficiency_too_low', required: boss.minProficiency }, 403);
  const cur = await myRoom(db, me);
  if (cur && cur.status !== 'done') return c.json({ error: 'already_in_raid' }, 409);
  const wait = (await cooldownsOf(db, me))[boss.id];
  if (wait) return c.json({ error: 'raid_cooldown', until: wait }, 429);

  const id = crypto.randomUUID();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await db.batch([
        leaveDone(db, me),
        db.prepare('INSERT INTO raid_rooms (id, code, boss_id, leader_id, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, makeCode(), boss.id, me, Date.now()),
        db.prepare('INSERT INTO raid_members (room_id, user_id, joined_at) VALUES (?, ?, ?)').bind(id, me, Date.now()),
      ]);
      return c.json({ ok: true, id });
    } catch { /* 코드 충돌: 다시 */ }
  }
  return c.json({ error: 'try_again' }, 500);
});

raid.post('/raid/join', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const { code } = await c.req.json<{ code?: string }>();
  await sweepLobbies(db);
  const room = typeof code === 'string' ? await db.prepare("SELECT * FROM raid_rooms WHERE code = ? AND status = 'lobby'").bind(code.trim().toUpperCase()).first<RoomRow>() : null;
  if (!room) return c.json({ error: 'room_not_found' }, 404);
  const boss = RAID_BOSSES[room.boss_id]!;
  if ((await getCharacter(db, me)).proficiency < boss.minProficiency) return c.json({ error: 'proficiency_too_low', required: boss.minProficiency }, 403);
  const cur = await myRoom(db, me);
  if (cur && cur.status !== 'done') return c.json({ error: 'already_in_raid' }, 409);
  const wait = (await cooldownsOf(db, me))[boss.id];
  if (wait) return c.json({ error: 'raid_cooldown', until: wait }, 429);
  try {
    const res = await db.batch([
      leaveDone(db, me),
      db.prepare("INSERT INTO raid_members (room_id, user_id, joined_at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM raid_members WHERE room_id = ?) < ? AND EXISTS (SELECT 1 FROM raid_rooms WHERE id = ? AND status = 'lobby')")
        .bind(room.id, me, Date.now(), room.id, boss.maxParty, room.id),
    ]);
    if (res[1]?.meta.changes === 0) return c.json({ error: 'room_full' }, 400);
  } catch {
    return c.json({ error: 'already_in_raid' }, 409);
  }
  return c.json({ ok: true });
});

/** 로비에서만: 역할 선택(겹치지 않게)·준비·떠나기·시작 */
async function lobbyOf(db: D1Database, me: string): Promise<{ room: RoomRow; members: MemberRow[] } | null> {
  const room = await myRoom(db, me);
  if (!room || room.status !== 'lobby') return null;
  return { room, members: await membersOf(db, room.id) };
}

raid.post('/raid/role', async (c) => {
  const me = c.get('user').id;
  const { role } = await c.req.json<{ role?: string }>();
  if (!role || !RAID_ROLE_IDS.includes(role as RaidRole)) return c.json({ error: 'invalid_request' }, 400);
  const lobby = await lobbyOf(c.env.DB, me);
  if (!lobby) return c.json({ error: 'not_in_lobby' }, 400);
  // 그 역할의 정원(4인 레이드 1명, 8인 레이드 2명)이 찼으면 변경되지 않는다 (changes() = 0)
  const res = await c.env.DB
    .prepare('UPDATE raid_members SET role = ?, ready = 0 WHERE room_id = ? AND user_id = ? AND (SELECT COUNT(*) FROM raid_members WHERE room_id = ? AND role = ? AND user_id != ?) < ?')
    .bind(role, lobby.room.id, me, lobby.room.id, role, me, raidRoleCap(lobby.room.boss_id))
    .run();
  if (res.meta.changes === 0) return c.json({ error: 'role_taken' }, 409);
  return c.json({ ok: true });
});

raid.post('/raid/ready', async (c) => {
  const me = c.get('user').id;
  const { ready } = await c.req.json<{ ready?: boolean }>();
  const lobby = await lobbyOf(c.env.DB, me);
  if (!lobby) return c.json({ error: 'not_in_lobby' }, 400);
  const mine = lobby.members.find((m) => m.user_id === me)!;
  if (!mine.role) return c.json({ error: 'role_required' }, 400);
  await c.env.DB.prepare('UPDATE raid_members SET ready = ? WHERE room_id = ? AND user_id = ?').bind(ready ? 1 : 0, lobby.room.id, me).run();
  return c.json({ ok: true });
});

raid.post('/raid/leave', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const room = await myRoom(db, me);
  if (!room) return c.json({ ok: true });
  if (room.status === 'active') return c.json({ error: 'raid_active' }, 409);
  const members = await membersOf(db, room.id);
  const rest = members.filter((m) => m.user_id !== me);
  if (room.status === 'done' || rest.length === 0) {
    await db.batch([
      db.prepare('DELETE FROM raid_members WHERE room_id = ? AND user_id = ?').bind(room.id, me),
      ...(rest.length === 0 ? [db.prepare('DELETE FROM raid_rooms WHERE id = ?').bind(room.id)] : []),
    ]);
  } else {
    await db.batch([
      db.prepare('DELETE FROM raid_members WHERE room_id = ? AND user_id = ?').bind(room.id, me),
      ...(room.leader_id === me ? [db.prepare('UPDATE raid_rooms SET leader_id = ? WHERE id = ?').bind(rest[0]!.user_id, room.id)] : []),
    ]);
  }
  return c.json({ ok: true });
});

raid.post('/raid/start', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const lobby = await lobbyOf(db, me);
  if (!lobby) return c.json({ error: 'not_in_lobby' }, 400);
  if (lobby.room.leader_id !== me) return c.json({ error: 'not_allowed' }, 403);
  const { room, members } = lobby;
  if (members.length < RAID_MIN_PARTY) return c.json({ error: 'party_too_small', min: RAID_MIN_PARTY }, 400);
  if (members.some((m) => !m.role || (!m.ready && m.user_id !== me))) return c.json({ error: 'not_ready' }, 400);

  const { state, slots } = await startState(db, room, members);
  try {
    await db.batch([
      db.prepare("UPDATE raid_rooms SET status = 'active', state = ?, round_no = 1, deadline = ? WHERE id = ? AND status = 'lobby'").bind(JSON.stringify(state), Date.now() + RAID_ROUND_MS, room.id),
      guard(db),
      ...members.map((m) => db.prepare('UPDATE raid_members SET slot = ?, ready = 1 WHERE room_id = ? AND user_id = ?').bind(slots.get(m.user_id)!, room.id, m.user_id)),
    ]);
  } catch {
    return c.json({ error: 'not_in_lobby' }, 409);
  }
  return c.json({ ok: true });
});

raid.post('/raid/action', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  let room = await myRoom(db, me);
  if (!room || room.status === 'lobby') return c.json({ error: 'not_in_raid' }, 400);
  room = await advance(db, room);
  if (room.status !== 'active') return c.json(await roomView(db, room, me));

  const members = await membersOf(db, room.id);
  const mine = members.find((m) => m.user_id === me)!;
  const state = JSON.parse(room.state!) as BattleState;
  if (!needsAction(state, mine.slot!)) return c.json(await roomView(db, room, me));
  const self = state.combatants.find((x) => x.id === mine.slot)!;
  const body = await c.req.json<{ action?: string; skillId?: string; targetId?: string }>();

  const livingEnemies = state.combatants.filter((x) => x.side === 'enemy' && x.hp > 0);
  const livingAllies = state.combatants.filter((x) => x.side === 'player' && x.hp > 0);
  let action: Action;
  if (body.action === 'attack') {
    const t = body.targetId ?? BOSS;
    if (!livingEnemies.some((x) => x.id === t)) return c.json({ error: 'invalid_target' }, 400);
    action = { kind: 'attack', targetId: t };
  } else if (body.action === 'guard') action = { kind: 'guard' };
  else if (body.action === 'skill' && body.skillId) {
    if (!raidKit(mine.role!).includes(body.skillId)) return c.json({ error: 'unknown_skill' }, 400);
    const check = canUseSkill(state, self, body.skillId);
    if (!check.ok) return c.json({ error: 'skill_unavailable', reason: check.reason }, 400);
    let targetId: string | undefined;
    if (check.skill.target === 'enemy') {
      targetId = body.targetId ?? BOSS;
      if (!livingEnemies.some((x) => x.id === targetId)) return c.json({ error: 'invalid_target' }, 400);
    } else if (check.skill.target === 'ally') {
      targetId = body.targetId ?? self.id;
      if (!livingAllies.some((x) => x.id === targetId)) return c.json({ error: 'invalid_target' }, 400);
    }
    action = { kind: 'skill', skillId: check.skill.id, targetId };
  } else return c.json({ error: 'invalid_action' }, 400);

  const res = await db
    .prepare("UPDATE raid_members SET action = ? WHERE room_id = ? AND user_id = ? AND action IS NULL AND EXISTS (SELECT 1 FROM raid_rooms WHERE id = ? AND status = 'active' AND round_no = ?)")
    .bind(JSON.stringify(action), room.id, me, room.id, room.round_no)
    .run();
  if (res.meta.changes === 0) return c.json({ error: 'already_submitted' }, 409);
  room = await advance(db, (await db.prepare('SELECT * FROM raid_rooms WHERE id = ?').bind(room.id).first<RoomRow>())!);
  return c.json(await roomView(db, room, me));
});

