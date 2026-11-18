import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './index';
import { clearAuthCache } from './auth';
import { createTestDb } from './test-db';
import { RAID_BOSSES, raidBossHp } from '@rtgm/data';
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
  const created = await call(who[0]!, 'POST', '/api/raid/create', { bossId: 'dragon' });
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
    expect((await call('A', 'POST', '/api/raid/create', { bossId: 'dragon' })).json).toMatchObject({ error: 'proficiency_too_low', required: 1000 });
    setProf('A', 2000);
    await call('A', 'POST', '/api/raid/create', { bossId: 'dragon' });
    const code = (await call('A', 'GET', '/api/raid')).json.room.code;
    expect((await call('B', 'POST', '/api/raid/join', { code })).json.error).toBe('proficiency_too_low');
    expect((await call('A', 'POST', '/api/raid/create', { bossId: 'nope' })).status).toBe(404);
  });
  it('코드로 입장하고, 정원 4명·중복 참여·없는 코드는 거절된다', async () => {
    for (const w of ['A', 'B', 'C', 'D', 'E'] as const) { await call(w, 'GET', '/api/me'); setProf(w, 2000); }
    await call('A', 'POST', '/api/raid/create', { bossId: 'dragon' });
    const code = (await call('A', 'GET', '/api/raid')).json.room.code;
    for (const w of ['B', 'C', 'D'] as const) expect((await call(w, 'POST', '/api/raid/join', { code: code.toLowerCase() })).status).toBe(200);
    expect((await call('E', 'POST', '/api/raid/join', { code })).json.error).toBe('room_full');
    expect((await call('B', 'POST', '/api/raid/join', { code })).json.error).toBe('already_in_raid');
    expect((await call('A', 'POST', '/api/raid/create', { bossId: 'dragon' })).json.error).toBe('already_in_raid');
    expect((await call('E', 'POST', '/api/raid/join', { code: 'ZZZZZZ' })).status).toBe(404);
    expect((await view('A')).members).toHaveLength(4);
  });
  it('친구가 연 방이 목록에 보인다', async () => {
    for (const w of ['A', 'B'] as const) { await call(w, 'GET', '/api/me'); setProf(w, 2000); }
    await call('A', 'POST', '/api/friends/request', { userId: U.B.id }); await call('B', 'POST', '/api/friends/accept', { userId: U.A.id });
    await call('A', 'POST', '/api/raid/create', { bossId: 'dragon' });
    expect((await call('B', 'GET', '/api/raid')).json.friendRooms).toMatchObject([{ leader: '에이', members: 1 }]);
  });
});

