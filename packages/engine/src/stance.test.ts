import { describe, expect, it } from 'vitest';
import { createBattle, resolveRound } from './battle';
import type { Action, BattleState, BossScript, Combatant, SkillDef } from './types';

const script: BossScript = {
  bossId: 'enemy',
  patterns: {
    strike: { kind: 'attack', name: '내리치기', mult: 1, telegraph: '움직인다.' },
    twin: { kind: 'attack', name: '쌍격', mult: 0.5, hits: 2, telegraph: '두 번 노린다.' },
    shell: { kind: 'stance', name: '웅크리기', takenMult: 0.5, reflectPct: 0.5, telegraph: '등껍질 속으로 움츠린다.' },
    mirror: { kind: 'mirror', name: '거울 복제', pct: 1, telegraph: '거울이 일렁인다.' },
  },
  phases: [
    { fromHpPct: 100, atkMult: 1, pool: [{ id: 'strike', weight: 1 }] },
    { fromHpPct: 60, atkMult: 1, pool: [{ id: 'strike', weight: 1 }] },
    { fromHpPct: 25, atkMult: 1, pool: [{ id: 'strike', weight: 1 }] },
  ],
  stance: {
    counter: { reduction: 0.5, reflect: 0.6 },
    offense: { atkMult: 1.6, guardPierce: 0.4 },
    enhancedFromPhase: 2, enhancedMult: 1.5,
    reversalFromPhase: 3, reversalEvery: 3,
  },
};
const withPool = (id: string, base: BossScript = script): BossScript => ({
  ...base, phases: base.phases.map((p) => ({ ...p, pool: [{ id, weight: 1 }] })),
});

const SKILL: Record<string, SkillDef> = {
  zap: { id: 'zap', name: '번개', apCost: 1, cooldown: 0, priority: 'normal', target: 'enemy', effects: [{ kind: 'damage', coef: 100 }] },
};
const player = (over: Partial<Combatant['stats']> = {}): Combatant => ({
  id: 'p', name: '모험가', side: 'player', hp: 1000, guardedLastRound: false, ap: 6, gauge: 0,
  stats: { maxHp: 1000, atk: 100, def: 0, spd: 10, ...over },
});
const boss = (over: Partial<Combatant['stats']> = {}, hp = 10000): Combatant => ({
  id: 'enemy', name: '코에도스', side: 'enemy', hp, guardedLastRound: false,
  stats: { maxHp: 10000, atk: 50, def: 0, spd: 5, ...over },
});
const start = (sc = script, p = player(), b = boss()) => createBattle([p, b], 1, sc, SKILL);
const attack: Action = { kind: 'attack', targetId: 'enemy' };
const guard: Action = { kind: 'guard' };
const zap: Action = { kind: 'skill', skillId: 'zap', targetId: 'enemy' };
const item: Action = { kind: 'item', itemId: 'x', healHp: 0 };
const bossHp = (s: BattleState) => s.combatants.find((c) => c.id === 'enemy')!.hp;
const myHp = (s: BattleState) => s.combatants.find((c) => c.id === 'p')!.hp;
const step = (s: BattleState, a: Action) => resolveRound(s, { p: a });

