import { Hono } from 'hono';
import { RAID_ROLES, RAID_ROLE_IDS, START_AP, computeStats, raidKit, raidSkillById, raidStats, type RaidRole } from '@rtgm/data';
import {
  canUseSkill, createBattle, resolveRound,
  type Action, type BattleState, type Combatant, type LogEntry, type SkillDef,
} from '@rtgm/engine';
import type { AppEnv } from './auth';
import { equippedItems, getInventory } from './character';
import { guard } from './guard';
import { K_FACTOR, PVP_CAP, clampStats } from './pvp';

/**
 * PvP 4v4 (역할 팀전): 팀마다 탱커·딜러·힐러·서포터 한 명씩, 레이드와 같은 역할 스킬로 싸운다.
 * - 랭크전: 역할별 대기열에서 레이팅이 비슷한 8명을 모아 두 팀으로 나눈다 (팀 레이팅 Elo).
 * - 친선 방: 코드로 모여 팀·역할을 정하고 시작한다 (레이팅 변동 없음, 1v1~4v4).
 * - 동시 선택 45초, 3회 연속 미제출이면 쓰러진 것으로 본다. 도발하면 상대는 도발한 사람만 노릴 수 있다.
 */
export const team = new Hono<AppEnv>();

export const TEAM_SIZE = 4;
export const TEAM_ROUND_MS = 45_000;
export const TEAM_MAX_ROUNDS = 40;
export const TEAM_MISS_LIMIT = 3;
export const TEAM_QUEUE_TTL_MS = 180_000;
export const TEAM_LOBBY_TTL_MS = 30 * 60_000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

type Side = 'A' | 'B';
interface MatchRow {
  id: string; code: string | null; ranked: number; leader_id: string | null; status: 'lobby' | 'active' | 'done'; state: string | null;
  round_no: number; deadline: number; last_log: string; winner: 'A' | 'B' | 'draw' | null; created_at: number; finished_at: number | null;
}
interface PlayerRow {
  match_id: string; user_id: string; team: Side | null; role: RaidRole | null; ready: number; slot: string | null; action: string | null;
  miss: number; delta: number; joined_at: number; nickname?: string | null;
}

/** 팀 Elo: 내 팀 평균 레이팅 대 상대 팀 평균 레이팅 (score 1=승, 0.5=무, 0=패) */
export function teamEloDelta(myAvg: number, foeAvg: number, score: number): number {
  const expected = 1 / (1 + 10 ** ((foeAvg - myAvg) / 400));
  return Math.round(K_FACTOR * (score - expected));
}

const defOf = (id: string): SkillDef => {
  const s = raidSkillById(id)!;
  return { id: s.id, name: s.name, ultimate: s.ultimate, apCost: s.apCost, cooldown: s.cooldown, priority: s.priority, target: s.target, effects: s.effects };
};

async function playersOf(db: D1Database, matchId: string): Promise<PlayerRow[]> {
  const { results } = await db
    .prepare('SELECT t.*, p.nickname FROM team_players t LEFT JOIN profiles p ON p.user_id = t.user_id WHERE t.match_id = ? ORDER BY t.team, t.joined_at, t.user_id')
    .bind(matchId)
    .all<PlayerRow>();
  return results ?? [];
}

const myMatch = (db: D1Database, userId: string) =>
  db.prepare('SELECT m.* FROM team_matches m JOIN team_players p ON p.match_id = m.id WHERE p.user_id = ? ORDER BY m.created_at DESC LIMIT 1').bind(userId).first<MatchRow>();

const leaveDone = (db: D1Database, userId: string) =>
  db.prepare("DELETE FROM team_players WHERE user_id = ? AND match_id IN (SELECT id FROM team_matches WHERE status = 'done')").bind(userId);

