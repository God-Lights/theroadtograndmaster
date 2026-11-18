import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './index';
import { clearAuthCache } from './auth';
import { createTestDb } from './test-db';
import commands from './bot/commands.json';

const mk = (c: string, n: string) => ({ id: `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`, email: `${n}@x.com`, username: n, nickname: n, emailVerified: true });
const A = mk('a', '에이'), B = mk('b', '비이');
const USERS: Record<string, ReturnType<typeof mk>> = { tokA: A, tokB: B };
const DA = '123456789012345678', DBB = '223456789012345678';
const KEY = 'bot-key';
let env: Record<string, any>;
let sqlite: ReturnType<typeof createTestDb>['sqlite'];
let priv: CryptoKey;
/** 디스코드로 나간 전체 공개 메시지 (웹훅 후속 메시지) */
let hooks: { url: string; body: any }[] = [];

const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
beforeEach(async () => {
  clearAuthCache();
  hooks = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string, init: { body: string }) => {
    if (String(u).includes('discord.com/api')) { hooks.push({ url: String(u), body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); }
    const user = USERS[JSON.parse(init.body).token as string];
    return user ? new Response(JSON.stringify({ user }), { status: 200 }) : new Response('{}', { status: 401 });
  }));
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' } as never, true, ['sign', 'verify'])) as CryptoKeyPair;
  priv = pair.privateKey;
  const t = createTestDb(); sqlite = t.sqlite;
  env = { GL_ACCOUNT_KEY: 'k', BOT_API_KEY: KEY, ADMIN_USER_IDS: A.id, DISCORD_PUBLIC_KEY: toHex((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer), DB: t.db, ASSETS: { fetch: vi.fn() } };
});
afterEach(() => vi.unstubAllGlobals());

async function interact(rawPayload: object) {
  const body = JSON.stringify({ application_id: 'app1', token: 'tok-abc', guild_id: '1572492493604397110', channel_id: '1572492730641420389', ...rawPayload });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await crypto.subtle.sign({ name: 'Ed25519' } as never, priv, new TextEncoder().encode(ts + body));
  const res = await app.request('https://rtgm.officialgl.com/discord/interactions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': toHex(sig), 'X-Signature-Timestamp': ts }, body }, env);
  return { status: res.status, json: (await res.json()) as any };
}
const slash = (name: string, options: Record<string, unknown> = {}, uid = DA) =>
  interact({ type: 2, member: { user: { id: uid } }, data: { name, options: Object.entries(options).map(([k, v]) => ({ name: k, value: v })) } });
