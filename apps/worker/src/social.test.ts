import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './index';
import { clearAuthCache } from './auth';
import { createTestDb } from './test-db';

const mk = (c: string, n: string, verified = true) => ({ id: `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`, email: `${n}@x.com`, username: n, nickname: n, emailVerified: verified });
const A = mk('a', '에이'), B = mk('b', '비이'), C = mk('c', '씨이'), D = mk('d', '미인증', false);
const USERS: Record<string, ReturnType<typeof mk>> = { tokA: A, tokB: B, tokC: C, tokD: D };

let env: { GL_ACCOUNT_KEY: string; DB: D1Database; ASSETS: { fetch: ReturnType<typeof vi.fn> } };
let sqlite: ReturnType<typeof createTestDb>['sqlite'];

beforeEach(() => {
  clearAuthCache();
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
    const user = USERS[JSON.parse(init.body).token as string];
    return user ? new Response(JSON.stringify({ user }), { status: 200 }) : new Response('{}', { status: 401 });
  }));
  const t = createTestDb();
  sqlite = t.sqlite;
  env = { GL_ACCOUNT_KEY: 'k', DB: t.db, ASSETS: { fetch: vi.fn() } };
});
afterEach(() => vi.unstubAllGlobals());

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await app.request(`https://rtgm.officialgl.com${path}`, { method, headers: { Cookie: `gl_session=${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, env);
  return { status: res.status, json: (await res.json()) as any };
}
const visit = async () => { for (const t of ['tokA', 'tokB', 'tokC', 'tokD']) await call(t, 'GET', '/api/me'); };
const gold = (id: string) => (sqlite.prepare('SELECT gold FROM characters WHERE user_id = ?').get(id) as { gold: number }).gold;
const setGold = (id: string, g: number) => sqlite.prepare('UPDATE characters SET gold = ? WHERE user_id = ?').run(g, id);
const give = (id: string, itemId: string, qty = 1) =>
  sqlite.prepare('INSERT INTO inventory (user_id, item_id, quantity, equipped) VALUES (?, ?, ?, 0) ON CONFLICT DO UPDATE SET quantity = quantity + ?').run(id, itemId, qty, qty);
const qtyOf = (id: string, itemId: string) => (sqlite.prepare('SELECT quantity FROM inventory WHERE user_id = ? AND item_id = ?').get(id, itemId) as { quantity: number } | undefined)?.quantity ?? 0;
const befriend = async () => { await call('tokA', 'POST', '/api/friends/request', { userId: B.id }); await call('tokB', 'POST', '/api/friends/accept', { userId: A.id }); };

describe('프로필·검색', () => {
  it('접속하면 프로필이 생기고 닉네임으로 찾을 수 있다 (자기 자신 제외, 이메일은 저장 안 함)', async () => {
    await visit();
    const r = await call('tokA', 'GET', `/api/players/search?q=${encodeURIComponent('비이')}`);
    expect(r.json.players).toHaveLength(1);
    expect(r.json.players[0]).toMatchObject({ id: B.id, nickname: '비이', relation: 'none' });
    expect((await call('tokA', 'GET', `/api/players/search?q=${encodeURIComponent('에이')}`)).json.players).toHaveLength(0);
    expect((await call('tokA', 'GET', '/api/players/search?q=a')).json.players).toHaveLength(0); // 2글자 미만
    const cols = (sqlite.prepare('PRAGMA table_info(profiles)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('email');
  });
  it('검색어의 % _ 는 와일드카드로 동작하지 않는다', async () => {
    await visit();
    expect((await call('tokA', 'GET', '/api/players/search?q=%25%25')).json.players).toHaveLength(0);
  });
});

describe('친구', () => {
  it('요청 → 수락 → 목록에 서로 나타난다', async () => {
    await visit();
    expect((await call('tokA', 'POST', '/api/friends/request', { userId: B.id })).json.status).toBe('sent');
    expect((await call('tokB', 'GET', '/api/friends')).json.incoming.map((p: any) => p.id)).toEqual([A.id]);
    expect((await call('tokA', 'GET', '/api/friends')).json.outgoing.map((p: any) => p.id)).toEqual([B.id]);
    expect((await call('tokA', 'POST', '/api/friends/accept', { userId: B.id })).status).toBe(404); // 보낸 사람은 수락 못 함
    expect((await call('tokB', 'POST', '/api/friends/accept', { userId: A.id })).status).toBe(200);
    expect((await call('tokA', 'GET', '/api/friends')).json.friends[0]).toMatchObject({ id: B.id, online: true });
    expect((await call('tokB', 'GET', '/api/friends')).json.friends[0].id).toBe(A.id);
  });
  it('서로 요청하면 바로 친구가 되고, 중복·자기 자신·없는 사람은 거절된다', async () => {
    await visit();
    await call('tokA', 'POST', '/api/friends/request', { userId: B.id });
    expect((await call('tokA', 'POST', '/api/friends/request', { userId: B.id })).json.error).toBe('already_requested');
    expect((await call('tokB', 'POST', '/api/friends/request', { userId: A.id })).json.status).toBe('friend');
    expect((await call('tokB', 'POST', '/api/friends/request', { userId: A.id })).json.error).toBe('already_friends');
    expect((await call('tokA', 'POST', '/api/friends/request', { userId: A.id })).status).toBe(400);
    expect((await call('tokA', 'POST', '/api/friends/request', { userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })).status).toBe(404);
  });
  it('거절·취소·삭제는 remove 하나로 된다', async () => {
    await visit(); await befriend();
    await call('tokA', 'POST', '/api/friends/remove', { userId: B.id });
    expect((await call('tokB', 'GET', '/api/friends')).json.friends).toHaveLength(0);
  });
});

describe('채팅', () => {
  it('전체 채팅: 보내고 after 로 새 글만 받는다', async () => {
    await visit();
    expect((await call('tokA', 'POST', '/api/chat/global', { body: '  안녕   하세요 ' })).status).toBe(200);
    const first = (await call('tokB', 'GET', '/api/chat/global')).json.messages;
    expect(first).toMatchObject([{ nickname: '에이', body: '안녕 하세요' }]);
    sqlite.prepare('UPDATE chat_messages SET created_at = created_at - 5000').run();
    await call('tokB', 'POST', '/api/chat/global', { body: '반가워요' });
    const next = (await call('tokA', 'GET', `/api/chat/global?after=${first[0].id}`)).json.messages;
    expect(next.map((m: any) => m.body)).toEqual(['반가워요']);
  });
  it('도배 방지·길이 제한·이메일 미인증 제한', async () => {
    await visit();
    await call('tokA', 'POST', '/api/chat/global', { body: '하나' });
    expect((await call('tokA', 'POST', '/api/chat/global', { body: '둘' })).status).toBe(429);
    expect((await call('tokB', 'POST', '/api/chat/global', { body: 'x'.repeat(201) })).status).toBe(400);
    expect((await call('tokB', 'POST', '/api/chat/global', { body: '   ' })).status).toBe(400);
    expect((await call('tokD', 'POST', '/api/chat/global', { body: '안녕' })).json.error).toBe('email_required');
  });
  it('귓속말은 친구끼리만, 제3자는 읽을 수 없다', async () => {
    await visit();
    expect((await call('tokA', 'POST', `/api/chat/dm:${B.id}`, { body: '몰래' })).status).toBe(403); // 아직 친구 아님
    await befriend();
    expect((await call('tokA', 'POST', `/api/chat/dm:${B.id}`, { body: '몰래' })).status).toBe(200);
    expect((await call('tokB', 'GET', `/api/chat/dm:${A.id}`)).json.messages[0].body).toBe('몰래');
    expect((await call('tokC', 'GET', `/api/chat/dm:${A.id}`)).status).toBe(403);
    expect((await call('tokC', 'GET', `/api/chat/dm:${B.id}`)).status).toBe(403);
  });
  it('채널마다 최근 300개만 남는다', async () => {
    await visit();
    const ins = sqlite.prepare("INSERT INTO chat_messages (channel, user_id, nickname, body, created_at) VALUES ('global', ?, 'x', 'm', 1)");
    for (let i = 0; i < 305; i++) ins.run(A.id);
    await call('tokB', 'POST', '/api/chat/global', { body: '새 글' });
    const n = (sqlite.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE channel='global'").get() as { n: number }).n;
    expect(n).toBe(300);
  });
});

describe('길드', () => {
  it('만들기: 달런트 1000 차감, 중복 이름·이미 가입·돈 부족 거절', async () => {
    await visit(); setGold(A.id, 1500);
    expect((await call('tokA', 'POST', '/api/guild/create', { name: '용사단', description: '환영' })).status).toBe(200);
    expect(gold(A.id)).toBe(500);
    expect((await call('tokA', 'POST', '/api/guild/create', { name: '다른길드' })).json.error).toBe('already_in_guild');
    setGold(B.id, 5000);
    expect((await call('tokB', 'POST', '/api/guild/create', { name: '용사단' })).json.error).toBe('guild_name_taken');
    expect((await call('tokB', 'POST', '/api/guild/create', { name: '!' })).json.error).toBe('invalid_guild_name');
    setGold(C.id, 999);
    expect((await call('tokC', 'POST', '/api/guild/create', { name: '가난뱅이' })).json.error).toBe('not_enough_gold');
    expect(gold(C.id)).toBe(999);
    const mine = (await call('tokA', 'GET', '/api/guild')).json.guild;
    expect(mine).toMatchObject({ name: '용사단', myRole: 'leader', level: 1 });
    expect(mine.members).toHaveLength(1);
  });
  it('가입·정원·탈퇴·길드장 규칙', async () => {
    await visit(); setGold(A.id, 2000);
    const { json } = await call('tokA', 'POST', '/api/guild/create', { name: '길드' });
    const gid = json.id;
    expect((await call('tokB', 'POST', '/api/guild/join', { guildId: gid })).status).toBe(200);
    expect((await call('tokB', 'POST', '/api/guild/join', { guildId: gid })).json.error).toBe('already_in_guild');
    expect((await call('tokA', 'POST', '/api/guild/leave')).json.error).toBe('leader_must_transfer');
    // 정원
    const ins = sqlite.prepare("INSERT INTO guild_members (user_id, guild_id, role, joined_at) VALUES (?, ?, 'member', 1)");
    for (let i = 0; i < 18; i++) ins.run(`fill-${i}`, gid);
    expect((await call('tokC', 'POST', '/api/guild/join', { guildId: gid })).json.error).toBe('guild_full_or_missing');
    expect((await call('tokB', 'POST', '/api/guild/leave')).status).toBe(200);
    expect((await call('tokC', 'POST', '/api/guild/join', { guildId: gid })).status).toBe(200);
  });
  it('임명·내보내기·위임 권한', async () => {
    await visit(); setGold(A.id, 2000);
    const gid = (await call('tokA', 'POST', '/api/guild/create', { name: '길드' })).json.id;
    await call('tokB', 'POST', '/api/guild/join', { guildId: gid });
    await call('tokC', 'POST', '/api/guild/join', { guildId: gid });
    expect((await call('tokB', 'POST', '/api/guild/role', { userId: C.id, role: 'officer' })).status).toBe(403); // 길드장만
    await call('tokA', 'POST', '/api/guild/role', { userId: B.id, role: 'officer' });
    expect((await call('tokB', 'POST', '/api/guild/kick', { userId: A.id })).status).toBe(403);
    expect((await call('tokB', 'POST', '/api/guild/kick', { userId: C.id })).status).toBe(200);
    await call('tokA', 'POST', '/api/guild/role', { userId: B.id, role: 'leader' });
    const g = (await call('tokB', 'GET', '/api/guild')).json.guild;
    expect(g.myRole).toBe('leader');
    expect(g.members.find((m: any) => m.id === A.id).role).toBe('officer');
    expect((await call('tokA', 'POST', '/api/guild/disband')).status).toBe(403);
    expect((await call('tokB', 'POST', '/api/guild/disband')).status).toBe(200);
    expect((await call('tokA', 'GET', '/api/guild')).json.guild).toBeNull();
  });
  it('기부: 골드 차감·길드 금고·기여도, 부족하면 변화 없음. 길드 채팅은 길드원만', async () => {
    await visit(); setGold(A.id, 3000);
    const gid = (await call('tokA', 'POST', '/api/guild/create', { name: '길드' })).json.id;
    expect((await call('tokA', 'POST', '/api/guild/donate', { amount: 99999 })).json.error).toBe('not_enough_gold');
    expect((await call('tokA', 'POST', '/api/guild/donate', { amount: 2000 })).status).toBe(200);
    const g = (await call('tokA', 'GET', '/api/guild')).json.guild;
    expect(g).toMatchObject({ gold: 2000, level: 2 });
    expect(g.members[0].contribution).toBe(2000);
    expect(gold(A.id)).toBe(0);
    await call('tokA', 'POST', '/api/chat/guild', { body: '길드 공지' });
    expect((await call('tokB', 'GET', '/api/chat/guild')).status).toBe(403);
    await call('tokB', 'POST', '/api/guild/join', { guildId: gid });
    expect((await call('tokB', 'GET', '/api/chat/guild')).json.messages[0].body).toBe('길드 공지');
  });
  it('목록 검색', async () => {
    await visit(); setGold(A.id, 2000);
    await call('tokA', 'POST', '/api/guild/create', { name: '용사단' });
    expect((await call('tokB', 'GET', `/api/guilds?q=${encodeURIComponent('용사')}`)).json.guilds[0]).toMatchObject({ name: '용사단', members: 1 });
    expect((await call('tokB', 'GET', `/api/guilds?q=${encodeURIComponent('없음')}`)).json.guilds).toHaveLength(0);
  });
});

describe('교환소', () => {
  it('등록 → 구매: 아이템 이동, 수수료 5% 제외하고 판매자 지급', async () => {
    await visit(); give(A.id, 'bread', 10); setGold(B.id, 1000); setGold(A.id, 0);
    const { json } = await call('tokA', 'POST', '/api/exchange/list', { itemId: 'bread', quantity: 4, price: 200 });
    expect(qtyOf(A.id, 'bread')).toBe(6); // 에스크로
    const listing = (await call('tokB', 'GET', '/api/exchange')).json.listings[0];
    expect(listing).toMatchObject({ id: json.id, itemId: 'bread', quantity: 4, price: 200, seller: '에이' });
    expect((await call('tokA', 'GET', '/api/exchange')).json.listings).toHaveLength(0); // 내 것은 구매 목록에 안 보임
    expect((await call('tokB', 'POST', '/api/exchange/buy', { listingId: json.id })).status).toBe(200);
    expect(qtyOf(B.id, 'bread')).toBe(4);
    expect(gold(B.id)).toBe(800);
    expect(gold(A.id)).toBe(190); // 200 - 5% (10)
    expect((await call('tokC', 'POST', '/api/exchange/buy', { listingId: json.id })).json.error).toBe('listing_unavailable'); // 이미 팔림
    const mine = (await call('tokA', 'GET', '/api/exchange/mine')).json.listings[0];
    expect(mine).toMatchObject({ status: 'sold', buyer: '비이', proceeds: 190 });
  });
  it('돈이 모자라면 아무것도 바뀌지 않는다 (목록은 계속 판매 중)', async () => {
    await visit(); give(A.id, 'bread', 1); setGold(B.id, 50);
    const { json } = await call('tokA', 'POST', '/api/exchange/list', { itemId: 'bread', quantity: 1, price: 100 });
    const r = await call('tokB', 'POST', '/api/exchange/buy', { listingId: json.id });
    expect(r.json.error).toBe('not_enough_gold');
    expect(gold(B.id)).toBe(50);
    expect(qtyOf(B.id, 'bread')).toBe(0);
    expect((await call('tokC', 'GET', '/api/exchange')).json.listings).toHaveLength(1);
  });
  it('자기 물건 구매 불가, 취소하면 아이템이 돌아온다, 남의 것은 취소 불가', async () => {
    await visit(); give(A.id, 'bread', 3);
    const { json } = await call('tokA', 'POST', '/api/exchange/list', { itemId: 'bread', quantity: 3, price: 10 });
    expect((await call('tokA', 'POST', '/api/exchange/buy', { listingId: json.id })).json.error).toBe('own_listing');
    expect((await call('tokB', 'POST', '/api/exchange/cancel', { listingId: json.id })).status).toBe(404);
    expect((await call('tokA', 'POST', '/api/exchange/cancel', { listingId: json.id })).status).toBe(200);
    expect(qtyOf(A.id, 'bread')).toBe(3);
    expect((await call('tokA', 'POST', '/api/exchange/cancel', { listingId: json.id })).status).toBe(404); // 이중 취소 방지
    expect(qtyOf(A.id, 'bread')).toBe(3);
  });
  it('가진 것보다 많이/장착 중인 마지막 1개/잘못된 값은 등록할 수 없다', async () => {
    await visit(); give(A.id, 'bread', 2);
    expect((await call('tokA', 'POST', '/api/exchange/list', { itemId: 'bread', quantity: 3, price: 10 })).json.error).toBe('cannot_list');
    expect((await call('tokA', 'POST', '/api/exchange/list', { itemId: 'rusted_sword', quantity: 1, price: 10 })).json.error).toBe('cannot_list'); // 장착 중
    expect((await call('tokA', 'POST', '/api/exchange/list', { itemId: 'bread', quantity: 1, price: 0 })).json.error).toBe('invalid_price');
    expect((await call('tokA', 'POST', '/api/exchange/list', { itemId: 'bread', quantity: 1.5, price: 10 })).status).toBe(400);
    expect((await call('tokA', 'POST', '/api/exchange/list', { itemId: 'nope', quantity: 1, price: 10 })).status).toBe(400);
    expect(qtyOf(A.id, 'bread')).toBe(2);
  });
  it('지정 거래: 지정한 사람만 보고 살 수 있다', async () => {
    await visit(); give(A.id, 'bread', 1); setGold(B.id, 100); setGold(C.id, 100);
    const { json } = await call('tokA', 'POST', '/api/exchange/list', { itemId: 'bread', quantity: 1, price: 50, to: B.id });
    expect((await call('tokC', 'GET', '/api/exchange')).json.listings).toHaveLength(0);
    expect((await call('tokC', 'POST', '/api/exchange/buy', { listingId: json.id })).status).toBe(404);
    expect((await call('tokB', 'GET', '/api/exchange')).json.listings[0]).toMatchObject({ private: true });
    expect((await call('tokB', 'POST', '/api/exchange/buy', { listingId: json.id })).status).toBe(200);
  });
  it('동시에 두 명이 사도 한 명만 성공한다 (이중 지급 없음)', async () => {
    await visit(); give(A.id, 'bread', 1); setGold(B.id, 100); setGold(C.id, 100); setGold(A.id, 0);
    const { json } = await call('tokA', 'POST', '/api/exchange/list', { itemId: 'bread', quantity: 1, price: 40 });
    const [r1, r2] = await Promise.all([call('tokB', 'POST', '/api/exchange/buy', { listingId: json.id }), call('tokC', 'POST', '/api/exchange/buy', { listingId: json.id })]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(gold(A.id)).toBe(38);
    expect(qtyOf(B.id, 'bread') + qtyOf(C.id, 'bread')).toBe(1);
    expect(gold(B.id) + gold(C.id)).toBe(160);
  });
});
