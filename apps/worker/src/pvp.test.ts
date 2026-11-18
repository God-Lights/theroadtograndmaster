import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './index';
import { clearAuthCache } from './auth';
import { createTestDb } from './test-db';
import { PVP_CAP, ROUND_MS, MAX_ROUNDS, clampStats, eloDelta } from './pvp';

const mk = (c: string, n: string) => ({ id: `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`, email: `${n}@x.com`, username: n, nickname: n, emailVerified: true });
const A = mk('a', '에이'), B = mk('b', '비이'), C = mk('c', '씨이');
const USERS: Record<string, ReturnType<typeof mk>> = { tokA: A, tokB: B, tokC: C };
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

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await app.request(`https://rtgm.officialgl.com${path}`, { method, headers: { Cookie: `gl_session=${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, env);
  return { status: res.status, json: (await res.json()) as any };
}
const visit = async () => { for (const t of ['tokA', 'tokB', 'tokC']) await call(t, 'GET', '/api/pvp/status'); };
const rating = (id: string) => sqlite.prepare('SELECT * FROM pvp_ratings WHERE user_id = ?').get(id) as { rating: number; wins: number; losses: number; draws: number };
const match = (id: string) => sqlite.prepare('SELECT * FROM pvp_matches WHERE id = ?').get(id) as any;
async function ranked() {
  await visit();
  await call('tokA', 'POST', '/api/pvp/queue');
  const r = await call('tokB', 'POST', '/api/pvp/queue');
  return r.json.matchId as string;
}
const round = async (id: string, a: unknown, b: unknown) => { await call('tokA', 'POST', `/api/pvp/match/${id}/action`, a); return call('tokB', 'POST', `/api/pvp/match/${id}/action`, b); };
const setHp = (id: string, who: 'p1' | 'p2', hp: number) => {
  const m = match(id); const s = JSON.parse(m.state);
  s.combatants.find((c: any) => c.id === who).hp = hp;
  sqlite.prepare('UPDATE pvp_matches SET state = ? WHERE id = ?').run(JSON.stringify(s), id);
};

describe('레이팅 계산', () => {
  it('Elo: 같은 레이팅이면 ±16, 약자가 이기면 더 많이 오른다, 합이 0', () => {
    expect(eloDelta(1000, 1000, 1)).toBe(16);
    expect(eloDelta(1000, 1000, 0)).toBe(-16);
    expect(eloDelta(1000, 1000, 0.5)).toBe(0);
    expect(eloDelta(1000, 1400, 1)).toBeGreaterThan(eloDelta(1400, 1000, 1));
    expect(eloDelta(1200, 1000, 1) + eloDelta(1000, 1200, 0)).toBe(0);
  });
  it('PvP 스탯은 상한으로 보정된다', () => {
    const s = clampStats({ maxHp: 900, atk: 200, def: 90, spd: 12, int: 20 });
    expect(s).toMatchObject({ maxHp: PVP_CAP.maxHp, atk: PVP_CAP.atk, def: PVP_CAP.def, spd: 12 });
    expect(clampStats({ maxHp: 110, atk: 10, def: 3, spd: 10, int: 20 }).atk).toBe(10);
  });
});

describe('매칭', () => {
  it('처음 접속하면 레이팅 1000, 한 명이면 대기, 두 명이 되면 대전이 만들어진다', async () => {
    await visit();
    expect((await call('tokA', 'GET', '/api/pvp/status')).json).toMatchObject({ rating: 1000, wins: 0, queued: false, matchId: null });
    expect((await call('tokA', 'POST', '/api/pvp/queue')).json.queued).toBe(true);
    expect((await call('tokA', 'GET', '/api/pvp/status')).json.queued).toBe(true);
    const r = await call('tokB', 'POST', '/api/pvp/queue');
    expect(r.json.matchId).toBeTruthy();
    // 먼저 기다리던 사람도 상태 조회로 대전을 알게 된다
    const a = (await call('tokA', 'GET', '/api/pvp/status')).json;
    expect(a).toMatchObject({ matchId: r.json.matchId, queued: false });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM pvp_queue').get()).toEqual({ n: 0 });
    expect((await call('tokA', 'POST', '/api/pvp/queue')).status).toBe(409); // 대전 중에는 다시 못 들어간다
  });
  it('레이팅 차이가 크면 매칭되지 않는다 (기다릴수록 넓어진다)', async () => {
    await visit();
    sqlite.prepare('UPDATE pvp_ratings SET rating = 1500 WHERE user_id = ?').run(A.id);
    await call('tokA', 'POST', '/api/pvp/queue');
    expect((await call('tokB', 'POST', '/api/pvp/queue')).json.queued).toBe(true);
    // 오래 기다린 사람의 범위는 넓어진다
    sqlite.prepare('UPDATE pvp_queue SET queued_at = queued_at - 100000 WHERE user_id = ?').run(A.id);
    sqlite.prepare('DELETE FROM pvp_queue WHERE user_id = ?').run(B.id);
    expect((await call('tokB', 'POST', '/api/pvp/queue')).json.matchId).toBeTruthy();
  });
  it('대기열을 취소할 수 있고, 오래된 대기는 정리된다', async () => {
    await visit();
    await call('tokA', 'POST', '/api/pvp/queue');
    await call('tokA', 'POST', '/api/pvp/queue/leave');
    expect((await call('tokB', 'POST', '/api/pvp/queue')).json.queued).toBe(true);
    sqlite.prepare('UPDATE pvp_queue SET queued_at = 1').run();
    expect((await call('tokC', 'POST', '/api/pvp/queue')).json.queued).toBe(true); // 만료된 B와는 매칭되지 않는다
  });
});

describe('대전 진행', () => {
  it('상대의 선택은 숨겨지고, 둘 다 내면 한꺼번에 처리된다', async () => {
    const id = await ranked();
    expect((await call('tokA', 'POST', `/api/pvp/match/${id}/action`, { action: 'attack' })).json).toMatchObject({ submitted: true, opponentSubmitted: false, round: 1 });
    const bView = (await call('tokB', 'GET', `/api/pvp/match/${id}`)).json;
    expect(bView).toMatchObject({ submitted: false, opponentSubmitted: true, mine: 'p2' });
    expect(JSON.stringify(bView)).not.toContain('rngSeed');
    expect(bView.state.combatants).toHaveLength(2);
    const done = await call('tokB', 'POST', `/api/pvp/match/${id}/action`, { action: 'guard' });
    expect(done.json.round).toBe(2);
    expect(done.json.log.length).toBeGreaterThan(0);
    expect(match(id)).toMatchObject({ a1: null, a2: null, round_no: 2 });
    expect((await call('tokA', 'GET', `/api/pvp/match/${id}`)).json).toMatchObject({ submitted: false, round: 2 });
  });
  it('같은 라운드에 두 번 낼 수 없고, 아이템·모르는 스킬·남의 대전은 거절된다', async () => {
    const id = await ranked();
    await call('tokA', 'POST', `/api/pvp/match/${id}/action`, { action: 'attack' });
    expect((await call('tokA', 'POST', `/api/pvp/match/${id}/action`, { action: 'guard' })).json.error).toBe('already_submitted');
    expect((await call('tokB', 'POST', `/api/pvp/match/${id}/action`, { action: 'item', itemId: 'hp_potion' })).json.error).toBe('invalid_action');
    expect((await call('tokB', 'POST', `/api/pvp/match/${id}/action`, { action: 'skill', skillId: 'execute' })).json.error).toBe('unknown_skill');
    expect((await call('tokC', 'GET', `/api/pvp/match/${id}`)).status).toBe(404);
    expect((await call('tokC', 'POST', `/api/pvp/match/${id}/action`, { action: 'attack' })).status).toBe(404);
  });
  it('스킬을 낼 수 있고 AP가 부족하면 거절된다', async () => {
    const id = await ranked();
    const r = await call('tokA', 'POST', `/api/pvp/match/${id}/action`, { action: 'skill', skillId: 'strike' });
    expect(r.json.submitted).toBe(true);
    expect(Object.keys(r.json.skills)).toEqual(expect.arrayContaining(['strike']));
    await call('tokB', 'POST', `/api/pvp/match/${id}/action`, { action: 'guard' });
    const s = JSON.parse(match(id).state);
    expect(s.combatants.find((c: any) => c.id === 'p1').ap).toBeLessThan(6);
  });
  it('승부가 나면 레이팅이 오르내리고 한 번만 반영된다', async () => {
    const id = await ranked();
    setHp(id, 'p2', 1);
    const r = await round(id, { action: 'attack' }, { action: 'guard' });
    expect(r.json).toMatchObject({ status: 'done' });
    const winnerUser = match(id).winner;
    expect(winnerUser).toBe(A.id);
    expect(rating(A.id)).toMatchObject({ rating: 1016, wins: 1, losses: 0 });
    expect(rating(B.id)).toMatchObject({ rating: 984, wins: 0, losses: 1 });
    expect((await call('tokA', 'GET', `/api/pvp/match/${id}`)).json.result).toEqual({ winner: 'me', ratingChange: 16 });
    expect((await call('tokB', 'GET', `/api/pvp/match/${id}`)).json.result).toEqual({ winner: 'opponent', ratingChange: -16 });
    await call('tokA', 'GET', `/api/pvp/match/${id}`);
    expect(rating(A.id).rating).toBe(1016); // 중복 반영 없음
    expect((await call('tokA', 'GET', '/api/pvp/status')).json).toMatchObject({ matchId: null, rating: 1016, history: [{ result: 'win', ratingChange: 16, opponent: '비이' }] });
    const rank = (await call('tokB', 'GET', '/api/pvp/ranking')).json.ranking;
    expect(rank.map((x: any) => x.nickname)).toEqual(['에이', '비이']);
    expect(rank[1].me).toBe(true);
  });
  it('둘 다 쓰러지면 무승부', async () => {
    const id = await ranked();
    setHp(id, 'p1', 1); setHp(id, 'p2', 1);
    sqlite.prepare("UPDATE pvp_matches SET state = json_set(state, '$.combatants[0].stats.spd', 10, '$.combatants[1].stats.spd', 10) WHERE id = ?").run(id);
    await round(id, { action: 'attack' }, { action: 'attack' });
    const m = match(id);
    // 속도 동률은 시드로 갈리므로 한쪽만 쓰러질 수 있다. 어느 쪽이든 결과가 확정되고 레이팅 합은 0.
    expect(m.status).toBe('done');
    expect(m.delta1 + m.delta2).toBe(0);
  });
  it('제한 시간이 지나면 방어로 처리하고, 3회 연속 안 내면 기권패', async () => {
    const id = await ranked();
    for (let i = 0; i < 2; i++) {
      await call('tokB', 'POST', `/api/pvp/match/${id}/action`, { action: 'attack' });
      sqlite.prepare('UPDATE pvp_matches SET deadline = 1 WHERE id = ?').run(id);
      const v = (await call('tokB', 'GET', `/api/pvp/match/${id}`)).json;
      expect(v.status).toBe('active');
      expect(v.round).toBe(i + 2);
    }
    expect(match(id).miss1).toBe(2);
    await call('tokB', 'POST', `/api/pvp/match/${id}/action`, { action: 'attack' });
    sqlite.prepare('UPDATE pvp_matches SET deadline = 1 WHERE id = ?').run(id);
    const end = (await call('tokB', 'GET', `/api/pvp/match/${id}`)).json;
    expect(end).toMatchObject({ status: 'done', result: { winner: 'me' } });
    expect(rating(B.id).wins).toBe(1);
    expect(rating(A.id).losses).toBe(1);
  });
  it('마감이 새 라운드마다 갱신된다', async () => {
    const id = await ranked();
    const before = match(id).deadline;
    await round(id, { action: 'guard' }, { action: 'guard' });
    expect(match(id).deadline).toBeGreaterThanOrEqual(before);
    expect(match(id).deadline - Date.now()).toBeLessThanOrEqual(ROUND_MS);
  });
  it('40라운드가 넘으면 남은 HP 비율로 판정한다', async () => {
    const id = await ranked();
    const m = match(id); const s = JSON.parse(m.state); s.round = MAX_ROUNDS;
    s.combatants[0].hp = 50; s.combatants[1].hp = 100;
    sqlite.prepare('UPDATE pvp_matches SET state = ? WHERE id = ?').run(JSON.stringify(s), id);
    await round(id, { action: 'guard' }, { action: 'guard' });
    const after = match(id);
    expect(after.status).toBe('done');
    expect(after.winner).toBe(B.id);
  });
  it('기권하면 진다', async () => {
    const id = await ranked();
    expect((await call('tokA', 'POST', `/api/pvp/match/${id}/forfeit`)).json.result).toMatchObject({ winner: 'opponent', ratingChange: -16 });
    expect(rating(B.id)).toMatchObject({ rating: 1016, wins: 1 });
    await call('tokA', 'POST', `/api/pvp/match/${id}/forfeit`);
    expect(rating(A.id).rating).toBe(984); // 중복 기권 반영 없음
  });
});

describe('친구 도전전', () => {
  const befriend = async () => { await call('tokA', 'POST', '/api/friends/request', { userId: B.id }); await call('tokB', 'POST', '/api/friends/accept', { userId: A.id }); };
  it('친구만 도전할 수 있고, 수락하면 레이팅이 바뀌지 않는 대전이 만들어진다', async () => {
    await visit();
    expect((await call('tokA', 'POST', '/api/pvp/challenge', { userId: B.id })).json.error).toBe('not_friends');
    await befriend();
    expect((await call('tokA', 'POST', '/api/pvp/challenge', { userId: B.id })).status).toBe(200);
    const inc = (await call('tokB', 'GET', '/api/pvp/status')).json.incoming;
    expect(inc).toMatchObject([{ nickname: '에이' }]);
    expect((await call('tokA', 'GET', '/api/pvp/status')).json.outgoing).toHaveLength(1);
    const { json } = await call('tokB', 'POST', '/api/pvp/challenge/accept', { id: inc[0].id });
    const id = json.matchId;
    expect(match(id).ranked).toBe(0);
    setHp(id, 'p1', 1);
    await round(id, { action: 'guard' }, { action: 'attack' });
    expect(match(id)).toMatchObject({ status: 'done', winner: B.id, delta1: 0, delta2: 0 });
    expect(rating(B.id)).toMatchObject({ rating: 1000, wins: 0 });
  });
  it('거절·취소하면 사라진다', async () => {
    await visit(); await befriend();
    await call('tokA', 'POST', '/api/pvp/challenge', { userId: B.id });
    const id = (await call('tokB', 'GET', '/api/pvp/status')).json.incoming[0].id;
    await call('tokA', 'POST', '/api/pvp/challenge/decline', { id }); // 보낸 쪽 취소
    expect((await call('tokB', 'POST', '/api/pvp/challenge/accept', { id })).status).toBe(404);
  });
});
