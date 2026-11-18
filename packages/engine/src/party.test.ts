import { describe, expect, it } from 'vitest';
import { createBattle, resolveRound } from './battle';
import type { Action, BattleState, BossScript, Combatant, SkillDef } from './types';

const SK: Record<string, SkillDef> = {
  mend: { id: 'mend', name: '치유의 빛', apCost: 1, cooldown: 0, priority: 'last', target: 'ally', effects: [{ kind: 'heal', scale: 'maxhp', coef: 50 }] },
  aegis: { id: 'aegis', name: '수호의 장막', apCost: 1, cooldown: 0, priority: 'first', target: 'all_allies', effects: [{ kind: 'shield', maxHpPct: 20, turns: 2 }] },
  clean: { id: 'clean', name: '정화의 빛', apCost: 1, cooldown: 0, priority: 'normal', target: 'ally', effects: [{ kind: 'cleanse' }] },
  taunt: { id: 'taunt', name: '도발', apCost: 1, cooldown: 0, priority: 'first', target: 'self', effects: [{ kind: 'status', to: 'self', status: { id: 'taunt', taunt: true, turns: 2 } }] },
};
const pl = (id: string, hp = 1000): Combatant => ({ id, name: id.toUpperCase(), side: 'player', hp, guardedLastRound: false, ap: 6, gauge: 0, cooldowns: {}, stats: { maxHp: 1000, atk: 10, def: 0, spd: 10, int: 100 } });
const mkBoss = (hp = 100000): Combatant => ({ id: 'enemy', name: '안키오', side: 'enemy', hp, guardedLastRound: false, stats: { maxHp: 100000, atk: 100, def: 0, spd: 5 } });
const script = (pattern: BossScript['patterns'][string], extra: Partial<BossScript> = {}): BossScript => ({
  bossId: 'enemy', patterns: { x: pattern },
  phases: [100, 60, 25].map((f) => ({ fromHpPct: f, atkMult: 1, pool: [{ id: 'x', weight: 1 }] })), ...extra,
});
const start = (sc: BossScript, players = ['p1', 'p2', 'p3', 'p4'], seed = 1) => createBattle([...players.map((id) => pl(id)), mkBoss()], seed, sc, SK);
const idle: Action = { kind: 'guard' };
const acts = (m: Record<string, Action>): Record<string, Action> => ({ p1: idle, p2: idle, p3: idle, p4: idle, ...m });
const hp = (s: BattleState, id: string) => s.combatants.find((c) => c.id === id)!.hp;
const step = (s: BattleState, m: Record<string, Action> = {}) => resolveRound(s, acts(m)).state;

describe('아군 대상 스킬', () => {
  it('치유: 고른 아군의 HP를 회복시킨다 (시전자 자신은 그대로)', () => {
    let s = start(script({ kind: 'attack', name: '약타', mult: 0.01, telegraph: '' }));
    s.combatants.find((c) => c.id === 'p2')!.hp = 300;
    s = step(s, { p1: { kind: 'skill', skillId: 'mend', targetId: 'p2' } });
    expect(hp(s, 'p2')).toBe(800); // +500
    expect(hp(s, 'p1')).toBeGreaterThan(990);
  });
  it('전체 보호막: 살아 있는 아군 모두에게 걸린다 (쓰러진 아군 제외)', () => {
    let s = start(script({ kind: 'attack', name: '약타', mult: 0.01, telegraph: '' }));
    s.combatants.find((c) => c.id === 'p4')!.hp = 0;
    s = step(s, { p1: { kind: 'skill', skillId: 'aegis' } });
    for (const id of ['p1', 'p2', 'p3']) expect(s.combatants.find((c) => c.id === id)!.statuses?.some((st) => st.id === 'shield')).toBe(true);
    expect(s.combatants.find((c) => c.id === 'p4')!.statuses?.length ?? 0).toBe(0);
  });
  it('정화: 아군의 해로운 효과를 지운다', () => {
    let s = start(script({ kind: 'attack', name: '약타', mult: 0.01, telegraph: '' }));
    for (const id of ['p2', 'p3']) s.combatants.find((c) => c.id === id)!.statuses = [{ id: 'weaken', until: 5, harmful: true, atkMult: 0.8 }];
    s = step(s, { p1: { kind: 'skill', skillId: 'clean', targetId: 'p3' } });
    expect(s.combatants.find((c) => c.id === 'p3')!.statuses?.some((st) => st.harmful)).toBe(false);
    expect(s.combatants.find((c) => c.id === 'p2')!.statuses?.some((st) => st.harmful)).toBe(true);
  });
});