const press = (custom_id: string, values?: string[], uid = DA) => interact({ type: 3, member: { user: { id: uid } }, data: { custom_id, values } });
const auto = (name: string, optName: string, value: string, uid = DA) => interact({ type: 4, user: { id: uid }, data: { name, options: [{ name: optName, value, focused: true }] } });
async function web(token: string, method: string, path: string, body?: unknown) {
  const res = await app.request(`https://rtgm.officialgl.com${path}`, { method, headers: { Cookie: `gl_session=${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, env);
  return { status: res.status, json: (await res.json()) as any };
}
async function linkBoth() {
  for (const [tok, did] of [['tokA', DA], ['tokB', DBB]] as const) {
    await web(tok, 'GET', '/api/me');
    const { json } = await web(tok, 'POST', '/api/discord/link-code');
    expect((await slash('연동', { 코드: json.code }, did)).json.data.embeds[0].title).toContain('연동 완료');
  }
}
const text = (r: any) => JSON.stringify(r.json.data?.embeds ?? []);
const ids = (r: any): string[] => (r.json.data.components ?? []).flatMap((row: any) => row.components.map((c: any) => c.custom_id));
const options = (r: any, id: string): string[] => (r.json.data.components ?? []).flatMap((row: any) => row.components).find((c: any) => c.custom_id === id)?.options?.map((o: any) => o.value) ?? [];
const setProf = (id: string, p: number) => sqlite.prepare('UPDATE characters SET proficiency = ? WHERE user_id = ?').run(p, id);
const setGold = (id: string, g: number) => sqlite.prepare('UPDATE characters SET gold = ? WHERE user_id = ?').run(g, id);

beforeEach(async () => { await linkBoth(); });

describe('봇: 레이드', () => {
  it('로비 → 방 만들기 → 입장 → 역할·준비 → 시작 → 전투 행동 (힐러는 아군 대상 선택)', async () => {
    setProf(A.id, 2000); setProf(B.id, 2000);
    const lobby = await slash('레이드');
    expect(text(lobby)).toContain('드래곤');
    expect(options(lobby, 'ra:c')).toEqual(['slime_king', 'dragon', 'baekkario', 'ankio']);
    const room = await press('ra:c', ['dragon']);
    expect(room.json.type).toBe(7);
    const code = /\*\*([A-Z0-9]{6})\*\*/.exec(text(room))![1]!;
    expect(options(room, 'ra:r')).toEqual(['tank', 'dealer', 'healer', 'support']);
    expect(text(await slash('레이드입장', { 코드: code }, DBB))).toContain('대기실');
    await press('ra:r', ['dealer']);
    await press('ra:r', ['healer'], DBB);
    expect(options(await slash('레이드', {}, DBB), 'ra:r')).not.toContain('dealer'); // 정원 찬 역할은 목록에서 빠진다
    await press('ra:y', undefined, DBB); // 준비
    const started = await press('ra:s');
    expect(started.json.data.embeds[0].title).toContain('드래곤');
    expect(ids(started).some((x) => x.startsWith('ra:a:'))).toBe(true);
    const bs = ids(started).includes('ra:k');
    expect(bs).toBe(true);
    // 딜러(A): 공격 → 제출 완료 안내
    const act = await press(ids(started).find((x) => x.startsWith('ra:a:'))!);
    expect(act.json.data.embeds[0].description).toContain('선택 완료');
    // 힐러(B): 치유 선택 → 대상 아군 메뉴 → 선택하면 제출되고 라운드가 넘어간다
    const hb = await slash('레이드', {}, DBB);
    expect(options(hb, 'ra:k')).toContain('r_heal');
    const pick = await press('ra:k', ['r_heal'], DBB);
    expect(ids(pick)).toContain('ra:t:r_heal');
    expect(options(pick, 'ra:t:r_heal').length).toBe(2);
    const done = await press('ra:t:r_heal', [options(pick, 'ra:t:r_heal')[0]!], DBB);
    expect(done.json.data.embeds[0].title).toContain('2라운드');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM raid_members WHERE action IS NOT NULL').get()).toEqual({ n: 0 }); // 한 라운드 처리됨
  });
  it('레이드 클리어 결과는 파티 이름·보상과 함께 전체 공개된다', async () => {
    setProf(A.id, 2000); setProf(B.id, 2000);
    const room = await press('ra:c', ['dragon']);
    const code = /\*\*([A-Z0-9]{6})\*\*/.exec(text(room))![1]!;
    await slash('레이드입장', { 코드: code }, DBB);
    await press('ra:r', ['dealer']); await press('ra:r', ['healer'], DBB);
    await press('ra:y', undefined, DBB);
    const started = await press('ra:s');
    const rid = (sqlite.prepare('SELECT id FROM raid_rooms').get() as any).id;
    const st = JSON.parse((sqlite.prepare('SELECT state FROM raid_rooms WHERE id = ?').get(rid) as any).state);
    st.combatants.find((c: any) => c.id === 'enemy').hp = 1;
    sqlite.prepare('UPDATE raid_rooms SET state = ? WHERE id = ?').run(JSON.stringify(st), rid);
    await press('ra:g', undefined, DBB);
    const fin = await press(ids(started).find((x) => x.startsWith('ra:a:'))!);
    expect(JSON.stringify(fin.json.data.embeds)).toContain('레이드 성공');
    expect(hooks).toHaveLength(1);
    const e = hooks[0]!.body.embeds[0];
    expect(e.title).toContain('드래곤');
    expect(e.title).toContain('클리어');
    expect(e.description).toContain('에이');
    expect(e.description).toContain('비이');
    expect(e.description).toContain('🎁');
    await press('ra:f', undefined, DBB);
    expect(hooks).toHaveLength(1);
  });
  it('숙련도·대기시간·없는 방은 안내', async () => {
    expect(options(await slash('레이드'), 'ra:c')).toEqual(['slime_king']); // 숙련도가 낮으면 입문 레이드만 고를 수 있다
    expect(text(await slash('레이드입장', { 코드: 'ZZZZZZ' }))).toContain('방이 없거나');
  });
});

describe('봇: PvP 1v1', () => {
  it('랭크 대기열 → 매칭 → 행동 → 라운드 처리, 랭킹', async () => {
    const lobby = await slash('대전');
    expect(ids(lobby)).toContain('pv:q');
    expect(text(await press('pv:q'))).toContain('상대를 찾는 중');
    const matched = await press('pv:q', undefined, DBB);
    expect(matched.json.data.embeds[0].title).toContain('랭크전 vs');
    expect(ids(matched)).toEqual(expect.arrayContaining(['pv:g', 'pv:k', 'pv:f']));
    const a = await press('pv:g');
    expect(a.json.data.embeds[0].description).toContain('선택 완료');
    const b = await press(ids(matched).find((x) => x.startsWith('pv:a:'))!, undefined, DBB);
    expect(b.json.data.embeds[0].title).toContain('2라운드');
    const refresh = await press('pv:f');
    expect(refresh.json.data.embeds[0].title).toContain('2라운드');
    sqlite.prepare("UPDATE pvp_matches SET state = json_set(state, '$.combatants[1].hp', 1)").run();
    await press('pv:g', undefined, DBB);
    const fin = await press(ids(refresh).find((x) => x.startsWith('pv:a:'))!);
    expect(fin.json.data.embeds[0].description).toMatch(/승리|패배/);
    expect(text(await slash('랭킹'))).toContain('PvP 1v1');
    // 전체 공개: 끝난 결과는 한 번만, 승자 문구로 올라간다 (패자가 새로고침해도 중복 없음)
    await press('pv:f', undefined, DBB);
    await slash('대전', {}, DBB);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.body.flags).toBeUndefined();
    expect(hooks[0]!.body.embeds[0].title).toMatch(/님이 .*님을 이겼다/);
    expect(hooks[0]!.body.embeds[0].description).toContain('랭크전');
  });
  it('친구에게 도전 → 상대가 수락', async () => {
    await web('tokA', 'POST', '/api/friends/request', { userId: B.id });
    await web('tokB', 'POST', '/api/friends/accept', { userId: A.id });
    const choices = (await auto('도전', '유저', '비이')).json.data.choices;
    expect(choices).toEqual([expect.objectContaining({ value: B.id })]);
    expect(text(await slash('도전', { 유저: B.id }))).toContain('도전장을 보냈어요');
    const lobby = await slash('대전', {}, DBB);
    expect(ids(lobby)).toContain('pv:ac');
    const accepted = await press('pv:ac', options(lobby, 'pv:ac'), DBB);
    expect(accepted.json.data.embeds[0].title).toContain('친선전');
  });
});

describe('봇: 4v4 팀전', () => {
  it('친선 방: 만들기 → 입장 → 팀·역할·준비 → 시작 → 행동', async () => {
    const home = await slash('팀전');
    expect(ids(home)).toEqual(expect.arrayContaining(['tm:q', 'tm:c']));
    const room = await press('tm:c');
    const code = /\*\*([A-Z0-9]{6})\*\*/.exec(text(room))![1]!;
    expect(text(await slash('팀입장', { 코드: code }, DBB))).toContain('친선 방');
    await press('tm:r', ['tank']);
    const b = await press('tm:r', ['dealer'], DBB);
    expect(options(b, 'tm:r')).toEqual(['tank', 'dealer', 'healer', 'support']); // 다른 팀이라 A팀의 탱커와 겹쳐도 되고, 내 역할도 목록에 남는다
    expect(text(await slash('팀전'))).toContain('A팀');
    await press('tm:y', undefined, DBB);
    const started = await press('tm:s');
    expect(started.json.data.embeds[0].title).toContain('4v4');
    expect(ids(started).some((x) => x.startsWith('tm:a:'))).toBe(true);
    const act = await press('tm:g');
    expect(act.json.data.embeds[0].description).toContain('선택 완료');
  });
});

describe('봇: 친구·유저·길드·교환소·이벤트', () => {
  it('친구 신청 → 수락, 유저 목록', async () => {
    expect(text(await slash('친구신청', { 닉네임: '비이' }))).toContain('친구 신청을 보냈어요');
    const fr = await slash('친구', {}, DBB);
    expect(options(fr, 'fr:ac')).toEqual([A.id]);
    expect(text(await press('fr:ac', [A.id], DBB))).toContain('에이');
    expect(text(await slash('친구'))).toContain('비이');
    expect(text(await slash('유저'))).toContain('비이');
    expect(text(await slash('친구신청', { 닉네임: '없는유저' }))).toContain('찾지 못했어요');
  });
  it('길드 만들기·기부·가입·탈퇴', async () => {
    setGold(A.id, 3000);
    expect(text(await slash('길드생성', { 이름: '용사단', 소개: '환영' }))).toContain('용사단');
    expect(text(await slash('길드기부', { 금액: 500 }))).toContain('기부했어요');
    expect(text(await slash('길드'))).toContain('기여 500D');
    const list = await slash('길드', {}, DBB);
    expect(options(list, 'gl:j').length).toBe(1);
    expect(text(await press('gl:j', options(list, 'gl:j'), DBB))).toContain('용사단');
    expect(text(await press('gl:l', undefined, DBB))).toContain('가입하지 않았어요');
  });
  it('교환소: 등록 → 다른 유저가 구매 → 판매 내역', async () => {
    expect((await auto('등록', '아이템', '검')).json.data.choices.length).toBeGreaterThan(0);
    sqlite.prepare("INSERT INTO inventory (user_id, item_id, quantity, equipped) VALUES (?, 'bread', 3, 0)").run(A.id);
    expect(text(await slash('등록', { 아이템: 'bread', 수량: 3, 가격: 100 }))).toContain('올렸어요');
    const ex = await slash('교환소', {}, DBB);
    const listing = options(ex, 'ex:b');
    expect(listing.length).toBe(1);
    setGold(B.id, 500);
    expect(text(await press('ex:b', listing, DBB))).toContain('올라온 물품이 없어요');
    expect(sqlite.prepare("SELECT quantity FROM inventory WHERE user_id = ? AND item_id = 'bread'").get(B.id)).toEqual({ quantity: 3 });
    expect(text(await slash('교환소'))).toContain('최근 판매');
  });
  it('이벤트 선물 받기', async () => {
    const created = await web('tokA', 'POST', '/api/admin/events', { title: '개업 선물', description: '', kind: 'gift', config: { gold: 700 }, startsAt: Date.now() - 1000, endsAt: Date.now() + 3_600_000 });
    expect(created.status).toBe(200);
    const ev = await slash('이벤트', {}, DBB);
    expect(options(ev, 'ev:c').length).toBe(1);
    expect(text(await press('ev:c', options(ev, 'ev:c'), DBB))).toContain('받았어요');
    expect((sqlite.prepare('SELECT gold FROM characters WHERE user_id = ?').get(B.id) as any).gold).toBe(1200);
  });
});

describe('전체 공개 메시지 형식', () => {
  it('팀전 결과: 승리 팀 표시와 양 팀 구성', async () => {
    const { publicTeam } = await import('./bot/ui');
    const msg = publicTeam({ myTeam: 'A', result: 'win', ranked: true, players: [
      { team: 'A', role: 'tank', nickname: '에이', delta: 16 }, { team: 'B', role: 'dealer', nickname: '비이', delta: -16 }] }) as any;
    expect(msg.embeds[0].title).toContain('A팀 승리');
    expect(msg.embeds[0].fields[0].name).toContain('🏆');
    expect(msg.embeds[0].fields[0].value).toContain('에이 (+16)');
    expect(msg.embeds[0].fields[1].value).toContain('비이 (-16)');
    expect((publicTeam({ myTeam: 'A', result: 'draw', ranked: false, players: [] }) as any).embeds[0].title).toContain('무승부');
  });
});

describe('명령어 정의 (전체)', () => {
  it('모든 명령어에 처리 코드가 있고 개수 제한(100) 안이다', () => {
    const names = (commands as any[]).map((c) => c.name);
    expect(names.length).toBeLessThanOrEqual(100);
    expect(names).toEqual(expect.arrayContaining(['레이드', '레이드입장', '대전', '도전', '팀전', '팀입장', '친구', '친구신청', '유저', '길드', '길드생성', '길드기부', '교환소', '등록', '이벤트', '랭킹']));
    for (const c of commands as any[]) for (const o of c.options ?? []) expect(o.name.length).toBeLessThanOrEqual(32);
  });
  it('모든 슬래시 명령어가 "알 수 없는 명령어" 없이 응답한다', async () => {
    for (const c of commands as any[]) {
      if (c.options?.some((o: any) => o.required)) continue; // 필수 옵션이 있는 건 위 테스트에서 개별 확인
      const r = await slash(c.name);
      expect(r.json.data.content ?? '', c.name).not.toContain('알 수 없는');
      expect(r.status).toBe(200);
    }
  });
});
