import { Hono } from 'hono';
import { PVP_RULES, START_AP, computeStats, type CombatStats } from '@rtgm/data';
import {
  canUseSkill, createBattle, resolveRound,
  type Action, type BattleState, type Combatant, type LogEntry, type SkillDef,
} from '@rtgm/engine';
import type { AppEnv } from './auth';
import { equippedItems, getCharacter, getInventory } from './character';
import { guard } from './guard';
import { battleSkills } from './skills';
import { relationOf, UUID } from './social';

/**
 * PvP 1v1 (동시 선택 턴제). 두 사람이 매 라운드 행동을 숨겨서 제출하고, 둘 다 내면 서버가 한꺼번에 처리한다.
 * - 아이템 사용 금지 (돈으로 이기지 않게), 스탯은 PvP 상한으로 보정한다.
 * - 45초 안에 안 내면 방어로 처리, 3회 연속이면 기권패. 40라운드가 넘으면 남은 HP 비율로 판정.
 * - 랭크전은 레이팅(Elo)이 오르내리고, 친구 도전전은 레이팅이 바뀌지 않는다.
 */
export const pvp = new Hono<AppEnv>();

export const P1 = 'p1';
export const P2 = 'p2';
export const ROUND_MS = PVP_RULES.roundSeconds * 1000;
export const MAX_MISSES = PVP_RULES.missLimit;
export const MAX_ROUNDS = PVP_RULES.maxRounds;
export const QUEUE_TTL_MS = 120_000;
export const K_FACTOR = PVP_RULES.kFactor;
/** PvP 스탯 상한: 좋은 장비는 유리하지만 한 방에 끝나지 않게 한다 */
export const PVP_CAP = PVP_RULES.cap;

export const clampStats = (s: CombatStats): CombatStats => ({
  ...s, maxHp: Math.min(s.maxHp, PVP_CAP.maxHp), atk: Math.min(s.atk, PVP_CAP.atk), def: Math.min(s.def, PVP_CAP.def),
});

/** Elo: 기대 승률과 변동량 (score 1=승, 0.5=무, 0=패) */
export function eloDelta(mine: number, theirs: number, score: number): number {
  const expected = 1 / (1 + 10 ** ((theirs - mine) / 400));
  return Math.round(K_FACTOR * (score - expected));
}

interface MatchRow {
  id: string; p1: string; p2: string; ranked: number; state: string; skills1: string; skills2: string; round_no: number;
  a1: string | null; a2: string | null; miss1: number; miss2: number; deadline: number; last_log: string;
  status: 'active' | 'done'; winner: string | null; delta1: number; delta2: number; created_at: number; finished_at: number | null;
}

const nameOf = async (db: D1Database, id: string) =>
  (await db.prepare('SELECT nickname FROM profiles WHERE user_id = ?').bind(id).first<{ nickname: string }>())?.nickname ?? '알 수 없음';

const activeMatchOf = (db: D1Database, userId: string) =>
  db.prepare("SELECT * FROM pvp_matches WHERE status = 'active' AND (p1 = ? OR p2 = ?) LIMIT 1").bind(userId, userId).first<MatchRow>();

async function ensureRating(db: D1Database, userId: string) {
  await db.prepare('INSERT OR IGNORE INTO pvp_ratings (user_id) VALUES (?)').bind(userId).run();
  return (await db.prepare('SELECT rating, wins, losses, draws FROM pvp_ratings WHERE user_id = ?').bind(userId).first<{ rating: number; wins: number; losses: number; draws: number }>())!;
}

async function buildFighter(db: D1Database, userId: string, id: string, side: 'player' | 'enemy'): Promise<{ c: Combatant; skills: Record<string, SkillDef> }> {
  const [inv, ch] = await Promise.all([getInventory(db, userId), getCharacter(db, userId)]);
  const stats = clampStats(computeStats(equippedItems(inv)));
  const skills = await battleSkills(db, userId, ch.proficiency);
  return {
    skills,
    c: { id, name: await nameOf(db, userId), side, hp: stats.maxHp, guardedLastRound: false, stats, ap: START_AP, gauge: 0, cooldowns: {} },
  };
}

