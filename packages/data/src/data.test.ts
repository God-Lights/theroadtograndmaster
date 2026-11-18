import { describe, expect, it } from 'vitest';
import { BASE_STATS, ITEMS, MOBS, PROFICIENCY_TIERS, RECIPES, computeStats, getNextTier, getProfTier, itemById } from './index';

describe('숙련도 티어 (EDRPG 50단계)', () => {
  it('50단계, 점수는 오름차순', () => {
    expect(PROFICIENCY_TIERS).toHaveLength(50);
    for (let i = 1; i < PROFICIENCY_TIERS.length; i++) {
      expect(PROFICIENCY_TIERS[i]!.min).toBeGreaterThan(PROFICIENCY_TIERS[i - 1]!.min);
    }
  });
  it('점수로 티어를 찾는다', () => {
    expect(getProfTier(0).name).toBe('초보자');
    expect(getProfTier(449).level).toBe(9);
    expect(getProfTier(450).name).toBe('용맹한 전사'); // Lv.10 관문 (리치)
    expect(getProfTier(99999).name).toBe('최강자');
    expect(getNextTier(450)?.level).toBe(11);
    expect(getNextTier(99999)).toBeNull();
  });
});

describe('장비 스탯', () => {
  it('장비 없으면 기본 스탯', () => {
    expect(computeStats([])).toEqual(BASE_STATS);
  });
  it('검=ATK, 방패=DEF, 갑옷=HP가 더해진다', () => {
    const eq = ['iron_sword', 'iron_shield', 'leather_armor'].map((id) => itemById(id)!);
    expect(computeStats(eq)).toMatchObject({ atk: 8 + 8, def: 3 + 7, maxHp: 100 + 20 });
  });
});

describe('데이터 무결성', () => {
  it('아이템 ID는 유일하고 몹 드롭은 존재하는 아이템을 가리킨다', () => {
    const ids = ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MOBS) for (const d of m.drops) expect(itemById(d.itemId), `${m.id} → ${d.itemId}`).toBeDefined();
  });
});

describe('레시피 무결성', () => {
  const dropped = new Set(MOBS.flatMap((m) => m.drops.map((d) => d.itemId)));
  const crafted = new Set(RECIPES.map((r) => r.resultId));

  it('레시피 ID는 유일하고 결과·재료는 존재하는 아이템이다', () => {
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(RECIPES.length);
    for (const r of RECIPES) {
      expect(itemById(r.resultId), `${r.id} 결과`).toBeDefined();
      for (const m of r.materials) expect(itemById(m.itemId), `${r.id} 재료 ${m.itemId}`).toBeDefined();
    }
  });

  it('모든 재료는 지금 게임에서 구할 수 있다 (상점·몹 드롭·다른 레시피)', () => {
    for (const r of RECIPES) {
      for (const m of r.materials) {
        const obtainable = itemById(m.itemId)!.buy !== null || dropped.has(m.itemId) || crafted.has(m.itemId);
        expect(obtainable, `${r.id}: ${m.itemId}`).toBe(true);
      }
    }
  });

  it('레시피가 서로를 순환 참조하지 않는다', () => {
    const deps = new Map(RECIPES.map((r) => [r.resultId, r.materials.map((m) => m.itemId)]));
    const visit = (id: string, path: string[]): void => {
      expect(path.includes(id), `순환: ${[...path, id].join(' → ')}`).toBe(false);
      for (const d of deps.get(id) ?? []) visit(d, [...path, id]);
    };
    for (const id of deps.keys()) visit(id, []);
  });

  it('몹 숙련도 보상은 양수이고 패배 < 승리', () => {
    for (const m of MOBS) {
      expect(m.profWin).toBeGreaterThan(0);
      expect(m.profLose).toBeLessThan(m.profWin);
    }
  });
});
