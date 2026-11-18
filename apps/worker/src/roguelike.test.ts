import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './index';
import { clearAuthCache } from './auth';
import { createTestDb } from './test-db';
import { ROGUE_ABORT_COOLDOWN_FACTOR, rogueById } from '@rtgm/data';

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
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await app.request(`https://rtgm.officialgl.com${path}`, { method, headers: { Cookie: `gl_session=${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, env);
  return { status: res.status, json: (await res.json()) as any };
}
const me = (id: string) => sqlite.prepare('SELECT gold, proficiency FROM characters WHERE user_id = ?').get(id) as { gold: number; proficiency: number };
const setProf = (id: string, p: number) => sqlite.prepare('UPDATE characters SET proficiency = ? WHERE user_id = ?').run(p, id);
const setGold = (id: string, g: number) => sqlite.prepare('UPDATE characters SET gold = ? WHERE user_id = ?').run(g, id);
const qty = (id: string, item: string) => (sqlite.prepare('SELECT quantity FROM inventory WHERE user_id = ? AND item_id = ?').get(id, item) as { quantity: number } | undefined)?.quantity ?? 0;
const runRow = (id: string) => sqlite.prepare('SELECT * FROM dungeon_runs WHERE id = ?').get(id) as any;
const D = rogueById('catacomb')!;

/** getRandomValues 를 지정한 값들로 차례대로 대체한다 (방 종류를 고르려고) */
function rig(values: number[]) {
  const real = crypto.getRandomValues.bind(crypto);
  let i = 0;
  return vi.spyOn(crypto, 'getRandomValues').mockImplementation(((arr: Uint32Array) => {
    if (arr instanceof Uint32Array && arr.length === 1 && i < values.length) { arr[0] = values[i++]!; return arr; }
    return real(arr);
  }) as never);
}
/** mulberry32(seed)() 의 첫 값이 원하는 구간에 들어오는 시드를 찾는다 */
import { mulberry32 } from '@rtgm/engine';
const seedFor = (lo: number, hi: number) => { for (let s = 1; s < 100000; s++) { const v = mulberry32(s)(); if (v >= lo && v < hi) return s; } throw new Error('no seed'); };
// 방 종류 가중치(몬스터 45·보물 22·함정 15·빈 방 18) 기준 구간
const ROOM = { monster: seedFor(0, 0.4), treasure: seedFor(0.46, 0.64), trap: seedFor(0.68, 0.8), nothing: seedFor(0.85, 0.98) };

async function startRun(w = 'tokA', id = A.id) {
  await call(w, 'GET', '/api/me');
  const r = await call(w, 'POST', '/api/run/start', { dungeonId: 'catacomb' });
  expect(r.status).toBe(200);
  void id;
  return r.json;
}
const advanceTo = async (kind: keyof typeof ROOM, w = 'tokA') => { const spy = rig([ROOM[kind]]); const r = await call(w, 'POST', '/api/run/advance'); spy.mockRestore(); return r; };

describe('로그라이크 던전 진행', () => {
  it('목록에 던전이 있고, 시작하면 HP가 가득 찬 런이 만들어진다', async () => {
    await call('tokA', 'GET', '/api/me');
    const list = (await call('tokA', 'GET', '/api/run')).json;
    expect(list.run).toBeNull();
    expect(list.dungeons.map((d: any) => d.id)).toEqual(['catacomb', 'mist_depths', 'hunger_den']);
    const run = await startRun();
    expect(run).toMatchObject({ dungeonId: 'catacomb', floor: 0, floors: D.floors, status: 'idle', hp: run.maxHp, loot: { gold: 0, items: [] } });
    expect((await call('tokA', 'POST', '/api/run/start', { dungeonId: 'catacomb' })).json.error).toBe('already_in_run');
    expect((await call('tokA', 'GET', '/api/run')).json.run.id).toBe(run.id);
  });
  it('입장 조건: 숙련도 제한·입장 골드·없는 던전', async () => {
    await call('tokA', 'GET', '/api/me');
    expect((await call('tokA', 'POST', '/api/run/start', { dungeonId: 'mist_depths' })).json).toMatchObject({ error: 'dungeon_locked', required: 800 });
    setProf(A.id, 900); setGold(A.id, 100);
    expect((await call('tokA', 'POST', '/api/run/start', { dungeonId: 'mist_depths' })).json.error).toBe('not_enough_gold');
    setGold(A.id, 250);
    expect((await call('tokA', 'POST', '/api/run/start', { dungeonId: 'mist_depths' })).status).toBe(200);
    expect(me(A.id).gold).toBe(50); // 입장 200D
    expect((await call('tokB', 'POST', '/api/run/start', { dungeonId: 'nowhere' })).status).toBe(404);
  });
  it('보물 방: 전리품에 쌓이지만 아직 내 것이 아니다', async () => {
    await startRun();
    const g0 = me(A.id).gold;
    const r = await advanceTo('treasure');
    expect(r.json).toMatchObject({ floor: 1, status: 'idle', room: { kind: 'treasure' } });
    expect(r.json.loot.gold).toBeGreaterThanOrEqual(D.treasure.gold[0]);
    expect(r.json.loot.items.length).toBe(1);
    expect(me(A.id).gold).toBe(g0);
  });
  it('함정 방: HP가 깎이지만 1 아래로는 내려가지 않는다', async () => {
    const run = await startRun();
    const r = await advanceTo('trap');
    expect(r.json.room.kind).toBe('trap');
    expect(r.json.hp).toBeLessThan(run.maxHp);
    expect(r.json.hp).toBeGreaterThanOrEqual(run.maxHp - Math.ceil(run.maxHp * D.trapDamagePct[1] / 100) - 1);
    sqlite.prepare('UPDATE dungeon_runs SET hp = 2 WHERE id = ?').run(run.id);
    expect((await advanceTo('trap')).json.hp).toBe(1);
  });
  it('빈 방: 아무 일도 일어나지 않는다', async () => {
    const run = await startRun();
    const r = await advanceTo('nothing');
    expect(r.json).toMatchObject({ floor: 1, hp: run.maxHp, room: { kind: 'nothing' } });
    expect(r.json.loot).toMatchObject({ gold: 0, items: [] });
  });
  it('몬스터 방: 전투가 만들어지고 현재 HP를 이어받으며, 전투 중에는 다음 방으로 갈 수 없다', async () => {
    const run = await startRun();
    sqlite.prepare('UPDATE dungeon_runs SET hp = 40 WHERE id = ?').run(run.id);
    const r = await advanceTo('monster');
    expect(r.json).toMatchObject({ status: 'battle', room: { kind: 'monster' } });
    expect(r.json.battle.state.combatants.find((c: any) => c.id === 'player').hp).toBe(40);
    expect(D.monsters).toContain(r.json.battle.mobId);
    expect((await call('tokA', 'POST', '/api/run/advance')).json.error).toBe('run_busy');
    expect((await call('tokA', 'POST', '/api/run/retreat')).json.error).toBe('run_busy');
    expect((await call('tokA', 'GET', '/api/run')).json.run.battle.id).toBe(r.json.battle.id); // 이어서 할 수 있다
  });
  it('전투에서 이기면 HP가 이어지고 보상은 전리품이 된다 (바로 받지 않는다)', async () => {
    const run = await startRun();
    const r = await advanceTo('monster');
    const bid = r.json.battle.id;
    const st = JSON.parse((sqlite.prepare('SELECT state FROM battles WHERE id = ?').get(bid) as any).state);
    st.combatants.find((c: any) => c.id === 'enemy').hp = 1;
    st.combatants.find((c: any) => c.id === 'player').hp = 70;
    sqlite.prepare('UPDATE battles SET state = ? WHERE id = ?').run(JSON.stringify(st), bid);
    const g0 = me(A.id), p0 = g0.proficiency;
    let out: any;
    for (let i = 0; i < 6 && !out?.json.rewards; i++) out = await call('tokA', 'POST', `/api/battle/${bid}/round`, { action: 'attack' });
    expect(out.json).toMatchObject({ deferred: true });
    expect(out.json.state.status).toBe('victory');
    expect(me(A.id)).toEqual(g0); // 내 것이 아직 아님
    const after = (await call('tokA', 'GET', '/api/run')).json.run;
    expect(after).toMatchObject({ status: 'idle', floor: 1 });
    expect(after.hp).toBeGreaterThan(0);
    expect(after.hp).toBeLessThanOrEqual(run.maxHp);
    expect(after.loot.proficiency).toBeGreaterThan(0);
    // 후퇴하면 전리품을 받는다
    const retreat = await call('tokA', 'POST', '/api/run/retreat');
    expect(retreat.json).toMatchObject({ status: 'done', result: 'retreat' });
    expect(me(A.id).proficiency).toBe(p0 + after.loot.proficiency);
    expect(me(A.id).gold).toBe(g0.gold + after.loot.gold);
  });
  it('후퇴: 전리품을 받고 대기시간(절반)이 걸린다. 두 번 받을 수 없다', async () => {
    const run = await startRun();
    await advanceTo('treasure');
    const loot = (await call('tokA', 'GET', '/api/run')).json.run.loot;
    const g0 = me(A.id).gold;
    const t0 = Date.now();
    const r = await call('tokA', 'POST', '/api/run/retreat');
    expect(r.json).toMatchObject({ status: 'done', result: 'retreat' });
    expect(me(A.id).gold).toBe(g0 + loot.gold);
    for (const it of loot.items) expect(qty(A.id, it.itemId)).toBeGreaterThanOrEqual(it.quantity);
    const until = (sqlite.prepare("SELECT until FROM action_cooldowns WHERE key = 'run:catacomb'").get() as any).until;
    expect(until).toBeGreaterThanOrEqual(t0 + D.cooldownMinutes * 60_000 * ROGUE_ABORT_COOLDOWN_FACTOR - 1000);
    expect(until).toBeLessThan(t0 + D.cooldownMinutes * 60_000 + 5000);
    expect((await call('tokA', 'POST', '/api/run/retreat')).status).toBe(404);
    expect(me(A.id).gold).toBe(g0 + loot.gold);
    // 대기 중에는 다시 들어갈 수 없고, 끝나면 들어갈 수 있다
    expect((await call('tokA', 'POST', '/api/run/start', { dungeonId: 'catacomb' })).json).toMatchObject({ error: 'run_cooldown', until });
    expect((await call('tokA', 'GET', '/api/run')).json.dungeons[0].until).toBe(until);
    sqlite.prepare('UPDATE action_cooldowns SET until = ?').run(Date.now() - 1);
    expect((await call('tokA', 'POST', '/api/run/start', { dungeonId: 'catacomb' })).status).toBe(200);
    void run;
  });
  it('쓰러지면 전리품을 잃고 숙련도만 조금 받는다', async () => {
    await startRun();
    await advanceTo('treasure');
    const r = await advanceTo('monster');
    const bid = r.json.battle.id;
    const st = JSON.parse((sqlite.prepare('SELECT state FROM battles WHERE id = ?').get(bid) as any).state);
    st.combatants.find((c: any) => c.id === 'player').hp = 1;
    st.combatants.find((c: any) => c.id === 'enemy').stats.atk = 9999;
    st.combatants.find((c: any) => c.id === 'enemy').stats.spd = 99;
    sqlite.prepare('UPDATE battles SET state = ? WHERE id = ?').run(JSON.stringify(st), bid);
    const g0 = me(A.id);
    for (let i = 0; i < 6; i++) { const out = await call('tokA', 'POST', `/api/battle/${bid}/round`, { action: 'attack' }); if (out.json.state.status !== 'ongoing') break; }
    const done = (await call('tokA', 'GET', '/api/run/last')).json.run;
    expect(done).toMatchObject({ status: 'done', result: 'dead' });
    expect(me(A.id).gold).toBe(g0.gold); // 보물로 얻은 골드는 사라졌다
    expect(me(A.id).proficiency).toBeLessThanOrEqual(g0.proficiency + 5);
    expect((await call('tokA', 'GET', '/api/run')).json.run).toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM action_cooldowns WHERE key = 'run:catacomb'").get()).toEqual({ n: 1 });
  });
  it('마지막 층은 항상 강화된 최종 보스이고, 이기면 완주 보너스와 전체 알림', async () => {
    const run = await startRun();
    sqlite.prepare('UPDATE dungeon_runs SET floor = ? WHERE id = ?').run(D.floors - 1, run.id);
    const r = await call('tokA', 'POST', '/api/run/advance');
    expect(r.json).toMatchObject({ floor: D.floors, status: 'battle', battle: { mobId: D.finalBoss.mobId } });
    const boss = r.json.battle.state.combatants.find((c: any) => c.id === 'enemy');
    expect(boss.stats.maxHp).toBeGreaterThan(85); // 늑대인간 HP 85 × 1.4
    const bid = r.json.battle.id;
    const st = JSON.parse((sqlite.prepare('SELECT state FROM battles WHERE id = ?').get(bid) as any).state);
    st.combatants.find((c: any) => c.id === 'enemy').hp = 1;
    sqlite.prepare('UPDATE battles SET state = ? WHERE id = ?').run(JSON.stringify(st), bid);
    const g0 = me(A.id);
    for (let i = 0; i < 6; i++) { const out = await call('tokA', 'POST', `/api/battle/${bid}/round`, { action: 'attack' }); if (out.json.state.status !== 'ongoing') break; }
    const done = (await call('tokA', 'GET', '/api/run/last')).json.run;
    expect(done).toMatchObject({ status: 'done', result: 'clear' });
    expect(me(A.id).gold).toBeGreaterThanOrEqual(g0.gold + D.clearBonus.gold[0]);
    expect(me(A.id).proficiency).toBeGreaterThanOrEqual(g0.proficiency + D.clearBonus.proficiency);
    const news = (await call('tokB', 'GET', '/api/announcements')).json.announcements;
    expect(news.at(-1)).toMatchObject({ kind: 'dungeon' });
    expect(news.at(-1).text).toContain('에이');
    expect(news.at(-1).text).toContain('지하 묘지');
    // 같은 전투로 보상이 두 번 지급되지 않는다
    const again = await call('tokA', 'POST', `/api/battle/${bid}/round`, { action: 'attack' });
    expect(again.json.rewards).toBeUndefined();
  });
  it('남의 런은 건드릴 수 없고, 던전 밖에서 진행/후퇴하면 거절된다', async () => {
    await call('tokB', 'GET', '/api/me');
    expect((await call('tokB', 'POST', '/api/run/advance')).status).toBe(404);
    expect((await call('tokB', 'POST', '/api/run/retreat')).status).toBe(404);
    await startRun();
    expect((await call('tokB', 'GET', '/api/run')).json.run).toBeNull();
  });
});

describe('전체 알림', () => {
  it('보스를 쓰러뜨리면 모두에게 알림이 가고, 일반 몹은 알림이 없다', async () => {
    await call('tokA', 'GET', '/api/me'); await call('tokB', 'GET', '/api/me');
    expect((await call('tokB', 'GET', '/api/announcements')).json).toMatchObject({ latest: 0, announcements: [] });
    const killBoss = async (mobId: string) => {
      const { json } = await call('tokA', 'POST', '/api/battle', { mobId });
      const st = JSON.parse((sqlite.prepare('SELECT state FROM battles WHERE id = ?').get(json.id) as any).state);
      st.combatants.find((c: any) => c.id === 'enemy').hp = 1;
      sqlite.prepare('UPDATE battles SET state = ? WHERE id = ?').run(JSON.stringify(st), json.id);
      for (let i = 0; i < 8; i++) { const out = await call('tokA', 'POST', `/api/battle/${json.id}/round`, { action: 'attack' }); if (out.json.state.status !== 'ongoing') return out.json; }
    };
    await killBoss('rich');
    const list = (await call('tokB', 'GET', '/api/announcements')).json;
    expect(list.announcements).toHaveLength(1);
    expect(list.announcements[0]).toMatchObject({ kind: 'boss' });
    expect(list.announcements[0].text).toContain('에이');
    expect(list.announcements[0].text).toContain('리치');
    // after 로 새 것만
    const none = (await call('tokB', 'GET', `/api/announcements?after=${list.latest}`)).json;
    expect(none.announcements).toEqual([]);
    expect(none.latest).toBe(list.latest);
  });
  it('최근 200개만 남긴다', async () => {
    await call('tokA', 'GET', '/api/me');
    const ins = sqlite.prepare("INSERT INTO announcements (kind, text, created_at) VALUES ('boss', 'x', 1)");
    for (let i = 0; i < 205; i++) ins.run();
    const { announceStmts } = await import('./announce');
    await env.DB.batch(announceStmts(env.DB, 'boss', '새 소식'));
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM announcements').get() as any).n).toBe(200);
    expect((await call('tokA', 'GET', '/api/announcements')).json.announcements.at(-1).text).toBe('새 소식');
  });
});

describe('유저 목록', () => {
  const visit = async () => { for (const t of ['tokA', 'tokB', 'tokC']) await call(t, 'GET', '/api/me'); };
  it('자기 자신을 뺀 접속 이력이 있는 유저를 접속 중인 사람 먼저 보여 준다', async () => {
    await visit();
    sqlite.prepare('UPDATE profiles SET last_seen = ? WHERE user_id = ?').run(Date.now() - 3_600_000, B.id);
    const r = (await call('tokA', 'GET', '/api/users')).json;
    expect(r).toMatchObject({ total: 2, online: 2, hasMore: false }); // A, C 접속 중
    expect(r.users.map((u: any) => u.nickname)).toEqual(['씨이', '비이']);
    expect(r.users[0]).toMatchObject({ online: true, relation: 'none', proficiency: 0 });
    expect(r.users[1].online).toBe(false);
    expect(JSON.stringify(r)).not.toContain('@x.com'); // 이메일은 내보내지 않는다
  });
  it('검색과 더 보기, 친구 관계 표시', async () => {
    await visit();
    for (let i = 0; i < 25; i++) sqlite.prepare('INSERT INTO profiles (user_id, nickname, username, last_seen) VALUES (?, ?, ?, ?)').run(`fill-${i}`, `채움${String(i).padStart(2, '0')}`, `f${i}`, 1000 + i);
    const page1 = (await call('tokA', 'GET', '/api/users')).json;
    expect(page1.users).toHaveLength(20);
    expect(page1.hasMore).toBe(true);
    expect(page1.total).toBe(27);
    const page2 = (await call('tokA', 'GET', '/api/users?offset=20')).json;
    expect(page2.users).toHaveLength(7);
    expect(page2.hasMore).toBe(false);
    expect((await call('tokA', 'GET', `/api/users?q=${encodeURIComponent('채움1')}`)).json.users.map((u: any) => u.nickname)).toEqual(expect.arrayContaining(['채움10', '채움19']));
    expect((await call('tokA', 'GET', '/api/users?q=%25')).json.users).toHaveLength(0); // 와일드카드 아님
    await call('tokA', 'POST', '/api/friends/request', { userId: B.id });
    await call('tokC', 'POST', '/api/friends/request', { userId: A.id });
    const rel = Object.fromEntries((await call('tokA', 'GET', `/api/users?q=${encodeURIComponent('비이')}`)).json.users.map((u: any) => [u.nickname, u.relation]));
    expect(rel).toEqual({ 비이: 'sent' });
    expect((await call('tokA', 'GET', `/api/users?q=${encodeURIComponent('씨이')}`)).json.users[0].relation).toBe('received');
    await call('tokB', 'POST', '/api/friends/accept', { userId: A.id });
    expect((await call('tokA', 'GET', `/api/users?q=${encodeURIComponent('비이')}`)).json.users[0].relation).toBe('friend');
  });
});
