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
    expect(rewards.proficiency).toBe(mob.profWin);
    expect((await call('tokA', 'GET', '/api/inventory')).json.proficiency).toBe(mob.profWin);

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

describe('전투 숙련도', () => {
  beforeEach(async () => { await call('tokA', 'GET', '/api/me'); });

  const finishBattle = async (mobId: string, playerHp: number, enemyHp: number) => {
    const { json: b } = await call('tokA', 'POST', '/api/battle', { mobId });
    const st = JSON.parse((sqlite.prepare('SELECT state FROM battles WHERE id = ?').get(b.id) as any).state);
    st.combatants.find((c: any) => c.id === 'player').hp = playerHp;
    st.combatants.find((c: any) => c.id === 'enemy').hp = enemyHp;
    sqlite.prepare('UPDATE battles SET state = ? WHERE id = ?').run(JSON.stringify(st), b.id);
    let last: any;
    for (let i = 0; i < 6; i++) {
      last = (await call('tokA', 'POST', `/api/battle/${b.id}/round`, { action: 'attack' })).json;
      if (last.state.status !== 'ongoing') break;
    }
    return { id: b.id, last };
  };

  it('패배해도 소량의 숙련도를 한 번만 얻는다 (골드·아이템은 없음)', async () => {
    const mob = mobById('orc')!;
    const { id, last } = await finishBattle('orc', 1, mob.hp); // 플레이어 HP 1 → 거의 확실히 패배
    expect(last.state.status).toBe('defeat');
    expect(last.rewards).toEqual({ gold: 0, proficiency: mob.profLose, items: [] });
    const inv = (await call('tokA', 'GET', '/api/inventory')).json;
    expect(inv.proficiency).toBe(mob.profLose);
    expect(inv.gold).toBe(500);
    await call('tokA', 'POST', `/api/battle/${id}/round`, { action: 'attack' });
    expect((await call('tokA', 'GET', '/api/inventory')).json.proficiency).toBe(mob.profLose);
  });
});