async function ensureRating(db: D1Database, userId: string) {
  await db.prepare('INSERT OR IGNORE INTO team_ratings (user_id) VALUES (?)').bind(userId).run();
  return (await db.prepare('SELECT rating, wins, losses, draws FROM team_ratings WHERE user_id = ?').bind(userId).first<{ rating: number; wins: number; losses: number; draws: number }>())!;
}

const needsAction = (state: BattleState, slot: string): boolean => {
  const c = state.combatants.find((x) => x.id === slot);
  return !!c && c.hp > 0 && !(c.pending && c.pending.fireRound === state.round);
};

/** 도발 중인 적 (상대는 단일 대상 공격을 이 사람에게만 할 수 있다) */
const taunterOf = (state: BattleState, foes: Combatant[]): Combatant | undefined =>
  foes.find((c) => c.hp > 0 && (c.statuses ?? []).some((s) => s.taunt && s.until >= state.round && (s.from ?? 0) <= state.round));

async function startState(db: D1Database, players: PlayerRow[]): Promise<{ state: BattleState; slots: Map<string, string> }> {
  const skills: Record<string, SkillDef> = {};
  const slots = new Map<string, string>();
  const count = { A: 0, B: 0 };
  const combatants: Combatant[] = [];
  for (const p of players) {
    const side = p.team!;
    count[side] += 1;
    const slot = `${side.toLowerCase()}${count[side]}`;
    slots.set(p.user_id, slot);
    const gear = clampStats(computeStats(equippedItems(await getInventory(db, p.user_id))));
    const stats = raidStats(p.role!, gear);
    for (const id of raidKit(p.role!)) skills[id] = defOf(id);
    combatants.push({ id: slot, name: p.nickname ?? '모험가', side: side === 'A' ? 'player' : 'enemy', hp: stats.maxHp, guardedLastRound: false, stats, ap: START_AP, gauge: 0, cooldowns: {} });
  }
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;
  return { state: createBattle(combatants, seed, undefined, skills), slots };
}

const sideOf = (slot: string): Side => (slot.startsWith('a') ? 'A' : 'B');
const hpRatio = (state: BattleState, side: Side) => {
  const cs = state.combatants.filter((c) => sideOf(c.id) === side);
  const max = cs.reduce((a, c) => a + c.stats.maxHp, 0);
  return max === 0 ? 0 : cs.reduce((a, c) => a + c.hp, 0) / max;
};

/**
 * 모두 냈거나 제한 시간이 지났으면 라운드를 처리한다 (round_no 로 한 요청만 선점).
 * 끝나면 같은 트랜잭션에서 레이팅을 반영한다.
 */
