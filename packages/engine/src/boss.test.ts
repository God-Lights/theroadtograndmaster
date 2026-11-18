import { describe, expect, it } from 'vitest';
import { createBattle, resolveRound } from './battle';
import type { Action, BattleState, BossScript, Combatant } from './types';

const script: BossScript = {
  bossId: 'enemy',
  patterns: {
    arrow: { kind: 'attack', name: '화살', mult: 1, telegraph: '마력이 모인다.' },
    curse: { kind: 'debuff', name: '저주', atkMult: 0.5, turns: 2, telegraph: '저주를 읊는다.' },
    drain: { kind: 'drain', name: '흡수', pct: 0.2, telegraph: '빨아들인다.' },
    summon: { kind: 'summon', name: '소집', count: 2, minPhase: 2, telegraph: '일어난다.' },
    touch: {
      kind: 'charge_attack', name: '손길', mult: 3, chargeRounds: [2, 2, 1], interruptPct: [0.1, 0.1, 0.05],
      minGap: 3, minPhase: 2, telegraphCharge: '손을 뻗는다.', telegraphRelease: '손이 닿는다!',
    },
  },
  phases: [
    { fromHpPct: 100, atkMult: 1, pool: [{ id: 'arrow', weight: 1 }] },
    { fromHpPct: 60, atkMult: 1, enterText: '의식이 시작된다!', pool: [{ id: 'arrow', weight: 1 }] },
    { fromHpPct: 25, atkMult: 2, enterText: '분노한다!', pool: [{ id: 'arrow', weight: 1 }] },
  ],
  vessel: { name: '영혼함', hp: 50, def: 0, damageReduction: 0.6, reviveHpPct: 0.3, appearsAtPhase: 2 },
  minion: { name: '하수인', stats: { maxHp: 30, atk: 10, def: 0, spd: 5 }, max: 2, healBossPct: 0.05 },
};

const player = (over: Partial<Combatant['stats']> = {}): Combatant => ({
  id: 'p', name: '모험가', side: 'player', hp: 1000, guardedLastRound: false,
  stats: { maxHp: 1000, atk: 30, def: 0, spd: 10, ...over },
});
const boss = (over: Partial<Combatant['stats']> = {}, hp = 1000): Combatant => ({
  id: 'enemy', name: '리치', side: 'enemy', hp, guardedLastRound: false,
  stats: { maxHp: 1000, atk: 20, def: 0, spd: 5, ...over },
});
const withPatterns = (pool: string[]): BossScript => ({
  ...script,
  phases: script.phases.map((p) => ({ ...p, pool: pool.map((id) => ({ id, weight: 1 })) })),
});
const attack = (targetId = 'enemy'): Record<string, Action> => ({ p: { kind: 'attack', targetId } });
const guard: Record<string, Action> = { p: { kind: 'guard' } };
const setBoss = (s: BattleState, hp: number) => { s.combatants.find((c) => c.id === 'enemy')!.hp = hp; return s; };

describe('행동 예고', () => {
  it('보스전은 시작할 때부터 다음 행동이 예고된다', () => {
    const s = createBattle([player(), boss()], 1, script);
    expect(s.intents?.enemy).toMatchObject({ patternId: 'arrow', telegraph: '마력이 모인다.', targetId: 'p' });
  });

  it('예고된 행동이 그대로 실행되고 다음 예고가 갱신된다', () => {
    const s = createBattle([player({ def: 5 }), boss()], 1, script);
    const r = resolveRound(s, guard);
    expect(r.log.some((l) => l.text.includes('화살'))).toBe(true);
    expect(r.state.intents?.enemy).toBeDefined();
    expect(r.state.round).toBe(2);
  });

  it('같은 보스 상태·시드·입력이면 결과가 같다 (결정론)', () => {
    const s = createBattle([player(), boss()], 7, withPatterns(['arrow', 'curse', 'drain']));
    expect(resolveRound(s, attack())).toEqual(resolveRound(s, attack()));
  });
});

