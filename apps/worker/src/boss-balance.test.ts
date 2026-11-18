import { describe, expect, it } from 'vitest';
import { SKILLS, START_AP, bossScriptFor, computeStats, itemById, mobById } from '@rtgm/data';
import { canUseSkill, createBattle, resolveRound, type Action, type BattleState, type BossScript, type SkillDef } from '@rtgm/engine';

/**
 * 리치(Lv.10 관문) 밸런스 시뮬레이션. 장비 구간 × 스킬 빌드별로 수백 판을 돌려 클리어율을 본다.
 * 수치를 바꾸면 이 테스트가 설계 목표(클리어율 밴드)를 벗어났는지 알려 준다.
 */
const SETS = {
  low: ['good_sword', 'iron_shield', 'leather_armor'],   // 숙련 ~50~100
  mid: ['lord_sword', 'good_shield', 'chain_armor'],      // 숙련 150 (권장)
  high: ['spirit_sword', 'king_shield', 'plate_armor'],   // 숙련 300
} as const;

/** 숙련 450(Lv.10)에서 고를 수 있는 일반 스킬 4개 + 궁극기 1개 */
const BUILDS = {
  none: [] as string[],
  attacker: ['strike', 'pierce', 'heal', 'ironwall', 'execute'],
  tank: ['bash', 'counter', 'heal', 'ironwall', 'overdrive'],
};

const defOf = (id: string): SkillDef => {
  const s = SKILLS.find((x) => x.id === id)!;
  return { id: s.id, name: s.name, ultimate: s.ultimate, apCost: s.apCost, cooldown: s.cooldown, priority: s.priority, target: s.target, effects: s.effects };
};

function simulate(setIds: readonly string[], build: string[], seed: number) {
  const mob = mobById('rich')!;
  const stats = computeStats(setIds.map((id) => itemById(id)!));
  const script = { ...bossScriptFor('rich'), bossId: 'enemy' } as unknown as BossScript;
  const skills = Object.fromEntries(build.map((id) => [id, defOf(id)]));
  let s: BattleState = createBattle(
    [
      { id: 'player', name: '모험가', side: 'player', hp: stats.maxHp, guardedLastRound: false, stats, ap: START_AP, gauge: 0, cooldowns: {} },
      { id: 'enemy', name: mob.name, side: 'enemy', hp: mob.hp, guardedLastRound: false, stats: { maxHp: mob.hp, atk: mob.atk, def: mob.def, spd: mob.spd } },
    ],
    seed, script, skills,
  );
  const potions = [100, 100, 100, 100, 300].map((heal) => ({ heal, left: 1 }));
  let rounds = 0;
  while (s.status === 'ongoing' && rounds < 80) {
    const me = s.combatants.find((c) => c.id === 'player')!;
    const boss = s.combatants.find((c) => c.id === 'enemy')!;
    const vessel = s.combatants.find((c) => c.role === 'vessel' && c.hp > 0);
    const heavy = s.intents?.enemy?.kind === 'release';
    const ratio = me.hp / me.stats.maxHp;
    const ok = (id: string) => build.includes(id) && canUseSkill(s, me, id).ok;
    const target = vessel ? 'vessel' : 'enemy'; // 영혼함을 먼저 부순다
    const potion = potions.find((p) => p.left > 0 && me.stats.maxHp - me.hp >= p.heal * 0.7);

    let act: Action = { kind: 'attack', targetId: target };
    if (me.pending) act = { kind: 'guard' };
    else if (ok('execute') && boss.hp <= boss.stats.maxHp * 0.35 && !vessel) act = { kind: 'skill', skillId: 'execute', targetId: 'enemy' };
    else if (ok('overdrive')) act = { kind: 'skill', skillId: 'overdrive' };
    else if (ratio < 0.4 && ok('heal')) act = { kind: 'skill', skillId: 'heal' };
    else if (ratio < 0.4 && potion) { potion.left -= 1; act = { kind: 'item', itemId: 'p', healHp: potion.heal }; }
    else if (heavy && ok('counter')) act = { kind: 'skill', skillId: 'counter' };
    else if (heavy && ok('ironwall')) act = { kind: 'skill', skillId: 'ironwall' };
    else if (heavy && ratio > 0.5) act = { kind: 'guard' };
    else if (ok('pierce')) act = { kind: 'skill', skillId: 'pierce', targetId: target };
    else if (ok('strike')) act = { kind: 'skill', skillId: 'strike', targetId: target };
    else if (ok('bash')) act = { kind: 'skill', skillId: 'bash', targetId: target };
    s = resolveRound(s, { player: act }).state;
    rounds++;
  }
  return { won: s.status === 'victory', rounds };
}

function batch(setIds: readonly string[], build: string[], n = 200) {
  let wins = 0, winRounds = 0;
  for (let i = 1; i <= n; i++) {
    const r = simulate(setIds, build, i * 7919);
    if (r.won) { wins++; winRounds += r.rounds; }
  }
  return { clear: wins / n, avgWinRounds: wins ? winRounds / wins : 0 };
}

describe('리치 밸런스 (시뮬레이션)', () => {
  const result = {
    attackerLow: batch(SETS.low, BUILDS.attacker),
    attackerMid: batch(SETS.mid, BUILDS.attacker),
    attackerHigh: batch(SETS.high, BUILDS.attacker),
    noSkillMid: batch(SETS.mid, BUILDS.none),
    tankMid: batch(SETS.mid, BUILDS.tank),
    tankHigh: batch(SETS.high, BUILDS.tank),
  };
  console.log('rich balance', JSON.stringify(result, (_, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)));

  it('권장 장비 + 공격형 스킬 빌드의 클리어율이 45~75%다 (관문이지만 넘을 수 있다)', () => {
    expect(result.attackerMid.clear).toBeGreaterThan(0.45);
    expect(result.attackerMid.clear).toBeLessThan(0.75);
  });
  it('장비를 못 갖추면 막히고(25% 미만), 좋은 장비면 거의 깬다(90% 초과)', () => {
    expect(result.attackerLow.clear).toBeLessThan(0.25);
    expect(result.attackerHigh.clear).toBeGreaterThan(0.9);
  });
  it('스킬을 쓰는 쪽이 기본 공격만 하는 쪽보다 확실히 낫다', () => {
    expect(result.attackerMid.clear).toBeGreaterThan(result.noSkillMid.clear + 0.1);
  });
  it('방어형 빌드도 좋은 장비면 깰 수 있다 (탱커 스킬이 쓸모없지 않다)', () => {
    expect(result.tankHigh.clear).toBeGreaterThan(0.7);
    expect(result.tankMid.clear).toBeGreaterThan(0.05);
  });
  it('승리까지 10~25라운드가 걸린다', () => {
    expect(result.attackerMid.avgWinRounds).toBeGreaterThan(10);
    expect(result.attackerMid.avgWinRounds).toBeLessThan(25);
  });
});
