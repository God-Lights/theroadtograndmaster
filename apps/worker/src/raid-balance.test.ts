import { describe, expect, it } from 'vitest';
import {
  RAID_BOSSES, RAID_ROLES, START_AP, computeStats, itemById, raidBossHp, raidKit, raidSkillById, raidStats, type RaidRole,
} from '@rtgm/data';
import { canUseSkill, createBattle, resolveRound, type Action, type BattleState, type BossScript, type Combatant, type SkillDef } from '@rtgm/engine';

/**
 * 안키오 레이드 밸런스 시뮬레이션: 역할별 봇 4명이 파티를 이룬다.
 * 봇은 "예고를 읽는" 플레이어를 흉내 낸다 (신탁 대상 보호, 충전 끊기, 위기 때 힐).
 */
const SETS = {
  low: ['ancient_sword', 'god_shield', 'god_armor'],
  mid: ['titan_sword', 'titan_shield', 'titan_armor'],
  high: ['devourer_sword', 'titan_shield', 'glutton_armor'],
} as const;

const defOf = (id: string): SkillDef => {
  const s = raidSkillById(id)!;
  return { id: s.id, name: s.name, ultimate: s.ultimate, apCost: s.apCost, cooldown: s.cooldown, priority: s.priority, target: s.target, effects: s.effects };
};
const ROLES: RaidRole[] = ['tank', 'dealer', 'healer', 'support'];

export function buildParty(roles: RaidRole[], gearIds: readonly string[]): { combatants: Combatant[]; skills: Record<string, SkillDef> } {
  const gear = computeStats(gearIds.map((id) => itemById(id)!));
  const skills: Record<string, SkillDef> = {};
  const combatants = roles.map((role, i): Combatant => {
    const stats = raidStats(role, gear);
    for (const id of raidKit(role)) skills[id] = defOf(id);
    return { id: `p${i + 1}`, name: RAID_ROLES[role].label, side: 'player', role: undefined, hp: stats.maxHp, guardedLastRound: false, stats, ap: START_AP, gauge: 0, cooldowns: {} };
  });
  return { combatants, skills };
}

function policy(s: BattleState, me: Combatant, role: RaidRole, smart: boolean): Action {
  const can = (id: string) => canUseSkill(s, me, id).ok;
  const skill = (id: string, targetId?: string): Action => ({ kind: 'skill', skillId: id, targetId });
  const allies = s.combatants.filter((c) => c.side === 'player' && c.hp > 0);
  const boss = s.combatants.find((c) => c.id === 'enemy')!;
  const intent = s.intents?.enemy;
  const ratio = (c: Combatant) => c.hp / c.stats.maxHp;
  const lowest = [...allies].sort((a, b) => ratio(a) - ratio(b))[0]!;
  const minion = s.combatants.find((c) => c.role === 'minion' && c.hp > 0);
  const charging = intent?.kind === 'charge';
  const oracleOnMe = intent?.kind === 'attack' && intent.targetId === me.id;
  const attack: Action = { kind: 'attack', targetId: 'enemy' };
  if (me.pending) return { kind: 'guard' };
  if (!smart) return attack;

  switch (role) {
    case 'tank':
      if (can('r_fortress') && allies.filter((a) => ratio(a) < 0.6).length >= 2) return skill('r_fortress');
      if (oracleOnMe && can('r_ironwall')) return skill('r_ironwall');
      if (can('r_taunt') && !(me.statuses ?? []).some((x) => x.taunt)) return skill('r_taunt');
      if (can('r_guardian') && ratio(lowest) < 0.55 && lowest.id !== me.id) return skill('r_guardian', lowest.id);
      if (can('r_bash')) return skill('r_bash', 'enemy');
      return attack;
    case 'dealer':
      if (can('r_execute') && (charging || boss.hp < boss.stats.maxHp * 0.5)) return skill('r_execute', 'enemy');
      if (can('r_frenzy') && !(me.statuses ?? []).some((x) => x.id === 'frenzy')) return skill('r_frenzy');
      if (charging && can('r_focus')) return skill('r_focus', 'enemy');
      if (can('r_focus')) return skill('r_focus', 'enemy');
      if (can('r_multi') && minion) return skill('r_multi', 'enemy');
      if (can('r_strike')) return skill('r_strike', 'enemy');
      return attack;
    case 'healer':
      if (can('r_blessing') && allies.filter((a) => ratio(a) < 0.5).length >= 2) return skill('r_blessing');
      if (can('r_heal') && ratio(lowest) < 0.45) return skill('r_heal', lowest.id);
      if (can('r_mass') && allies.filter((a) => ratio(a) < 0.7).length >= 2) return skill('r_mass');
      if (can('r_purify')) { const sick = allies.find((a) => (a.statuses ?? []).some((x) => x.harmful)); if (sick) return skill('r_purify', sick.id); }
      if (can('r_ward') && intent?.kind !== 'minion_attack' && ratio(lowest) < 0.9) return skill('r_ward');
      if (can('r_heal') && ratio(lowest) < 0.75) return skill('r_heal', lowest.id);
      return attack;
    case 'support':
      if (can('r_command') && (charging || boss.hp < boss.stats.maxHp * 0.6)) return skill('r_command');
      if (can('r_aid') && ratio(lowest) < 0.4) return skill('r_aid', lowest.id);
      if (can('r_snare') && !(boss.statuses ?? []).some((x) => x.id === 'weaken')) return skill('r_snare', 'enemy');
      if (can('r_analyze') && !(boss.statuses ?? []).some((x) => x.id === 'vulnerable')) return skill('r_analyze', 'enemy');
      if (can('r_morale') && !(allies[0]?.statuses ?? []).some((x) => x.id === 'morale')) return skill('r_morale');
      return attack;
  }
}

