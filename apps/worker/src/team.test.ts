import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './index';
import { clearAuthCache } from './auth';
import { createTestDb } from './test-db';
import { TEAM_MAX_ROUNDS, TEAM_ROUND_MS, teamEloDelta } from './team';

const NAMES = ['a', 'b', 'c', 'd', 'e', 'f', '1', '2'] as const;
const mk = (c: string) => ({ id: `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`, email: `${c}@x.com`, username: `u${c}`, nickname: `유저${c}`, emailVerified: true });
const U = Object.fromEntries(NAMES.map((n) => [n, mk(n)])) as Record<(typeof NAMES)[number], ReturnType<typeof mk>>;
type W = (typeof NAMES)[number];
const USERS: Record<string, ReturnType<typeof mk>> = Object.fromEntries(NAMES.map((n) => [`tok${n}`, U[n]]));
let env: { GL_ACCOUNT_KEY: string; DB: D1Database; ASSETS: { fetch: ReturnType<typeof vi.fn> } };
let sqlite: ReturnType<typeof createTestDb>['sqlite'];

beforeEach(() => {
  clearAuthCache();
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
    const user = USERS[JSON.parse(init.body).token as string];
    return user ? new Response(JSON.stringify({ user }), { status: 200 }) : new Response('{}', { status: 401 });
  }));
  const t = createTestDb(); sqlite = t.sqlite;
  env = { GL_ACCOUNT_KEY: 'k', DB: t.db, ASSETS: { fetch: vi.fn() } };
});
afterEach(() => vi.unstubAllGlobals());

