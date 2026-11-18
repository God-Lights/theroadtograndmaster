import { describe, expect, it } from 'vitest';
import { createBattle, resolveRound, calcDamage } from './battle';
import type { Combatant } from './types';

const mk = (id: string, side: 'player' | 'enemy', over: Partial<Combatant['stats']> = {}): Combatant => ({
  id, name: id, side, hp: 100, guardedLastRound: false,
  stats: { maxHp: 100, atk: 20, def: 5, spd: 10, ...over },
});

describe('resolveRound', () => {
  it('공격은 피해를 주고 방어는 피해를 줄인다', () => {
    const s = createBattle([mk('p', 'player'), mk('e', 'enemy')]);
    const plain = resolveRound(s, { p: { kind: 'attack', targetId: 'e' }, e: { kind: 'guard' } });
    const e = plain.state.combatants.find((c) => c.id === 'e')!;
    expect(e.hp).toBe(100 - calcDamage(20, 5, 0.7));
    expect(100 - e.hp).toBeLessThan(calcDamage(20, 5, 1));
  });

  it('연속 방어는 효과가 절반이다', () => {
    let s = createBattle([mk('p', 'player'), mk('e', 'enemy')]);
    s = resolveRound(s, { p: { kind: 'guard' }, e: { kind: 'guard' } }).state;
    const r = resolveRound(s, { p: { kind: 'attack', targetId: 'e' }, e: { kind: 'guard' } });
    const e = r.state.combatants.find((c) => c.id === 'e')!;
    expect(e.hp).toBe(100 - calcDamage(20, 5, 0.85));
  });

  it('속도가 빠른 쪽이 먼저 쓰러뜨리면 느린 쪽은 행동하지 못한다', () => {
    const s = createBattle([
      mk('p', 'player', { spd: 20, atk: 200 }),
      mk('e', 'enemy', { spd: 5 }),
    ]);
    const r = resolveRound(s, {
      p: { kind: 'attack', targetId: 'e' },
      e: { kind: 'attack', targetId: 'p' },
    });
    expect(r.state.status).toBe('victory');
    expect(r.state.combatants.find((c) => c.id === 'p')!.hp).toBe(100);
  });

  it('회복은 최대 HP를 넘지 않는다', () => {
    const p = mk('p', 'player');
    p.hp = 90;
    const s = createBattle([p, mk('e', 'enemy')]);
    const r = resolveRound(s, { p: { kind: 'item', itemId: 'hp_potion', healHp: 100 }, e: { kind: 'guard' } });
    expect(r.state.combatants.find((c) => c.id === 'p')!.hp).toBe(100);
  });

  it('같은 시드와 입력이면 결과가 같다 (결정론)', () => {
    const s = createBattle([mk('p', 'player'), mk('e', 'enemy')], 42);
    const a = { p: { kind: 'attack', targetId: 'e' }, e: { kind: 'attack', targetId: 'p' } } as const;
    expect(resolveRound(s, a)).toEqual(resolveRound(s, a));
  });

  it('입력 상태를 변경하지 않는다', () => {
    const s = createBattle([mk('p', 'player'), mk('e', 'enemy')]);
    const snap = JSON.stringify(s);
    resolveRound(s, { p: { kind: 'attack', targetId: 'e' }, e: { kind: 'guard' } });
    expect(JSON.stringify(s)).toBe(snap);
  });
});

describe('josa', () => {
  it('받침에 따라 조사를 고른다', async () => {
    const { josa } = await import('./josa');
    expect(josa('좀비', '이', '가')).toBe('좀비가');
    expect(josa('오크', '이', '가')).toBe('오크가');
    expect(josa('늑대인간', '이', '가')).toBe('늑대인간이');
    expect(josa('모험가', '은', '는')).toBe('모험가는');
    expect(josa('리치몬드', '은', '는')).toBe('리치몬드는');
    expect(josa('스켈레톤', '은', '는')).toBe('스켈레톤은');
  });
});