describe('약화의 저주', () => {
  it('저주가 걸리면 플레이어 공격력이 낮아진다', () => {
    let s = createBattle([player(), boss({ spd: 99 })], 1, withPatterns(['curse']));
    s = resolveRound(s, guard).state; // 보스가 저주를 건다
    expect(s.combatants.find((c) => c.id === 'p')!.statuses).toEqual([{ id: 'weaken', until: 3, atkMult: 0.5 }]);
    const r = resolveRound(s, attack());
    expect(r.log.find((l) => l.type === 'attack' && l.actorId === 'p')!.amount).toBe(15); // 30 × 0.5
  });

  it('유효 기간(2라운드)이 지나면 풀리고 공격력이 돌아온다', () => {
    const p = player();
    p.statuses = [{ id: 'weaken', until: 2, atkMult: 0.5 }];
    let s = createBattle([p, boss({ spd: 1 })], 1, withPatterns(['arrow']));
    const dmg = (r: ReturnType<typeof resolveRound>) => r.log.find((l) => l.type === 'attack' && l.actorId === 'p')!.amount;
    const r1 = resolveRound(s, attack());
    expect(dmg(r1)).toBe(15);
    const r2 = resolveRound(r1.state, attack()); // until=2 라운드까지 유지
    expect(dmg(r2)).toBe(15);
    expect(r2.state.combatants.find((c) => c.id === 'p')!.statuses).toEqual([]);
    expect(dmg(resolveRound(r2.state, attack()))).toBe(30);
  });
});

describe('생명 흡수', () => {
  it('플레이어 HP를 깎고 보스가 같은 만큼 회복한다 (방어하면 절반)', () => {
    const p = player({ maxHp: 100 }); p.hp = 100;
    const s = setBoss(createBattle([p, boss({ spd: 99 })], 1, withPatterns(['drain'])), 500);
    const r = resolveRound(s, { p: { kind: 'item', itemId: 'x', healHp: 0 } });
    expect(r.state.combatants.find((c) => c.id === 'p')!.hp).toBe(100 - 20);
    expect(r.state.combatants.find((c) => c.id === 'enemy')!.hp).toBe(520);
    const g = resolveRound(s, guard);
    expect(g.state.combatants.find((c) => c.id === 'p')!.hp).toBe(100 - 14);
  });
});

describe('페이즈와 영혼함', () => {
  it('HP 60% 이하가 되면 페이즈 전환 라운드가 오고 영혼함이 나타난다', () => {
    let s = setBoss(createBattle([player({ atk: 400 }), boss({ spd: 1 })], 1, script), 1000);
    const r = resolveRound(s, attack()); // 400 피해 → HP 600 (60%)
    s = r.state;
    expect(s.boss!.runtime.phase).toBe(2);
    expect(s.combatants.some((c) => c.role === 'vessel' && c.hp === 50)).toBe(true);
    expect(s.intents?.enemy?.kind).toBe('phase_shift');
    const r2 = resolveRound(s, guard);
    expect(r2.log.some((l) => l.type === 'phase' && l.text.includes('의식'))).toBe(true);
    expect(r2.state.intents?.enemy?.kind).not.toBe('phase_shift');
  });

  it('영혼함이 살아 있으면 보스 피해가 60% 줄어든다', () => {
    let s = setBoss(createBattle([player({ atk: 400 }), boss({ spd: 1 })], 1, script), 1000);
    s = resolveRound(s, attack()).state; // 페이즈 2, 영혼함 등장
    const bossHp = s.combatants.find((c) => c.id === 'enemy')!.hp;
    const r = resolveRound(s, attack());
    const dealt = bossHp - r.state.combatants.find((c) => c.id === 'enemy')!.hp;
    expect(dealt).toBe(Math.round(400 * 0.4));
  });

  it('영혼함을 부수면 보스가 경직되고 피해 감소가 사라진다', () => {
    let s = setBoss(createBattle([player({ atk: 400 }), boss({ spd: 1 })], 1, script), 1000);
    s = resolveRound(s, attack()).state;
    const r = resolveRound(s, attack('vessel'));
    expect(r.log.some((l) => l.text.includes('산산조각'))).toBe(true);
    expect(r.state.intents?.enemy?.kind).toBe('stunned');
    const bossHp = r.state.combatants.find((c) => c.id === 'enemy')!.hp;
    const r2 = resolveRound(r.state, attack());
    expect(bossHp - r2.state.combatants.find((c) => c.id === 'enemy')!.hp).toBe(400);
    expect(r2.log.some((l) => l.text.includes('움직이지 못했다'))).toBe(true);
  });

  it('영혼함이 살아 있는 채 쓰러지면 한 번 부활하고 영혼함은 소모된다', () => {
    let s = createBattle([player({ atk: 5000 }), boss({ spd: 1 })], 1, script);
    s = resolveRound(s, attack()).state; // 즉사급 피해 → 페이즈 2 진입 전에 쓰러짐(영혼함 없음)
    expect(s.status).toBe('victory');

    s = setBoss(createBattle([player({ atk: 5000 }), boss({ spd: 1 })], 1, script), 500);
    s = resolveRound(s, guard).state; // 보스 HP 500 → 페이즈 2 아님? (50%이지만 라운드 종료 시 전환)
    expect(s.boss!.runtime.phase).toBe(2);
    const r = resolveRound(s, attack());
    expect(r.log.some((l) => l.text.includes('되살아난다'))).toBe(true);
    expect(r.state.status).toBe('ongoing');
    expect(r.state.boss!.runtime.revived).toBe(true);
    expect(r.state.combatants.find((c) => c.id === 'enemy')!.hp).toBe(300);
    expect(r.state.combatants.find((c) => c.id === 'vessel')!.hp).toBe(0);
  });
});