/** 두 사람의 대전을 만든다 (INSERT 문만 돌려주므로 호출하는 쪽에서 batch 에 넣는다) */
async function matchStatement(db: D1Database, p1: string, p2: string, ranked: boolean) {
  const [a, b] = await Promise.all([buildFighter(db, p1, P1, 'player'), buildFighter(db, p2, P2, 'enemy')]);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;
  const state = createBattle([a.c, b.c], seed, undefined, { ...a.skills, ...b.skills });
  const id = crypto.randomUUID();
  const now = Date.now();
  return {
    id,
    stmt: db
      .prepare('INSERT INTO pvp_matches (id, p1, p2, ranked, state, skills1, skills2, deadline, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, p1, p2, ranked ? 1 : 0, JSON.stringify(state), JSON.stringify(Object.keys(a.skills)), JSON.stringify(Object.keys(b.skills)), now + ROUND_MS, now),
  };
}

const needsAction = (state: BattleState, id: string): boolean => {
  const c = state.combatants.find((x) => x.id === id)!;
  return !(c.pending && c.pending.fireRound === state.round);
};

/** 남은 HP 비율로 승부를 가린다 (시간 초과 판정) */
function byHealth(state: BattleState): 'p1' | 'p2' | 'draw' {
  const r = (id: string) => { const c = state.combatants.find((x) => x.id === id)!; return c.hp / c.stats.maxHp; };
  const [x, y] = [r(P1), r(P2)];
  return Math.abs(x - y) < 1e-9 ? 'draw' : x > y ? 'p1' : 'p2';
}

/**
 * 둘 다 제출했거나 제한 시간이 지났으면 라운드를 처리한다. 동시에 여러 요청이 와도
 * round_no 로 한 요청만 처리를 선점한다. 처리 후의 최신 대전을 돌려준다.
 */
export async function advance(db: D1Database, m: MatchRow): Promise<MatchRow> {
  if (m.status !== 'active') return m;
  const state = JSON.parse(m.state) as BattleState;
  const a1 = m.a1 ? (JSON.parse(m.a1) as Action) : null;
  const a2 = m.a2 ? (JSON.parse(m.a2) as Action) : null;
  const n1 = needsAction(state, P1), n2 = needsAction(state, P2);
  const ready = (a: Action | null, n: boolean) => a !== null || !n;
  const now = Date.now();
  if (!(ready(a1, n1) && ready(a2, n2)) && now < m.deadline) return m;

  const miss1 = n1 && a1 === null ? m.miss1 + 1 : 0;
  const miss2 = n2 && a2 === null ? m.miss2 + 1 : 0;
  const result = resolveRound(state, { [P1]: a1 ?? { kind: 'guard' }, [P2]: a2 ?? { kind: 'guard' } });
  const next = result.state;

  // 결과 판정: 정상 종료 / 기권 / 시간 초과
  let winner: string | null = null; // user_id | 'draw'
  const asUser = (side: 'p1' | 'p2' | 'draw') => (side === 'draw' ? 'draw' : side === 'p1' ? m.p1 : m.p2);
  if (miss1 >= MAX_MISSES && miss2 >= MAX_MISSES) winner = 'draw';
  else if (miss1 >= MAX_MISSES) winner = m.p2;
  else if (miss2 >= MAX_MISSES) winner = m.p1;
  else if (next.status === 'victory') winner = m.p1;
  else if (next.status === 'defeat') winner = m.p2;
  else if (next.round > MAX_ROUNDS) winner = asUser(byHealth(next));

  const log = JSON.stringify(result.log);
  if (winner === null) {
    await db
      .prepare("UPDATE pvp_matches SET state = ?, round_no = round_no + 1, a1 = NULL, a2 = NULL, miss1 = ?, miss2 = ?, deadline = ?, last_log = ? WHERE id = ? AND round_no = ? AND status = 'active'")
      .bind(JSON.stringify(next), miss1, miss2, now + ROUND_MS, log, m.id, m.round_no)
      .run();
  } else {
    const r1 = await ensureRating(db, m.p1), r2 = await ensureRating(db, m.p2);
    const score1 = winner === 'draw' ? 0.5 : winner === m.p1 ? 1 : 0;
    const d1 = m.ranked ? eloDelta(r1.rating, r2.rating, score1) : 0;
    const d2 = m.ranked ? eloDelta(r2.rating, r1.rating, 1 - score1) : 0;
    const col = (won: boolean, lost: boolean) => (won ? 'wins' : lost ? 'losses' : 'draws');
    try {
      await db.batch([
        db
          .prepare("UPDATE pvp_matches SET state = ?, status = 'done', winner = ?, delta1 = ?, delta2 = ?, miss1 = ?, miss2 = ?, last_log = ?, a1 = NULL, a2 = NULL, finished_at = ? WHERE id = ? AND round_no = ? AND status = 'active'")
          .bind(JSON.stringify(next), winner, d1, d2, miss1, miss2, log, now, m.id, m.round_no),
        guard(db),
        ...(m.ranked
          ? [
              db.prepare(`UPDATE pvp_ratings SET rating = MAX(0, rating + ?), ${col(winner === m.p1, winner === m.p2)} = ${col(winner === m.p1, winner === m.p2)} + 1 WHERE user_id = ?`).bind(d1, m.p1),
              db.prepare(`UPDATE pvp_ratings SET rating = MAX(0, rating + ?), ${col(winner === m.p2, winner === m.p1)} = ${col(winner === m.p2, winner === m.p1)} + 1 WHERE user_id = ?`).bind(d2, m.p2),
            ]
          : []),
      ]);
    } catch {
      /* 다른 요청이 먼저 처리했다 */
    }
  }
  return (await db.prepare('SELECT * FROM pvp_matches WHERE id = ?').bind(m.id).first<MatchRow>())!;
}

/** 클라이언트에 보여 줄 대전 상태 (시드·상대의 제출 내용은 숨긴다) */
async function matchView(db: D1Database, m: MatchRow, me: string) {
  const mine = m.p1 === me ? P1 : P2;
  const state = JSON.parse(m.state) as BattleState;
  const { rngSeed: _seed, ...publicState } = state;
  void _seed;
  const oppId = m.p1 === me ? m.p2 : m.p1;
  const mySkillIds = JSON.parse(m.p1 === me ? m.skills1 : m.skills2) as string[];
  const myAction = m.p1 === me ? m.a1 : m.a2;
  const oppAction = m.p1 === me ? m.a2 : m.a1;
  return {
    id: m.id, mine, opponent: { id: oppId, nickname: await nameOf(db, oppId) }, ranked: !!m.ranked,
    status: m.status, round: state.round, deadline: m.deadline, serverNow: Date.now(),
    needsAction: m.status === 'active' && needsAction(state, mine),
    submitted: myAction !== null, opponentSubmitted: oppAction !== null,
    state: publicState, skills: Object.fromEntries(mySkillIds.map((id) => [id, state.skills?.[id]]).filter(([, v]) => v)),
    log: JSON.parse(m.last_log) as LogEntry[],
    result: m.status === 'done' ? { winner: m.winner === 'draw' ? 'draw' : m.winner === me ? 'me' : 'opponent', ratingChange: m.p1 === me ? m.delta1 : m.delta2 } : undefined,
  };
}

pvp.get('/pvp/status', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const rating = await ensureRating(db, me);
  let active = await activeMatchOf(db, me);
  if (active) active = await advance(db, active);
  if (active?.status !== 'active') active = null;

  const now = Date.now();
  await db.prepare('DELETE FROM pvp_queue WHERE queued_at < ?').bind(now - QUEUE_TTL_MS).run();
  const queued = await db.prepare('SELECT queued_at FROM pvp_queue WHERE user_id = ?').bind(me).first<{ queued_at: number }>();
  const [inc, out, hist] = await Promise.all([
    db.prepare('SELECT c.id, p.nickname FROM pvp_challenges c LEFT JOIN profiles p ON p.user_id = c.from_id WHERE c.to_id = ? ORDER BY c.created_at DESC').bind(me).all<{ id: string; nickname: string }>(),
    db.prepare('SELECT c.id, p.nickname FROM pvp_challenges c LEFT JOIN profiles p ON p.user_id = c.to_id WHERE c.from_id = ?').bind(me).all<{ id: string; nickname: string }>(),
    db.prepare("SELECT m.*, pa.nickname AS n1, pb.nickname AS n2 FROM pvp_matches m LEFT JOIN profiles pa ON pa.user_id = m.p1 LEFT JOIN profiles pb ON pb.user_id = m.p2 WHERE m.status = 'done' AND (m.p1 = ? OR m.p2 = ?) ORDER BY m.finished_at DESC LIMIT 8")
      .bind(me, me).all<MatchRow & { n1: string | null; n2: string | null }>(),
  ]);
  return c.json({
    rating: rating.rating, wins: rating.wins, losses: rating.losses, draws: rating.draws,
    matchId: active?.id ?? null,
    queued: !!queued && !active, queuedAt: queued?.queued_at ?? null,
    incoming: inc.results ?? [], outgoing: out.results ?? [],
    history: (hist.results ?? []).map((h) => ({
      id: h.id, opponent: (h.p1 === me ? h.n2 : h.n1) ?? '알 수 없음', ranked: !!h.ranked,
      result: h.winner === 'draw' ? 'draw' : h.winner === me ? 'win' : 'loss', ratingChange: h.p1 === me ? h.delta1 : h.delta2,
    })),
  });
});