describe('반대 자세 (코에도스)', () => {
  it('첫 라운드는 중립이다', () => {
    expect(start().boss!.runtime.stance).toBe('neutral');
  });

  it('기본 공격하면 다음 라운드는 반격의 자세: 기본 공격 피해가 줄고 일부가 되돌아온다', () => {
    let s = step(start(), attack).state;
    expect(s.boss!.runtime.stance).toBe('counter');
    const hpBefore = myHp(s);
    const bHp = bossHp(s);
    const r = step(s, attack);
    expect(bHp - bossHp(r.state)).toBe(50); // 100 × (1 − 0.5)
    // 되돌아온 피해 = 50 × 60% = 30, 보스 본인 공격 50
    expect(hpBefore - myHp(r.state)).toBe(50 + 30);
    expect(r.log.some((l) => l.text.includes('반격'))).toBe(true);
  });

  it('스킬은 반격의 자세의 영향을 받지 않는다 (기본 공격 직후에도)', () => {
    const s = step(start(), attack).state;
    const bHp = bossHp(s);
    const r = step(s, zap);
    expect(bHp - bossHp(r.state)).toBe(100);
    expect(r.log.some((l) => l.text.includes('반격'))).toBe(false);
  });

  it('방어하면 다음 라운드는 공세의 자세: 보스 공격력이 오르고 방어 효과를 일부 무시한다', () => {
    const s = step(start(), guard).state;
    expect(s.boss!.runtime.stance).toBe('offense');
    const hpBefore = myHp(s);
    const r = step(s, guard);
    // ATK 50 × 1.6 = 80. 연속 방어라 방어 효과는 15%이고 그중 40%를 무시 → 감소 9%
    expect(hpBefore - myHp(r.state)).toBe(Math.round(80 * (1 - 0.15 * 0.6)));
    // 같은 조건에서 공세의 자세가 없었다면 50 × 0.85 = 43 피해였다
    expect(hpBefore - myHp(r.state)).toBeGreaterThan(Math.round(50 * 0.85));
  });

  it('스킬이나 아이템을 쓰면 다음 라운드는 중립으로 돌아온다', () => {
    let s = step(start(), attack).state;
    s = step(s, zap).state;
    expect(s.boss!.runtime.stance).toBe('neutral');
    s = step(s, attack).state;
    s = step(s, item).state;
    expect(s.boss!.runtime.stance).toBe('neutral');
  });

  it('2페이즈부터 같은 행동을 연속하면 자세 효과가 1.5배로 강해진다', () => {
    let s = start();
    s.boss!.runtime.phase = 2;
    s = step(s, attack).state;
    expect(s.boss!.runtime.stanceBoost).toBe(1); // 첫 공격은 연속이 아니다
    const r = step(s, attack);
    expect(r.state.boss!.runtime.stanceBoost).toBe(1.5);
    const bHp = bossHp(r.state);
    const r2 = step(r.state, attack);
    expect(bHp - bossHp(r2.state)).toBe(Math.round(100 * (1 - 0.75))); // 감소 50% × 1.5
  });

  it('3페이즈에서는 3라운드마다 규칙이 반전된다 (공격 → 공세)', () => {
    let s = start();
    s.boss!.runtime.phase = 3;
    s = step(s, attack).state; // 1라운드 종료 → 2라운드: 반격
    expect(s.boss!.runtime).toMatchObject({ stance: 'counter', reversed: false });
    s = step(s, attack).state; // 2라운드 종료 → 3라운드: 반전
    expect(s.round).toBe(3);
    expect(s.boss!.runtime).toMatchObject({ reversed: true, stance: 'offense' });
    s = step(s, attack).state; // 4라운드는 정상
    expect(s.boss!.runtime.reversed).toBe(false);
  });

  it('보스가 스킬로 쓰러져도 중립/자세 계산이 깨지지 않는다 (무작위 200판)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      let s = createBattle([player({ atk: 80 }), boss({ atk: 60 }, 900)], seed, script, SKILL);
      s.combatants.find((c) => c.id === 'enemy')!.stats.maxHp = 900;
      let n = 0;
      while (s.status === 'ongoing' && n++ < 80) {
        const acts: Action[] = [attack, guard, zap, item];
        s = step(s, acts[(seed + n * 3) % 4]!).state;
        expect(['neutral', 'counter', 'offense']).toContain(s.boss!.runtime.stance);
        for (const c of s.combatants) { expect(Number.isFinite(c.hp)).toBe(true); expect(c.hp).toBeGreaterThanOrEqual(0); }
      }
      expect(s.status).not.toBe('ongoing');
    }
  });
});

describe('다단 타격과 웅크리기, 거울 복제', () => {
  it('연속 타격은 같은 대상에게 여러 번 피해를 준다', () => {
    const s = start(withPool('twin'));
    const r = step(s, guard);
    const hits = r.log.filter((l) => l.type === 'attack' && l.actorId === 'enemy');
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.amount === Math.round(50 * 0.5 * 0.7))).toBe(true); // 방어 30% 감소
  });

  it('웅크리기는 선행으로 이번 라운드 피해를 줄이고 공격한 쪽에 반사한다', () => {
    const s = start(withPool('shell'), player(), boss({ spd: 99 }));
    const r = step(s, attack);
    // 보스가 느려도 선행이라 먼저 웅크린다: 100 × 0.5 = 50 피해, 반사 25
    expect(bossHp(s) - bossHp(r.state)).toBe(50);
    expect(r.log.some((l) => l.text.includes('반격'))).toBe(true);
    expect(myHp(r.state)).toBe(1000 - 25);
    // 웅크림은 그 라운드만 유효하다: 다음 라운드(스킬은 반격의 자세와 무관)에는 피해가 그대로 들어간다
    const r2 = resolveRound({ ...r.state, intents: { enemy: { patternId: 'strike', kind: 'attack', name: '내리치기', telegraph: '', targetId: 'p' } } }, { p: zap });
    expect(bossHp(r.state) - bossHp(r2.state)).toBe(100);
  });

  it('거울 복제는 플레이어가 직전 라운드에 입힌 피해를 되돌려 준다', () => {
    let s = start(withPool('mirror'), player(), boss({ spd: 99 }));
    s = step(s, zap).state; // 직전 라운드 입힌 피해 100 (거울 복제는 쓸 피해가 없어 건너뜀)
    expect(s.boss!.runtime.lastPlayerDamage).toBe(100);
    const hpBefore = myHp(s);
    const r = step(s, item); // 이번 라운드엔 가만히 있어도 직전 피해가 되돌아온다
    expect(hpBefore - myHp(r.state)).toBe(100);
    expect(r.log.some((l) => l.text.includes('거울 복제'))).toBe(true);
  });

  it('거울 복제는 되돌려 줄 피해가 없으면 계획에서 제외된다', () => {
    const s = start({ ...script, phases: script.phases.map((p) => ({ ...p, pool: [{ id: 'mirror', weight: 1 }, { id: 'strike', weight: 1 }] })) });
    for (let i = 0; i < 30; i++) {
      const fresh = createBattle([player(), boss()], i + 1, script, SKILL);
      expect(fresh.intents!.enemy!.patternId).not.toBe('mirror');
    }
    void s;
  });

  it('오래된 저장 상태(새 필드 없음)도 이어서 처리한다', () => {
    const s = start();
    const old = JSON.parse(JSON.stringify(s)) as BattleState;
    delete (old.boss!.runtime as unknown as Record<string, unknown>).lastActions;
    delete (old.boss!.runtime as unknown as Record<string, unknown>).stance;
    expect(() => step(old, attack)).not.toThrow();
  });
});
