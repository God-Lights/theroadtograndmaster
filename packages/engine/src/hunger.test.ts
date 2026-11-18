import { describe, expect, it } from 'vitest';
import { createBattle, resolveRound } from './battle';
import type { Action, BattleState, BossScript, Combatant } from './types';

const base: BossScript = {
  bossId: 'enemy',
  patterns: {
    chomp: { kind: 'attack', name: '우걱우걱', mult: 1, telegraph: '입을 벌린다.' },
    devour: { kind: 'devour', name: '식사', mult: 2, healPct: 0.5, minHunger: 2, telegraph: '달려든다.' },
    more: { kind: 'copy_item', name: '부족해!', maxHealPct: 0.05, telegraph: '가방을 노린다.' },
  },
  phases: [
    { fromHpPct: 100, atkMult: 1, pool: [{ id: 'chomp', weight: 1 }] },
    { fromHpPct: 60, atkMult: 1, pool: [{ id: 'chomp', weight: 1 }] },
    { fromHpPct: 25, atkMult: 1, pool: [{ id: 'chomp', weight: 1 }] },
  ],
  hunger: { perRound: 1, max: 5, atkPerStack: 0.5 },
};
const only = (id: string): BossScript => ({ ...base, phases: base.phases.map((p) => ({ ...p, pool: [{ id, weight: 1 }] })) });
const player = (): Combatant => ({ id: 'p', name: '모험가', side: 'player', hp: 3000, guardedLastRound: false, ap: 6, gauge: 0, stats: { maxHp: 3000, atk: 10, def: 0, spd: 10 } });
const boss = (hp = 9000): Combatant => ({ id: 'enemy', name: '포더모어', side: 'enemy', hp, guardedLastRound: false, stats: { maxHp: 10000, atk: 100, def: 0, spd: 5 } });
const start = (sc: BossScript, hp = 9000) => createBattle([player(), boss(hp)], 1, sc);
const idle: Action = { kind: 'item', itemId: 'x', healHp: 0 };
const potion: Action = { kind: 'item', itemId: 'x', healHp: 400 };
const step = (s: BattleState, a: Action) => resolveRound(s, { p: a }).state;
const hp = (s: BattleState, id: string) => s.combatants.find((c) => c.id === id)!.hp;

describe('허기·식사·아이템 복제', () => {
  it('허기는 매 라운드 쌓이고 최대치에서 멈춘다', () => {
    let s = start(only('chomp'));
    for (let i = 0; i < 8; i++) s = step(s, idle);
    expect(s.boss!.runtime.hunger).toBe(5);
  });
  it('허기가 쌓일수록 같은 공격이 더 아프다', () => {
    let s = start(only('chomp'));
    const dmgs: number[] = [];
    for (let i = 0; i < 4; i++) { const before = hp(s, 'p'); s = step(s, idle); dmgs.push(before - hp(s, 'p')); }
    expect(dmgs[0]!).toBeLessThan(dmgs[1]!);
    expect(dmgs[1]!).toBeLessThan(dmgs[3]!);
  });
  it('허기가 모자라면 식사를 쓰지 않는다 (일반 공격으로 대체)', () => {
    const s = start(only('devour'));
    expect(s.intents!.enemy!.kind).toBe('attack');
  });
  it('식사: 허기가 쌓이면 나오고, 준 피해의 일부를 회복하며 허기가 0이 된다', () => {
    let s = start(only('devour'));
    s = step(s, idle); s = step(s, idle); // 허기 2
    expect(s.intents!.enemy!.kind).toBe('devour');
    const before = hp(s, 'enemy');
    s = step(s, idle);
    expect(hp(s, 'enemy')).toBeGreaterThan(before);
    expect(s.boss!.runtime.hunger).toBe(1); // 먹어서 0 → 라운드 끝에 +1
  });
  it('식사는 가드로 막으면 회복도 줄어든다', () => {
    let a = start(only('devour')); let b = start(only('devour'));
    for (let i = 0; i < 2; i++) { a = step(a, idle); b = step(b, idle); }
    a = step(a, idle); b = step(b, { kind: 'guard' });
    expect(hp(b, 'p')).toBeGreaterThan(hp(a, 'p'));
    expect(hp(b, 'enemy')).toBeLessThan(hp(a, 'enemy'));
  });
  it('부족해!: 아이템을 쓴 다음에만 나오고, 쓴 회복을 상한까지 가로챈다', () => {
    let s = start(only('more'));
    expect(s.intents!.enemy!.kind).toBe('attack'); // 아직 아이템을 쓰지 않았다
    s = step(s, potion);
    expect(s.intents!.enemy!.kind).toBe('copy_item');
    const before = hp(s, 'enemy');
    s = step(s, idle);
    expect(hp(s, 'enemy') - before).toBe(400); // 상한 500(5%) 이하라 그대로
  });
  it('부족해!: 회복량이 크면 최대 HP 비율로 제한된다', () => {
    let s = start(only('more'));
    s = step(s, { kind: 'item', itemId: 'x', healHp: 9999 });
    const before = hp(s, 'enemy');
    s = step(s, idle);
    expect(hp(s, 'enemy') - before).toBe(500);
  });
  it('부족해!는 한 번 쓰고 나면 다음 라운드에 아이템을 안 썼다면 나오지 않는다', () => {
    let s = start(only('more'));
    s = step(s, potion); s = step(s, idle);
    expect(s.intents!.enemy!.kind).toBe('attack');
  });
  it('옛 저장 상태(허기 필드 없음)도 이어서 진행된다', () => {
    let s = start(only('chomp'));
    const legacy = JSON.parse(JSON.stringify(s)) as BattleState;
    delete (legacy.boss!.runtime as unknown as Record<string, unknown>).hunger;
    delete (legacy.boss!.runtime as unknown as Record<string, unknown>).lastItemHeal;
    delete (legacy.boss!.runtime as unknown as Record<string, unknown>).itemHealThisRound;
    s = step(legacy, idle);
    expect(Number.isFinite(s.boss!.runtime.hunger)).toBe(true);
  });
});
