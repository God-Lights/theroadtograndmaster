import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './index';
import { clearAuthCache } from './auth';
import { createTestDb } from './test-db';
import { LINK_CODE_TTL_MS, safeEqual } from './discord';

const mk = (c: string, n: string, verified = true) => ({ id: `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`, email: `${n}@x.com`, username: n, nickname: n, emailVerified: verified });
const A = mk('a', '에이'), B = mk('b', '비이', false);
const USERS: Record<string, ReturnType<typeof mk>> = { tokA: A, tokB: B };
const KEY = 'bot-secret-key';
const DA = '123456789012345678', DB_ID = '223456789012345678';
let env: { GL_ACCOUNT_KEY: string; BOT_API_KEY?: string; ADMIN_USER_IDS?: string; DB: D1Database; ASSETS: { fetch: ReturnType<typeof vi.fn> } };
let sqlite: ReturnType<typeof createTestDb>['sqlite'];

beforeEach(() => {
  clearAuthCache();
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
    const user = USERS[JSON.parse(init.body).token as string];
    return user ? new Response(JSON.stringify({ user }), { status: 200 }) : new Response('{}', { status: 401 });
  }));
  const t = createTestDb(); sqlite = t.sqlite;
  env = { GL_ACCOUNT_KEY: 'k', BOT_API_KEY: KEY, ADMIN_USER_IDS: A.id, DB: t.db, ASSETS: { fetch: vi.fn(async () => new Response('<html>')) } };
});
afterEach(() => vi.unstubAllGlobals());