export async function advance(db: D1Database, m: MatchRow): Promise<MatchRow> {
  if (m.status !== 'active' || !m.state) return m;
  const state = JSON.parse(m.state) as BattleState;
  const players = await playersOf(db, m.id);
  const now = Date.now();
  const alive = players.filter((p) => needsAction(state, p.slot!));
  const missing = alive.filter((p) => p.action === null);
  if (missing.length > 0 && now < m.deadline) return m;

  const actions: Record<string, Action> = {};
  for (const p of players) if (p.action) actions[p.slot!] = JSON.parse(p.action) as Action;
  const missSet = new Set(missing.map((p) => p.user_id));
  const result = resolveRound(state, actions);
  const next = result.state;
  const log: LogEntry[] = [...result.log];

  const newMiss = new Map(players.map((p) => [p.user_id, missSet.has(p.user_id) ? p.miss + 1 : needsAction(state, p.slot!) ? 0 : p.miss]));
  for (const p of players) {
    const c = next.combatants.find((x) => x.id === p.slot);
    if (c && c.hp > 0 && (newMiss.get(p.user_id) ?? 0) >= TEAM_MISS_LIMIT) {
      c.hp = 0;
      log.push({ round: state.round, type: 'down', actorId: c.id, text: `${c.name}은(는) 오랫동안 움직이지 않아 쓰러진 것으로 처리됐다.` });
    }
  }
  const aAlive = next.combatants.some((c) => sideOf(c.id) === 'A' && c.hp > 0);
  const bAlive = next.combatants.some((c) => sideOf(c.id) === 'B' && c.hp > 0);
  let winner: 'A' | 'B' | 'draw' | null = null;
  if (!aAlive && !bAlive) winner = 'draw';
  else if (!bAlive) winner = 'A';
  else if (!aAlive) winner = 'B';
  else if (next.round > TEAM_MAX_ROUNDS) {
    const [x, y] = [hpRatio(next, 'A'), hpRatio(next, 'B')];
    winner = Math.abs(x - y) < 1e-9 ? 'draw' : x > y ? 'A' : 'B';
  }
  if (winner) next.status = winner === 'A' ? 'victory' : winner === 'B' ? 'defeat' : 'defeat';

  const logJson = JSON.stringify(log);
  const clear = (p: PlayerRow) => db.prepare('UPDATE team_players SET action = NULL, miss = ? WHERE match_id = ? AND user_id = ?').bind(newMiss.get(p.user_id) ?? 0, m.id, p.user_id);
  try {
    if (!winner) {
      await db.batch([
        db.prepare("UPDATE team_matches SET state = ?, round_no = round_no + 1, deadline = ?, last_log = ? WHERE id = ? AND round_no = ? AND status = 'active'")
          .bind(JSON.stringify(next), now + TEAM_ROUND_MS, logJson, m.id, m.round_no),
        guard(db),
        ...players.map(clear),
      ]);
    } else {
      const ratings = new Map<string, number>();
      for (const p of players) ratings.set(p.user_id, (await ensureRating(db, p.user_id)).rating);
      const avg = (side: Side) => { const ps = players.filter((p) => p.team === side); return ps.reduce((a, p) => a + ratings.get(p.user_id)!, 0) / Math.max(1, ps.length); };
      const [avgA, avgB] = [avg('A'), avg('B')];
      const stmts: D1PreparedStatement[] = [];
      for (const p of players) {
        const mine = p.team!;
        const score = winner === 'draw' ? 0.5 : winner === mine ? 1 : 0;
        const delta = m.ranked ? teamEloDelta(mine === 'A' ? avgA : avgB, mine === 'A' ? avgB : avgA, score) : 0;
        const col = score === 1 ? 'wins' : score === 0 ? 'losses' : 'draws';
        stmts.push(db.prepare('UPDATE team_players SET action = NULL, miss = ?, delta = ? WHERE match_id = ? AND user_id = ?').bind(newMiss.get(p.user_id) ?? 0, delta, m.id, p.user_id));
        if (m.ranked) stmts.push(db.prepare(`UPDATE team_ratings SET rating = MAX(0, rating + ?), ${col} = ${col} + 1 WHERE user_id = ?`).bind(delta, p.user_id));
      }
      await db.batch([
        db.prepare("UPDATE team_matches SET state = ?, status = 'done', winner = ?, last_log = ?, finished_at = ? WHERE id = ? AND round_no = ? AND status = 'active'")
          .bind(JSON.stringify(next), winner, logJson, now, m.id, m.round_no),
        guard(db),
        ...stmts,
      ]);
    }
  } catch {
    /* 다른 요청이 먼저 처리했다 */
  }
  return (await db.prepare('SELECT * FROM team_matches WHERE id = ?').bind(m.id).first<MatchRow>())!;
}

