import { describe, expect, it } from 'vitest';
import { AP_MAX, canUseSkill, createBattle, resolveRound } from './battle';
import type { Action, BattleState, Combatant, SkillDef } from './types';

const SK: Record<string, SkillDef> = {
  strike: { id: 'strike', name: '강타', apCost: 2, cooldown: 0, priority: 'normal', target: 'enemy', effects: [{ kind: 'damage', coef: 150 }] },
  multi: { id: 'multi', name: '연속 베기', apCost: 3, cooldown: 2, priority: 'normal', target: 'enemy', effects: [{ kind: 'damage', coef: 50, hits: 3 }] },
  pierce: { id: 'pierce', name: '관통', apCost: 1, cooldown: 0, priority: 'normal', target: 'enemy', effects: [{ kind: 'damage', coef: 100, ignoreDefPct: 50 }] },
  weakpoint: { id: 'weakpoint', name: '약점 공격', apCost: 1, cooldown: 0, priority: 'normal', target: 'enemy', effects: [{ kind: 'damage', coef: 100, vsVulnerablePct: 50 }] },
  analyze: { id: 'analyze', name: '약점 분석', apCost: 1, cooldown: 0, priority: 'first', target: 'enemy', effects: [{ kind: 'status', to: 'target', status: { id: 'vulnerable', takenMult: 1.5, turns: 3, harmful: true } }] },
  frenzy: { id: 'frenzy', name: '광란', apCost: 1, cooldown: 3, priority: 'first', target: 'self', effects: [{ kind: 'status', to: 'self', status: { id: 'atk_up', atkMult: 2, takenMult: 1.1, turns: 2 } }] },
  bleed: { id: 'bleed', name: '출혈', apCost: 1, cooldown: 0, priority: 'normal', target: 'enemy', effects: [{ kind: 'status', to: 'target', status: { id: 'bleed', turns: 3, startsNextRound: true, dotAtkPct: 50, harmful: true } }] },
  heal: { id: 'heal', name: '치유', apCost: 2, cooldown: 0, priority: 'last', target: 'self', effects: [{ kind: 'heal', scale: 'int', coef: 150 }] },
  firstaid: { id: 'firstaid', name: '응급 처치', apCost: 1, cooldown: 0, priority: 'last', target: 'self', effects: [{ kind: 'heal', scale: 'int', coef: 100, doubleBelowPct: 30 }] },
  regen: { id: 'regen', name: '재생', apCost: 1, cooldown: 0, priority: 'last', target: 'self', effects: [{ kind: 'status', to: 'self', status: { id: 'regen', turns: 3, startsNextRound: true, hotIntPct: 50 } }] },
  shield: { id: 'shield', name: '보호막', apCost: 1, cooldown: 0, priority: 'first', target: 'self', effects: [{ kind: 'shield', maxHpPct: 10, turns: 2 }] },
  ironwall: {
    id: 'ironwall', name: '철벽', apCost: 1, cooldown: 0, priority: 'first', target: 'self',
    effects: [
      { kind: 'status', to: 'self', status: { id: 'ironwall', takenMult: 0.5, turns: 1 } },
      { kind: 'status', to: 'self', status: { id: 'ironwall2', takenMult: 0.8, turns: 1, startsNextRound: true } },
    ],
  },
  counter: { id: 'counter', name: '반격 태세', apCost: 1, cooldown: 0, priority: 'first', target: 'self', effects: [{ kind: 'status', to: 'self', status: { id: 'counter', reflectPct: 0.8, turns: 1 } }] },
  purify: { id: 'purify', name: '정화', apCost: 1, cooldown: 0, priority: 'first', target: 'self', effects: [{ kind: 'cleanse', count: 1 }] },
  focus: { id: 'focus', name: '일점 집중', apCost: 1, cooldown: 3, priority: 'delayed', target: 'enemy', effects: [{ kind: 'damage', coef: 400 }] },
  discount: { id: 'discount', name: '개방', apCost: 1, cooldown: 0, priority: 'first', target: 'self', effects: [{ kind: 'status', to: 'self', status: { id: 'open', apDiscount: 1, turns: 3 } }] },
  gainap: { id: 'gainap', name: '재정비', apCost: 0, cooldown: 0, priority: 'first', target: 'self', effects: [{ kind: 'ap', amount: 3 }] },
  sweep: { id: 'sweep', name: '휩쓸기', apCost: 1, cooldown: 0, priority: 'normal', target: 'all_enemies', effects: [{ kind: 'damage', coef: 100 }] },
  execute: { id: 'execute', name: '처형', ultimate: true, apCost: 0, cooldown: 0, priority: 'normal', target: 'enemy', effects: [{ kind: 'damage', coef: 200, executeBelowPct: 30, executeCoef: 500 }] },
  wall: { id: 'wall', name: '최후의 방패', ultimate: true, apCost: 0, cooldown: 0, priority: 'first', target: 'self', effects: [{ kind: 'status', to: 'self', status: { id: 'wall', undying: true, turns: 1 } }] },
};