describe('죽음의 손길 (충전 → 발동, 끊기)', () => {
  const touchOnly = { ...script, phases: script.phases.map((p) => ({ ...p, pool: [{ id: 'touch', weight: 1 }] })) };
  const inPhase2 = (atk = 5) => {
    const s = createBattle([player({ atk, def: 0 }), boss({ spd: 99 })], 3, touchOnly);
    s.boss!.runtime.phase = 2;
    s.intents = {};
    // 다음 예고를 다시 계획하기 위해 한 라운드 진행
    return resolveRound(s, guard).state;
  };

  it('충전 라운드에 예고가 보이고, 다음 라운드에 발동 예고로 바뀐다', () => {
    const s = inPhase2();
    expect(s.intents?.enemy).toMatchObject({ kind: 'charge', telegraph: '손을 뻗는다.' });
    const r = resolveRound(s, guard);
    expect(r.state.intents?.enemy).toMatchObject({ kind: 'release', telegraph: '손이 닿는다!' });
  });

  it('충전 중 보스 최대 HP 10% 이상 피해를 주면 끊기고 경직된다', () => {
    const s = inPhase2(150); // 150 피해 = 15%
    expect(s.intents?.enemy?.kind).toBe('charge');
    const r = resolveRound(s, attack());
    expect(r.log.some((l) => l.type === 'interrupt')).toBe(true);
    expect(r.state.intents?.enemy?.kind).toBe('stunned');
  });

  it('끊지 못하면 ATK 300%로 발동한다', () => {
    const s = inPhase2(5);
    const r1 = resolveRound(s, guard);
    const hpBefore = r1.state.combatants.find((c) => c.id === 'p')!.hp;
    const r2 = resolveRound(r1.state, { p: { kind: 'item', itemId: 'x', healHp: 0 } });
    expect(hpBefore - r2.state.combatants.find((c) => c.id === 'p')!.hp).toBe(60); // 20 * 3
  });

  it('발동 직전에 충분한 피해를 주면 발동이 취소된다 (속도가 빠른 쪽이 먼저)', () => {
    const s = inPhase2(5);
    const r1 = resolveRound(s, guard);
    const faster = { ...r1.state, combatants: r1.state.combatants.map((c) => (c.id === 'p' ? { ...c, stats: { ...c.stats, spd: 200, atk: 150 } } : c)) };
    const r2 = resolveRound(faster, attack());
    expect(r2.log.some((l) => l.type === 'interrupt')).toBe(true);
    expect(r2.state.combatants.find((c) => c.id === 'p')!.hp).toBe(r1.state.combatants.find((c) => c.id === 'p')!.hp);
  });

  it('3페이즈는 충전 없이 바로 발동 예고가 나온다', () => {
    const s = createBattle([player(), boss({ spd: 99 })], 3, touchOnly);
    s.boss!.runtime.phase = 3;
    const r = resolveRound(s, guard);
    expect(r.state.intents?.enemy?.kind).toBe('release');
  });
});