/** 랭크전 대기열에 들어간다. 비슷한 레이팅의 상대가 있으면 바로 대전이 만들어진다 (기다릴수록 범위가 넓어진다). */
pvp.post('/pvp/queue', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  if (await activeMatchOf(db, me)) return c.json({ error: 'already_in_match' }, 409);
  const { rating } = await ensureRating(db, me);
  const now = Date.now();
  await db.prepare('DELETE FROM pvp_queue WHERE queued_at < ?').bind(now - QUEUE_TTL_MS).run();

  const opp = await db
    .prepare('SELECT user_id FROM pvp_queue WHERE user_id != ? AND ABS(rating - ?) <= 100 + (? - queued_at) / 200 ORDER BY queued_at LIMIT 1')
    .bind(me, rating, now)
    .first<{ user_id: string }>();
  if (opp) {
    const { id, stmt } = await matchStatement(db, opp.user_id, me, true);
    try {
      await db.batch([
        db.prepare('DELETE FROM pvp_queue WHERE user_id = ?').bind(opp.user_id),
        guard(db), // 그 사이 다른 사람에게 잡혔으면 중단
        db.prepare('DELETE FROM pvp_queue WHERE user_id = ?').bind(me),
        stmt,
      ]);
      return c.json({ matchId: id });
    } catch { /* 상대가 사라졌다: 내가 대기열에서 기다린다 */ }
  }
  await db.prepare('INSERT OR REPLACE INTO pvp_queue (user_id, rating, queued_at) VALUES (?, ?, ?)').bind(me, rating, now).run();
  return c.json({ queued: true });
});