const me = (over: Partial<Combatant> = {}, stats: Partial<Combatant['stats']> = {}): Combatant => ({
  id: 'p', name: '모험가', side: 'player', hp: 100, guardedLastRound: false, ap: 4, gauge: 0,
  stats: { maxHp: 100, atk: 20, def: 0, spd: 10, int: 20, ...stats }, ...over,
});
const foe = (over: Partial<Combatant> = {}, stats: Partial<Combatant['stats']> = {}): Combatant => ({
  id: 'enemy', name: '허수아비', side: 'enemy', hp: 1000, guardedLastRound: false,
  stats: { maxHp: 1000, atk: 0, def: 0, spd: 1, ...stats }, ...over,
});
const battle = (p = me(), e = foe()) => createBattle([p, e], 1, undefined, SK);
// 허수아비는 방어도 공격도 하지 않고 가만히 있는다 (행동이 없으면 엔진은 방어로 간주하므로 '빈 아이템'을 쓴다)
const idle: Action = { kind: 'item', itemId: 'none', healHp: 0 };
const skill = (skillId: string, targetId = 'enemy'): Record<string, Action> => ({ p: { kind: 'skill', skillId, targetId }, enemy: idle });
const attack: Record<string, Action> = { p: { kind: 'attack', targetId: 'enemy' }, enemy: idle };
const guard: Record<string, Action> = { p: { kind: 'guard' }, enemy: idle };
const hp = (s: BattleState, id = 'enemy') => s.combatants.find((c) => c.id === id)!.hp;
const mine = (s: BattleState) => s.combatants.find((c) => c.id === 'p')!;
const dealt = (r: ReturnType<typeof resolveRound>) => r.log.filter((l) => l.type === 'attack' && l.actorId === 'p').map((l) => l.amount);

describe('AP와 쿨다운', () => {
  it('스킬은 AP를 소모하고 계수만큼 피해를 준다', () => {
    const r = resolveRound(battle(), skill('strike'));
    expect(dealt(r)).toEqual([30]); // 20 × 150%
    expect(mine(r.state).ap).toBe(4 - 2 + 2); // 소모 후 라운드 종료 재생 +2
  });

  it('AP가 부족하면 스킬 대신 기본 공격이 나간다', () => {
    const r = resolveRound(battle(me({ ap: 1 })), skill('strike'));
    expect(dealt(r)).toEqual([20]);
    expect(r.log.some((l) => l.type === 'skip' && l.text.includes('기본 공격'))).toBe(true);
  });

  it('기본 공격은 AP +1, 라운드 종료마다 +2가 차고 최대치를 넘지 않는다', () => {
    const r = resolveRound(battle(me({ ap: 5 })), attack);
    expect(mine(r.state).ap).toBe(AP_MAX); // 5 + 1 + 2 → 상한 6
  });

  it('쿨다운 중에는 다시 쓸 수 없고, 지나면 쓸 수 있다', () => {
    let s = battle(me({ ap: 6 }));
    s = resolveRound(s, skill('multi')).state; // cooldown 2 → 3라운드째부터
    expect(canUseSkill(s, mine(s), 'multi')).toEqual({ ok: false, reason: 'cooldown' });
    s = resolveRound(s, guard).state;
    expect(canUseSkill(s, mine(s), 'multi')).toEqual({ ok: false, reason: 'cooldown' });
    s = resolveRound(s, guard).state;
    expect(canUseSkill(s, mine(s), 'multi').ok).toBe(true);
  });

  it('canUseSkill 은 이유를 알려 준다', () => {
    const s = battle(me({ ap: 0 }));
    expect(canUseSkill(s, mine(s), 'strike')).toEqual({ ok: false, reason: 'ap' });
    expect(canUseSkill(s, mine(s), 'nope')).toEqual({ ok: false, reason: 'unknown' });
    expect(canUseSkill(s, mine(s), 'execute')).toEqual({ ok: false, reason: 'gauge' });
  });
});

