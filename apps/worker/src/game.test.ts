import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './index';
import { clearAuthCache } from './auth';
import { createTestDb } from './test-db';
import { rollRewards } from './battle';
import { mobById } from '@rtgm/data';

const A = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'a@x.com', username: 'a', nickname: '에이', emailVerified: true };
const B = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'b@x.com', username: 'b', nickname: '비', emailVerified: true };

let env: { GL_ACCOUNT_KEY: string; DB: D1Database; ASSETS: { fetch: ReturnType<typeof vi.fn> } };
let sqlite: ReturnType<typeof createTestDb>['sqlite'];

beforeEach(() => {
  clearAuthCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const token = JSON.parse(init.body).token as string;
      const user = token === 'tokA' ? A : token === 'tokB' ? B : null;
      return user ? new Response(JSON.stringify({ user }), { status: 200 }) : new Response('{}', { status: 401 });
    }),
  );
  const t = createTestDb();
  sqlite = t.sqlite;
  env = { GL_ACCOUNT_KEY: 'k', DB: t.db, ASSETS: { fetch: vi.fn() } };
});
afterEach(() => vi.unstubAllGlobals());

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await app.request(
    `https://rtgm.officialgl.com${path}`,
    { method, headers: { Cookie: `gl_session=${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined },
    env,
  );
  return { status: res.status, json: (await res.json()) as any };
}
const setGold = (id: string, gold: number) => sqlite.prepare('UPDATE characters SET gold = ? WHERE user_id = ?').run(gold, id);
const setProf = (id: string, p: number) => sqlite.prepare('UPDATE characters SET proficiency = ? WHERE user_id = ?').run(p, id);
const give = (id: string, itemId: string, qty = 1) =>
  sqlite.prepare('INSERT INTO inventory (user_id, item_id, quantity, equipped) VALUES (?, ?, ?, 0) ON CONFLICT DO UPDATE SET quantity = quantity + ?').run(id, itemId, qty, qty);

describe('캐릭터 생성', () => {
  it('첫 접속 시 시작 골드와 낡은 검·갑옷(장착)을 받고, 다시 접속해도 중복되지 않는다', async () => {
    await call('tokA', 'GET', '/api/me');
    await call('tokA', 'GET', '/api/me');
    const inv = (await call('tokA', 'GET', '/api/inventory')).json;
    expect(inv.gold).toBe(500);
    expect(inv.items).toEqual([
      { itemId: 'rusted_armor', quantity: 1, equipped: true },
      { itemId: 'rusted_sword', quantity: 1, equipped: true },
    ]);
    // 기본 스탯 ATK 8 + 2, HP 100 + 10
    expect(inv.stats).toMatchObject({ atk: 10, maxHp: 110, def: 3 });
  });

  it('사용자별로 인벤토리가 분리된다', async () => {
    await call('tokA', 'GET', '/api/me');
    await call('tokB', 'GET', '/api/me');
    give(A.id, 'bread', 5);
    const b = (await call('tokB', 'GET', '/api/inventory')).json;
    expect(b.items.find((i: any) => i.itemId === 'bread')).toBeUndefined();
  });
});

describe('장비', () => {
  beforeEach(async () => { await call('tokA', 'GET', '/api/me'); });

  it('같은 슬롯은 하나만 장착되고 스탯에 반영된다', async () => {
    give(A.id, 'decent_sword');
    const r = await call('tokA', 'POST', '/api/inventory/equip', { itemId: 'decent_sword' });
    expect(r.status).toBe(200);
    const equipped = r.json.items.filter((i: any) => i.equipped).map((i: any) => i.itemId).sort();
    expect(equipped).toEqual(['decent_sword', 'rusted_armor']);
    expect(r.json.stats.atk).toBe(8 + 6);
  });

  it('보유하지 않은 장비는 장착할 수 없다', async () => {
    expect((await call('tokA', 'POST', '/api/inventory/equip', { itemId: 'iron_sword' })).status).toBe(404);
  });

  it('필요 숙련이 부족하면 장착할 수 없다', async () => {
    give(A.id, 'good_sword'); // 필요 숙련 50
    const r = await call('tokA', 'POST', '/api/inventory/equip', { itemId: 'good_sword' });
    expect(r.status).toBe(403);
    expect(r.json.required).toBe(50);
    setProf(A.id, 50);
    expect((await call('tokA', 'POST', '/api/inventory/equip', { itemId: 'good_sword' })).status).toBe(200);
  });

  it('장비가 아닌 아이템은 장착할 수 없다', async () => {
    give(A.id, 'bread');
    expect((await call('tokA', 'POST', '/api/inventory/equip', { itemId: 'bread' })).status).toBe(400);
  });

  it('해제하면 스탯이 내려간다', async () => {
    const r = await call('tokA', 'POST', '/api/inventory/unequip', { itemId: 'rusted_sword' });
    expect(r.json.stats.atk).toBe(8);
  });
});

describe('판매', () => {
  beforeEach(async () => { await call('tokA', 'GET', '/api/me'); });

  it('판매하면 수량이 줄고 골드가 오른다 (0개면 행 삭제)', async () => {
    give(A.id, 'bread', 3);
    const r = await call('tokA', 'POST', '/api/inventory/sell', { itemId: 'bread', quantity: 3 });
    expect(r.status).toBe(200);
    expect(r.json.gold).toBe(500 + 15 * 3);
    expect(r.json.items.find((i: any) => i.itemId === 'bread')).toBeUndefined();
  });

  it('보유 수량보다 많이는 팔 수 없고 골드도 변하지 않는다', async () => {
    give(A.id, 'bread', 2);
    const r = await call('tokA', 'POST', '/api/inventory/sell', { itemId: 'bread', quantity: 3 });
    expect(r.status).toBe(400);
    expect((await call('tokA', 'GET', '/api/inventory')).json.gold).toBe(500);
  });

  it('장착 중인 마지막 1개는 팔 수 없다', async () => {
    expect((await call('tokA', 'POST', '/api/inventory/sell', { itemId: 'rusted_sword' })).status).toBe(400);
    give(A.id, 'rusted_sword'); // 2개가 되면 1개는 팔 수 있다
    const r = await call('tokA', 'POST', '/api/inventory/sell', { itemId: 'rusted_sword' });
    expect(r.status).toBe(200);
    expect(r.json.items.find((i: any) => i.itemId === 'rusted_sword').equipped).toBe(true);
  });
});

describe('상점 구매', () => {
  beforeEach(async () => { await call('tokA', 'GET', '/api/me'); });

  it('골드가 충분하면 차감되고 아이템이 쌓인다', async () => {
    await call('tokA', 'POST', '/api/shop/buy', { itemId: 'bread', quantity: 4 });
    const r = await call('tokA', 'POST', '/api/shop/buy', { itemId: 'bread', quantity: 2 });
    expect(r.json.gold).toBe(500 - 50 * 6);
    expect(r.json.items.find((i: any) => i.itemId === 'bread').quantity).toBe(6);
  });

  it('골드가 부족하면 아무것도 변하지 않는다', async () => {
    setGold(A.id, 100);
    const r = await call('tokA', 'POST', '/api/shop/buy', { itemId: 'bread', quantity: 3 });
    expect(r.status).toBe(400);
    const inv = (await call('tokA', 'GET', '/api/inventory')).json;
    expect(inv.gold).toBe(100);
    expect(inv.items.find((i: any) => i.itemId === 'bread')).toBeUndefined();
  });

  it('구매 불가 아이템·숙련 부족·잘못된 수량은 거부된다', async () => {
    expect((await call('tokA', 'POST', '/api/shop/buy', { itemId: 'golden_lich' })).status).toBe(400);
    expect((await call('tokA', 'POST', '/api/shop/buy', { itemId: 'good_sword' })).status).toBe(403);
    expect((await call('tokA', 'POST', '/api/shop/buy', { itemId: 'bread', quantity: 0 })).status).toBe(400);
    expect((await call('tokA', 'POST', '/api/shop/buy', { itemId: 'bread', quantity: 1.5 })).status).toBe(400);
    expect((await call('tokA', 'POST', '/api/shop/buy', { itemId: 'bread', quantity: 1000 })).status).toBe(400);
  });
});

describe('전투 연결', () => {
  beforeEach(async () => { await call('tokA', 'GET', '/api/me'); });

  it('장착 장비가 전투 스탯에 반영된다', async () => {
    give(A.id, 'decent_sword');
    await call('tokA', 'POST', '/api/inventory/equip', { itemId: 'decent_sword' });
    const { json } = await call('tokA', 'POST', '/api/battle', { mobId: 'zombie' });
    const me = json.state.combatants.find((c: any) => c.id === 'player');
    expect(me.stats).toMatchObject({ atk: 14, maxHp: 110 });
  });

  it('아이템 사용은 보유 수량을 소모하고, 없으면 거부된다', async () => {
    const { json: b } = await call('tokA', 'POST', '/api/battle', { mobId: 'orc' });
    expect((await call('tokA', 'POST', `/api/battle/${b.id}/round`, { action: 'item', itemId: 'bread' })).status).toBe(400);
    give(A.id, 'bread', 1);
    expect((await call('tokA', 'POST', `/api/battle/${b.id}/round`, { action: 'item', itemId: 'bread' })).status).toBe(200);
    expect((await call('tokA', 'GET', '/api/inventory')).json.items.find((i: any) => i.itemId === 'bread')).toBeUndefined();
  });

  it('승리 보상은 한 번만 지급된다', async () => {
    setProf(A.id, 0);
    sqlite.prepare("UPDATE inventory SET quantity = 1 WHERE user_id = ?").run(A.id);
    const { json: b } = await call('tokA', 'POST', '/api/battle', { mobId: 'zombie' });
    // 적을 거의 죽은 상태로 만들어 한 번에 승리하게 한다
    const st = JSON.parse((sqlite.prepare('SELECT state FROM battles WHERE id = ?').get(b.id) as any).state);
    st.combatants.find((c: any) => c.id === 'enemy').hp = 1;
    sqlite.prepare('UPDATE battles SET state = ? WHERE id = ?').run(JSON.stringify(st), b.id);

    let rewards: any;
    for (let i = 0; i < 5 && !rewards; i++) {
      const r = await call('tokA', 'POST', `/api/battle/${b.id}/round`, { action: 'attack' });
      rewards = r.json.rewards;
      if (r.json.state.status !== 'ongoing') break;
    }
    expect(rewards).toBeDefined();
    const mob = mobById('zombie')!;
    expect(rewards.gold).toBeGreaterThanOrEqual(mob.gold[0]);
    expect(rewards.gold).toBeLessThanOrEqual(mob.gold[1]);
    const goldAfter = (await call('tokA', 'GET', '/api/inventory')).json.gold;
    expect(goldAfter).toBe(500 + rewards.gold);

    // 같은 전투를 다시 진행해도 추가 보상은 없다
    const again = await call('tokA', 'POST', `/api/battle/${b.id}/round`, { action: 'attack' });
    expect(again.json.rewards).toBeUndefined();
    expect((await call('tokA', 'GET', '/api/inventory')).json.gold).toBe(goldAfter);
  });

  it('다른 사용자의 전투는 조작할 수 없다', async () => {
    await call('tokB', 'GET', '/api/me');
    const { json: b } = await call('tokA', 'POST', '/api/battle', { mobId: 'zombie' });
    expect((await call('tokB', 'POST', `/api/battle/${b.id}/round`, { action: 'attack' })).status).toBe(404);
  });
});

describe('보상 굴림', () => {
  it('같은 시드면 같은 결과, 골드는 몹 범위 안', () => {
    const mob = mobById('zombie')!;
    expect(rollRewards(mob, 123)).toEqual(rollRewards(mob, 123));
    for (let s = 0; s < 50; s++) {
      const r = rollRewards(mob, s);
      expect(r.gold).toBeGreaterThanOrEqual(mob.gold[0]);
      expect(r.gold).toBeLessThanOrEqual(mob.gold[1]);
    }
  });
});
