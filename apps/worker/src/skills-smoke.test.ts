import { describe, expect, it } from 'vitest';
import { SKILLS } from '@rtgm/data';
import { GAUGE_MAX, canUseSkill, createBattle, resolveRound, type Combatant, type SkillDef } from '@rtgm/engine';

/** 실제 스킬 데이터 27개가 엔진에서 모두 오류 없이 돌아가고 자원을 제대로 쓰는지 확인한다. */
const defs = Object.fromEntries(
  SKILLS.map((s) => [s.id, { id: s.id, name: s.name, ultimate: s.ultimate, apCost: s.apCost, cooldown: s.cooldown, priority: s.priority, target: s.target, effects: s.effects } as SkillDef]),
);
const me = (): Combatant => ({
  id: 'player', name: '모험가', side: 'player', hp: 70, guardedLastRound: false, ap: 6, gauge: 100,
  stats: { maxHp: 120, atk: 20, def: 10, spd: 10, int: 20 },
});
const dummy = (): Combatant => ({ id: 'enemy', name: '허수아비', side: 'enemy', hp: 400, guardedLastRound: false, stats: { maxHp: 400, atk: 12, def: 5, spd: 5 } });

describe.each(SKILLS.map((s) => [s.id, s] as const))('스킬 %s', (id, s) => {
  it('사용할 수 있고, 라운드를 정상 처리하며 자원을 쓴다', () => {
    const start = createBattle([me(), dummy()], 3, undefined, defs);
    expect(canUseSkill(start, start.combatants[0]!, id).ok).toBe(true);
    const r = resolveRound(start, { player: { kind: 'skill', skillId: id, targetId: 'enemy' }, enemy: { kind: 'attack', targetId: 'player' } });
    const p = r.state.combatants.find((c) => c.id === 'player')!;
    for (const c of r.state.combatants) {
      expect(Number.isFinite(c.hp)).toBe(true);
      expect(c.hp).toBeGreaterThanOrEqual(0);
      expect(c.hp).toBeLessThanOrEqual(c.stats.maxHp);
    }
    expect(r.log.some((l) => l.type === 'skill' || l.type === 'status')).toBe(true);
    if (s.ultimate) expect(p.gauge!).toBeLessThan(GAUGE_MAX);
    if (s.cooldown > 0) expect(canUseSkill(r.state, p, id)).toEqual({ ok: false, reason: id === 'focus' ? 'charging' : 'cooldown' });
  });
});

describe('스킬 구성', () => {
  it('피해 스킬은 실제로 적 HP를 깎는다 (충전·버프형 제외)', () => {
    for (const s of SKILLS.filter((x) => x.effects.some((e) => e.kind === 'damage') && x.priority !== 'delayed')) {
      const start = createBattle([me(), dummy()], 3, undefined, defs);
      const r = resolveRound(start, { player: { kind: 'skill', skillId: s.id, targetId: 'enemy' }, enemy: { kind: 'item', itemId: 'x', healHp: 0 } });
      expect(r.state.combatants.find((c) => c.id === 'enemy')!.hp, s.id).toBeLessThan(400);
    }
  });

  it('회복 스킬은 실제로 HP를 올린다', () => {
    for (const s of SKILLS.filter((x) => x.effects.some((e) => e.kind === 'heal') && x.id !== 'blessing')) {
      const start = createBattle([me(), dummy()], 3, undefined, defs);
      const r = resolveRound(start, { player: { kind: 'skill', skillId: s.id }, enemy: { kind: 'item', itemId: 'x', healHp: 0 } });
      expect(r.state.combatants.find((c) => c.id === 'player')!.hp, s.id).toBeGreaterThan(70);
    }
  });
});