async function web(token: string, method: string, path: string, body?: unknown) {
  const res = await app.request(`https://rtgm.officialgl.com${path}`, { method, headers: { Cookie: `gl_session=${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, env);
  return { status: res.status, json: (await res.json()) as any };
}
async function bot(method: string, path: string, opts: { discord?: string; key?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.key !== null) headers.Authorization = `Bearer ${opts.key ?? KEY}`;
  if (opts.discord) headers['X-Discord-User'] = opts.discord;
  const res = await app.request(`https://rtgm.officialgl.com${path}`, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined }, env);
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
/** 웹에서 코드를 만들고 봇으로 연동한다 */
async function link(token = 'tokA', discordId = DA) {
  const { json } = await web(token, 'POST', '/api/discord/link-code');
  const r = await bot('POST', '/api/bot/link', { body: { code: json.code, discordId } });
  return { code: json.code as string, r };
}

describe('연동 코드', () => {
  it('웹에서 코드를 만들고 봇이 입력하면 연동된다 (코드는 1회용)', async () => {
    const { code, r } = await link();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(r).toMatchObject({ status: 200, json: { ok: true, nickname: '에이' } });
    expect((await web('tokA', 'GET', '/api/discord/status')).json).toMatchObject({ linked: true, botEnabled: true });
    expect((await bot('POST', '/api/bot/link', { body: { code, discordId: DB_ID } })).json.error).toBe('invalid_code'); // 이미 사용됨
    expect((await bot('GET', '/api/me', { discord: DB_ID })).json.error).toBe('not_linked');
  });
  it('새 코드를 만들면 이전 코드는 무효, 만료된 코드도 무효', async () => {
    await web('tokA', 'GET', '/api/me');
    const first = (await web('tokA', 'POST', '/api/discord/link-code')).json.code;
    const second = (await web('tokA', 'POST', '/api/discord/link-code')).json;
    expect(second.expiresAt).toBeGreaterThan(Date.now() + LINK_CODE_TTL_MS - 5000);
    expect((await bot('POST', '/api/bot/link', { body: { code: first, discordId: DA } })).status).toBe(404);
    sqlite.prepare('UPDATE discord_link_codes SET expires_at = ?').run(Date.now() - 1);
    expect((await bot('POST', '/api/bot/link', { body: { code: second.code, discordId: DA } })).status).toBe(404);
  });
  it('코드는 소문자·공백이 섞여도 되고, 잘못된 요청은 거절된다', async () => {
    const { json } = await web('tokA', 'POST', '/api/discord/link-code');
    expect((await bot('POST', '/api/bot/link', { body: { code: json.code, discordId: 'abc' } })).status).toBe(400);
    expect((await bot('POST', '/api/bot/link', { body: { discordId: DA } })).status).toBe(400);
    expect((await bot('POST', '/api/bot/link', { body: { code: ` ${json.code.toLowerCase()} `, discordId: DA } })).status).toBe(200);
  });
  it('1:1 연동: 다시 연동하면 이전 연결이 바뀐다', async () => {
    await link('tokA', DA);
    await link('tokB', DA); // 같은 디스코드를 다른 계정에 연동 → A 의 연결은 끊어진다
    expect((await web('tokA', 'GET', '/api/discord/status')).json.linked).toBe(false);
    expect((await bot('GET', '/api/me', { discord: DA })).json.id).toBe(B.id);
    await link('tokB', DB_ID); // 같은 계정을 다른 디스코드에 연동 → 이전 디스코드는 끊어진다
    expect((await bot('GET', '/api/me', { discord: DA })).json.error).toBe('not_linked');
    expect((await bot('GET', '/api/me', { discord: DB_ID })).json.id).toBe(B.id);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM discord_links').get()).toEqual({ n: 1 });
  });
  it('연동 해제', async () => {
    await link();
    expect((await web('tokA', 'POST', '/api/discord/unlink')).status).toBe(200);
    expect((await bot('GET', '/api/me', { discord: DA })).json.error).toBe('not_linked');
  });
});

describe('봇 인증', () => {
  it('키가 없거나 틀리면 401, 서버에 키가 설정되지 않았으면 봇은 아예 동작하지 않는다', async () => {
    await link();
    expect((await bot('GET', '/api/me', { discord: DA, key: 'wrong' })).status).toBe(401);
    expect((await bot('GET', '/api/me', { discord: DA, key: '' })).status).toBe(401);
    expect((await bot('GET', '/api/me', { discord: DA, key: null })).status).toBe(401); // 쿠키도 키도 없음
    env.BOT_API_KEY = undefined;
    expect((await bot('GET', '/api/me', { discord: DA })).status).toBe(401);
    expect((await web('tokA', 'GET', '/api/discord/status')).json.botEnabled).toBe(false);
  });
  it('연동된 사용자 대신 게임 API를 호출한다 (/api/me, 탐험, 인벤토리, 소셜)', async () => {
    await link();
    const me = await bot('GET', '/api/me', { discord: DA });
    expect(me.json).toMatchObject({ id: A.id, nickname: '에이', gold: 500 });
    expect(me.json.email).toBeUndefined();
    const explore = await bot('POST', '/api/explore', { discord: DA, body: { biomeId: 'plains' } });
    expect(explore.status).toBe(200);
    expect(explore.json.state.status).toBe('ongoing');
    expect((await bot('POST', '/api/explore', { discord: DA, body: { biomeId: 'plains' } })).json.error).toBe('explore_cooldown'); // 대기시간도 똑같이 적용
    const round = await bot('POST', `/api/battle/${explore.json.id}/round`, { discord: DA, body: { action: 'attack' } });
    expect(round.status).toBe(200);
    expect((await bot('GET', '/api/inventory', { discord: DA })).json.items.length).toBeGreaterThan(0);
    // 웹과 같은 데이터: 웹 세션에서도 같은 전투가 보인다
    expect((await web('tokA', 'GET', '/api/me')).json.id).toBe(A.id);
  });
  it('다른 사람의 디스코드 ID로는 다른 사람 데이터를 볼 수 없다', async () => {
    await link('tokA', DA);
    await link('tokB', DB_ID);
    expect((await bot('GET', '/api/me', { discord: DB_ID })).json.id).toBe(B.id);
    expect((await bot('GET', '/api/me', { discord: DA })).json.id).toBe(A.id);
    expect((await bot('GET', '/api/me', { discord: '999999999999999999' })).json.error).toBe('not_linked');
    expect((await bot('GET', '/api/me', { discord: "1; DROP TABLE" })).json.error).toBe('discord_user_required');
    expect((await bot('GET', '/api/me')).json.error).toBe('discord_user_required');
  });
  it('관리자 API·페이지·웹 전용 기능은 봇으로 호출할 수 없다 (관리자와 연동돼 있어도)', async () => {
    await link(); // A 는 관리자
    expect((await web('tokA', 'GET', '/api/admin/ping')).status).toBe(200);
    expect((await bot('GET', '/api/admin/ping', { discord: DA })).status).toBe(404);
    expect((await bot('POST', '/api/admin/events', { discord: DA, body: {} })).status).toBe(404);
    expect((await bot('GET', '/', { discord: DA })).status).toBe(404);
    expect((await bot('POST', '/api/discord/link-code', { discord: DA })).status).toBe(403);
    expect((await bot('POST', '/api/discord/unlink', { discord: DA })).status).toBe(403);
    expect((await web('tokA', 'POST', '/api/bot/link', { code: 'X', discordId: DA })).status).toBe(404); // 웹 세션은 연동 API 불가
  });
  it('사용자 없이 쓸 수 있는 경로: 전체 알림·헬스체크·게임 데이터', async () => {
    await web('tokA', 'GET', '/api/me');
    sqlite.prepare("INSERT INTO announcements (kind, text, created_at) VALUES ('boss', '리치를 쓰러뜨렸다', 1)").run();
    const ann = await bot('GET', '/api/announcements?after=0');
    expect(ann.json.announcements[0]).toMatchObject({ kind: 'boss', text: '리치를 쓰러뜨렸다' });
    expect((await bot('GET', '/api/health')).status).toBe(200);
    expect((await bot('GET', '/api/data/items')).status).toBe(200);
    expect((await bot('GET', '/api/inventory')).json.error).toBe('discord_user_required');
  });
  it('이메일 미인증 계정은 연동 후에도 전체 채팅을 못 쓴다', async () => {
    await link('tokB', DB_ID);
    expect((await bot('POST', '/api/chat/global', { discord: DB_ID, body: { body: '안녕' } })).json.error).toBe('email_required');
    await link('tokA', DA);
    expect((await bot('POST', '/api/chat/global', { discord: DA, body: { body: '안녕' } })).status).toBe(200);
  });
  it('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