async function matchView(db: D1Database, m: MatchRow, me: string) {
  const players = await playersOf(db, m.id);
  const mine = players.find((p) => p.user_id === me);
  const state = m.state ? (JSON.parse(m.state) as BattleState) : null;
  let publicState: Omit<BattleState, 'rngSeed'> | null = null;
  if (state) { const { rngSeed: _s, ...rest } = state; void _s; publicState = rest; }
  const kit = mine?.role ? raidKit(mine.role) : [];
  const myTeam = mine?.team ?? null;
  return {
    id: m.id, code: m.code, ranked: !!m.ranked, status: m.status, leaderId: m.leader_id, teamSize: TEAM_SIZE, roundSeconds: TEAM_ROUND_MS / 1000,
    players: players.map((p) => ({ userId: p.user_id, nickname: p.nickname ?? '알 수 없음', team: p.team, role: p.role, ready: !!p.ready, slot: p.slot, submitted: p.action !== null, miss: p.miss, delta: p.delta })),
    mySlot: mine?.slot ?? null, myTeam, myRole: mine?.role ?? null,
    round: state?.round ?? 0, deadline: m.deadline, serverNow: Date.now(),
    needsAction: !!(state && mine?.slot && m.status === 'active' && needsAction(state, mine.slot)),
    state: publicState,
    skills: Object.fromEntries(kit.map((id) => [id, state?.skills?.[id] ?? defOf(id)])),
    log: JSON.parse(m.last_log) as LogEntry[],
    result: m.winner ? (m.winner === 'draw' ? 'draw' : m.winner === myTeam ? 'win' : 'loss') : undefined,
  };
}

const makeCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');

async function sweep(db: D1Database) {
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM team_players WHERE match_id IN (SELECT id FROM team_matches WHERE status = 'lobby' AND created_at < ?)").bind(now - TEAM_LOBBY_TTL_MS),
    db.prepare("DELETE FROM team_matches WHERE status = 'lobby' AND created_at < ?").bind(now - TEAM_LOBBY_TTL_MS),
    db.prepare('DELETE FROM team_queue WHERE queued_at < ?').bind(now - TEAM_QUEUE_TTL_MS),
  ]);
}

/** 대기열에서 레이팅이 비슷한 역할별 2명씩 8명을 모아 랭크전을 만든다 */
export async function tryFormRanked(db: D1Database): Promise<string | null> {
  const now = Date.now();
  const { results } = await db.prepare('SELECT user_id, role, rating, queued_at FROM team_queue ORDER BY queued_at').all<{ user_id: string; role: RaidRole; rating: number; queued_at: number }>();
  const queue = results ?? [];
  if (queue.length < TEAM_SIZE * 2) return null;
  const anchor = queue[0]!;
  const window = 100 + (now - anchor.queued_at) / 200;
  const near = queue.filter((q) => Math.abs(q.rating - anchor.rating) <= window);
  const picks: typeof queue = [];
  for (const role of RAID_ROLE_IDS) {
    const ofRole = near.filter((q) => q.role === role);
    if (role === anchor.role) ofRole.sort((a, b) => (a.user_id === anchor.user_id ? -1 : b.user_id === anchor.user_id ? 1 : 0));
    if (ofRole.length < 2) return null;
    picks.push(ofRole[0]!, ofRole[1]!);
  }
  // 역할마다 두 명을 나눈다: 레이팅이 높은 쪽을 지금까지 합이 낮은 팀에 (균형)
  const sum = { A: 0, B: 0 };
  const assign = new Map<string, Side>();
  for (const role of RAID_ROLE_IDS) {
    const [hi, lo] = picks.filter((p) => p.role === role).sort((a, b) => b.rating - a.rating) as [typeof queue[number], typeof queue[number]];
    const hiTeam: Side = sum.A <= sum.B ? 'A' : 'B';
    assign.set(hi.user_id, hiTeam); assign.set(lo.user_id, hiTeam === 'A' ? 'B' : 'A');
    sum[hiTeam] += hi.rating; sum[hiTeam === 'A' ? 'B' : 'A'] += lo.rating;
  }
  const id = crypto.randomUUID();
  const players: PlayerRow[] = picks.map((p, i) => ({ match_id: id, user_id: p.user_id, team: assign.get(p.user_id)!, role: p.role, ready: 1, slot: null, action: null, miss: 0, delta: 0, joined_at: now + i }));
  const names = new Map<string, string>();
  for (const p of picks) names.set(p.user_id, (await db.prepare('SELECT nickname FROM profiles WHERE user_id = ?').bind(p.user_id).first<{ nickname: string }>())?.nickname ?? '모험가');
  for (const p of players) p.nickname = names.get(p.user_id);
  const ordered = [...players].sort((a, b) => (a.team! < b.team! ? -1 : a.team! > b.team! ? 1 : 0) || RAID_ROLE_IDS.indexOf(a.role!) - RAID_ROLE_IDS.indexOf(b.role!));
  const { state, slots } = await startState(db, ordered);
  try {
    await db.batch([
      ...picks.flatMap((p) => [db.prepare('DELETE FROM team_queue WHERE user_id = ?').bind(p.user_id), guard(db), leaveDone(db, p.user_id)]),
      db.prepare("INSERT INTO team_matches (id, ranked, status, state, round_no, deadline, created_at) VALUES (?, 1, 'active', ?, 1, ?, ?)").bind(id, JSON.stringify(state), now + TEAM_ROUND_MS, now),
      ...ordered.map((p) => db.prepare('INSERT INTO team_players (match_id, user_id, team, role, ready, slot, joined_at) VALUES (?, ?, ?, ?, 1, ?, ?)').bind(id, p.user_id, p.team!, p.role!, slots.get(p.user_id)!, p.joined_at)),
    ]);
  } catch {
    return null; // 그 사이 누군가 대기열을 떠났다
  }
  return id;
}

