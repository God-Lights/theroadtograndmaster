import { describe, expect, it } from 'vitest';
import { bossScriptFor, computeStats, itemById, mobById } from '@rtgm/data';
import { createBattle, resolveRound, type Action, type BattleState, type BossScript } from '@rtgm/engine';

/**
 * 리치(Lv.10 관문) 밸런스 시뮬레이션. 장비 구간별로 수백 판을 돌려 클리어율·라운드 수를 본다.
 * 수치를 바꾸면 이 테스트가 설계 목표(클리어율 밴드)를 벗어났는지 알려 준다.
 */
const SETS = {
  low: ['good_sword', 'iron_shield', 'leather_armor'],   // 숙련 ~50~100
  mid: ['lord_sword', 'good_shield', 'chain_armor'],      // 숙련 150
  high: ['spirit_sword', 'king_shield', 'plate_armor'],   // 숙련 300
} as const;

type Potion = { heal: number; left: number };

function simulate(setIds: readonly string[], seed: number, potionPlan = [100, 100, 100, 100, 300], opts: { smart?: boolean } = {}) {
  const smart = opts.smart ?? true;
  const mob = mobById('rich')!;
  const stats = computeStats(setIds.map((id) => itemById(id)!));
  const script = { ...bossScriptFor('rich'), bossId: 'enemy' } as unknown as BossScript;
  let s: BattleState = createBattle(
    [
      { id: 'player', name: '모험가', side: 'player', hp: stats.maxHp, guardedLastRound: false, stats },
      { id: 'enemy', name: mob.name, side: 'enemy', hp: mob.hp, guardedLastRound: false, stats: { maxHp: mob.hp, atk: mob.atk, def: mob.def, spd: mob.spd } },
    ],
    seed,
    script,
  );
  const potions: Potion[] = potionPlan.map((heal) => ({ heal, left: 1 }));
  let rounds = 0;
  let used = 0;
  while (s.status === 'ongoing' && rounds < 80) {
    const me = s.combatants.find((c) => c.id === 'player')!;
    const boss = s.combatants.find((c) => c.id === 'enemy')!;
    const vessel = s.combatants.find((c) => c.role === 'vessel' && c.hp > 0);
    const intent = s.intents?.enemy;
    const ratio = me.hp / me.stats.maxHp;
    let act: Action = { kind: 'attack', targetId: smart && vessel ? 'vessel' : 'enemy' };
    const potion = potions.find((p) => p.left > 0 && me.stats.maxHp - me.hp >= p.heal * 0.7);
    const heavy = intent?.kind === 'release';
    if (smart && heavy && ratio > 0.5) act = { kind: 'guard' };
    else if (potion && ratio < (heavy ? 0.7 : 0.45)) {
      potion.left -= 1; used += 1;
      act = { kind: 'item', itemId: 'p', healHp: potion.heal };
    }
    s = resolveRound(s, { player: act }).state;
    rounds++;
    void boss;
  }
  return { won: s.status === 'victory', rounds, used, revived: s.boss!.runtime.revived };
}

function batch(setIds: readonly string[], n = 300, smart = true) {
  let wins = 0, roundSum = 0, winRounds = 0;
  for (let i = 1; i <= n; i++) {
    const r = simulate(setIds, i * 7919, undefined, { smart });
    roundSum += r.rounds;
    if (r.won) { wins++; winRounds += r.rounds; }
  }
  return { clear: wins / n, avgRounds: roundSum / n, avgWinRounds: wins ? winRounds / wins : 0 };
}

describe('리치 밸런스 (시뮬레이션)', () => {
  const result = {
    low: batch(SETS.low),
    mid: batch(SETS.mid),
    high: batch(SETS.high),
    midNaive: batch(SETS.mid, 300, false),
  };
  console.log('rich balance', JSON.stringify(result, (_, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)));

  // 기본 공격만 있는 지금 단계의 목표 밴드. 스킬이 들어오면 라운드 수는 더 줄어든다.
  it('권장 장비(중간 세트)의 클리어율이 45~75%다 (관문이지만 넘을 수 있다)', () => {
    expect(result.mid.clear).toBeGreaterThan(0.45);
    expect(result.mid.clear).toBeLessThan(0.75);
  });
  it('장비를 못 갖추면 막히고(낮은 세트 30% 미만), 좋은 장비면 거의 깬다(85% 초과)', () => {
    expect(result.low.clear).toBeLessThan(0.3);
    expect(result.high.clear).toBeGreaterThan(0.85);
  });
  it('장비가 좋을수록 클리어율이 오른다', () => {
    expect(result.high.clear).toBeGreaterThan(result.mid.clear);
    expect(result.mid.clear).toBeGreaterThan(result.low.clear);
  });
  it('영혼함 파괴·큰 기술 방어 같은 공략을 하는 쪽이 무작정 공격보다 낫다', () => {
    expect(result.mid.clear).toBeGreaterThan(result.midNaive.clear + 0.1);
  });
  it('승리까지 10~25라운드가 걸린다', () => {
    expect(result.mid.avgWinRounds).toBeGreaterThan(10);
    expect(result.mid.avgWinRounds).toBeLessThan(25);
  });
});