pvp.post('/pvp/queue/leave', async (c) => {
  await c.env.DB.prepare('DELETE FROM pvp_queue WHERE user_id = ?').bind(c.get('user').id).run();
  return c.json({ ok: true });
});

// ─── 친구 도전전 (레이팅 변동 없음) ───────────────────────────────────────────────

pvp.post('/pvp/challenge', async (c) => {
  const me = c.get('user').id;
  const { userId } = await c.req.json<{ userId?: string }>();
  if (!userId || !UUID.test(userId) || userId === me) return c.json({ error: 'invalid_request' }, 400);
  if ((await relationOf(c.env.DB, me, userId)) !== 'friend') return c.json({ error: 'not_friends' }, 403);
  await c.env.DB
    .prepare('INSERT INTO pvp_challenges (id, from_id, to_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (from_id, to_id) DO UPDATE SET created_at = excluded.created_at')
    .bind(crypto.randomUUID(), me, userId, Date.now())
    .run();
  return c.json({ ok: true });
});

pvp.post('/pvp/challenge/accept', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const { id } = await c.req.json<{ id?: string }>();
  if (!id || !UUID.test(id)) return c.json({ error: 'invalid_request' }, 400);
  const ch = await db.prepare('SELECT from_id FROM pvp_challenges WHERE id = ? AND to_id = ?').bind(id, me).first<{ from_id: string }>();
  if (!ch) return c.json({ error: 'challenge_not_found' }, 404);
  if ((await activeMatchOf(db, me)) || (await activeMatchOf(db, ch.from_id))) return c.json({ error: 'already_in_match' }, 409);
  const { id: matchId, stmt } = await matchStatement(db, ch.from_id, me, false);
  try {
    await db.batch([db.prepare('DELETE FROM pvp_challenges WHERE id = ? AND to_id = ?').bind(id, me), guard(db), stmt]);
  } catch {
    return c.json({ error: 'challenge_not_found' }, 404);
  }
  return c.json({ matchId });
});

