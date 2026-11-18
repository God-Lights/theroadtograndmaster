import { josa } from './josa';
import type { BattleState, Combatant, Intent, PatternDef } from './types';

/** 보스 HP 비율(0~1)에 해당하는 페이즈 번호(1부터) */
export function phaseFor(state: BattleState, hpRatio: number): number {
  const script = state.boss!.script;
  let phase = 1;
  script.phases.forEach((p, i) => {
    if (hpRatio * 100 <= p.fromHpPct && i + 1 > phase && p.fromHpPct < 100) phase = i + 1;
  });
  return phase;
}

const firstLivingPlayer = (state: BattleState): Combatant | undefined =>
  state.combatants.find((c) => c.side === 'player' && c.hp > 0);

export const livingMinions = (state: BattleState): Combatant[] =>
  state.combatants.filter((c) => c.role === 'minion' && c.hp > 0);

function pickWeighted<T extends { weight: number }>(items: T[], rng: () => number): T {
  const total = items.reduce((a, b) => a + b.weight, 0);
  let r = rng() * total;
  for (const it of items) {
    r -= it.weight;
    if (r < 0) return it;
  }
  return items[items.length - 1]!;
}

/** 패턴을 지금 쓸 수 있는가: 페이즈·하수인 수·재사용 간격 */
function usable(state: BattleState, id: string, def: PatternDef): boolean {
  const rt = state.boss!.runtime;
  if (def.kind === 'summon') {
    return rt.phase >= def.minPhase && livingMinions(state).length < (state.boss!.script.minion?.max ?? 0);
  }
  if (def.kind === 'charge_attack') {
    return rt.phase >= def.minPhase && (rt.sinceUsed[id] ?? 99) >= def.minGap;
  }
  return true;
}

function planBoss(state: BattleState, boss: Combatant, targetId: string | undefined, rng: () => number): Intent {
  const { script, runtime: rt } = state.boss!;

  if (rt.stunned) {
    return { patternId: 'stunned', kind: 'stunned', name: '경직', telegraph: `${josa(boss.name, '은', '는')} 움직이지 못한다.` };
  }
  if (rt.phaseShift) {
    const text = script.phases[rt.phase - 1]?.enterText ?? `${josa(boss.name, '이', '가')} 힘을 끌어올린다.`;
    return { patternId: 'phase_shift', kind: 'phase_shift', name: '변이', telegraph: text };
  }
  if (rt.charging) {
    const def = script.patterns[rt.charging];
    if (def?.kind === 'charge_attack') {
      return { patternId: rt.charging, kind: 'release', name: def.name, telegraph: def.telegraphRelease, targetId };
    }
  }

  const pool = script.phases[rt.phase - 1]?.pool ?? [];
  let candidates = pool.filter((p) => {
    const def = script.patterns[p.id];
    if (!def || !usable(state, p.id, def)) return false;
    // 같은 패턴이 3번 연속 나오지 않게 한다
    const r = rt.recent;
    return !(r.length >= 2 && r[r.length - 1] === p.id && r[r.length - 2] === p.id);
  });
  if (candidates.length === 0) {
    // 쓸 수 있는 패턴이 없으면(페이즈·간격 제한) 스크립트의 일반 공격으로 대체한다. 제한을 어기고 고르지 않는다.
    candidates = Object.entries(script.patterns)
      .filter(([, def]) => def.kind === 'attack')
      .map(([id]) => ({ id, weight: 1 }));
  }
  if (candidates.length === 0) {
    return { patternId: 'idle', kind: 'stunned', name: '대기', telegraph: `${josa(boss.name, '은', '는')} 상황을 살핀다.` };
  }

  const chosen = pickWeighted(candidates, rng);
  const def = script.patterns[chosen.id]!;
  rt.recent = [...rt.recent, chosen.id].slice(-3);
  rt.sinceUsed[chosen.id] = 0;

  if (def.kind === 'charge_attack') {
    if (def.chargeRounds[rt.phase - 1]! >= 2) {
      rt.charging = chosen.id;
      return { patternId: chosen.id, kind: 'charge', name: def.name, telegraph: def.telegraphCharge, targetId };
    }
    return { patternId: chosen.id, kind: 'release', name: def.name, telegraph: def.telegraphRelease, targetId };
  }
  const telegraph = def.kind === 'summon' ? def.telegraph : `${def.telegraph}`;
  return { patternId: chosen.id, kind: def.kind, name: def.name, telegraph, targetId };
}

/** 살아 있는 모든 적의 다음 행동을 정한다 (보스는 스크립트, 하수인은 단순 공격). */
export function planIntents(state: BattleState, rng: () => number): Record<string, Intent> {
  const intents: Record<string, Intent> = {};
  const target = firstLivingPlayer(state);
  for (const c of state.combatants) {
    if (c.side !== 'enemy' || c.hp <= 0) continue;
    if (c.role === 'boss') {
      intents[c.id] = planBoss(state, c, target?.id, rng);
    } else if (c.role === 'minion') {
      intents[c.id] = {
        patternId: 'minion_attack', kind: 'minion_attack', name: '공격',
        telegraph: `${josa(c.name, '이', '가')} 달려든다.`, targetId: target?.id,
      };
    }
  }
  return intents;
}
