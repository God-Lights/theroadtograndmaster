import { describe, expect, it } from 'vitest';
import { SKILLS, START_AP, bossScriptFor, computeStats, itemById, mobById } from '@rtgm/data';
import { canUseSkill, createBattle, resolveRound, type Action, type BattleState, type BossScript, type SkillDef } from '@rtgm/engine';

/** 중간계 던전 II (숙련 1300~) 밸런스 시뮬레이션: 일반 몹 4종 + 포더모어 */
const SETS = {
  low: ['ancient_sword', 'god_shield', 'god_armor'],
  mid: ['titan_sword', 'titan_shield', 'titan_armor'],       // 권장
  high: ['devourer_sword', 'titan_shield', 'glutton_armor'],
} as const;
const BUILD = ['strike', 'multi', 'heal', 'ironwall', 'execute'];
const defOf = (id: string): SkillDef => {
  const s = SKILLS.find((x) => x.id === id)!;
  return { id: s.id, name: s.name, ultimate: s.ultimate, apCost: s.apCost, cooldown: s.cooldown, priority: s.priority, target: s.target, effects: s.effects };
};

function simulate(mobId: string, setIds: readonly string[], smart: boolean, seed: number) {
  const mob = mobById(mobId)!;
  const stats = computeStats(setIds.map((id) => itemById(id)!));
  const script = { ...bossScriptFor(mobId), bossId: 'enemy' } as unknown as BossScript;
  const skills = smart ? Object.fromEntries(BUILD.map((id) => [id, defOf(id)])) : {};
  let s: BattleState = createBattle(
    [
      { id: 'player', name: '모험가', side: 'player', hp: stats.maxHp, guardedLastRound: false, stats, ap: START_AP, gauge: 0, cooldowns: {} },
      { id: 'enemy', name: mob.name, side: 'enemy', hp: mob.hp, guardedLastRound: false, stats: { maxHp: mob.hp, atk: mob.atk, def: mob.def, spd: mob.spd } },
    ],
    seed, script, skills,
  );
  const potions = [150, 150, 150, 150, 400, 400].map((heal) => ({ heal, left: 1 }));
  let rounds = 0;
  while (s.status === 'ongoing' && rounds < 90) {
    const me = s.combatants.find((c) => c.id === 'player')!;
    const boss = s.combatants.find((c) => c.id === 'enemy')!;
    const kind = s.intents?.enemy?.kind;
    const ratio = me.hp / me.stats.maxHp;
    const danger = kind === 'release' || kind === 'devour';
    const ok = (id: string) => smart && canUseSkill(s, me, id).ok;
    const minion = s.combatants.find((c) => c.role === 'minion' && c.hp > 0);
    const potion = potions.find((p) => p.left > 0 && me.stats.maxHp - me.hp >= p.heal * 0.7);
    // 아이템을 쓰면 '부족해!'로 가로채이므로, 똑똑한 플레이어는 위급할 때만 쓴다
    const itemOk = ratio < (smart ? 0.3 : 0.4);

    let act: Action = { kind: 'attack', targetId: 'enemy' };
    if (me.pending) act = { kind: 'guard' };
    else if (smart) {
      if (ok('execute') && boss.hp <= boss.stats.maxHp * 0.35) act = { kind: 'skill', skillId: 'execute', targetId: 'enemy' };
      else if (ratio < 0.45 && ok('heal')) act = { kind: 'skill', skillId: 'heal' };
      else if (ratio < 0.3 && potion) { potion.left -= 1; act = { kind: 'item', itemId: 'p', healHp: potion.heal }; }
      else if (danger && ok('ironwall')) act = { kind: 'skill', skillId: 'ironwall' };
      else if (danger) act = { kind: 'guard' };
      else if (minion && ok('multi')) act = { kind: 'skill', skillId: 'multi', targetId: 'enemy' };
      else if (ok('strike')) act = { kind: 'skill', skillId: 'strike', targetId: 'enemy' };
    } else if (itemOk && potion) { potion.left -= 1; act = { kind: 'item', itemId: 'p', healHp: potion.heal }; }
    else if (danger && ratio > 0.5) act = { kind: 'guard' };
    s = resolveRound(s, { player: act }).state;
    rounds++;
  }
  return { won: s.status === 'victory', rounds };
}

function batch(mobId: string, setIds: readonly string[], smart: boolean, n = 120) {
  let wins = 0, winRounds = 0;
  for (let i = 1; i <= n; i++) {
    const r = simulate(mobId, setIds, smart, i * 7919);
    if (r.won) { wins++; winRounds += r.rounds; }
  }
  return { clear: wins / n, avgWinRounds: wins ? winRounds / wins : 0 };
}

describe('중간계 던전 II 밸런스 (시뮬레이션)', () => {
  const normals = ['raidos', 'core_lord', 'ancient_lord', 'paka'];
  const normal = Object.fromEntries(normals.map((id) => [id, batch(id, SETS.mid, true)]));
  const fm = {
    smartLow: batch('fodermore', SETS.low, true),
    smartMid: batch('fodermore', SETS.mid, true),
    smartHigh: batch('fodermore', SETS.high, true),
    naiveMid: batch('fodermore', SETS.mid, false),
  };
  console.log('midrealm2 balance', JSON.stringify({ normal, fm }, (_, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)));

  it('권장 장비 + 스킬이면 일반 몹은 안정적으로 잡는다', () => {
    for (const id of normals) {
      expect(normal[id]!.clear, id).toBeGreaterThan(0.9);
      expect(normal[id]!.avgWinRounds, id).toBeLessThan(22);
    }
  });
  it('포더모어: 권장 장비로 허기·식사 타이밍을 읽으면 40~75%로 넘을 수 있다', () => {
    expect(fm.smartMid.clear).toBeGreaterThan(0.4);
    expect(fm.smartMid.clear).toBeLessThan(0.75);
  });
  it('포더모어: 패턴을 안 읽고 아이템만 쓰면 확실히 불리하다', () => {
    expect(fm.smartMid.clear).toBeGreaterThan(fm.naiveMid.clear + 0.25);
  });
  it('포더모어: 장비가 부족하면 막히고(15% 미만), 좋은 장비면 거의 깬다(85% 초과)', () => {
    expect(fm.smartLow.clear).toBeLessThan(0.15);
    expect(fm.smartHigh.clear).toBeGreaterThan(0.85);
  });
  it('포더모어 승리까지 13~35라운드가 걸린다', () => {
    expect(fm.smartMid.avgWinRounds).toBeGreaterThan(13);
    expect(fm.smartMid.avgWinRounds).toBeLessThan(35);
  });
});
