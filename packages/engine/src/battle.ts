import { livingMinions, phaseFor, planIntents } from './boss-plan';
import { josa } from './josa';
import { mulberry32 } from './rng';
import type {
  Action, BattleState, BossScript, Combatant, Intent, LogEntry, LogType, RoundResult, StatusEffect,
} from './types';

/** docs/stats 시트 '개요' 설정값과 동일하게 유지할 것 */
export const GUARD_REDUCTION = 0.3;
export const REPEAT_GUARD_FACTOR = 0.5;

const clone = (c: Combatant): Combatant => ({
  ...c,
  stats: { ...c.stats },
  statuses: c.statuses?.map((s) => ({ ...s })),
});

export function createBattle(combatants: Combatant[], seed = 1, script?: BossScript): BattleState {
  const state: BattleState = {
    round: 1,
    status: 'ongoing',
    combatants: combatants.map((c) => {
      const copy = clone(c);
      if (script && c.id === script.bossId) copy.role = 'boss';
      return copy;
    }),
    rngSeed: seed,
  };
  if (script) {
    state.boss = {
      script,
      runtime: {
        phase: 1, revived: false, stunned: false, phaseShift: false, recent: [],
        sinceUsed: Object.fromEntries(Object.keys(script.patterns).map((id) => [id, 99])),
        damageThisRound: 0, minionSeq: 0,
      },
    };
    state.intents = planIntents(state, mulberry32((seed ^ 0xa5a5a5a5) >>> 0));
  }
  return state;
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

/** 상태이상(약화 등)을 반영한 공격력 */
export function effectiveAtk(c: Combatant): number {
  return c.stats.atk * (c.statuses ?? []).reduce((m, s) => m * s.atkMult, 1);
}

interface Ctx {
  state: BattleState;
  log: LogEntry[];
  round: number;
  rng: () => number;
  guarding: Set<string>;
}

const find = (ctx: Ctx, id: string | undefined) => ctx.state.combatants.find((c) => c.id === id);
const say = (ctx: Ctx, type: LogType, actorId: string, text: string, extra: Partial<LogEntry> = {}) =>
  ctx.log.push({ round: ctx.round, type, actorId, text, ...extra });
const vesselAlive = (ctx: Ctx) => ctx.state.combatants.some((c) => c.role === 'vessel' && c.hp > 0);

/** 쓰러짐 처리: 영혼함 파괴(보스 경직)·보스 부활 */
function onDown(ctx: Ctx, target: Combatant): void {
  const boss = ctx.state.boss;
  if (boss && target.role === 'vessel') {
    boss.runtime.stunned = true;
    boss.runtime.charging = undefined;
    say(ctx, 'down', target.id, `${josa(target.name, '이', '가')} 산산조각 났다! 보스가 충격에 휘청인다.`);
    return;
  }
  if (boss && target.role === 'boss') {
    const vessel = ctx.state.combatants.find((c) => c.role === 'vessel' && c.hp > 0);
    const vesselCfg = boss.script.vessel;
    if (vessel && vesselCfg && !boss.runtime.revived) {
      boss.runtime.revived = true;
      boss.runtime.charging = undefined;
      vessel.hp = 0;
      target.hp = Math.max(1, Math.ceil(target.stats.maxHp * vesselCfg.reviveHpPct));
      say(ctx, 'phase', target.id, `${josa(vessel.name, '이', '가')} 깨지며 ${josa(target.name, '이', '가')} 되살아난다!`);
      return;
    }
  }
  say(ctx, 'down', target.id, `${josa(target.name, '이', '가')} 쓰러졌다.`);
}

/** 한 번의 타격. 방어·영혼함 피해 감소를 반영하고 보스가 잃은 HP를 기록한다. */
function hit(ctx: Ctx, actor: Combatant, target: Combatant, atkValue: number, label = '공격'): number {
  let dmg = calcDamage(atkValue, target.stats.def, guardFactorOf(target, ctx.guarding.has(target.id)));
  let reduced = false;
  const boss = ctx.state.boss;
  if (boss && target.role === 'boss' && boss.script.vessel && vesselAlive(ctx)) {
    dmg = Math.max(1, Math.round(dmg * (1 - boss.script.vessel.damageReduction)));
    reduced = true;
  }
  const before = target.hp;
  target.hp = Math.max(0, target.hp - dmg);
  if (boss && target.role === 'boss') boss.runtime.damageThisRound += before - target.hp;
  say(ctx, 'attack', actor.id, `${actor.name}의 ${label}! ${target.name}에게 ${dmg} 피해.${reduced ? ' (영혼함이 피해를 줄였다)' : ''}`, {
    targetId: target.id, amount: dmg,
  });
  if (target.hp === 0) onDown(ctx, target);
  return dmg;
}

function applyWeaken(ctx: Ctx, target: Combatant, atkMult: number, turns: number): void {
  const status: StatusEffect = { id: 'weaken', until: ctx.round + turns, atkMult };
  target.statuses = [...(target.statuses ?? []).filter((s) => s.id !== 'weaken'), status];
}

function spawnMinions(ctx: Ctx, count: number): void {
  const boss = ctx.state.boss!;
  const cfg = boss.script.minion;
  if (!cfg) return;
  const room = cfg.max - livingMinions(ctx.state).length;
  for (let i = 0; i < Math.min(count, room); i++) {
    boss.runtime.minionSeq += 1;
    const id = `minion-${boss.runtime.minionSeq}`;
    ctx.state.combatants.push({
      id, name: cfg.name, side: 'enemy', role: 'minion', hp: cfg.stats.maxHp, guardedLastRound: false,
      stats: { ...cfg.stats },
    });
    say(ctx, 'summon', id, `${josa(cfg.name, '이', '가')} 나타났다!`);
  }
}

/** 적(보스·하수인)이 예고한 행동을 실행한다. */
function execIntent(ctx: Ctx, actor: Combatant, intent: Intent): void {
  const boss = ctx.state.boss!;
  const rt = boss.runtime;
  const target = find(ctx, intent.targetId);
  const phaseMult = actor.role === 'boss' ? (boss.script.phases[rt.phase - 1]?.atkMult ?? 1) : 1;

  switch (intent.kind) {
    case 'stunned':
      say(ctx, 'skip', actor.id, `${josa(actor.name, '은', '는')} 움직이지 못했다.`);
      rt.stunned = false;
      return;
    case 'phase_shift':
      say(ctx, 'phase', actor.id, intent.telegraph);
      rt.phaseShift = false;
      return;
    case 'charge':
      say(ctx, 'status', actor.id, `${josa(actor.name, '이', '가')} ${intent.name}을(를) 준비한다... ${intent.telegraph}`);
      return;
    case 'minion_attack':
      if (target && target.hp > 0) hit(ctx, actor, target, effectiveAtk(actor));
      return;
    default:
      break;
  }

  const def = boss.script.patterns[intent.patternId];
  if (!def) return;

  if (def.kind === 'attack' && target && target.hp > 0) {
    hit(ctx, actor, target, effectiveAtk(actor) * def.mult * phaseMult, def.name);
  } else if (def.kind === 'charge_attack' && intent.kind === 'release') {
    const need = Math.ceil(def.interruptPct[rt.phase - 1]! * actor.stats.maxHp);
    rt.charging = undefined;
    if (rt.damageThisRound >= need) {
      rt.stunned = true;
      say(ctx, 'interrupt', actor.id, `강한 일격이 ${def.name}을(를) 끊었다! ${josa(actor.name, '은', '는')} 경직된다.`);
    } else if (target && target.hp > 0) {
      hit(ctx, actor, target, effectiveAtk(actor) * def.mult * phaseMult, def.name);
    }
  } else if (def.kind === 'debuff' && target && target.hp > 0) {
    applyWeaken(ctx, target, def.atkMult, def.turns);
    say(ctx, 'status', actor.id, `${josa(actor.name, '이', '가')} ${def.name}을(를) 걸었다! ${target.name}의 공격력이 약해졌다.`, { targetId: target.id });
  } else if (def.kind === 'drain' && target && target.hp > 0) {
    const raw = Math.ceil(target.stats.maxHp * def.pct);
    const amount = Math.min(target.hp, Math.max(1, Math.round(raw * guardFactorOf(target, ctx.guarding.has(target.id)))));
    target.hp -= amount;
    const healed = Math.min(amount, actor.stats.maxHp - actor.hp);
    actor.hp += healed;
    say(ctx, 'attack', actor.id, `${josa(actor.name, '이', '가')} ${target.name}의 생기를 빨아들였다! ${amount} 피해, ${josa(actor.name, '은', '는')} HP ${healed} 회복.`, {
      targetId: target.id, amount,
    });
    if (target.hp === 0) onDown(ctx, target);
  } else if (def.kind === 'summon') {
    say(ctx, 'summon', actor.id, `${josa(actor.name, '이', '가')} ${def.name}을(를) 외쳤다!`);
    spawnMinions(ctx, def.count);
  }
}

/** 라운드 종료 처리: 끊기 판정·상태 만료·하수인 회복·페이즈 전환 */
function endOfRound(ctx: Ctx): void {
  const { state } = ctx;
  for (const c of state.combatants) {
    if (c.statuses) c.statuses = c.statuses.filter((s) => s.until > ctx.round);
  }
  const boss = state.boss;
  if (!boss) return;
  const bossC = state.combatants.find((c) => c.role === 'boss')!;
  const rt = boss.runtime;

  // 충전 중이던 큰 기술: 이번 라운드에 충분한 피해를 받았으면 끊긴다
  const intent = state.intents?.[bossC.id];
  if (bossC.hp > 0 && intent?.kind === 'charge') {
    const def = boss.script.patterns[intent.patternId];
    if (def?.kind === 'charge_attack' && rt.damageThisRound >= Math.ceil(def.interruptPct[rt.phase - 1]! * bossC.stats.maxHp)) {
      rt.charging = undefined;
      rt.stunned = true;
      say(ctx, 'interrupt', bossC.id, `강한 일격이 ${def.name}을(를) 끊었다! ${josa(bossC.name, '은', '는')} 경직된다.`);
    }
  }

  if (bossC.hp > 0) {
    // 하수인이 보스를 회복시킨다
    const cfg = boss.script.minion;
    if (cfg) {
      const heal = livingMinions(state).length * Math.floor(bossC.stats.maxHp * cfg.healBossPct);
      const healed = Math.min(heal, bossC.stats.maxHp - bossC.hp);
      if (healed > 0) {
        bossC.hp += healed;
        say(ctx, 'heal', bossC.id, `하수인들이 ${josa(bossC.name, '을', '를')} 회복시킨다. (HP +${healed})`, { amount: healed });
      }
    }
    // 페이즈 전환 (뒤로만 진행)
    const newPhase = phaseFor(state, bossC.hp / bossC.stats.maxHp);
    if (newPhase > rt.phase) {
      rt.phase = newPhase;
      rt.phaseShift = true;
      rt.charging = undefined;
      const vessel = boss.script.vessel;
      if (vessel && newPhase >= vessel.appearsAtPhase && !rt.revived && !state.combatants.some((c) => c.role === 'vessel')) {
        state.combatants.push({
          id: 'vessel', name: vessel.name, side: 'enemy', role: 'vessel', hp: vessel.hp, guardedLastRound: false,
          stats: { maxHp: vessel.hp, atk: 0, def: vessel.def, spd: 0 },
        });
        say(ctx, 'summon', 'vessel', `${josa(vessel.name, '이', '가')} 모습을 드러냈다! 부수기 전에는 ${bossC.name}에게 피해가 잘 들어가지 않는다.`);
      }
    }
  }
  for (const k of Object.keys(rt.sinceUsed)) rt.sinceUsed[k] = (rt.sinceUsed[k] ?? 0) + 1;
}

/**
 * 동시 선택 턴제 한 라운드를 처리한다.
 * 우선순위: 방어(선행) → 공격·적 행동(속도순) → 회복(후행)
 * 입력 상태는 변경하지 않는다.
 */
export function resolveRound(state: BattleState, actions: Record<string, Action>): RoundResult {
  if (state.status !== 'ongoing') return { state, log: [] };

  const next: BattleState = {
    ...state,
    combatants: state.combatants.map(clone),
    boss: state.boss && {
      script: state.boss.script,
      runtime: {
        ...state.boss.runtime,
        recent: [...state.boss.runtime.recent],
        sinceUsed: { ...state.boss.runtime.sinceUsed },
        damageThisRound: 0,
      },
    },
    intents: state.intents && { ...state.intents },
  };
  const rng = mulberry32(state.rngSeed);
  const ctx: Ctx = { state: next, log: [], round: state.round, rng, guarding: new Set() };
  const { round, log } = ctx;

  const living = next.combatants.filter((c) => c.hp > 0);
  const bossMode = !!next.boss;
  // 보스전에서는 적의 행동이 예고(intent)로 정해져 있고, 일반 전투에서는 actions 로 받는다.
  const intentOf = (c: Combatant): Intent | undefined => (bossMode && c.side === 'enemy' ? next.intents?.[c.id] : undefined);
  const chosen = (c: Combatant): Action | undefined =>
    intentOf(c) || (bossMode && c.side === 'enemy') ? undefined : (actions[c.id] ?? { kind: 'guard' });

  for (const c of living) {
    if (chosen(c)?.kind === 'guard') {
      ctx.guarding.add(c.id);
      say(ctx, 'guard', c.id, `${josa(c.name, '이', '가')} 방어 자세를 취했다.`);
    }
  }

  // 공격·적 행동: 속도 내림차순, 동속이면 시드 기반 무작위
  const actors = living
    .filter((c) => chosen(c)?.kind === 'attack' || intentOf(c))
    .map((c) => ({ c, tie: rng() }))
    .sort((a, b) => b.c.stats.spd - a.c.stats.spd || a.tie - b.tie)
    .map((x) => x.c);

  for (const actor of actors) {
    if (actor.hp <= 0) {
      say(ctx, 'skip', actor.id, `${josa(actor.name, '은', '는')} 쓰러져 행동하지 못했다.`);
      continue;
    }
    const intent = intentOf(actor);
    if (intent) {
      execIntent(ctx, actor, intent);
      continue;
    }
    const act = chosen(actor);
    if (act?.kind !== 'attack') continue;
    const target = next.combatants.find((c) => c.id === act.targetId);
    if (!target || target.hp <= 0) {
      say(ctx, 'skip', actor.id, `${actor.name}의 공격 대상은 이미 쓰러졌다.`);
      continue;
    }
    hit(ctx, actor, target, effectiveAtk(actor));
  }

  // 회복(후행)
  for (const c of living) {
    const act = chosen(c);
    if (act?.kind !== 'item' || c.hp <= 0) continue;
    const healed = Math.min(act.healHp, c.stats.maxHp - c.hp);
    c.hp += healed;
    say(ctx, 'heal', c.id, `${josa(c.name, '이', '가')} 아이템으로 HP ${healed} 회복.`, { amount: healed });
  }

  for (const c of next.combatants) c.guardedLastRound = ctx.guarding.has(c.id);

  endOfRound(ctx);

  const playersAlive = next.combatants.some((c) => c.side === 'player' && c.hp > 0);
  // 보스전: 보스가 완전히 쓰러지면 승리 (하수인이 남아 있어도). 일반 전투: 적이 모두 쓰러지면 승리.
  const bossDead = bossMode && next.combatants.some((c) => c.role === 'boss' && c.hp <= 0);
  const enemiesAlive = next.combatants.some((c) => c.side === 'enemy' && c.hp > 0);
  next.status = !playersAlive ? 'defeat' : (bossMode ? bossDead : !enemiesAlive) ? 'victory' : 'ongoing';
  next.round = round + 1;
  if (next.status === 'ongoing' && bossMode) next.intents = planIntents(next, rng);
  if (next.status !== 'ongoing') next.intents = {};
  next.rngSeed = Math.floor(rng() * 0xffffffff) >>> 0;

  return { state: next, log };
}