describe('역할·준비·시작', () => {
  it('역할은 겹칠 수 없고, 바꾸면 준비가 풀린다', async () => {
    for (const w of ['A', 'B'] as const) { await call(w, 'GET', '/api/me'); setProf(w, 2000); }
    await call('A', 'POST', '/api/raid/create', { bossId: 'dragon' });
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
    await call('A', 'POST', '/api/raid/create', { bossId: 'dragon' });
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
    const { json } = await call('A', 'POST', '/api/raid/create', { bossId: 'dragon' });
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
    expect(v.state.combatants.find((c: any) => c.id === 'enemy').stats.maxHp).toBe(raidBossHp('dragon', 4));
    expect(Object.keys(v.skills)).toEqual(['r_taunt', 'r_bash', 'r_ironwall', 'r_guardian', 'r_fortress']);
    expect(JSON.stringify(v)).not.toContain('rngSeed');
  });
  it('별 등급: 1★ 드래곤(최대 4·적정 2) / 3★ 백카리오(4·3) / 5★ 안키오(8·6)', () => {
    const r = RAID_BOSSES;
    expect([r.dragon, r.baekkario, r.ankio].map((b) => [b!.star, b!.maxParty, b!.recParty])).toEqual([[1, 4, 2], [3, 4, 3], [5, 8, 6]]);
    expect(raidBossHp('ankio', 6)).toBe(r.ankio!.hp); // 적정 인원이 기본 HP
    expect(raidBossHp('ankio', 8)).toBeGreaterThan(raidBossHp('ankio', 6));
    expect(raidBossHp('ankio', 2)).toBeLessThan(raidBossHp('ankio', 6));
    expect(raidBossHp('dragon', 2)).toBe(r.dragon!.hp);
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

describe('8인 레이드 (안키오)', () => {
  const ALL = ['A', 'B', 'C', 'D', 'E'] as const;
  it('최대 8명까지 들어오고, 역할은 둘까지 겹칠 수 있다', async () => {
    const extra = Array.from({ length: 3 }, (_, i) => `f${i}`);
    for (const w of ALL) { await call(w, 'GET', '/api/me'); setProf(w, 2000); }
    // 가짜 파티원 3명을 DB에 직접 넣는다 (방장 포함 4명 → B·C·D·E 입장으로 8명)
    await call('A', 'POST', '/api/raid/create', { bossId: 'ankio' });
    const info = (await call('A', 'GET', '/api/raid')).json.room;
    expect(info).toMatchObject({ maxParty: 8, recParty: 6, star: 5, roleCap: 2 });
    for (const [i, id] of extra.entries()) {
      const uid = `${String(i + 1).repeat(8)}-1111-4111-8111-111111111111`;
      sqlite.prepare('INSERT INTO raid_members (room_id, user_id, joined_at) VALUES (?, ?, ?)').run(info.id, uid, i + 1);
    }
    for (const w of ['B', 'C', 'D'] as const) expect((await call(w, 'POST', '/api/raid/join', { code: info.code })).status).toBe(200); // 5~7번째
    expect((await call('E', 'POST', '/api/raid/join', { code: info.code })).status).toBe(200); // 8번째
    expect((await call('E', 'POST', '/api/raid/role', { role: 'dealer' })).status).toBe(200);
    expect((await call('D', 'POST', '/api/raid/role', { role: 'dealer' })).status).toBe(200); // 둘째 딜러
    expect((await call('C', 'POST', '/api/raid/role', { role: 'dealer' })).json.error).toBe('role_taken'); // 셋째는 불가
    expect((await call('B', 'POST', '/api/raid/role', { role: 'tank' })).status).toBe(200);
    expect((await call('C', 'POST', '/api/raid/role', { role: 'tank' })).status).toBe(200);
    expect((await call('A', 'POST', '/api/raid/role', { role: 'tank' })).json.error).toBe('role_taken');
  });
  it('4인 레이드(드래곤)는 역할이 하나씩만, 정원은 4명', async () => {
    for (const w of ['A', 'B', 'C', 'D', 'E'] as const) { await call(w, 'GET', '/api/me'); setProf(w, 2000); }
    await call('A', 'POST', '/api/raid/create', { bossId: 'dragon' });
    const code = (await call('A', 'GET', '/api/raid')).json.room.code;
    await call('B', 'POST', '/api/raid/join', { code });
    await call('A', 'POST', '/api/raid/role', { role: 'tank' });
    expect((await call('B', 'POST', '/api/raid/role', { role: 'tank' })).json.error).toBe('role_taken');
    expect((await call('A', 'GET', '/api/raid')).json.room).toMatchObject({ maxParty: 4, roleCap: 1 });
  });
  it('로비 목록은 별 등급 순으로, 별·인원 정보를 함께 준다', async () => {
    await call('A', 'GET', '/api/me');
    const bosses = (await call('A', 'GET', '/api/raid')).json.bosses;
    expect(bosses.map((b: any) => [b.id, b.star, b.maxParty, b.recParty])).toEqual([['dragon', 1, 4, 2], ['baekkario', 3, 4, 3], ['ankio', 5, 8, 6]]);
  });
});

describe('대기시간', () => {
  const cd = (w: keyof typeof U, boss = 'dragon') => sqlite.prepare('SELECT until FROM raid_cooldowns WHERE user_id = ? AND boss_id = ?').get(U[w].id, boss) as { until: number } | undefined;
  const win = async (id: string) => {
    patchState(id, (st) => { st.combatants.find((c: any) => c.id === 'enemy').hp = 1; });
    await guardAll(['A', 'C', 'D']);
    await call('B', 'POST', '/api/raid/action', { action: 'attack' });
  };
  it('끝나면 보스별 대기시간이 모든 파티원에게 걸리고, 승리는 전체·패배는 절반이다', async () => {
    const { id } = await setup();
    const t0 = Date.now();
    await win(id);
    const min = RAID_BOSSES.dragon!.cooldownMinutes * 60_000;
    for (const w of ['A', 'B', 'C', 'D'] as const) expect(cd(w)!.until).toBeGreaterThanOrEqual(t0 + min - 1000);
    expect(cd('A', 'ankio')).toBeUndefined(); // 다른 보스는 영향 없음
    const lobby = (await call('A', 'GET', '/api/raid')).json;
    expect(Object.keys(lobby.cooldowns)).toEqual(['dragon']);
  });
  it('패배하면 대기시간이 절반', async () => {
    const { id } = await setup();
    patchState(id, (st) => {
      for (const c of st.combatants) if (c.side === 'player') c.hp = 1;
      st.intents.enemy = { patternId: 'breath', kind: 'attack', name: '화염 숨결', telegraph: '' };
    });
    const t0 = Date.now();
    await guardAll(['A', 'B', 'C', 'D']);
    const want = RAID_BOSSES.dragon!.cooldownMinutes * 60_000 * 0.5;
    const until = cd('A')!.until;
    expect(until).toBeGreaterThanOrEqual(t0 + want - 1000);
    expect(until).toBeLessThan(t0 + want + 5000);
  });
  it('대기시간 중에는 만들기·입장이 막히고, 지나면 다시 된다. 다른 보스는 바로 가능', async () => {
    for (const w of ['A', 'B'] as const) { await call(w, 'GET', '/api/me'); setProf(w, 2000); }
    sqlite.prepare('INSERT INTO raid_cooldowns (user_id, boss_id, until) VALUES (?, ?, ?)').run(U.A.id, 'dragon', Date.now() + 60_000);
    const blocked = await call('A', 'POST', '/api/raid/create', { bossId: 'dragon' });
    expect(blocked.status).toBe(429);
    expect(blocked.json.until).toBeGreaterThan(Date.now());
    await call('B', 'POST', '/api/raid/create', { bossId: 'dragon' });
    const code = (await call('B', 'GET', '/api/raid')).json.room.code;
    expect((await call('A', 'POST', '/api/raid/join', { code })).json.error).toBe('raid_cooldown');
    expect((await call('A', 'POST', '/api/raid/create', { bossId: 'baekkario' })).status).toBe(200);
    sqlite.prepare('UPDATE raid_cooldowns SET until = ? WHERE user_id = ?').run(Date.now() - 1, U.A.id);
    await call('A', 'POST', '/api/raid/leave');
    expect((await call('A', 'POST', '/api/raid/join', { code })).status).toBe(200);
    expect((await call('A', 'GET', '/api/raid')).json.cooldowns).toEqual({});
  });
  it('대기실은 30분이 지나면 사라진다', async () => {
    for (const w of ['A', 'B'] as const) { await call(w, 'GET', '/api/me'); setProf(w, 2000); }
    const { json } = await call('A', 'POST', '/api/raid/create', { bossId: 'dragon' });
    const code = (await call('A', 'GET', '/api/raid')).json.room.code;
    sqlite.prepare('UPDATE raid_rooms SET created_at = ? WHERE id = ?').run(Date.now() - 31 * 60_000, json.id);
    expect((await call('B', 'POST', '/api/raid/join', { code })).status).toBe(404);
    expect((await call('A', 'GET', '/api/raid')).json.room).toBeNull();
    expect(room(json.id)).toBeUndefined();
  });
  it('시작한 레이드는 30분이 지나도 사라지지 않는다', async () => {
    const { id } = await setup();
    sqlite.prepare('UPDATE raid_rooms SET created_at = ? WHERE id = ?').run(Date.now() - 90 * 60_000, id);
    await call('A', 'GET', '/api/raid');
    expect(room(id).status).toBe('active');
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
      expect(after.gold).toBeGreaterThanOrEqual(before[w]!.gold + RAID_BOSSES.dragon!.gold[0]);
      expect(after.proficiency).toBe(before[w]!.proficiency + RAID_BOSSES.dragon!.profWin);
      expect((await view(w)).members.find((m: any) => m.userId === U[w].id).rewards.items.map((i: any) => i.itemId)).toContain('dragon_scale'); // 비늘은 100%
    }
    await view('A'); await view('B');
    expect(row('A').proficiency).toBe(before.A!.proficiency + RAID_BOSSES.dragon!.profWin); // 중복 지급 없음
    expect((sqlite.prepare("SELECT quantity FROM inventory WHERE user_id = ? AND item_id = 'dragon_scale'").get(U.A.id) as any).quantity).toBe(1);
  });
  it('전멸하면 패배: 골드 없이 소량의 숙련도만', async () => {
    const { id } = await setup();
    patchState(id, (s) => {
      for (const c of s.combatants) if (c.side === 'player') c.hp = 1;
      s.intents.enemy = { patternId: 'breath', kind: 'attack', name: '화염 숨결', telegraph: '' };
    });
    const g0 = row('A').gold, p0 = row('A').proficiency;
    const r = await guardAll(['A', 'B', 'C', 'D']);
    expect(r.json).toMatchObject({ status: 'done', result: 'defeat' });
    expect(row('A')).toEqual({ gold: g0, proficiency: p0 + RAID_BOSSES.dragon!.profLose });
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
    expect((await call('A', 'POST', '/api/raid/create', { bossId: 'dragon' })).json).toMatchObject({ error: 'raid_cooldown' }); // 대기시간 중
    sqlite.prepare('DELETE FROM raid_cooldowns').run();
    expect((await call('A', 'POST', '/api/raid/create', { bossId: 'dragon' })).status).toBe(200); // 결과 화면을 건너뛰고 새 방
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