describe('보스의 대상 선택', () => {
  it('전체 공격은 살아 있는 모두를 때린다', () => {
    const s = step(start(script({ kind: 'attack', name: '성광', mult: 1, telegraph: '', target: 'all' })));
    for (const id of ['p1', 'p2', 'p3', 'p4']) expect(hp(s, id)).toBeLessThan(1000);
  });
  it('단일 공격(first)은 한 명만 때린다', () => {
    const s = step(start(script({ kind: 'attack', name: '창', mult: 1, telegraph: '' })));
    expect(['p1', 'p2', 'p3', 'p4'].filter((id) => hp(s, id) < 1000)).toHaveLength(1);
  });
  it('random 은 시드에 따라 대상이 달라지고, 예고 문구에 대상 이름이 들어간다', () => {
    const sc = script({ kind: 'attack', name: '신탁의 창', mult: 1, telegraph: '창이 {target}을(를) 겨눈다!', target: 'random' });
    const targets = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const s = start(sc, undefined, seed);
      const intent = s.intents!.enemy!;
      targets.add(intent.targetId!);
      expect(intent.telegraph).toContain(intent.targetId!.toUpperCase());
    }
    expect(targets.size).toBeGreaterThan(1);
  });
  it('lowest_hp / highest_hp 규칙', () => {
    const mk = (rule: 'lowest_hp' | 'highest_hp') => {
      const hps: Record<string, number> = { p1: 900, p2: 1000, p3: 100, p4: 900 };
      const s = createBattle([...Object.entries(hps).map(([id, h]) => pl(id, h)), mkBoss()], 1, script({ kind: 'attack', name: '심판', mult: 1, telegraph: '', target: rule }), SK);
      return step(s);
    };
    expect(hp(mk('lowest_hp'), 'p3')).toBeLessThan(100);
    expect(hp(mk('highest_hp'), 'p2')).toBeLessThan(1000);
  });
  it('도발하면 단일 공격이 도발한 사람에게 몰린다 (전체 공격은 영향 없음)', () => {
    const sc = script({ kind: 'attack', name: '창', mult: 1, telegraph: '', target: 'random' });
    for (let seed = 1; seed <= 15; seed++) {
      let s = start(sc, undefined, seed);
      s = step(s, { p4: { kind: 'skill', skillId: 'taunt' } }); // 이번 라운드 도발 → 다음 라운드 예고에 반영
      const before = ['p1', 'p2', 'p3', 'p4'].map((id) => hp(s, id));
      expect(s.intents!.enemy!.targetId).toBe('p4');
      s = step(s, { p4: { kind: 'skill', skillId: 'taunt' } });
      const after = ['p1', 'p2', 'p3', 'p4'].map((id) => hp(s, id));
      expect(after[3]!).toBeLessThan(before[3]!);
      expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
    }
  });
  it('예고한 대상이 그 사이 쓰러지면 다른 생존자가 맞는다', () => {
    let s = start(script({ kind: 'attack', name: '창', mult: 1, telegraph: '' }));
    const tid = s.intents!.enemy!.targetId!;
    s.combatants.find((c) => c.id === tid)!.hp = 0;
    s = step(s);
    expect(['p1', 'p2', 'p3', 'p4'].filter((id) => id !== tid && hp(s, id) < 1000)).toHaveLength(1);
  });
  it('전원이 쓰러지면 패배', () => {
    let s = start(script({ kind: 'attack', name: '대멸', mult: 100, telegraph: '', target: 'all' }));
    s = step(s);
    expect(s.status).toBe('defeat');
  });
});

describe('격노', () => {
  it('지정한 라운드부터 매 라운드 공격력이 쌓인다', () => {
    const sc = script({ kind: 'attack', name: '창', mult: 1, telegraph: '', target: 'all' }, { enrage: { fromRound: 3, perRound: 0.5 } });
    let s = start(sc, ['p1']);
    const dmg: number[] = [];
    const noop: Action = { kind: 'item', itemId: 'x', healHp: 0 };
    for (let i = 0; i < 4; i++) { const b = hp(s, 'p1'); s = resolveRound(s, { p1: noop }).state; dmg.push(b - hp(s, 'p1')); }
    expect(dmg[1]).toBe(dmg[0]);
    expect(dmg[2]!).toBeGreaterThan(dmg[1]!);
    expect(dmg[3]!).toBeGreaterThan(dmg[2]!);
  });
});