describe('언데드 소집', () => {
  const summonOnly = { ...script, phases: script.phases.map((p) => ({ ...p, pool: [{ id: 'summon', weight: 1 }] })) };

  it('하수인을 최대 2체까지 소환하고 매 라운드 보스를 회복시킨다', () => {
    const s = setBoss(createBattle([player({ atk: 1 }), boss({ spd: 99 })], 1, summonOnly), 500);
    s.boss!.runtime.phase = 2;
    s.intents = { enemy: { patternId: 'summon', kind: 'summon', name: '소집', telegraph: '일어난다.', targetId: 'p' } };
    const r = resolveRound(s, guard);
    const minions = r.state.combatants.filter((c) => c.role === 'minion' && c.hp > 0);
    expect(minions).toHaveLength(2);
    expect(r.state.combatants.find((c) => c.id === 'enemy')!.hp).toBe(500 + 2 * 50); // 5% × 2체
    // 이미 2체가 있으면 다시 소환하지 않는다
    const r2 = resolveRound(r.state, guard);
    expect(r2.state.combatants.filter((c) => c.role === 'minion')).toHaveLength(2);
  });

  it('하수인도 플레이어를 공격하고, 하수인이 남아 있어도 보스가 쓰러지면 승리한다', () => {
    let s = createBattle([player({ atk: 10 }), boss({ spd: 1 })], 1, script);
    s.combatants.push({ id: 'minion-9', name: '하수인', side: 'enemy', role: 'minion', hp: 30, guardedLastRound: false, stats: { maxHp: 30, atk: 10, def: 0, spd: 5 } });
    s.intents = { ...s.intents, 'minion-9': { patternId: 'minion_attack', kind: 'minion_attack', name: '공격', telegraph: '달려든다.', targetId: 'p' } };
    const r = resolveRound(s, guard);
    expect(r.log.some((l) => l.actorId === 'minion-9' && l.type === 'attack')).toBe(true);
    s = setBoss(r.state, 1);
    const win = resolveRound(s, attack());
    expect(win.state.status).toBe('victory');
    expect(win.state.combatants.some((c) => c.role === 'minion' && c.hp > 0)).toBe(true);
  });
});

describe('패턴 선택 규칙과 안정성', () => {
  it('같은 패턴이 3번 연속 나오지 않는다', () => {
    let s = createBattle([player({ maxHp: 1e9, atk: 0 }), boss({ spd: 99 })], 11, withPatterns(['arrow', 'curse']));
    s.combatants.find((c) => c.id === 'p')!.hp = 1e9;
    const seq: string[] = [s.intents!.enemy!.patternId];
    for (let i = 0; i < 60; i++) {
      s = resolveRound(s, guard).state;
      seq.push(s.intents!.enemy!.patternId);
    }
    for (let i = 2; i < seq.length; i++) expect(!(seq[i] === seq[i - 1] && seq[i] === seq[i - 2]), seq.join(',')).toBe(true);
  });

  it('죽음의 손길은 최소 간격(3라운드) 이후에만 다시 나온다', () => {
    const pool = ['arrow', 'touch'];
    let s = createBattle([player({ maxHp: 1e9, atk: 0 }), boss({ spd: 99 })], 5, withPatterns(pool));
    s.combatants.find((c) => c.id === 'p')!.hp = 1e9;
    s.boss!.runtime.phase = 2;
    const used: number[] = [];
    for (let i = 0; i < 80; i++) {
      s = resolveRound(s, guard).state;
      const k = s.intents!.enemy!.kind;
      if (k === 'charge' || (k === 'release' && s.boss!.runtime.phase >= 3)) used.push(i);
    }
    for (let i = 1; i < used.length; i++) expect(used[i]! - used[i - 1]!).toBeGreaterThanOrEqual(3);
  });

  it('무작위 전투 300판: HP 범위·종료·NaN 없음', () => {
    for (let seed = 1; seed <= 300; seed++) {
      let s = createBattle([player({ maxHp: 120, atk: 20 + (seed % 15), def: 5 + (seed % 7) }), boss({ atk: 30, maxHp: 200, def: 6 }, 200)], seed, script);
      s.combatants.find((c) => c.id === 'p')!.hp = 120;
      s.combatants.find((c) => c.id === 'enemy')!.stats.maxHp = 200;
      let rounds = 0;
      while (s.status === 'ongoing' && rounds < 200) {
        const live = s.combatants.filter((c) => c.side === 'enemy' && c.hp > 0);
        const pick = live[(seed + rounds) % live.length]!;
        const act: Action = (seed + rounds) % 5 === 0 ? { kind: 'guard' } : { kind: 'attack', targetId: pick.id };
        s = resolveRound(s, { p: act }).state;
        for (const c of s.combatants) {
          expect(Number.isFinite(c.hp)).toBe(true);
          expect(c.hp).toBeGreaterThanOrEqual(0);
          expect(c.hp).toBeLessThanOrEqual(Math.max(c.stats.maxHp, 1));
        }
        rounds++;
      }
      expect(s.status, `seed ${seed}`).not.toBe('ongoing');
    }
  });

  it('입력 상태를 변경하지 않는다', () => {
    const s = createBattle([player(), boss()], 1, script);
    const snap = JSON.stringify(s);
    resolveRound(s, attack());
    expect(JSON.stringify(s)).toBe(snap);
  });
});