/** 거절(받은 쪽)·취소(보낸 쪽) */
pvp.post('/pvp/challenge/decline', async (c) => {
  const me = c.get('user').id;
  const { id } = await c.req.json<{ id?: string }>();
  if (!id || !UUID.test(id)) return c.json({ error: 'invalid_request' }, 400);
  await c.env.DB.prepare('DELETE FROM pvp_challenges WHERE id = ? AND (to_id = ? OR from_id = ?)').bind(id, me, me).run();
  return c.json({ ok: true });
});

// ─── 대전 진행 ───────────────────────────────────────────────────────────────

const loadMine = async (db: D1Database, id: string, me: string) => {
  if (!UUID.test(id)) return null;
  return db.prepare('SELECT * FROM pvp_matches WHERE id = ? AND (p1 = ? OR p2 = ?)').bind(id, me, me).first<MatchRow>();
};

pvp.get('/pvp/match/:id', async (c) => {
  const me = c.get('user').id;
  const row = await loadMine(c.env.DB, c.req.param('id'), me);
  if (!row) return c.json({ error: 'match_not_found' }, 404);
  return c.json(await matchView(c.env.DB, await advance(c.env.DB, row), me));
});

pvp.post('/pvp/match/:id/action', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const found = await loadMine(db, c.req.param('id'), me);
  if (!found) return c.json({ error: 'match_not_found' }, 404);
  let m = await advance(db, found); // 시간 초과가 지난 라운드를 먼저 정리
  if (m.status !== 'active') return c.json(await matchView(db, m, me));

  const body = await c.req.json<{ action?: string; skillId?: string }>();
  const state = JSON.parse(m.state) as BattleState;
  const mine = m.p1 === me ? P1 : P2;
  const foe = mine === P1 ? P2 : P1;
  const self = state.combatants.find((x) => x.id === mine)!;
  if (!needsAction(state, mine)) return c.json(await matchView(db, m, me)); // 충전 스킬이 발동하는 라운드

  let action: Action;
  if (body.action === 'attack') action = { kind: 'attack', targetId: foe };
  else if (body.action === 'guard') action = { kind: 'guard' };
  else if (body.action === 'skill' && body.skillId) {
    const allowed = JSON.parse(mine === P1 ? m.skills1 : m.skills2) as string[];
    if (!allowed.includes(body.skillId)) return c.json({ error: 'unknown_skill' }, 400);
    const check = canUseSkill(state, self, body.skillId);
    if (!check.ok) return c.json({ error: 'skill_unavailable', reason: check.reason }, 400);
    action = { kind: 'skill', skillId: check.skill.id, targetId: check.skill.target === 'enemy' ? foe : undefined };
  } else return c.json({ error: 'invalid_action' }, 400);

  // 라운드당 한 번만 낼 수 있다 (바꿀 수 없다)
  const col = mine === P1 ? 'a1' : 'a2';
  const res = await db
    .prepare(`UPDATE pvp_matches SET ${col} = ? WHERE id = ? AND status = 'active' AND round_no = ? AND ${col} IS NULL`)
    .bind(JSON.stringify(action), m.id, m.round_no)
    .run();
  if (res.meta.changes === 0) return c.json({ error: 'already_submitted' }, 409);

  m = (await db.prepare('SELECT * FROM pvp_matches WHERE id = ?').bind(m.id).first<MatchRow>())!;
  m = await advance(db, m);
  return c.json(await matchView(db, m, me));
});