describe('제작', () => {
  beforeEach(async () => { await call('tokA', 'GET', '/api/me'); setProf(A.id, 300); });

  it('재료와 골드를 소모하고 결과 아이템과 숙련도를 얻는다', async () => {
    give(A.id, 'bread', 6);
    const r = await call('tokA', 'POST', '/api/craft', { recipeId: 'grilled_meat' });
    expect(r.status).toBe(200);
    expect(r.json.crafted).toMatchObject({ itemId: 'grilled_meat', quantity: 1 });
    expect(r.json.items.find((i: any) => i.itemId === 'bread').quantity).toBe(1);
    expect(r.json.items.find((i: any) => i.itemId === 'grilled_meat').quantity).toBe(1);
    expect(r.json.proficiency).toBe(303);
  });

  it('골드가 드는 레시피는 골드를 차감한다', async () => {
    give(A.id, 'decent_sword', 1);
    give(A.id, 'wolf_claw', 2);
    const r = await call('tokA', 'POST', '/api/craft', { recipeId: 'lord_sword' });
    expect(r.status).toBe(200);
    expect(r.json.gold).toBe(500 - 300);
    expect(r.json.items.find((i: any) => i.itemId === 'lord_sword').quantity).toBe(1);
    expect(r.json.items.find((i: any) => i.itemId === 'wolf_claw')).toBeUndefined(); // 0개 행은 삭제
  });

  it('재료가 부족하면 아무것도 변하지 않는다', async () => {
    give(A.id, 'bread', 4);
    const before = (await call('tokA', 'GET', '/api/inventory')).json;
    const r = await call('tokA', 'POST', '/api/craft', { recipeId: 'grilled_meat' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('not_enough_material');
    expect((await call('tokA', 'GET', '/api/inventory')).json).toEqual(before);
  });

  it('골드가 부족하면 재료도 소모되지 않는다', async () => {
    give(A.id, 'decent_sword', 1);
    give(A.id, 'wolf_claw', 2);
    setGold(A.id, 100);
    expect((await call('tokA', 'POST', '/api/craft', { recipeId: 'lord_sword' })).json.error).toBe('not_enough_gold');
    const inv = (await call('tokA', 'GET', '/api/inventory')).json;
    expect(inv.items.find((i: any) => i.itemId === 'wolf_claw').quantity).toBe(2);
  });

  it('숙련도가 모자라면 잠겨 있다', async () => {
    setProf(A.id, 10);
    give(A.id, 'bread', 5);
    const r = await call('tokA', 'POST', '/api/craft', { recipeId: 'grilled_meat' });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: 'recipe_locked', required: 20 });
  });

  it('장착 중인 아이템은 재료로 쓸 수 없다 (장착한 1개를 뺀 수량만 사용)', async () => {
    give(A.id, 'wolf_claw', 2);
    give(A.id, 'decent_sword', 1);
    await call('tokA', 'POST', '/api/inventory/equip', { itemId: 'decent_sword' });
    const r = await call('tokA', 'POST', '/api/craft', { recipeId: 'lord_sword' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('material_equipped');
    give(A.id, 'decent_sword', 1); // 2개가 되면 1개는 쓸 수 있다
    expect((await call('tokA', 'POST', '/api/craft', { recipeId: 'lord_sword' })).status).toBe(200);
  });

  it('알 수 없는 레시피는 거부된다', async () => {
    expect((await call('tokA', 'POST', '/api/craft', { recipeId: 'nope' })).status).toBe(400);
    expect((await call('tokA', 'POST', '/api/craft', {})).status).toBe(400);
  });

  it('가드가 걸리면 앞선 변경까지 모두 되돌아간다 (원자성)', async () => {
    // 사전 검사를 통과한 뒤 동시 요청이 재료를 가져간 상황을 흉내 낸다
    give(A.id, 'bread', 5);
    const db = env.DB;
    const guard = db.prepare("SELECT CASE WHEN changes() = 0 THEN json('guard_failed') ELSE 1 END");
    await expect(
      db.batch([
        db.prepare('UPDATE characters SET gold = gold - 100 WHERE user_id = ?').bind(A.id),
        guard,
        db.prepare("UPDATE inventory SET quantity = quantity - 5 WHERE user_id = ? AND item_id = 'bread' AND quantity >= 99").bind(A.id),
        guard,
      ]),
    ).rejects.toThrow();
    const inv = (await call('tokA', 'GET', '/api/inventory')).json;
    expect(inv.gold).toBe(500); // 첫 UPDATE도 롤백
    expect(inv.items.find((i: any) => i.itemId === 'bread').quantity).toBe(5);
  });
});

describe('보스전 (리치)', () => {
  beforeEach(async () => { await call('tokA', 'GET', '/api/me'); });

  it('보스는 시작할 때부터 다음 행동이 예고되고, 일반 몹에는 보스 기믹이 없다', async () => {
    const { json: rich } = await call('tokA', 'POST', '/api/battle', { mobId: 'rich' });
    expect(rich.state.boss).toBeDefined();
    expect(rich.state.intents.enemy.telegraph).toBeTruthy();
    const { json: zombie } = await call('tokA', 'POST', '/api/battle', { mobId: 'zombie' });
    expect(zombie.state.boss).toBeUndefined();
  });

  it('존재하지 않거나 쓰러진 대상은 공격할 수 없다', async () => {
    const { json: b } = await call('tokA', 'POST', '/api/battle', { mobId: 'rich' });
    expect((await call('tokA', 'POST', `/api/battle/${b.id}/round`, { action: 'attack', targetId: 'vessel' })).status).toBe(400); // 아직 영혼함 없음
    expect((await call('tokA', 'POST', `/api/battle/${b.id}/round`, { action: 'attack', targetId: 'player' })).status).toBe(400); // 아군
    expect((await call('tokA', 'POST', `/api/battle/${b.id}/round`, { action: 'attack', targetId: 'enemy' })).status).toBe(200);
  });

  it('보스를 쓰러뜨리면 황금 리치를 받고, 같은 전투로 다시 받지 못한다', async () => {
    const { json: b } = await call('tokA', 'POST', '/api/battle', { mobId: 'rich' });
    const st = JSON.parse((sqlite.prepare('SELECT state FROM battles WHERE id = ?').get(b.id) as any).state);
    st.combatants.find((c: any) => c.id === 'enemy').hp = 1;
    sqlite.prepare('UPDATE battles SET state = ? WHERE id = ?').run(JSON.stringify(st), b.id);

    let res: any;
    for (let i = 0; i < 4; i++) {
      res = (await call('tokA', 'POST', `/api/battle/${b.id}/round`, { action: 'attack' })).json;
      if (res.state.status !== 'ongoing') break;
    }
    expect(res.state.status).toBe('victory');
    expect(res.rewards.items.map((i: any) => i.itemId)).toContain('golden_lich');
    expect(res.rewards.proficiency).toBe(mobById('rich')!.profWin);
    const inv = (await call('tokA', 'GET', '/api/inventory')).json;
    expect(inv.items.find((i: any) => i.itemId === 'golden_lich').quantity).toBe(1);
    await call('tokA', 'POST', `/api/battle/${b.id}/round`, { action: 'attack' });
    expect((await call('tokA', 'GET', '/api/inventory')).json.items.find((i: any) => i.itemId === 'golden_lich').quantity).toBe(1);
  });
});

describe('스킬 장착', () => {
  beforeEach(async () => { await call('tokA', 'GET', '/api/me'); });
  const equipped = async () => ((await call('tokA', 'GET', '/api/skills')).json.skills as any[]).filter((x) => x.equipped).map((x) => x.id).sort();

  it('새 캐릭터는 기본 스킬 4개를 장착하고 있다', async () => {
    expect(await equipped()).toEqual(['bash', 'heal', 'shield', 'strike']);
  });

  it('스킬 초기화 전의 기존 캐릭터에게도 기본 스킬이 한 번만 들어간다', async () => {
    sqlite.prepare('DELETE FROM skill_loadout WHERE user_id = ?').run(A.id);
    sqlite.prepare('UPDATE characters SET skills_initialized = 0 WHERE user_id = ?').run(A.id);
    await call('tokA', 'GET', '/api/me');
    expect(await equipped()).toEqual(['bash', 'heal', 'shield', 'strike']);
    await call('tokA', 'POST', '/api/skills/unequip', { skillId: 'strike' });
    await call('tokA', 'GET', '/api/me'); // 다시 접속해도 직접 뺀 스킬이 되살아나지 않는다
    expect(await equipped()).toEqual(['bash', 'heal', 'shield']);
  });

  it('일반 스킬은 4개까지, 슬롯이 차면 거부되고 해제하면 다시 장착할 수 있다', async () => {
    const full = await call('tokA', 'POST', '/api/skills/equip', { skillId: 'morale' });
    expect(full.status).toBe(400);
    expect(full.json.error).toBe('slots_full');
    await call('tokA', 'POST', '/api/skills/unequip', { skillId: 'heal' });
    expect((await call('tokA', 'POST', '/api/skills/equip', { skillId: 'morale' })).status).toBe(200);
    expect(await equipped()).toEqual(['bash', 'morale', 'shield', 'strike']);
  });

  it('이미 장착한 스킬을 다시 장착해도 중복되지 않는다', async () => {
    expect((await call('tokA', 'POST', '/api/skills/equip', { skillId: 'strike' })).status).toBe(200);
    expect(await equipped()).toHaveLength(4);
  });

  it('숙련도가 모자라면 장착할 수 없다', async () => {
    await call('tokA', 'POST', '/api/skills/unequip', { skillId: 'heal' });
    const r = await call('tokA', 'POST', '/api/skills/equip', { skillId: 'multi' }); // 숙련도 30 필요
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: 'skill_locked', required: 30 });
    setProf(A.id, 30);
    expect((await call('tokA', 'POST', '/api/skills/equip', { skillId: 'multi' })).status).toBe(200);
  });

  it('궁극기는 하나만: 새로 장착하면 기존 궁극기가 빠진다 (일반 슬롯과 별개)', async () => {
    setProf(A.id, 150);
    await call('tokA', 'POST', '/api/skills/equip', { skillId: 'execute' });
    expect(await equipped()).toContain('execute');
    expect(await equipped()).toHaveLength(5); // 일반 4 + 궁극 1
    await call('tokA', 'POST', '/api/skills/equip', { skillId: 'overdrive' });
    const now = await equipped();
    expect(now).toContain('overdrive');
    expect(now).not.toContain('execute');
    expect(now).toHaveLength(5);
  });

  it('알 수 없는 스킬은 거부된다', async () => {
    expect((await call('tokA', 'POST', '/api/skills/equip', { skillId: 'nope' })).status).toBe(400);
    expect((await call('tokA', 'POST', '/api/skills/unequip', { skillId: 'nope' })).status).toBe(400);
  });

  it('사용자별로 장착이 분리된다', async () => {
    await call('tokB', 'GET', '/api/me');
    await call('tokA', 'POST', '/api/skills/unequip', { skillId: 'strike' });
    const b = ((await call('tokB', 'GET', '/api/skills')).json.skills as any[]).filter((x) => x.equipped).map((x) => x.id);
    expect(b).toContain('strike');
  });
});