describe('피해 스킬', () => {
  it('다단 히트는 계수만큼 여러 번 때린다', () => {
    expect(dealt(resolveRound(battle(me({ ap: 6 })), skill('multi')))).toEqual([10, 10, 10]);
  });

  it('방어 무시 비율만큼 대상 방어력을 깎는다', () => {
    const r = resolveRound(battle(me(), foe({}, { def: 10 })), skill('pierce'));
    expect(dealt(r)).toEqual([15]); // 20 - 10×0.5
  });

  it('취약 대상에게는 추가 피해를 준다', () => {
    let s = battle(me({ ap: 6 }));
    s = resolveRound(s, skill('analyze')).state;
    const r = resolveRound(s, skill('weakpoint'));
    expect(dealt(r)).toEqual([Math.round(20 * 1.5 * 1.5)]); // 계수 +50% × 받는 피해 ×1.5
    expect(dealt(resolveRound(battle(), skill('weakpoint')))).toEqual([20]);
  });

  it('전체 공격은 모든 적에게 들어간다', () => {
    const s = battle();
    s.combatants.push({ id: 'e2', name: '또', side: 'enemy', hp: 100, guardedLastRound: false, stats: { maxHp: 100, atk: 0, def: 0, spd: 1 } });
    const r = resolveRound(s, { ...skill('sweep'), e2: idle });
    expect(hp(r.state, 'enemy')).toBe(980);
    expect(hp(r.state, 'e2')).toBe(80);
  });

  it('처형: 대상 HP가 30% 이하일 때만 계수가 커진다', () => {
    const full = battle(me({ gauge: 100 }));
    expect(dealt(resolveRound(full, skill('execute')))).toEqual([40]);
    const low = battle(me({ gauge: 100 }), foe({ hp: 200 }));
    expect(dealt(resolveRound(low, skill('execute')))).toEqual([100]);
  });
});