async function call(who: W, method: string, path: string, body?: unknown) {
  const res = await app.request(`https://rtgm.officialgl.com${path}`, { method, headers: { Cookie: `gl_session=tok${who}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, env);
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) as any }; } catch { throw new Error(`${method} ${path} -> ${res.status} ${text}`); }
}
const ROLES = ['tank', 'dealer', 'healer', 'support'] as const;
const roleOf: Record<W, (typeof ROLES)[number]> = { a: 'tank', b: 'dealer', c: 'healer', d: 'support', e: 'tank', f: 'dealer', '1': 'healer', '2': 'support' };
const rating = (w: W) => sqlite.prepare('SELECT * FROM team_ratings WHERE user_id = ?').get(U[w].id) as { rating: number; wins: number; losses: number; draws: number };
const matchRow = (id: string) => sqlite.prepare('SELECT * FROM team_matches WHERE id = ?').get(id) as any;
const view = async (w: W) => (await call(w, 'GET', '/api/team/status')).json.match;
const visit = async () => { for (const n of NAMES) await call(n, 'GET', '/api/team/status'); };
/** 인메모리 DB 어댑터는 동시 트랜잭션을 못 하므로 순서대로 조회한다 */
const slotsOf = async () => { const out = {} as Record<W, string>; for (const n of NAMES) out[n] = (await view(n)).mySlot; return out; };
const patchState = (id: string, fn: (s: any) => void) => { const s = JSON.parse(matchRow(id).state); fn(s); sqlite.prepare('UPDATE team_matches SET state = ? WHERE id = ?').run(JSON.stringify(s), id); };

async function ranked(): Promise<string> {
  await visit();
  let id = '';
  for (const n of NAMES) { const r = await call(n, 'POST', '/api/team/queue', { role: roleOf[n] }); if (r.json.matchId) id = r.json.matchId; }
  return id;
}
/** 모두 방어 */
const guardAll = async (ws: readonly W[] = NAMES) => { let last: any; for (const w of ws) last = await call(w, 'POST', '/api/team/action', { action: 'guard' }); return last; };

describe('팀 Elo', () => {
  it('같은 평균이면 ±16, 약팀이 이기면 더 오른다', () => {
    expect(teamEloDelta(1000, 1000, 1)).toBe(16);
    expect(teamEloDelta(1000, 1000, 0)).toBe(-16);
    expect(teamEloDelta(1000, 1300, 1)).toBeGreaterThan(teamEloDelta(1300, 1000, 1));
  });
});

describe('랭크 매칭', () => {
  it('역할별 2명씩 8명이 모이면 대전이 만들어지고, 두 팀이 모든 역할을 하나씩 갖는다', async () => {
    await visit();
    for (const n of NAMES.slice(0, 7)) expect((await call(n, 'POST', '/api/team/queue', { role: roleOf[n] })).json.matchId).toBeUndefined();
    expect((await call('a', 'GET', '/api/team/status')).json.queued).toMatchObject({ role: 'tank' });
    const r = await call('2', 'POST', '/api/team/queue', { role: roleOf['2'] });
    expect(r.json.matchId).toBeTruthy();
    const v = await view('a');
    expect(v).toMatchObject({ status: 'active', ranked: true, round: 1 });
    expect(v.players).toHaveLength(8);
    for (const side of ['A', 'B']) expect(v.players.filter((p: any) => p.team === side).map((p: any) => p.role).sort()).toEqual(['dealer', 'healer', 'support', 'tank']);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM team_queue').get()).toEqual({ n: 0 });
    expect((await call('a', 'POST', '/api/team/queue', { role: 'tank' })).status).toBe(409);
    expect((await call('b', 'GET', '/api/team/status')).json.queued).toBeNull(); // 나중에 확인해도 대전으로 들어가 있다
  });
  it('역할이 모자라면 대기하고, 레이팅 차이가 크면 묶이지 않는다', async () => {
    await visit();
    for (const n of ['a', 'e', 'b', 'f', 'c', '1']) await call(n as W, 'POST', '/api/team/queue', { role: roleOf[n as W] }); // 서포터 없음
    expect((await call('d', 'POST', '/api/team/queue', { role: 'support' })).json.matchId).toBeUndefined();
    sqlite.prepare('UPDATE team_ratings SET rating = 1600 WHERE user_id = ?').run(U['2'].id);
    expect((await call('2', 'POST', '/api/team/queue', { role: 'support' })).json.matchId).toBeUndefined(); // 범위 밖
    sqlite.prepare('UPDATE team_queue SET queued_at = queued_at - 150000').run(); // 오래 기다리면 범위가 넓어진다
    expect((await call('a', 'GET', '/api/team/status')).json.match).not.toBeNull();
  });
  it('양 팀 레이팅이 비슷해지도록 나눈다', async () => {
    await visit();
    const ratings: Record<W, number> = { a: 1100, e: 1000, b: 1090, f: 1010, c: 1080, '1': 1020, d: 1070, '2': 1030 };
    for (const n of NAMES) sqlite.prepare('UPDATE team_ratings SET rating = ? WHERE user_id = ?').run(ratings[n], U[n].id);
    let id = '';
    for (const n of NAMES) { const r = await call(n, 'POST', '/api/team/queue', { role: roleOf[n] }); if (r.json.matchId) id = r.json.matchId; }
    const v = await view('a');
    const sum = (side: string) => v.players.filter((p: any) => p.team === side).reduce((a: number, p: any) => a + ratings[(NAMES.find((n) => U[n].id === p.userId))!], 0);
    expect(Math.abs(sum('A') - sum('B'))).toBeLessThanOrEqual(40);
    expect(id).toBeTruthy();
  });
});

describe('대전 진행', () => {
  it('모두 내면 한꺼번에 처리되고, 상대의 선택은 보이지 않는다', async () => {
    const id = await ranked();
    await call('a', 'POST', '/api/team/action', { action: 'guard' });
    const other = await view('b');
    expect(other.players.find((p: any) => p.userId === U.a.id).submitted).toBe(true);
    expect(JSON.stringify(other)).not.toContain('rngSeed');
    expect(JSON.stringify(other)).not.toContain('"action"');
    expect((await call('a', 'POST', '/api/team/action', { action: 'attack' })).json.error).toBe('already_submitted');
    const last = await guardAll(NAMES.slice(1));
    expect(last.json.round).toBe(2);
    expect(matchRow(id).round_no).toBe(2);
  });
  it('행동 검증: 내 역할 밖 스킬·아군 공격·적에게 아군 스킬·아이템', async () => {
    await ranked();
    const v = await view('a');
    const myFoe = v.state.combatants.find((c: any) => c.side !== v.state.combatants.find((x: any) => x.id === v.mySlot).side).id;
    const myAlly = v.state.combatants.find((c: any) => c.side === v.state.combatants.find((x: any) => x.id === v.mySlot).side && c.id !== v.mySlot).id;
    expect((await call('a', 'POST', '/api/team/action', { action: 'skill', skillId: 'r_strike' })).json.error).toBe('unknown_skill');
    expect((await call('a', 'POST', '/api/team/action', { action: 'attack', targetId: myAlly })).json.error).toBe('invalid_target');
    expect((await call('a', 'POST', '/api/team/action', { action: 'item', itemId: 'hp_potion' })).json.error).toBe('invalid_action');
    expect((await call('c', 'POST', '/api/team/action', { action: 'skill', skillId: 'r_heal', targetId: myFoe })).json.error).toBe('invalid_target');
  });
  it('도발하면 상대는 도발한 사람만 노릴 수 있다', async () => {
    await ranked();
    const slots = await slotsOf();
    const team = (n: W) => slots[n]!.charAt(0);
    const tankA = NAMES.find((n) => roleOf[n] === 'tank' && team(n) === 'a')!;
    const foe = NAMES.find((n) => roleOf[n] === 'dealer' && team(n) === 'b')!;
    const otherFoe = NAMES.find((n) => roleOf[n] === 'healer' && team(n) === 'a')!;
    void otherFoe;
    // 1라운드: 탱커 도발, 나머지 방어
    await call(tankA, 'POST', '/api/team/action', { action: 'skill', skillId: 'r_taunt' });
    await guardAll(NAMES.filter((n) => n !== tankA));
    // 2라운드: 상대 딜러가 탱커 아닌 사람을 공격하려 하면 거절
    const notTank = NAMES.find((n) => team(n) === 'a' && n !== tankA)!;
    const bad = await call(foe, 'POST', '/api/team/action', { action: 'attack', targetId: slots[notTank] });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ error: 'taunted', taunter: slots[tankA] });
    const good = await call(foe, 'POST', '/api/team/action', { action: 'attack', targetId: slots[tankA] });
    expect(good.status).toBe(200);
    // 도발한 사람이 쓰러지면 제한이 풀린다 (여기서는 대상 미지정이면 도발한 사람이 기본 대상)
    expect((await call(NAMES.find((n) => roleOf[n] === 'support' && team(n) === 'b')!, 'POST', '/api/team/action', { action: 'attack' })).status).toBe(200);
  });
  it('한 팀이 전멸하면 승패가 나고 Elo 가 반영된다', async () => {
    const id = await ranked();
    const slots = await slotsOf();
    patchState(id, (s) => { for (const c of s.combatants) if (c.id.startsWith('b')) c.hp = c.id === 'b1' ? 1 : 0; });
    const b1User = NAMES.find((n) => slots[n] === 'b1')!;
    const aDealer = NAMES.find((n) => slots[n].startsWith('a') && roleOf[n] === 'dealer')!;
    for (const n of NAMES.filter((x) => slots[x].startsWith('a') && x !== aDealer)) await call(n, 'POST', '/api/team/action', { action: 'guard' });
    await call(b1User, 'POST', '/api/team/action', { action: 'guard' });
    const r = await call(aDealer, 'POST', '/api/team/action', { action: 'attack', targetId: 'b1' });
    expect(r.json).toMatchObject({ status: 'done', result: 'win' });
    for (const n of NAMES) {
      const won = slots[n].startsWith('a');
      expect(rating(n)).toMatchObject(won ? { rating: 1016, wins: 1, losses: 0 } : { rating: 984, wins: 0, losses: 1 });
    }
    expect((await view(b1User)).result).toBe('loss');
    await view('a'); await view('b');
    expect(rating('a').rating + rating('e').rating).toBeGreaterThan(0);
    expect(NAMES.reduce((a, n) => a + rating(n).rating, 0)).toBe(8000); // 총합 보존, 중복 반영 없음
  });
  it('제한 시간이 지나면 방어로 처리하고, 3회 연속 안 내면 쓰러진 것으로 본다', async () => {
    const id = await ranked();
    const afk: W = 'a';
    for (let i = 0; i < 3; i++) {
      patchState(id, (s) => { for (const c of s.combatants) c.hp = c.stats.maxHp; });
      await guardAll(NAMES.filter((n) => n !== afk));
      sqlite.prepare('UPDATE team_matches SET deadline = 1 WHERE id = ?').run(id);
      await view('b');
    }
    const v = await view('b');
    const slot = v.players.find((p: any) => p.userId === U[afk].id).slot;
    expect(v.state.combatants.find((c: any) => c.id === slot).hp).toBe(0);
    expect(v.status).toBe('active');
  });
  it(`${TEAM_MAX_ROUNDS}라운드가 넘으면 남은 HP 비율로 판정한다`, async () => {
    const id = await ranked();
    patchState(id, (s) => { s.round = TEAM_MAX_ROUNDS; for (const c of s.combatants) if (c.id.startsWith('b')) c.hp = Math.floor(c.hp / 2); });
    await guardAll();
    expect(matchRow(id)).toMatchObject({ status: 'done', winner: 'A' });
    expect(TEAM_ROUND_MS).toBe(45_000);
  });
});

describe('친선 방', () => {
  it('코드로 모여 팀·역할을 정하고 시작하면 레이팅은 변하지 않는다', async () => {
    await visit();
    const { json } = await call('a', 'POST', '/api/team/room/create');
    const code = (await view('a')).code as string;
    expect(code).toHaveLength(6);
    expect((await call('b', 'POST', '/api/team/room/join', { code: code.toLowerCase() })).status).toBe(200);
    const v = await view('a');
    expect(v.players.map((p: any) => p.team).sort()).toEqual(['A', 'B']); // 번갈아 배정
    expect((await call('a', 'POST', '/api/team/room/start')).json.error).toBe('not_ready'); // 역할 미정
    await call('a', 'POST', '/api/team/room/role', { role: 'tank' });
    await call('b', 'POST', '/api/team/room/role', { role: 'dealer' });
    expect((await call('a', 'POST', '/api/team/room/start')).json.error).toBe('not_ready'); // b 준비 안 함
    expect((await call('b', 'POST', '/api/team/room/start')).json.error).toBe('not_allowed');
    await call('b', 'POST', '/api/team/room/ready', { ready: true });
    expect((await call('a', 'POST', '/api/team/room/start')).status).toBe(200);
    expect(matchRow(json.id)).toMatchObject({ status: 'active', ranked: 0 });
    const ms = await view('a');
    expect(ms.state.combatants).toHaveLength(2);
    // 1:1 친선전 끝내기
    const foeSlot = ms.state.combatants.find((c: any) => c.id !== ms.mySlot).id;
    patchState(json.id, (s) => { s.combatants.find((c: any) => c.id === foeSlot).hp = 1; });
    await call('b', 'POST', '/api/team/action', { action: 'guard' });
    await call('a', 'POST', '/api/team/action', { action: 'attack', targetId: foeSlot });
    expect(matchRow(json.id).status).toBe('done');
    expect(rating('a')).toMatchObject({ rating: 1000, wins: 0 });
  });
  it('팀 정원 4명·역할은 팀 안에서 하나씩·한 팀뿐이면 시작할 수 없다', async () => {
    await visit();
    await call('a', 'POST', '/api/team/room/create');
    const code = (await view('a')).code;
    for (const n of ['b', 'c', 'd', 'e', 'f', '1', '2'] as const) expect((await call(n, 'POST', '/api/team/room/join', { code })).status).toBe(200);
    const v = await view('a');
    expect(v.players.filter((p: any) => p.team === 'A')).toHaveLength(4);
    expect(v.players.filter((p: any) => p.team === 'B')).toHaveLength(4);
    expect((await call('a', 'POST', '/api/team/room/team', { team: 'B' })).json.error).toBe('room_full');
    await call('a', 'POST', '/api/team/room/role', { role: 'tank' });
    const teammate = NAMES.find((n) => n !== 'a' && v.players.find((p: any) => p.userId === U[n].id).team === v.players.find((p: any) => p.userId === U.a.id).team)!;
    expect((await call(teammate, 'POST', '/api/team/room/role', { role: 'tank' })).json.error).toBe('role_taken');
    const foe = NAMES.find((n) => v.players.find((p: any) => p.userId === U[n].id).team !== v.players.find((p: any) => p.userId === U.a.id).team)!;
    expect((await call(foe, 'POST', '/api/team/room/role', { role: 'tank' })).status).toBe(200); // 다른 팀은 같은 역할 가능
    // 한 팀만 있는 방은 시작 불가
    await call('a', 'POST', '/api/team/room/leave');
  });
  it('한 팀만 있으면 시작할 수 없고, 방장이 나가면 위임되며, 오래된 방은 사라진다', async () => {
    await visit();
    const { json } = await call('a', 'POST', '/api/team/room/create');
    await call('a', 'POST', '/api/team/room/role', { role: 'tank' });
    expect((await call('a', 'POST', '/api/team/room/start')).json.error).toBe('need_both_teams');
    const code = (await view('a')).code;
    await call('b', 'POST', '/api/team/room/join', { code });
    await call('a', 'POST', '/api/team/room/leave');
    expect((await view('b')).leaderId).toBe(U.b.id);
    sqlite.prepare('UPDATE team_matches SET created_at = ? WHERE id = ?').run(Date.now() - 31 * 60_000, json.id);
    expect((await call('c', 'POST', '/api/team/room/join', { code })).status).toBe(404);
  });
});