team.get('/team/status', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  await sweep(db);
  const rating = await ensureRating(db, me);
  const queued = await db.prepare('SELECT role, queued_at FROM team_queue WHERE user_id = ?').bind(me).first<{ role: string; queued_at: number }>();
  if (queued) await tryFormRanked(db);
  let m = await myMatch(db, me);
  if (m?.status === 'active') m = await advance(db, m);
  const stillQueued = queued ? await db.prepare('SELECT role, queued_at FROM team_queue WHERE user_id = ?').bind(me).first<{ role: string; queued_at: number }>() : null;
  const { results: top } = await db
    .prepare('SELECT r.user_id, r.rating, r.wins, r.losses, r.draws, p.nickname FROM team_ratings r LEFT JOIN profiles p ON p.user_id = r.user_id WHERE r.wins + r.losses + r.draws > 0 ORDER BY r.rating DESC, r.wins DESC LIMIT 20')
    .all<{ user_id: string; rating: number; wins: number; losses: number; draws: number; nickname: string | null }>();
  return c.json({
    rating: rating.rating, wins: rating.wins, losses: rating.losses, draws: rating.draws,
    queued: stillQueued ? { role: stillQueued.role, since: stillQueued.queued_at } : null,
    roles: RAID_ROLE_IDS.map((r) => ({ id: r, label: RAID_ROLES[r].label, desc: RAID_ROLES[r].desc, skills: raidKit(r).map((id) => raidSkillById(id)) })),
    cap: PVP_CAP,
    ranking: (top ?? []).map((r, i) => ({ rank: i + 1, id: r.user_id, nickname: r.nickname ?? '알 수 없음', rating: r.rating, wins: r.wins, losses: r.losses, me: r.user_id === me })),
    match: m ? await matchView(db, m, me) : null,
  });
});

team.post('/team/queue', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const { role } = await c.req.json<{ role?: string }>();
  if (!role || !RAID_ROLE_IDS.includes(role as RaidRole)) return c.json({ error: 'invalid_request' }, 400);
  const cur = await myMatch(db, me);
  if (cur && cur.status !== 'done') return c.json({ error: 'already_in_match' }, 409);
  await sweep(db);
  const { rating } = await ensureRating(db, me);
  await db.prepare('INSERT OR REPLACE INTO team_queue (user_id, role, rating, queued_at) VALUES (?, ?, ?, ?)').bind(me, role, rating, Date.now()).run();
  const id = await tryFormRanked(db);
  const mine = await myMatch(db, me);
  return c.json({ queued: !mine || mine.status === 'done' ? true : false, matchId: id && mine?.id === id ? id : undefined });
});