describe('상태 효과', () => {
  it('선행 버프는 같은 라운드의 공격에 반영되고 기간이 끝나면 사라진다', () => {
    let s = battle(me({ ap: 6 }));
    const r1 = resolveRound(s, skill('frenzy'));
    s = r1.state;
    expect(mine(s).statuses?.map((x) => x.id)).toEqual(['atk_up']);
    expect(dealt(resolveRound(s, attack))).toEqual([40]); // ATK ×2 (2라운드 중 2번째)
    const s3 = resolveRound(resolveRound(s, attack).state, attack);
    expect(dealt(s3)).toEqual([20]); // 만료
  });

  it('출혈은 다음 라운드부터 3번 고정 피해를 준다', () => {
    let s = battle(me({ ap: 6 }));
    s = resolveRound(s, skill('bleed')).state;
    expect(hp(s)).toBe(1000); // 걸린 라운드에는 피해 없음
    const ticks: number[] = [];
    for (let i = 0; i < 4; i++) {
      const before = hp(s);
      s = resolveRound(s, guard).state;
      ticks.push(before - hp(s));
    }
    expect(ticks).toEqual([10, 10, 10, 0]); // ATK 20 × 50%
  });

  it('철벽: 이번 라운드 -50%, 다음 라운드 -20%, 그 다음은 정상', () => {
    const s = battle(me({ ap: 6 }, { maxHp: 1000 }), foe({}, { atk: 100 }));
    s.combatants.find((c) => c.id === 'p')!.hp = 1000;
    s.boss = undefined;
    // 적 행동을 직접 지정하는 일반 전투
    const act = (a: Action): Record<string, Action> => ({ p: a, enemy: { kind: 'attack', targetId: 'p' } });
    const taken = (r: ReturnType<typeof resolveRound>) => 1000 - hp(r.state, 'p');
    const r1 = resolveRound(s, act({ kind: 'skill', skillId: 'ironwall' }));
    expect(taken(r1)).toBe(50);
    const r2 = resolveRound(r1.state, act({ kind: 'attack', targetId: 'enemy' }));
    expect(hp(r2.state, 'p') - 0).toBe(hp(r1.state, 'p') - 80);
    const r3 = resolveRound(r2.state, act({ kind: 'attack', targetId: 'enemy' }));
    expect(hp(r3.state, 'p')).toBe(hp(r2.state, 'p') - 100);
  });

  it('반격 태세는 받은 피해의 일부를 되돌리고, 공격받지 않으면 아무 일도 없다', () => {
    const s = battle(me({ ap: 6 }), foe({}, { atk: 50 }));
    const act = (a: Action): Record<string, Action> => ({ p: a, enemy: { kind: 'attack', targetId: 'p' } });
    const r = resolveRound(s, act({ kind: 'skill', skillId: 'counter' }));
    expect(hp(r.state)).toBe(1000 - 40); // 50 피해 × 80% 반사
    const quiet = resolveRound(s, { p: { kind: 'skill', skillId: 'counter' }, enemy: idle });
    expect(hp(quiet.state)).toBe(1000);
  });

  it('보호막이 피해를 먼저 흡수한다', () => {
    const s = battle(me({ ap: 6 }), foe({}, { atk: 14 }));
    const r = resolveRound(s, { p: { kind: 'skill', skillId: 'shield' }, enemy: { kind: 'attack', targetId: 'p' } });
    expect(hp(r.state, 'p')).toBe(100 - 4); // 보호막 10이 14 피해 중 10을 흡수하고 4만 HP를 깎는다
    expect(r.log.some((l) => l.text.includes('보호막 10 흡수'))).toBe(true);
  });

  it('정화는 해로운 효과를 지운다', () => {
    const p = me({ ap: 6 });
    p.statuses = [{ id: 'weaken', until: 9, atkMult: 0.5, harmful: true }, { id: 'buff', until: 9, atkMult: 1.2 }];
    const r = resolveRound(battle(p), skill('purify'));
    expect(mine(r.state).statuses?.map((x) => x.id)).toEqual(['buff']);
  });

  it('최후의 방패는 치명적인 피해에도 HP 1이 남게 한다', () => {
    const s = battle(me({ gauge: 100 }), foe({}, { atk: 9999 }));
    const r = resolveRound(s, { p: { kind: 'skill', skillId: 'wall' }, enemy: { kind: 'attack', targetId: 'p' } });
    expect(hp(r.state, 'p')).toBe(1);
    expect(r.state.status).toBe('ongoing');
  });

  it('AP 비용 감소는 스킬 비용에 반영된다', () => {
    let s = battle(me({ ap: 6 }));
    s = resolveRound(s, skill('discount')).state; // -1 AP, 이후 +2
    const before = mine(s).ap!;
    const r = resolveRound(s, skill('strike')); // 2 → 1
    expect(mine(r.state).ap).toBe(Math.min(AP_MAX, before - 1 + 2));
  });

  it('AP 회복 스킬', () => {
    const r = resolveRound(battle(me({ ap: 0 })), skill('gainap'));
    expect(mine(r.state).ap).toBe(Math.min(AP_MAX, 3 + 2));
  });
});

describe('회복', () => {
  it('지력 계수만큼 회복하고 최대 HP를 넘지 않는다', () => {
    const p = me({ hp: 40, ap: 6 });
    expect(hp(resolveRound(battle(p), skill('heal')).state, 'p')).toBe(40 + 30);
    const full = me({ hp: 95, ap: 6 });
    expect(hp(resolveRound(battle(full), skill('heal')).state, 'p')).toBe(100);
  });

  it('응급 처치는 HP 30% 이하일 때 두 배', () => {
    expect(hp(resolveRound(battle(me({ hp: 50, ap: 6 })), skill('firstaid')).state, 'p')).toBe(70);
    expect(hp(resolveRound(battle(me({ hp: 20, ap: 6 })), skill('firstaid')).state, 'p')).toBe(60);
  });

  it('재생은 다음 라운드부터 3번 회복한다', () => {
    let s = battle(me({ hp: 10, ap: 6 }));
    s = resolveRound(s, skill('regen')).state;
    expect(hp(s, 'p')).toBe(10);
    const gains: number[] = [];
    for (let i = 0; i < 4; i++) { const b = hp(s, 'p'); s = resolveRound(s, guard).state; gains.push(hp(s, 'p') - b); }
    expect(gains).toEqual([10, 10, 10, 0]); // 지력 20 × 50%
  });
});