describe('스킬 전투', () => {
  beforeEach(async () => { await call('tokA', 'GET', '/api/me'); });
  const start = async (mob = 'orc') => (await call('tokA', 'POST', '/api/battle', { mobId: mob })).json;
  const round = (id: string, body: object) => call('tokA', 'POST', `/api/battle/${id}/round`, body);
  const setState = (id: string, fn: (st: any) => void) => {
    const st = JSON.parse((sqlite.prepare('SELECT state FROM battles WHERE id = ?').get(id) as any).state);
    fn(st);
    sqlite.prepare('UPDATE battles SET state = ? WHERE id = ?').run(JSON.stringify(st), id);
  };

  it('장착한 스킬만 전투에 들어가고 AP로 시작한다', async () => {
    const b = await start();
    expect(Object.keys(b.state.skills).sort()).toEqual(['bash', 'heal', 'shield', 'strike']);
    const me = b.state.combatants.find((c: any) => c.id === 'player');
    expect(me).toMatchObject({ ap: 4, gauge: 0 });
    expect(me.stats.int).toBe(20);
  });

  it('스킬을 쓰면 계수만큼 피해를 주고 AP가 줄었다가 라운드 종료에 회복된다', async () => {
    // 일반 몹은 무작위로 방어해서 피해가 달라지므로, 방어하지 않는 스크립트 보스(리치)로 결정적으로 확인한다
    const b = await start('rich');
    const r = await round(b.id, { action: 'skill', skillId: 'strike' });
    expect(r.status).toBe(200);
    const hit = r.json.log.find((l: any) => l.type === 'attack' && l.actorId === 'player');
    expect(hit.amount).toBe(Math.max(1, Math.round(10 * 1.3 - 6))); // 낡은 검 ATK 10 × 130% − 리치 DEF 6
    expect(r.json.state.combatants.find((c: any) => c.id === 'player').ap).toBe(4 - 2 + 2);
  });

  it('장착하지 않은 스킬·AP 부족·쿨다운 중인 스킬은 거부되고 이유를 알려 준다', async () => {
    const b = await start();
    const notEquipped = await round(b.id, { action: 'skill', skillId: 'morale' });
    expect(notEquipped.status).toBe(400);
    expect(notEquipped.json).toMatchObject({ error: 'skill_unavailable', reason: 'unknown' });

    setState(b.id, (st) => { st.combatants.find((c: any) => c.id === 'player').ap = 0; });
    expect((await round(b.id, { action: 'skill', skillId: 'strike' })).json.reason).toBe('ap');

    setState(b.id, (st) => { st.combatants.find((c: any) => c.id === 'player').ap = 6; });
    expect((await round(b.id, { action: 'skill', skillId: 'shield' })).status).toBe(200); // 쿨다운 2
    const again = await round(b.id, { action: 'skill', skillId: 'shield' });
    expect(again.json).toMatchObject({ error: 'skill_unavailable', reason: 'cooldown' });
  });

  it('쓰러진 적을 대상으로 지정할 수 없다', async () => {
    const b = await start('rich');
    expect((await round(b.id, { action: 'skill', skillId: 'strike', targetId: 'vessel' })).json.error).toBe('invalid_target');
    expect((await round(b.id, { action: 'skill', skillId: 'strike', targetId: 'enemy' })).status).toBe(200);
  });

  it('충전 스킬(일점 집중)은 다음 라운드에 선택과 무관하게 발동한다', async () => {
    setProf(A.id, 700);
    await call('tokA', 'POST', '/api/skills/unequip', { skillId: 'heal' });
    await call('tokA', 'POST', '/api/skills/equip', { skillId: 'focus' });
    const b = await start('rich'); // 방어하지 않는 보스로 피해를 결정적으로 확인한다
    setState(b.id, (st) => {
      st.combatants.find((c: any) => c.id === 'enemy').stats.maxHp = 5000;
      st.combatants.find((c: any) => c.id === 'enemy').hp = 5000;
      // 리치가 무작위로 약화의 저주를 걸면 피해가 달라지므로, 암흑 화살만 쓰게 고정한다
      st.boss.script.phases.forEach((p: any) => { p.pool = [{ id: 'dark_arrow', weight: 1 }]; });
      st.intents.enemy = { patternId: 'dark_arrow', kind: 'attack', name: '암흑 화살', telegraph: '', targetId: 'player' };
    });
    const r1 = await round(b.id, { action: 'skill', skillId: 'focus' });
    expect(r1.status).toBe(200);
    expect(r1.json.state.combatants.find((c: any) => c.id === 'player').pending).toBeDefined();
    // 충전 중에는 다른 스킬을 요청해도 거부하지 않고, 충전한 스킬이 나간다
    const r2 = await round(b.id, { action: 'guard' });
    expect(r2.status).toBe(200);
    const hit = r2.json.log.find((l: any) => l.type === 'attack' && l.actorId === 'player');
    expect(hit.amount).toBe(Math.round(10 * 2.2 - 6)); // ATK 10 × 220% − 리치 DEF 6
  });

  it('궁극기는 게이지가 가득 차야 쓸 수 있다', async () => {
    setProf(A.id, 150);
    await call('tokA', 'POST', '/api/skills/equip', { skillId: 'execute' });
    const b = await start('orc');
    expect((await round(b.id, { action: 'skill', skillId: 'execute' })).json.reason).toBe('gauge');
    setState(b.id, (st) => { st.combatants.find((c: any) => c.id === 'player').gauge = 100; });
    const ok = await round(b.id, { action: 'skill', skillId: 'execute' });
    expect(ok.status).toBe(200);
    expect(ok.json.state.combatants.find((c: any) => c.id === 'player').gauge).toBeLessThan(100);
  });
});