team.post('/team/queue/leave', async (c) => {
  await c.env.DB.prepare('DELETE FROM team_queue WHERE user_id = ?').bind(c.get('user').id).run();
  return c.json({ ok: true });
});

// ─── 친선 방 ─────────────────────────────────────────────────────────────────

async function lobbyOf(db: D1Database, me: string): Promise<{ m: MatchRow; players: PlayerRow[] } | null> {
  const m = await myMatch(db, me);
  if (!m || m.status !== 'lobby') return null;
  return { m, players: await playersOf(db, m.id) };
}

team.post('/team/room/create', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const cur = await myMatch(db, me);
  if (cur && cur.status !== 'done') return c.json({ error: 'already_in_match' }, 409);
  await db.prepare('DELETE FROM team_queue WHERE user_id = ?').bind(me).run();
  const id = crypto.randomUUID();
  for (let i = 0; i < 5; i++) {
    try {
      await db.batch([
        leaveDone(db, me),
        db.prepare("INSERT INTO team_matches (id, code, ranked, leader_id, status, created_at) VALUES (?, ?, 0, ?, 'lobby', ?)").bind(id, makeCode(), me, Date.now()),
        db.prepare("INSERT INTO team_players (match_id, user_id, team, joined_at) VALUES (?, ?, 'A', ?)").bind(id, me, Date.now()),
      ]);
      return c.json({ ok: true, id });
    } catch { /* 코드 충돌 */ }
  }
  return c.json({ error: 'try_again' }, 500);
});

team.post('/team/room/join', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const { code } = await c.req.json<{ code?: string }>();
  await sweep(db);
  const m = typeof code === 'string' ? await db.prepare("SELECT * FROM team_matches WHERE code = ? AND status = 'lobby'").bind(code.trim().toUpperCase()).first<MatchRow>() : null;
  if (!m) return c.json({ error: 'room_not_found' }, 404);
  const cur = await myMatch(db, me);
  if (cur && cur.status !== 'done') return c.json({ error: 'already_in_match' }, 409);
  await db.prepare('DELETE FROM team_queue WHERE user_id = ?').bind(me).run();
  const players = await playersOf(db, m.id);
  const countA = players.filter((p) => p.team === 'A').length, countB = players.filter((p) => p.team === 'B').length;
  const side: Side | null = countA <= countB && countA < TEAM_SIZE ? 'A' : countB < TEAM_SIZE ? 'B' : null;
  if (!side) return c.json({ error: 'room_full' }, 400);
  try {
    const res = await db.batch([
      leaveDone(db, me),
      db.prepare("INSERT INTO team_players (match_id, user_id, team, joined_at) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM team_players WHERE match_id = ? AND team = ?) < ? AND EXISTS (SELECT 1 FROM team_matches WHERE id = ? AND status = 'lobby')")
        .bind(m.id, me, side, Date.now(), m.id, side, TEAM_SIZE, m.id),
    ]);
    if (res[1]?.meta.changes === 0) return c.json({ error: 'room_full' }, 400);
  } catch {
    return c.json({ error: 'already_in_match' }, 409);
  }
  return c.json({ ok: true });
});

