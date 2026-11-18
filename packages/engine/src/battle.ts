import { josa } from './josa';
import { mulberry32 } from './rng';
import type { Action, BattleState, Combatant, LogEntry, RoundResult } from './types';

/** docs/stats 시트 '개요' 설정값과 동일하게 유지할 것 */
export const GUARD_REDUCTION = 0.3;
export const REPEAT_GUARD_FACTOR = 0.5;

export function createBattle(combatants: Combatant[], seed = 1): BattleState {
  return {
    round: 1,
    status: 'ongoing',
    combatants: combatants.map((c) => ({ ...c, stats: { ...c.stats } })),
    rngSeed: seed,
  };
}

/** 임시 피해 공식 (EDRPG 계산식과 대조 후 교체 예정) */
export function calcDamage(atk: number, def: number, guardFactor: number): number {
  const raw = Math.max(1, atk - def);
  return Math.max(1, Math.round(raw * guardFactor));
}

function guardFactorOf(c: Combatant, guarding: boolean): number {
  if (!guarding) return 1;
  const reduction = c.guardedLastRound ? GUARD_REDUCTION * REPEAT_GUARD_FACTOR : GUARD_REDUCTION;
  return 1 - reduction;
}

/**
 * 동시 선택 턴제 한 라운드를 처리한다.
 * 우선순위: 방어(선행) → 공격(속도순) → 회복(후행)
 * 입력 상태는 변경하지 않는다.
 */
export function resolveRound(state: BattleState, actions: Record<string, Action>): RoundResult {
  if (state.status !== 'ongoing') return { state, log: [] };

  const next: BattleState = {
    ...state,
    combatants: state.combatants.map((c) => ({ ...c, stats: { ...c.stats } })),
  };
  const byId = new Map(next.combatants.map((c) => [c.id, c]));
  const log: LogEntry[] = [];
  const rng = mulberry32(state.rngSeed);
  const round = state.round;

  const living = next.combatants.filter((c) => c.hp > 0);
  const chosen = (c: Combatant): Action => actions[c.id] ?? { kind: 'guard' };

  const guarding = new Set<string>();
  for (const c of living) {
    if (chosen(c).kind === 'guard') {
      guarding.add(c.id);
      log.push({ round, type: 'guard', actorId: c.id, text: `${josa(c.name, '이', '가')} 방어 자세를 취했다.` });
    }
  }

  // 공격: 속도 내림차순, 동속이면 시드 기반 무작위
  const attackers = living
    .filter((c) => chosen(c).kind === 'attack')
    .map((c) => ({ c, tie: rng() }))
    .sort((a, b) => b.c.stats.spd - a.c.stats.spd || a.tie - b.tie)
    .map((x) => x.c);

  for (const actor of attackers) {
    if (actor.hp <= 0) {
      log.push({ round, type: 'skip', actorId: actor.id, text: `${josa(actor.name, '은', '는')} 쓰러져 행동하지 못했다.` });
      continue;
    }
    const act = chosen(actor);
    if (act.kind !== 'attack') continue;
    const target = byId.get(act.targetId);
    if (!target || target.hp <= 0) {
      log.push({ round, type: 'skip', actorId: actor.id, text: `${actor.name}의 공격 대상은 이미 쓰러졌다.` });
      continue;
    }
    const dmg = calcDamage(actor.stats.atk, target.stats.def, guardFactorOf(target, guarding.has(target.id)));
    target.hp = Math.max(0, target.hp - dmg);
    log.push({
      round, type: 'attack', actorId: actor.id, targetId: target.id, amount: dmg,
      text: `${actor.name}의 공격! ${target.name}에게 ${dmg} 피해.`,
    });
    if (target.hp === 0) {
      log.push({ round, type: 'down', actorId: target.id, text: `${josa(target.name, '이', '가')} 쓰러졌다.` });
    }
  }

  // 회복(후행)
  for (const c of living) {
    const act = chosen(c);
    if (act.kind !== 'item' || c.hp <= 0) continue;
    const healed = Math.min(act.healHp, c.stats.maxHp - c.hp);
    c.hp += healed;
    log.push({ round, type: 'heal', actorId: c.id, amount: healed, text: `${josa(c.name, '이', '가')} 아이템으로 HP ${healed} 회복.` });
  }

  for (const c of next.combatants) c.guardedLastRound = guarding.has(c.id);

  const playersAlive = next.combatants.some((c) => c.side === 'player' && c.hp > 0);
  const enemiesAlive = next.combatants.some((c) => c.side === 'enemy' && c.hp > 0);
  next.status = !playersAlive ? 'defeat' : !enemiesAlive ? 'victory' : 'ongoing';
  next.round = round + 1;
  next.rngSeed = Math.floor(rng() * 0xffffffff) >>> 0;

  return { state: next, log };
}