export interface SimOpts { smart?: boolean; roles?: RaidRole[] }
export function simulate(bossId: string, gear: readonly string[], seed: number, opts: SimOpts = {}) {
  const { smart = true } = opts;
  const roles = opts.roles ?? ROLES;
  const { combatants, skills } = buildParty(roles, gear);
  const b = RAID_BOSSES[bossId]!;
  const hp = raidBossHp(bossId, roles.length);
  const boss: Combatant = { id: 'enemy', name: b.name, side: 'enemy', hp, guardedLastRound: false, stats: { maxHp: hp, atk: b.atk, def: b.def, spd: b.spd } };
  let s = createBattle([...combatants, boss], seed, { ...(b.script as object), bossId: 'enemy' } as unknown as BossScript, skills);
  let rounds = 0;
  while (s.status === 'ongoing' && rounds < 80) {
    const actions: Record<string, Action> = {};
    s.combatants.filter((c) => c.side === 'player' && c.hp > 0).forEach((c) => { actions[c.id] = policy(s, c, roles[Number(c.id.slice(1)) - 1]!, smart); });
    s = resolveRound(s, actions).state;
    rounds++;
  }
  return { won: s.status === 'victory', rounds, alive: s.combatants.filter((c) => c.side === 'player' && c.hp > 0).length };
}

export function batch(bossId: string, gear: readonly string[], opts: SimOpts = {}, n = 100) {
  let wins = 0, wr = 0, alive = 0;
  for (let i = 1; i <= n; i++) { const r = simulate(bossId, gear, i * 7919, opts); if (r.won) { wins++; wr += r.rounds; alive += r.alive; } }
  return { clear: wins / n, avgWinRounds: wins ? wr / wins : 0, avgAlive: wins ? alive / wins : 0 };
}

/** 별 등급별 권장 구성(적정 인원)과 장비 구간 */
const TIERS: Record<string, { roles: RaidRole[]; low: readonly string[]; rec: readonly string[]; high: readonly string[] }> = {
  dragon: { roles: ['dealer', 'healer'], low: ['spirit_sword', 'king_shield', 'plate_armor'], rec: ['god_sword', 'dragon_shield', 'dragon_armor'], high: ['ancient_sword', 'god_shield', 'god_armor'] },
  baekkario: { roles: ['tank', 'dealer', 'healer'], low: ['ancient_sword', 'god_shield', 'god_armor'], rec: SETS.mid, high: SETS.high },
  ankio: { roles: ['tank', 'dealer', 'dealer', 'healer', 'healer', 'support'], low: SETS.mid, rec: SETS.high, high: ['oracle_blade', 'titan_shield', 'glutton_armor'] },
};

describe('레이드 밸런스 (시뮬레이션)', () => {
  const out: Record<string, unknown> = {};
  for (const [id, t] of Object.entries(TIERS)) {
    const r = { low: batch(id, t.low, { roles: t.roles }), rec: batch(id, t.rec, { roles: t.roles }), high: batch(id, t.high, { roles: t.roles }), naive: batch(id, t.rec, { roles: t.roles, smart: false }) };
    out[id] = r;
    it(`${id}: 적정 인원 + 권장 장비 + 예고를 읽으면 클리어율 40~75%`, () => {
      expect(r.rec.clear).toBeGreaterThan(0.4);
      expect(r.rec.clear).toBeLessThan(0.75);
    });
    it(`${id}: 장비가 부족하면 막히고(20% 미만), 좋은 장비면 대부분 깬다(78% 초과)`, () => {
      expect(r.low.clear).toBeLessThan(0.2);
      expect(r.high.clear).toBeGreaterThan(0.78);
    });
    it(`${id}: 기본 공격만 하면 거의 못 깬다`, () => {
      expect(r.naive.clear).toBeLessThan(0.05);
    });
    it(`${id}: 승리까지 10~36라운드`, () => {
      expect(r.rec.avgWinRounds).toBeGreaterThan(10);
      expect(r.rec.avgWinRounds).toBeLessThan(36);
    });
  }
  console.log('raid balance', JSON.stringify(out, (_, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)));
});
