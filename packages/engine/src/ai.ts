import { mulberry32 } from './rng';
import type { Action, BattleState, Combatant } from './types';

/** 임시 적 AI: 대부분 공격, 가끔 방어. 상대의 이번 라운드 선택은 보지 않는다. */
export function chooseEnemyAction(state: BattleState, enemy: Combatant, salt = 0): Action {
  const rng = mulberry32((state.rngSeed ^ (salt + 0x9e3779b9)) >>> 0);
  const target = state.combatants.find((c) => c.side === 'player' && c.hp > 0);
  if (!target || rng() < 0.2) return { kind: 'guard' };
  return { kind: 'attack', targetId: target.id };
}
