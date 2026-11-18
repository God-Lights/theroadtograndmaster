import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './index';
import { clearAuthCache } from './auth';
import { adminIds, isAdmin } from './admin';
import { createTestDb } from './test-db';
import { rollRewards, defeatRewards } from './battle';
import { validateEvent } from './events';
import { mobById } from '@rtgm/data';

const mk = (c: string, n: string) => ({ id: `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`, email: `${n}@x.com`, username: n, nickname: n, emailVerified: true });
const ADMIN = mk('a', '관리자'), USER = mk('b', '유저');
const USERS: Record<string, ReturnType<typeof mk>> = { tokA: ADMIN, tokB: USER };
let env: { GL_ACCOUNT_KEY: string; ADMIN_USER_IDS: string; DB: D1Database; ASSETS: { fetch: ReturnType<typeof vi.fn> } };
let sqlite: ReturnType<typeof createTestDb>['sqlite'];

beforeEach(() => {
  clearAuthCache();
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
    const user = USERS[JSON.parse(init.body).token as string];
    return user ? new Response(JSON.stringify({ user }), { status: 200 }) : new Response('{}', { status: 401 });
  }));
  const t = createTestDb(); sqlite = t.sqlite;
  env = { GL_ACCOUNT_KEY: 'k', ADMIN_USER_IDS: ` ${ADMIN.id.toUpperCase()} , ,other `, DB: t.db, ASSETS: { fetch: vi.fn() } };
});
afterEach(() => vi.unstubAllGlobals());

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await app.request(`https://rtgm.officialgl.com${path}`, { method, headers: { Cookie: `gl_session=${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, env);
  return { status: res.status, json: (await res.json()) as any };
}
const H = 3_600_000;
const ev = (over: Record<string, unknown> = {}) => ({ title: '개업 선물', description: '환영해요', kind: 'gift', config: { gold: 500, items: [{ itemId: 'bread', quantity: 3 }] }, startsAt: Date.now() - H, endsAt: Date.now() + H, ...over });
const gold = (id: string) => (sqlite.prepare('SELECT gold FROM characters WHERE user_id = ?').get(id) as { gold: number }).gold;
const qty = (id: string, item: string) => (sqlite.prepare('SELECT quantity FROM inventory WHERE user_id = ? AND item_id = ?').get(id, item) as { quantity: number } | undefined)?.quantity ?? 0;

describe('관리자 판별', () => {
  it('GL ID(UUID) 목록에서 공백·대소문자를 무시하고 찾는다. 설정이 없으면 아무도 관리자가 아니다', () => {
    expect(isAdmin(` ${ADMIN.id.toUpperCase()} , x`, ADMIN.id)).toBe(true);
    expect(isAdmin(undefined, ADMIN.id)).toBe(false);
    expect(isAdmin('', ADMIN.id)).toBe(false);
    expect(adminIds('a, b\nc').size).toBe(3);
  });
  it('/api/me 의 isAdmin, 관리자 API는 관리자만 (일반 유저에게는 404로 숨김)', async () => {
    expect((await call('tokA', 'GET', '/api/me')).json.isAdmin).toBe(true);
    expect((await call('tokB', 'GET', '/api/me')).json.isAdmin).toBe(false);
    expect((await call('tokA', 'GET', '/api/admin/ping')).status).toBe(200);
    expect((await call('tokB', 'GET', '/api/admin/ping')).status).toBe(404);
    expect((await call('tokB', 'POST', '/api/admin/events', ev())).status).toBe(404);
    expect((await call('tokB', 'GET', '/api/admin/events')).status).toBe(404);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
  });
  it('닉네임이나 아이디가 관리자 ID와 같아도 관리자가 되지 않는다', async () => {
    env.ADMIN_USER_IDS = '유저,b';
    expect((await call('tokB', 'GET', '/api/admin/ping')).status).toBe(404);
  });
});

describe('이벤트 입력 검증', () => {
  const ok = (o: Record<string, unknown>) => validateEvent({ ...ev(), ...o });
  it('잘못된 값은 거절한다', () => {
    expect(ok({ title: '' })).toMatchObject({ ok: false, error: 'invalid_title' });
    expect(ok({ kind: 'hack' })).toMatchObject({ error: 'invalid_kind' });
    expect(ok({ endsAt: Date.now() - 1 })).toMatchObject({ error: 'invalid_period' });
    expect(ok({ startsAt: Date.now(), endsAt: Date.now() + 100 * 86_400_000 })).toMatchObject({ error: 'invalid_period' });
    expect(ok({ config: { gold: -5 } })).toMatchObject({ error: 'invalid_gift' });
    expect(ok({ config: { gold: 99_999_999 } })).toMatchObject({ error: 'invalid_gift' });
    expect(ok({ config: { items: [{ itemId: 'nope', quantity: 1 }] } })).toMatchObject({ error: 'invalid_gift' });
    expect(ok({ config: { items: [{ itemId: 'bread', quantity: 1000 }] } })).toMatchObject({ error: 'invalid_gift' });
    expect(ok({ config: {} })).toMatchObject({ error: 'invalid_gift' });
    expect(ok({ kind: 'bonus', config: { gold: 9 } })).toMatchObject({ error: 'invalid_bonus' });
    expect(ok({ kind: 'bonus', config: { gold: 1 } })).toMatchObject({ error: 'invalid_bonus' });
    expect(ok({ kind: 'bonus', config: {} })).toMatchObject({ error: 'invalid_bonus' });
  });
  it('올바른 값은 정리돼서 통과한다 (같은 아이템은 합친다)', () => {
    const r = ok({ config: { items: [{ itemId: 'bread', quantity: 2 }, { itemId: 'bread', quantity: 3 }] } });
    expect(r).toMatchObject({ ok: true, value: { config: { items: [{ itemId: 'bread', quantity: 5 }] } } });
    expect(ok({ kind: 'bonus', config: { gold: 2, drop: '1.55' } })).toMatchObject({ ok: true, value: { config: { gold: 2, drop: 1.6 } } });
    expect(ok({ kind: 'notice', config: { anything: 1 } })).toMatchObject({ ok: true, value: { config: {} } });
  });
});

describe('선물 이벤트', () => {
  it('관리자가 만들면 기간 중에 한 번만 받을 수 있다', async () => {
    const { json } = await call('tokA', 'POST', '/api/admin/events', ev());
    await call('tokB', 'GET', '/api/me');
    const g0 = gold(USER.id);
    const list = (await call('tokB', 'GET', '/api/events')).json.events;
    expect(list).toMatchObject([{ id: json.id, title: '개업 선물', status: 'active', claimed: false }]);
    const r = await call('tokB', 'POST', `/api/events/${json.id}/claim`);
    expect(r.status).toBe(200);
    expect(gold(USER.id)).toBe(g0 + 500);
    expect(qty(USER.id, 'bread')).toBe(3);
    expect((await call('tokB', 'POST', `/api/events/${json.id}/claim`)).json.error).toBe('already_claimed');
    expect(gold(USER.id)).toBe(g0 + 500);
    expect((await call('tokB', 'GET', '/api/events')).json.events[0].claimed).toBe(true);
    expect((await call('tokA', 'GET', '/api/admin/events')).json.events[0].claims).toBe(1);
  });
  it('시작 전·종료 후·중단된 이벤트는 받을 수 없다', async () => {
    await call('tokB', 'GET', '/api/me');
    const future = (await call('tokA', 'POST', '/api/admin/events', ev({ startsAt: Date.now() + H, endsAt: Date.now() + 2 * H }))).json.id;
    expect((await call('tokB', 'POST', `/api/events/${future}/claim`)).status).toBe(404);
    const live = (await call('tokA', 'POST', '/api/admin/events', ev())).json.id;
    sqlite.prepare('UPDATE events SET ends_at = ? WHERE id = ?').run(Date.now() - 1, live);
    expect((await call('tokB', 'POST', `/api/events/${live}/claim`)).status).toBe(404);
    const cancelled = (await call('tokA', 'POST', '/api/admin/events', ev())).json.id;
    expect((await call('tokA', 'POST', `/api/admin/events/${cancelled}/cancel`)).status).toBe(200);
    expect((await call('tokA', 'POST', `/api/admin/events/${cancelled}/cancel`)).status).toBe(404);
    expect((await call('tokB', 'POST', `/api/events/${cancelled}/claim`)).status).toBe(404);
    expect((await call('tokB', 'GET', '/api/events')).json.events.map((e: any) => e.id)).toEqual([future]);
  });
  it('공지 이벤트는 받을 수 있는 선물이 아니다', async () => {
    const id = (await call('tokA', 'POST', '/api/admin/events', ev({ kind: 'notice', config: {} }))).json.id;
    expect((await call('tokB', 'POST', `/api/events/${id}/claim`)).status).toBe(404);
  });
});

describe('보너스 이벤트', () => {
  it('보상 배율이 적용되고, 같은 종류가 겹쳐도 가장 큰 값 하나만 쓴다', async () => {
    await call('tokA', 'POST', '/api/admin/events', ev({ kind: 'bonus', config: { gold: 2, proficiency: 1.5 } }));
    await call('tokA', 'POST', '/api/admin/events', ev({ title: '또 보너스', kind: 'bonus', config: { gold: 3 } }));
    const b = (await call('tokB', 'GET', '/api/events')).json.bonus;
    expect(b).toEqual({ gold: 3, proficiency: 1.5, drop: 1 });
    sqlite.prepare("UPDATE events SET ends_at = 1 WHERE title = '또 보너스'").run();
    expect((await call('tokB', 'GET', '/api/events')).json.bonus.gold).toBe(2);
  });
  it('rollRewards/defeatRewards 에 배율이 반영된다', () => {
    const mob = mobById('zombie')!;
    const base = rollRewards(mob, 7);
    const boosted = rollRewards(mob, 7, { gold: 2, proficiency: 2, drop: 1 });
    expect(boosted.gold).toBe(base.gold * 2);
    expect(boosted.proficiency).toBe(base.proficiency * 2);
    expect(defeatRewards(mob, { gold: 1, proficiency: 3, drop: 1 }).proficiency).toBe(mob.profLose * 3);
    expect(rollRewards(mob, 7, { gold: 1, proficiency: 1, drop: 5 }).items.length).toBeGreaterThanOrEqual(base.items.length);
  });
});
