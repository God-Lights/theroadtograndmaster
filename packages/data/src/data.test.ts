import { describe, expect, it } from 'vitest';
import { RAID_BOSSES, BASE_STATS, BOSS_SCRIPTS, DEFAULT_LOADOUT, DUNGEONS, ITEMS, MOBS, SKILLS, SKILL_SLOTS, dungeonById, entryCost, PROFICIENCY_TIERS, RECIPES, ULTIMATE_SLOTS, computeStats, getNextTier, getProfTier, itemById, skillById } from './index';

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
  for (const b of Object.values(RAID_BOSSES)) for (const d of b.drops) dropped.add(d.itemId);
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

describe('스킬 데이터 무결성', () => {
  it('ID가 유일하고 모든 스킬이 효과를 가진다', () => {
    expect(new Set(SKILLS.map((s) => s.id)).size).toBe(SKILLS.length);
    for (const s of SKILLS) {
      expect(s.effects.length, s.id).toBeGreaterThan(0);
      expect(s.description.length, s.id).toBeGreaterThan(0);
      expect(['first', 'normal', 'last', 'delayed']).toContain(s.priority);
    }
  });

  it('궁극기는 AP 0·쿨다운 0이고, 일반 스킬은 AP 비용이 있다 (비용 감소 스킬 제외)', () => {
    for (const s of SKILLS) {
      if (s.ultimate) {
        expect(s.apCost, s.id).toBe(0);
        expect(s.cooldown, s.id).toBe(0);
      } else {
        expect(s.apCost, s.id).toBeGreaterThan(0);
      }
    }
  });

  it('기본 장착 스킬은 처음부터 쓸 수 있고 슬롯 수를 넘지 않는다', () => {
    expect(DEFAULT_LOADOUT.length).toBeLessThanOrEqual(SKILL_SLOTS);
    for (const id of DEFAULT_LOADOUT) {
      const s = skillById(id);
      expect(s, id).toBeDefined();
      expect(s!.unlockProficiency).toBe(0);
      expect(s!.ultimate).toBe(false);
    }
  });

  it('처음부터 고를 수 있는 일반 스킬이 슬롯 수보다 많아 선택이 생기고, 궁극기는 후반에 열린다', () => {
    const early = SKILLS.filter((s) => !s.ultimate && s.unlockProficiency === 0);
    expect(early.length).toBeGreaterThan(SKILL_SLOTS);
    const ults = SKILLS.filter((s) => s.ultimate);
    expect(ults.length).toBeGreaterThan(ULTIMATE_SLOTS);
    for (const u of ults) expect(u.unlockProficiency, u.id).toBeGreaterThanOrEqual(150);
  });

  it('지력 장비가 있어 회복 스킬 빌드가 가능하다', () => {
    expect(ITEMS.some((i) => (i.int ?? 0) > 0)).toBe(true);
    expect(computeStats([itemById('sage_staff')!]).int).toBe(BASE_STATS.int + 18);
  });
});

describe('던전·몹 무결성', () => {
  it('모든 몹은 존재하는 던전에 속하고, 던전의 몹 목록과 일치한다', () => {
    for (const m of MOBS) expect(dungeonById(m.dungeon), m.id).toBeDefined();
    for (const d of DUNGEONS) {
      expect(d.mobs.length, d.id).toBeGreaterThan(0);
      for (const id of d.mobs) expect(MOBS.find((m) => m.id === id)?.dungeon, `${d.id}:${id}`).toBe(d.id);
    }
    expect(DUNGEONS.flatMap((d) => d.mobs).sort()).toEqual(MOBS.map((m) => m.id).sort());
  });

  it('던전마다 보스가 마지막에 있고, 열쇠를 요구하면 그 열쇠 아이템이 존재한다', () => {
    for (const d of DUNGEONS) {
      const last = MOBS.find((m) => m.id === d.mobs[d.mobs.length - 1])!;
      expect(last.kind, d.id).toBe('boss');
      if (d.entry.bossKey) expect(itemById(d.entry.bossKey), d.id).toBeDefined();
    }
  });

  it('입장 비용: 일반 몹은 골드만, 보스는 열쇠+골드 (기본 던전은 무료)', () => {
    const lappus = MOBS.find((m) => m.id === 'lappus')!;
    const oppoko = MOBS.find((m) => m.id === 'oppoko')!;
    expect(entryCost(lappus)).toEqual({ gold: 100, key: null });
    expect(entryCost(oppoko)).toEqual({ gold: 400, key: 'midrealm_key' });
    expect(entryCost(MOBS.find((m) => m.id === 'rich')!)).toEqual({ gold: 0, key: null });
  });

  it('중간계 열쇠는 리치 보상(황금 리치)으로 만들 수 있고 던전 진입에 쓰인다', () => {
    const recipe = RECIPES.find((r) => r.resultId === 'midrealm_key')!;
    expect(recipe.materials.map((m) => m.itemId)).toContain('golden_lich');
    expect(MOBS.find((m) => m.id === 'rich')!.drops.some((d) => d.itemId === 'golden_lich' && d.chance === 1)).toBe(true);
    expect(itemById('midrealm_key')!.sell).toBe(0); // 팔 수 없다
  });

  it('보스 스크립트가 있는 몹은 패턴 풀의 모든 ID가 정의돼 있다', () => {
    for (const [mobId, sc] of Object.entries(BOSS_SCRIPTS)) {
      expect(MOBS.find((m) => m.id === mobId), mobId).toBeDefined();
      const patterns = sc.patterns as Record<string, unknown>;
      for (const ph of sc.phases as { pool: { id: string }[] }[]) {
        for (const p of ph.pool) expect(patterns[p.id], `${mobId}:${p.id}`).toBeDefined();
      }
    }
  });

  it('중간계 몹 4종과 코에도스는 모두 공략 힌트(note)를 가진다', () => {
    for (const id of ['lappus', 'raufaino', 'toka_loga', 'xenosaurs', 'oppoko']) {
      expect(MOBS.find((m) => m.id === id)!.note, id).toBeTruthy();
      expect(BOSS_SCRIPTS[id], id).toBeDefined();
    }
  });
});