describe('던전 입장', () => {
  beforeEach(async () => { await call('tokA', 'GET', '/api/me'); });
  const start = (mobId: string) => call('tokA', 'POST', '/api/battle', { mobId });
  const battles = () => (sqlite.prepare('SELECT COUNT(*) AS n FROM battles').get() as any).n as number;
  const gold = async () => (await call('tokA', 'GET', '/api/inventory')).json.gold as number;
  const keys = async () => (((await call('tokA', 'GET', '/api/inventory')).json.items as any[]).find((i) => i.itemId === 'midrealm_key')?.quantity ?? 0) as number;

  it('기본 던전은 무료로 입장한다', async () => {
    const r = await start('zombie');
    expect(r.status).toBe(200);
    expect(r.json.paid).toEqual({ gold: 0, key: null });
    expect(await gold()).toBe(500);
  });

  it('중간계 던전은 숙련도 800 미만이면 입장할 수 없다 (아무것도 차감되지 않음)', async () => {
    const r = await start('lappus');
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: 'dungeon_locked', required: 800 });
    expect(await gold()).toBe(500);
    expect(battles()).toBe(0);
  });

  it('일반 몹은 입장 골드만 내고, 부족하면 전투가 생성되지 않는다', async () => {
    setProf(A.id, 800);
    setGold(A.id, 50);
    const no = await start('lappus');
    expect(no.status).toBe(400);
    expect(no.json).toMatchObject({ error: 'not_enough_gold', required: 100 });
    expect(await gold()).toBe(50);
    expect(battles()).toBe(0);
    setGold(A.id, 500);
    const ok = await start('lappus');
    expect(ok.status).toBe(200);
    expect(ok.json.paid).toEqual({ gold: 100, key: null });
    expect(await gold()).toBe(400);
    expect(battles()).toBe(1);
  });

  it('코에도스는 중간계의 열쇠 1개와 골드 400이 필요하다', async () => {
    setProf(A.id, 800);
    setGold(A.id, 1000);
    const noKey = await start('oppoko');
    expect(noKey.status).toBe(400);
    expect(noKey.json).toMatchObject({ error: 'key_missing', itemId: 'midrealm_key' });
    expect(await gold()).toBe(1000);

    give(A.id, 'midrealm_key', 2);
    setGold(A.id, 100); // 열쇠는 있지만 골드가 부족
    expect((await start('oppoko')).json.error).toBe('not_enough_gold');
    expect(await keys()).toBe(2);

    setGold(A.id, 1000);
    const ok = await start('oppoko');
    expect(ok.status).toBe(200);
    expect(ok.json.paid).toEqual({ gold: 400, key: 'midrealm_key' });
    expect(await gold()).toBe(600);
    expect(await keys()).toBe(1);
  });

  it('입장 비용 차감과 전투 생성은 함께 롤백된다 (사전 검사 이후 열쇠가 사라진 경우)', async () => {
    setProf(A.id, 800);
    setGold(A.id, 1000);
    give(A.id, 'midrealm_key', 1);
    // 사전 검사 직후 다른 요청이 열쇠를 가져간 상황을 흉내 낸다: 같은 가드 문장을 직접 실행
    const db = env.DB;
    const guardStmt = db.prepare("SELECT CASE WHEN changes() = 0 THEN json('guard_failed') ELSE 1 END");
    sqlite.prepare("DELETE FROM inventory WHERE item_id = 'midrealm_key'").run();
    await expect(
      db.batch([
        db.prepare('UPDATE characters SET gold = gold - 400 WHERE user_id = ?').bind(A.id),
        db.prepare("UPDATE inventory SET quantity = quantity - 1 WHERE user_id = ? AND item_id = 'midrealm_key' AND quantity >= 1").bind(A.id),
        guardStmt,
        db.prepare("INSERT INTO battles (id, user_id, mob_id, state, created_at) VALUES ('x', ?, 'oppoko', '{}', 0)").bind(A.id),
      ]),
    ).rejects.toThrow();
    expect(await gold()).toBe(1000);
    expect(battles()).toBe(0);
  });

  it('중간계 몹 4종과 코에도스는 모두 보스 스크립트로 시작하고 행동이 예고된다', async () => {
    setProf(A.id, 800);
    setGold(A.id, 100000);
    give(A.id, 'midrealm_key', 10);
    for (const id of ['lappus', 'raufaino', 'toka_loga', 'xenosaurs', 'oppoko']) {
      const r = await start(id);
      expect(r.status, id).toBe(200);
      expect(r.json.state.boss, id).toBeDefined();
      expect(r.json.state.intents.enemy.telegraph, id).toBeTruthy();
    }
  });

  it('코에도스: 기본 공격하면 다음 라운드가 반격의 자세가 된다', async () => {
    setProf(A.id, 800);
    setGold(A.id, 5000);
    give(A.id, 'midrealm_key', 1);
    const b = (await start('oppoko')).json;
    expect(b.state.boss.runtime.stance).toBe('neutral');
    expect(b.state.boss.script.stance).toBeDefined();
    const r1 = await call('tokA', 'POST', `/api/battle/${b.id}/round`, { action: 'attack' });
    expect(r1.json.state.boss.runtime.stance).toBe('counter');
    const r2 = await call('tokA', 'POST', `/api/battle/${b.id}/round`, { action: 'skill', skillId: 'strike' });
    expect(r2.json.state.boss.runtime.stance).toBe('neutral');
  });

  it('중간계 열쇠는 황금 리치로 만든다 (제작 후 던전 입장에 쓸 수 있고 팔 수는 없다)', async () => {
    setProf(A.id, 450);
    give(A.id, 'golden_lich', 1);
    give(A.id, 'rotten_lich_piece', 5);
    const r = await call('tokA', 'POST', '/api/craft', { recipeId: 'midrealm_key' });
    expect(r.status).toBe(200);
    expect(r.json.crafted.itemId).toBe('midrealm_key');
    expect(await keys()).toBe(1);
    expect((await call('tokA', 'POST', '/api/inventory/sell', { itemId: 'midrealm_key' })).status).toBe(400);
  });
});