/** 기권 (패배로 처리) */
pvp.post('/pvp/match/:id/forfeit', async (c) => {
  const me = c.get('user').id;
  const db = c.env.DB;
  const m = await loadMine(db, c.req.param('id'), me);
  if (!m) return c.json({ error: 'match_not_found' }, 404);
  if (m.status !== 'active') return c.json(await matchView(db, m, me));
  const winner = m.p1 === me ? m.p2 : m.p1;
  const r1 = await ensureRating(db, m.p1), r2 = await ensureRating(db, m.p2);
  const score1 = winner === m.p1 ? 1 : 0;
  const d1 = m.ranked ? eloDelta(r1.rating, r2.rating, score1) : 0;
  const d2 = m.ranked ? eloDelta(r2.rating, r1.rating, 1 - score1) : 0;
  const win = (id: string) => (id === winner ? 'wins' : 'losses');
  try {
    await db.batch([
      db.prepare("UPDATE pvp_matches SET status = 'done', winner = ?, delta1 = ?, delta2 = ?, finished_at = ? WHERE id = ? AND status = 'active'").bind(winner, d1, d2, Date.now(), m.id),
      guard(db),
      ...(m.ranked
        ? [
            db.prepare(`UPDATE pvp_ratings SET rating = MAX(0, rating + ?), ${win(m.p1)} = ${win(m.p1)} + 1 WHERE user_id = ?`).bind(d1, m.p1),
            db.prepare(`UPDATE pvp_ratings SET rating = MAX(0, rating + ?), ${win(m.p2)} = ${win(m.p2)} + 1 WHERE user_id = ?`).bind(d2, m.p2),
          ]
        : []),
    ]);
  } catch { /* 이미 끝났다 */ }
  return c.json(await matchView(db, (await db.prepare('SELECT * FROM pvp_matches WHERE id = ?').bind(m.id).first<MatchRow>())!, me));
});

pvp.get('/pvp/ranking', async (c) => {
  const me = c.get('user').id;
  const { results } = await c.env.DB
    .prepare('SELECT r.user_id, r.rating, r.wins, r.losses, r.draws, p.nickname FROM pvp_ratings r LEFT JOIN profiles p ON p.user_id = r.user_id WHERE r.wins + r.losses + r.draws > 0 ORDER BY r.rating DESC, r.wins DESC LIMIT 20')
    .all<{ user_id: string; rating: number; wins: number; losses: number; draws: number; nickname: string | null }>();
  return c.json({ ranking: (results ?? []).map((r, i) => ({ rank: i + 1, id: r.user_id, nickname: r.nickname ?? '알 수 없음', rating: r.rating, wins: r.wins, losses: r.losses, draws: r.draws, me: r.user_id === me })) });
});