team.post('/team/room/team', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const { team: side } = await c.req.json<{ team?: string }>();
  if (side !== 'A' && side !== 'B') return c.json({ error: 'invalid_request' }, 400);
  const lobby = await lobbyOf(db, me);
  if (!lobby) return c.json({ error: 'not_in_lobby' }, 400);
  // 정원이 남은 팀으로만 옮길 수 있고, 옮기면 역할과 준비가 풀린다
  const res = await db
    .prepare('UPDATE team_players SET team = ?, role = NULL, ready = 0 WHERE match_id = ? AND user_id = ? AND (SELECT COUNT(*) FROM team_players WHERE match_id = ? AND team = ? AND user_id != ?) < ?')
    .bind(side, lobby.m.id, me, lobby.m.id, side, me, TEAM_SIZE)
    .run();
  if (res.meta.changes === 0) return c.json({ error: 'room_full' }, 400);
  return c.json({ ok: true });
});

team.post('/team/room/role', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const { role } = await c.req.json<{ role?: string }>();
  if (!role || !RAID_ROLE_IDS.includes(role as RaidRole)) return c.json({ error: 'invalid_request' }, 400);
  const lobby = await lobbyOf(db, me);
  if (!lobby) return c.json({ error: 'not_in_lobby' }, 400);
  const mine = lobby.players.find((p) => p.user_id === me)!;
  const res = await db
    .prepare('UPDATE team_players SET role = ?, ready = 0 WHERE match_id = ? AND user_id = ? AND NOT EXISTS (SELECT 1 FROM team_players WHERE match_id = ? AND team = ? AND role = ? AND user_id != ?)')
    .bind(role, lobby.m.id, me, lobby.m.id, mine.team, role, me)
    .run();
  if (res.meta.changes === 0) return c.json({ error: 'role_taken' }, 409);
  return c.json({ ok: true });
});

team.post('/team/room/ready', async (c) => {
  const me = c.get('user').id;
  const { ready } = await c.req.json<{ ready?: boolean }>();
  const lobby = await lobbyOf(c.env.DB, me);
  if (!lobby) return c.json({ error: 'not_in_lobby' }, 400);
  if (!lobby.players.find((p) => p.user_id === me)?.role) return c.json({ error: 'role_required' }, 400);
  await c.env.DB.prepare('UPDATE team_players SET ready = ? WHERE match_id = ? AND user_id = ?').bind(ready ? 1 : 0, lobby.m.id, me).run();
  return c.json({ ok: true });
});

team.post('/team/room/leave', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const m = await myMatch(db, me);
  if (!m) return c.json({ ok: true });
  if (m.status === 'active') return c.json({ error: 'match_active' }, 409);
  const rest = (await playersOf(db, m.id)).filter((p) => p.user_id !== me);
  await db.batch([
    db.prepare('DELETE FROM team_players WHERE match_id = ? AND user_id = ?').bind(m.id, me),
    ...(m.status === 'lobby' && rest.length === 0 ? [db.prepare('DELETE FROM team_matches WHERE id = ?').bind(m.id)] : []),
    ...(m.status === 'done' && rest.length === 0 ? [db.prepare('DELETE FROM team_matches WHERE id = ?').bind(m.id)] : []),
    ...(m.status === 'lobby' && m.leader_id === me && rest.length > 0 ? [db.prepare('UPDATE team_matches SET leader_id = ? WHERE id = ?').bind(rest[0]!.user_id, m.id)] : []),
  ]);
  return c.json({ ok: true });
});

team.post('/team/room/start', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const lobby = await lobbyOf(db, me);
  if (!lobby) return c.json({ error: 'not_in_lobby' }, 400);
  if (lobby.m.leader_id !== me) return c.json({ error: 'not_allowed' }, 403);
  const { m, players } = lobby;
  if (!players.some((p) => p.team === 'A') || !players.some((p) => p.team === 'B')) return c.json({ error: 'need_both_teams' }, 400);
  if (players.some((p) => !p.role || (!p.ready && p.user_id !== me))) return c.json({ error: 'not_ready' }, 400);
  const ordered = [...players].sort((a, b) => (a.team! < b.team! ? -1 : a.team! > b.team! ? 1 : 0) || a.joined_at - b.joined_at);
  const { state, slots } = await startState(db, ordered);
  try {
    await db.batch([
      db.prepare("UPDATE team_matches SET status = 'active', state = ?, round_no = 1, deadline = ? WHERE id = ? AND status = 'lobby'").bind(JSON.stringify(state), Date.now() + TEAM_ROUND_MS, m.id),
      guard(db),
      ...ordered.map((p) => db.prepare('UPDATE team_players SET slot = ?, ready = 1 WHERE match_id = ? AND user_id = ?').bind(slots.get(p.user_id)!, m.id, p.user_id)),
    ]);
  } catch {
    return c.json({ error: 'not_in_lobby' }, 409);
  }
  return c.json({ ok: true });
});