describe('우선순위', () => {
  it('선행 스킬은 속도와 무관하게 먼저, 후행(회복)은 피해 뒤에 처리된다', () => {
    const p = me({ hp: 10, ap: 6 }, { spd: 1 });
    const s = battle(p, foe({}, { atk: 5, spd: 99 }));
    const r = resolveRound(s, { p: { kind: 'skill', skillId: 'heal' }, enemy: { kind: 'attack', targetId: 'p' } });
    // 적이 먼저 5 피해(10→5) → 이후 회복 +30 = 35
    expect(hp(r.state, 'p')).toBe(35);
    const first = battle(me({ ap: 6 }, { spd: 1 }), foe({}, { atk: 50, spd: 99 }));
    const r2 = resolveRound(first, { p: { kind: 'skill', skillId: 'ironwall' }, enemy: { kind: 'attack', targetId: 'p' } });
    expect(hp(r2.state, 'p')).toBe(100 - 25); // 선행으로 -50% 적용 후 피격
  });
});

describe('충전 스킬(일점 집중)', () => {
  it('이번 라운드는 충전만 하고 다음 라운드에 가장 마지막으로 발동한다', () => {
    let s = battle(me({ ap: 6 }, { spd: 99 }), foe({}, { spd: 5 }));
    const r1 = resolveRound(s, skill('focus'));
    expect(dealt(r1)).toEqual([]);
    expect(mine(r1.state).pending).toMatchObject({ skillId: 'focus', fireRound: 2 });
    expect(canUseSkill(r1.state, mine(r1.state), 'strike')).toEqual({ ok: false, reason: 'charging' });
    // 다음 라운드에는 무엇을 고르든 충전한 스킬이 나간다
    const r2 = resolveRound(r1.state, guard);
    expect(dealt(r2)).toEqual([80]); // 20 × 400%
    expect(mine(r2.state).pending).toBeUndefined();
    s = r2.state;
    expect(canUseSkill(s, mine(s), 'focus')).toEqual({ ok: false, reason: 'cooldown' });
  });
});

describe('궁극기 게이지', () => {
  it('피해를 주고 받을 때 차오르고 100이면 쓸 수 있으며 사용하면 비워진다', () => {
    let s = battle(me({ ap: 6 }), foe({}, { atk: 1 }));
    expect(canUseSkill(s, mine(s), 'execute')).toEqual({ ok: false, reason: 'gauge' });
    for (let i = 0; i < 5; i++) {
      s = resolveRound(s, { p: { kind: 'attack', targetId: 'enemy' }, enemy: { kind: 'attack', targetId: 'p' } }).state;
    }
    expect(mine(s).gauge).toBe(100); // (주는 10 + 받는 10) × 5
    expect(canUseSkill(s, mine(s), 'execute').ok).toBe(true);
    s = resolveRound(s, skill('execute')).state;
    expect(mine(s).gauge).toBeLessThan(100);
  });
});

describe('안정성', () => {
  it('입력 상태를 변경하지 않는다', () => {
    const s = battle(me({ ap: 6 }));
    const snap = JSON.stringify(s);
    resolveRound(s, skill('strike'));
    resolveRound(s, skill('focus'));
    expect(JSON.stringify(s)).toBe(snap);
  });

  it('무작위 스킬 사용 500판: 수치 범위·종료·NaN 없음', () => {
    const ids = Object.keys(SK);
    for (let seed = 1; seed <= 500; seed++) {
      let s = createBattle([me({ ap: 4, gauge: seed % 2 ? 100 : 0, hp: 150 }, { maxHp: 150 }), foe({ hp: 300 }, { maxHp: 300, atk: 20, def: 3 })], seed, undefined, SK);
      let n = 0;
      while (s.status === 'ongoing' && n++ < 100) {
        const pick = ids[(seed * 31 + n * 7) % ids.length]!;
        const act: Action = n % 4 === 0 ? { kind: 'guard' } : n % 3 === 0 ? { kind: 'attack', targetId: 'enemy' } : { kind: 'skill', skillId: pick, targetId: 'enemy' };
        s = resolveRound(s, { p: act, enemy: { kind: 'attack', targetId: 'p' } }).state;
        for (const c of s.combatants) {
          expect(Number.isFinite(c.hp)).toBe(true);
          expect(c.hp).toBeGreaterThanOrEqual(0);
          expect(c.hp).toBeLessThanOrEqual(c.stats.maxHp);
          if (c.ap !== undefined) { expect(c.ap).toBeGreaterThanOrEqual(0); expect(c.ap).toBeLessThanOrEqual(AP_MAX); }
          if (c.gauge !== undefined) { expect(c.gauge).toBeGreaterThanOrEqual(0); expect(c.gauge).toBeLessThanOrEqual(100); }
        }
      }
      expect(s.status, `seed ${seed}`).not.toBe('ongoing');
    }
  });
});
