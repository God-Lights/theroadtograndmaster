import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './index';
import { clearAuthCache } from './auth';
import { createTestDb } from './test-db';
import { RAID_BOSSES } from '@rtgm/data';
import { rollRaidRewards, RAID_ROUND_MS } from './raid';

const mk = (c: string, n: string) => ({ id: `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`, email: `${n}@x.com`, username: n, nickname: n, emailVerified: true });
const U = { A: mk('a', '에이'), B: mk('b', '비이'), C: mk('c', '씨이'), D: mk('d', '디이'), E: mk('e', '이이') };
const TOK: Record<string, string> = { A: 'tokA', B: 'tokB', C: 'tokC', D: 'tokD', E: 'tokE' };
const USERS: Record<string, ReturnType<typeof mk>> = Object.fromEntries(Object.entries(U).map(([k, v]) => [TOK[k]!, v]));
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

async function call(who: keyof typeof U, method: string, path: string, body?: unknown) {
  const res = await app.request(`https://rtgm.officialgl.com${path}`, { method, headers: { Cookie: `gl_session=${TOK[who]}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, env);
  return { status: res.status, json: (await res.json()) as any };
}
const ROLES = { A: 'tank', B: 'dealer', C: 'healer', D: 'support' } as const;
const setProf = (who: keyof typeof U, p: number) => sqlite.prepare('UPDATE characters SET proficiency = ? WHERE user_id = ?').run(p, U[who].id);
const row = (who: keyof typeof U) => sqlite.prepare('SELECT gold, proficiency FROM characters WHERE user_id = ?').get(U[who].id) as { gold: number; proficiency: number };
const room = (id: string) => sqlite.prepare('SELECT * FROM raid_rooms WHERE id = ?').get(id) as any;

/** 모두 접속·숙련도 부여 → 방 만들기 → 입장 → 역할 → 준비 → 시작 */
async function setup(who: (keyof typeof U)[] = ['A', 'B', 'C', 'D']) {
  for (const w of who) { await call(w, 'GET', '/api/me'); setProf(w, 2000); }
  const created = await call(who[0]!, 'POST', '/api/raid/create', { bossId: 'ankio' });
  const code = (await call(who[0]!, 'GET', '/api/raid')).json.room.code as string;
  for (const w of who.slice(1)) await call(w, 'POST', '/api/raid/join', { code });
  for (const w of who) { await call(w, 'POST', '/api/raid/role', { role: ROLES[w as 'A']}); await call(w, 'POST', '/api/raid/ready', { ready: true }); }
  const start = await call(who[0]!, 'POST', '/api/raid/start');
  return { id: created.json.id as string, code, start };
}
const view = async (w: keyof typeof U) => (await call(w, 'GET', '/api/raid')).json.room;
const patchState = (id: string, fn: (s: any) => void) => { const s = JSON.parse(room(id).state); fn(s); sqlite.prepare('UPDATE raid_rooms SET state = ? WHERE id = ?').run(JSON.stringify(s), id); };
const guardAll = async (who: (keyof typeof U)[]) => { let last: any; for (const w of who) last = await call(w, 'POST', '/api/raid/action', { action: 'guard' }); return last; };

describe('방 만들기·입장', () => {
  it('숙련도가 부족하면 만들거나 들어갈 수 없다', async () => {
    await call('A', 'GET', '/api/me'); await call('B', 'GET', '/api/me');
    expect((await call('A', 'POST', '/api/raid/create', { bossId: 'ankio' })).json).toMatchObject({ error: 'proficiency_too_low', required: 1800 });
    setProf('A', 2000);
    await call('A', 'POST', '/api/raid/create', { bossId: 'ankio' });
    const code = (await call('A', 'GET', '/api/raid')).json.room.code;
    expect((await call('B', 'POST', '/api/raid/join', { code })).json.error).toBe('proficiency_too_low');
    expect((await call('A', 'POST', '/api/raid/create', { bossId: 'nope' })).status).toBe(404);
  });
  it('코드로 입장하고, 정원 4명·중복 참여·없는 코드는 거절된다', async () => {
    for (const w of ['A', 'B', 'C', 'D', 'E'] as const) { await call(w, 'GET', '/api/me'); setProf(w, 2000); }
    await call('A', 'POST', '/api/raid/create', { bossId: 'ankio' });
    const code = (await call('A', 'GET', '/api/raid')).json.room.code;
    for (const w of ['B', 'C', 'D'] as const) expect((await call(w, 'POST', '/api/raid/join', { code: code.toLowerCase() })).status).toBe(200);
    expect((await call('E', 'POST', '/api/raid/join', { code })).json.error).toBe('room_full');
    expect((await call('B', 'POST', '/api/raid/join', { code })).json.error).toBe('already_in_raid');
    expect((await call('A', 'POST', '/api/raid/create', { bossId: 'ankio' })).json.error).toBe('already_in_raid');
    expect((await call('E', 'POST', '/api/raid/join', { code: 'ZZZZZZ' })).status).toBe(404);
    expect((await view('A')).members).toHaveLength(4);
  });
  it('친구가 연 방이 목록에 보인다', async () => {
    for (const w of ['A', 'B'] as const) { await call(w, 'GET', '/api/me'); setProf(w, 2000); }
    await call('A', 'POST', '/api/friends/request', { userId: U.B.id }); await call('B', 'POST', '/api/friends/accept', { userId: U.A.id });
    await call('A', 'POST', '/api/raid/create', { bossId: 'ankio' });
    expect((await call('B', 'GET', '/api/raid')).json.friendRooms).toMatchObject([{ leader: '에이', members: 1 }]);
  });
});

describe('역할·준비·시작', () => {
  it('역할은 겹칠 수 없고, 바꾸면 준비가 풀린다', async () => {
    for (const w of ['A', 'B'] as const) { await call(w, 'GET', '/api/me'); setProf(w, 2000); }
    await call('A', 'POST', '/api/raid/create', { bossId: 'ankio' });
    await call('B', 'POST', '/api/raid/join', { code: (await call('A', 'GET', '/api/raid')).json.room.code });
    expect((await call('A', 'POST', '/api/raid/ready', { ready: true })).json.error).toBe('role_required');
    expect((await call('A', 'POST', '/api/raid/role', { role: 'tank' })).status).toBe(200);
    expect((await call('B', 'POST', '/api/raid/role', { role: 'tank' })).json.error).toBe('role_taken');
    expect((await call('B', 'POST', '/api/raid/role', { role: 'wizard' })).status).toBe(400);
    await call('A', 'POST', '/api/raid/ready', { ready: true });
    await call('A', 'POST', '/api/raid/role', { role: 'dealer' });
    expect((await view('A')).members.find((m: any) => m.userId === U.A.id)).toMatchObject({ role: 'dealer', ready: false });
  });
  it('시작 조건: 방장만, 2명 이상, 모두 역할·준비 완료', async () => {
    for (const w of ['A', 'B'] as const) { await call(w, 'GET', '/api/me'); setProf(w, 2000); }
    await call('A', 'POST', '/api/raid/create', { bossId: 'ankio' });
    await call('A', 'POST', '/api/raid/role', { role: 'tank' });
    expect((await call('A', 'POST', '/api/raid/start')).json.error).toBe('party_too_small');
    await call('B', 'POST', '/api/raid/join', { code: (await call('A', 'GET', '/api/raid')).json.room.code });
    expect((await call('A', 'POST', '/api/raid/start')).json.error).toBe('not_ready'); // B 역할 없음
    await call('B', 'POST', '/api/raid/role', { role: 'healer' });
    expect((await call('A', 'POST', '/api/raid/start')).json.error).toBe('not_ready'); // B 준비 안 함
    expect((await call('B', 'POST', '/api/raid/start')).json.error).toBe('not_allowed');
    await call('B', 'POST', '/api/raid/ready', { ready: true });
    expect((await call('A', 'POST', '/api/raid/start')).status).toBe(200);
    expect((await call('A', 'POST', '/api/raid/start')).status).toBe(400); // 이미 시작
  });
  it('방장이 나가면 다음 사람이 방장이 되고, 마지막이 나가면 방이 사라진다', async () => {
    for (const w of ['A', 'B'] as const) { await call(w, 'GET', '/api/me'); setProf(w, 2000); }
    const { json } = await call('A', 'POST', '/api/raid/create', { bossId: 'ankio' });
    await call('B', 'POST', '/api/raid/join', { code: (await call('A', 'GET', '/api/raid')).json.room.code });
    await call('A', 'POST', '/api/raid/leave');
    expect((await view('B')).leaderId).toBe(U.B.id);
    expect((await view('A'))).toBeNull();
    await call('B', 'POST', '/api/raid/leave');
    expect(room(json.id)).toBeUndefined();
  });
});

describe('전투 진행', () => {
  it('시작하면 슬롯이 배정되고 보스 HP는 파티 크기로 조정된다', async () => {
    const { start } = await setup();
    expect(start.status).toBe(200);
    const v = await view('A');
    expect(v).toMatchObject({ status: 'active', mySlot: 'p1', myRole: 'tank', round: 1, needsAction: true });
    expect(v.state.combatants).toHaveLength(5);
    expect(v.state.combatants.find((c: any) => c.id === 'enemy').stats.maxHp).toBe(RAID_BOSSES.ankio!.hp);
    expect(Object.keys(v.skills)).toEqual(['r_taunt', 'r_bash', 'r_ironwall', 'r_guardian', 'r_fortress']);
    expect(JSON.stringify(v)).not.toContain('rngSeed');
  });
  it('모두 내면 한꺼번에 처리되고, 다른 사람의 선택 내용은 보이지 않는다', async () => {
    await setup();
    await call('A', 'POST', '/api/raid/action', { action: 'attack' });
    const b = await view('B');
    expect(b.members.find((m: any) => m.userId === U.A.id)).toMatchObject({ submitted: true });
    expect(JSON.stringify(b)).not.toContain('"action"');
    expect((await call('A', 'POST', '/api/raid/action', { action: 'guard' })).json.error).toBe('already_submitted');
    await call('B', 'POST', '/api/raid/action', { action: 'skill', skillId: 'r_strike' });
    await call('C', 'POST', '/api/raid/action', { action: 'skill', skillId: 'r_heal', targetId: 'p1' });
    const last = await call('D', 'POST', '/api/raid/action', { action: 'skill', skillId: 'r_analyze' });
    expect(last.json.round).toBe(2);
    expect(last.json.log.length).toBeGreaterThan(3);
    expect((await view('A')).members.every((m: any) => m.submitted === false)).toBe(true);
  });
  it('행동 검증: 내 역할 밖 스킬·없는 대상·아이템은 거절', async () => {
    await setup();
    expect((await call('A', 'POST', '/api/raid/action', { action: 'skill', skillId: 'r_strike' })).json.error).toBe('unknown_skill'); // 딜러 스킬
    expect((await call('C', 'POST', '/api/raid/action', { action: 'skill', skillId: 'r_heal', targetId: 'p9' })).json.error).toBe('invalid_target');
    expect((await call('B', 'POST', '/api/raid/action', { action: 'attack', targetId: 'p1' })).json.error).toBe('invalid_target'); // 아군 공격 불가
    expect((await call('B', 'POST', '/api/raid/action', { action: 'item', itemId: 'hp_potion' })).json.error).toBe('invalid_action');
    expect((await call('E', 'POST', '/api/raid/action', { action: 'guard' })).status).toBe(400); // 참가자 아님
  });
  it('제한 시간이 지나면 방어로 처리하고, 3회 연속 안 내면 쓰러진 것으로 본다', async () => {
    const { id } = await setup();
    for (let i = 0; i < 3; i++) {
      patchState(id, (st) => { for (const c of st.combatants) if (c.side === 'player') c.hp = c.stats.maxHp; }); // 보스에게 쓰러지지 않게 유지
      for (const w of ['B', 'C', 'D'] as const) await call(w, 'POST', '/api/raid/action', { action: 'guard' }); // A 만 안 낸다
      sqlite.prepare('UPDATE raid_rooms SET deadline = 1 WHERE id = ?').run(id);
      await view('B');
    }
    const v = await view('B');
    expect(v.state.combatants.find((c: any) => c.id === 'p1').hp).toBe(0); // 미제출 3회로 쓰러짐
    expect(v.members.find((m: any) => m.userId === U.A.id).miss).toBe(3);
    expect(v.status).toBe('active'); // 나머지가 계속 싸운다
  });
});

describe('결과와 보상', () => {
  it('승리하면 파티원 모두 보상을 한 번만 받는다', async () => {
    const { id } = await setup();
    patchState(id, (s) => { s.combatants.find((c: any) => c.id === 'enemy').hp = 1; });
    const before = Object.fromEntries((['A', 'B', 'C', 'D'] as const).map((w) => [w, row(w)]));
    await call('A', 'POST', '/api/raid/action', { action: 'guard' });
    await call('C', 'POST', '/api/raid/action', { action: 'guard' });
    await call('D', 'POST', '/api/raid/action', { action: 'guard' });
    const r = await call('B', 'POST', '/api/raid/action', { action: 'skill', skillId: 'r_strike' });
    expect(r.json).toMatchObject({ status: 'done', result: 'victory' });
    for (const w of ['A', 'B', 'C', 'D'] as const) {
      const after = row(w);
      expect(after.gold).toBeGreaterThanOrEqual(before[w]!.gold + 1500);
      expect(after.proficiency).toBe(before[w]!.proficiency + 120);
      expect((await view(w)).members.find((m: any) => m.userId === U[w].id).rewards.items.map((i: any) => i.itemId)).toContain('ankio_feather'); // 깃털은 100%
    }
    await view('A'); await view('B');
    expect(row('A').proficiency).toBe(before.A!.proficiency + 120); // 중복 지급 없음
    expect((sqlite.prepare("SELECT quantity FROM inventory WHERE user_id = ? AND item_id = 'ankio_feather'").get(U.A.id) as any).quantity).toBe(1);
  });
  it('전멸하면 패배: 골드 없이 소량의 숙련도만', async () => {
    const { id } = await setup();
    patchState(id, (s) => {
      for (const c of s.combatants) if (c.side === 'player') c.hp = 1;
      s.intents.enemy = { patternId: 'radiance', kind: 'attack', name: '성광', telegraph: '' };
    });
    const g0 = row('A').gold, p0 = row('A').proficiency;
    const r = await guardAll(['A', 'B', 'C', 'D']);
    expect(r.json).toMatchObject({ status: 'done', result: 'defeat' });
    expect(row('A')).toEqual({ gold: g0, proficiency: p0 + RAID_BOSSES.ankio!.profLose });
  });
  it('자리를 비운 사람은 보상을 받지 못한다', async () => {
    const { id } = await setup();
    sqlite.prepare('UPDATE raid_members SET miss = 2 WHERE room_id = ? AND user_id = ?').run(id, U.D.id);
    patchState(id, (s) => { s.combatants.find((c: any) => c.id === 'enemy').hp = 1; });
    const d0 = row('D');
    await call('A', 'POST', '/api/raid/action', { action: 'guard' });
    await call('C', 'POST', '/api/raid/action', { action: 'guard' });
    await call('B', 'POST', '/api/raid/action', { action: 'skill', skillId: 'r_strike' });
    sqlite.prepare('UPDATE raid_rooms SET deadline = 1 WHERE id = ?').run(id);
    const v = await view('B');
    expect(v.result).toBe('victory');
    expect(row('D')).toEqual(d0);
    expect(row('B').proficiency).toBeGreaterThan(2000);
  });
  it('끝난 뒤 나가면 새 방을 만들 수 있다', async () => {
    const { id } = await setup();
    patchState(id, (s) => { s.combatants.find((c: any) => c.id === 'enemy').hp = 1; });
    await guardAll(['A', 'C', 'D']);
    await call('B', 'POST', '/api/raid/action', { action: 'attack' });
    expect(room(id).status).toBe('done');
    expect((await call('A', 'POST', '/api/raid/create', { bossId: 'ankio' })).status).toBe(200); // 결과 화면을 건너뛰고 새 방
    expect((await view('A')).status).toBe('lobby');
  });
  it('보상 굴림은 시드로 재현되고 이벤트 배율이 적용된다', () => {
    const b = RAID_BOSSES.ankio!;
    expect(rollRaidRewards(b, 5, true)).toEqual(rollRaidRewards(b, 5, true));
    expect(rollRaidRewards(b, 5, true, { gold: 2, proficiency: 2 }).proficiency).toBe(b.profWin * 2);
    expect(rollRaidRewards(b, 5, false)).toEqual({ gold: 0, proficiency: b.profLose, items: [] });
    expect(RAID_ROUND_MS).toBe(60_000);
  });
});