// ─── 진행 ────────────────────────────────────────────────────────────────────

team.post('/team/action', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  let m = await myMatch(db, me);
  if (!m || m.status === 'lobby') return c.json({ error: 'not_in_match' }, 400);
  m = await advance(db, m);
  if (m.status !== 'active') return c.json(await matchView(db, m, me));

  const players = await playersOf(db, m.id);
  const mine = players.find((p) => p.user_id === me)!;
  const state = JSON.parse(m.state!) as BattleState;
  if (!needsAction(state, mine.slot!)) return c.json(await matchView(db, m, me));
  const self = state.combatants.find((x) => x.id === mine.slot)!;
  const body = await c.req.json<{ action?: string; skillId?: string; targetId?: string }>();

  const foes = state.combatants.filter((x) => x.side !== self.side && x.hp > 0);
  const allies = state.combatants.filter((x) => x.side === self.side && x.hp > 0);
  const taunter = taunterOf(state, foes);
  /** 적 단일 대상: 도발한 사람이 있으면 그 사람만 고를 수 있다 */
  const pickFoe = (id: string | undefined): { id: string } | { error: string; taunter?: string } => {
    const t = id ?? taunter?.id ?? foes[0]?.id;
    if (!t || !foes.some((x) => x.id === t)) return { error: 'invalid_target' };
    if (taunter && t !== taunter.id) return { error: 'taunted', taunter: taunter.id };
    return { id: t };
  };

  let action: Action;
  if (body.action === 'attack') {
    const t = pickFoe(body.targetId);
    if ('error' in t) return c.json(t, 400);
    action = { kind: 'attack', targetId: t.id };
  } else if (body.action === 'guard') action = { kind: 'guard' };
  else if (body.action === 'skill' && body.skillId) {
    if (!raidKit(mine.role!).includes(body.skillId)) return c.json({ error: 'unknown_skill' }, 400);
    const check = canUseSkill(state, self, body.skillId);
    if (!check.ok) return c.json({ error: 'skill_unavailable', reason: check.reason }, 400);
    let targetId: string | undefined;
    if (check.skill.target === 'enemy') {
      const t = pickFoe(body.targetId);
      if ('error' in t) return c.json(t, 400);
      targetId = t.id;
    } else if (check.skill.target === 'ally') {
      targetId = body.targetId ?? self.id;
      if (!allies.some((x) => x.id === targetId)) return c.json({ error: 'invalid_target' }, 400);
    }
    action = { kind: 'skill', skillId: check.skill.id, targetId };
  } else return c.json({ error: 'invalid_action' }, 400);

  const res = await db
    .prepare("UPDATE team_players SET action = ? WHERE match_id = ? AND user_id = ? AND action IS NULL AND EXISTS (SELECT 1 FROM team_matches WHERE id = ? AND status = 'active' AND round_no = ?)")
    .bind(JSON.stringify(action), m.id, me, m.id, m.round_no)
    .run();
  if (res.meta.changes === 0) return c.json({ error: 'already_submitted' }, 409);
  m = await advance(db, (await db.prepare('SELECT * FROM team_matches WHERE id = ?').bind(m.id).first<MatchRow>())!);
  return c.json(await matchView(db, m, me));
});
