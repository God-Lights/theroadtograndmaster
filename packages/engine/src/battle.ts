import { livingMinions, phaseFor, planIntents } from './boss-plan';
import { josa } from './josa';
import { mulberry32 } from './rng';
import type {
  Action, BattleState, BossRuntime, BossScript, Combatant, Intent, LogEntry, LogType, RoundResult, SkillDef, SkillEffect,
  StatusEffect, StatusSpec,
} from './types';

/** docs/stats 시트 '개요' 설정값과 동일하게 유지할 것 */
export const GUARD_REDUCTION = 0.3;
export const REPEAT_GUARD_FACTOR = 0.5;
export const AP_MAX = 6;
export const AP_REGEN = 2;
export const AP_ON_ATTACK = 1;
export const GAUGE_MAX = 100;
export const GAUGE_ON_DEAL = 10;
export const GAUGE_ON_TAKE = 10;
export const GAUGE_ON_HEAL = 8;
/** 방어력 기반 스킬(방패 강타 등)의 공격값 = 방어력 × 이 값 × 계수 */
export const DEF_SCALE = 3;

const RUNTIME_DEFAULTS: Pick<BossRuntime, 'stance' | 'stanceBoost' | 'reversed' | 'lastPlayerDamage' | 'hunger' | 'lastItemHeal' | 'itemHealThisRound'> = {
  stance: 'neutral', stanceBoost: 1, reversed: false, lastPlayerDamage: 0, hunger: 0, lastItemHeal: 0, itemHealThisRound: 0,
};

const clone = (c: Combatant): Combatant => ({
  ...c,
  stats: { ...c.stats },
  statuses: c.statuses?.map((s) => ({ ...s })),
  cooldowns: c.cooldowns && { ...c.cooldowns },
  pending: c.pending && { ...c.pending },
});

export function createBattle(
  combatants: Combatant[],
  seed = 1,
  script?: BossScript,
  skills?: Record<string, SkillDef>,
): BattleState {
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
  if (skills) state.skills = skills;
  if (script) {
    state.boss = {
      script,
      runtime: {
        phase: 1, revived: false, stunned: false, phaseShift: false, recent: [],
        sinceUsed: Object.fromEntries(Object.keys(script.patterns).map((id) => [id, 99])),
        damageThisRound: 0, minionSeq: 0,
        stance: 'neutral', stanceBoost: 1, reversed: false, lastActions: [], lastPlayerDamage: 0, playerDamageThisRound: 0,
        hunger: 0, lastItemHeal: 0, itemHealThisRound: 0,
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

/** pierce: 공격 쪽이 방어 효과를 이 비율만큼 무시한다 (공세의 자세) */
function guardFactorOf(c: Combatant, guarding: boolean, pierce = 0): number {
  if (!guarding) return 1;
  const reduction = (c.guardedLastRound ? GUARD_REDUCTION * REPEAT_GUARD_FACTOR : GUARD_REDUCTION) * (1 - pierce);
  return 1 - reduction;
}

// ─── 상태 효과 계산 ────────────────────────────────────────────────────────────

const isActive = (s: StatusEffect, round: number) => (s.from ?? 0) <= round && s.until >= round;
const activeOf = (c: Combatant, round: number) => (c.statuses ?? []).filter((s) => isActive(s, round));
type MultKey = 'atkMult' | 'defMult' | 'spdMult' | 'takenMult';
const factor = (c: Combatant, key: MultKey, round: number) => activeOf(c, round).reduce((m, s) => m * (s[key] ?? 1), 1);

/** 상태이상(약화·버프 등)을 반영한 공격력 */
export const effectiveAtk = (c: Combatant, round: number): number => c.stats.atk * factor(c, 'atkMult', round);
export const effectiveDef = (c: Combatant, round: number): number => c.stats.def * factor(c, 'defMult', round);
export const effectiveSpd = (c: Combatant, round: number): number => c.stats.spd * factor(c, 'spdMult', round);

// ─── 스킬 사용 가능 여부 ─────────────────────────────────────────────────────

/** 이번 라운드 스킬의 AP 비용 (극한 개방 같은 비용 감소 반영, 궁극기는 게이지를 쓰므로 0) */
export function skillCost(actor: Combatant, skill: SkillDef, round: number): number {
  if (skill.ultimate) return 0;
  const discount = activeOf(actor, round).reduce((a, s) => a + (s.apDiscount ?? 0), 0);
  return Math.max(0, skill.apCost - discount);
}

export type SkillCheck =
  | { ok: true; skill: SkillDef }
  | { ok: false; reason: 'unknown' | 'ap' | 'cooldown' | 'gauge' | 'charging' };

/** 서버·화면이 행동을 확정하기 전에 쓰는 검증. 엔진도 같은 검사를 한다. */
export function canUseSkill(state: BattleState, actor: Combatant, skillId: string): SkillCheck {
  const skill = state.skills?.[skillId];
  if (!skill || actor.ap === undefined) return { ok: false, reason: 'unknown' };
  if (actor.pending) return { ok: false, reason: 'charging' };
  if ((actor.cooldowns?.[skillId] ?? 0) > state.round) return { ok: false, reason: 'cooldown' };
  if (skill.ultimate) {
    if ((actor.gauge ?? 0) < GAUGE_MAX) return { ok: false, reason: 'gauge' };
  } else if (actor.ap < skillCost(actor, skill, state.round)) {
    return { ok: false, reason: 'ap' };
  }
  return { ok: true, skill };
}

// ─── 전투 처리 ────────────────────────────────────────────────────────────────

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
const addGauge = (c: Combatant, n: number) => { if (c.gauge !== undefined) c.gauge = Math.min(GAUGE_MAX, c.gauge + n); };
const addAp = (c: Combatant, n: number) => { if (c.ap !== undefined) c.ap = Math.max(0, Math.min(AP_MAX, c.ap + n)); };
const enemiesOf = (ctx: Ctx, c: Combatant) => ctx.state.combatants.filter((x) => x.side !== c.side && x.hp > 0);

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
  target.pending = undefined;
  say(ctx, 'down', target.id, `${josa(target.name, '이', '가')} 쓰러졌다.`);
}

interface HitOpts {
  label?: string;
  ignoreDefPct?: number;
  /** 반사 피해처럼 다시 반사되지 않게 한다 */
  noReflect?: boolean;
  /** basic: 기본 공격 / skill: 스킬. 반격의 자세는 기본 공격만 막고 되돌린다 */
  source?: 'basic' | 'skill' | 'other';
  /** 공세의 자세: 상대의 방어 효과를 이 비율만큼 무시 */
  guardPierce?: number;
}

/** 보호막이 먼저 피해를 흡수하고, 남은 피해만 HP를 깎는다. 최후의 방패 상태면 HP 1 아래로 내려가지 않는다. */
function takeDamage(ctx: Ctx, target: Combatant, dmg: number): { hpLost: number; absorbed: number } {
  let remaining = dmg;
  let absorbed = 0;
  for (const s of activeOf(target, ctx.round)) {
    if (!s.shield || remaining <= 0) continue;
    const take = Math.min(s.shield, remaining);
    s.shield -= take;
    remaining -= take;
    absorbed += take;
  }
  if (target.statuses) target.statuses = target.statuses.filter((s) => s.shield === undefined || s.shield > 0);
  const before = target.hp;
  target.hp = Math.max(0, target.hp - remaining);
  if (target.hp === 0 && activeOf(target, ctx.round).some((s) => s.undying)) target.hp = 1;
  const hpLost = before - target.hp;
  const boss = ctx.state.boss;
  if (boss && target.role === 'boss') boss.runtime.damageThisRound += hpLost;
  return { hpLost, absorbed };
}

/** 한 번의 타격. 방어·취약·영혼함·보호막·반사를 반영하고 게이지를 채운다. */
function hit(ctx: Ctx, actor: Combatant, target: Combatant, atkValue: number, opts: HitOpts = {}): number {
  const def = effectiveDef(target, ctx.round) * (1 - (opts.ignoreDefPct ?? 0) / 100);
  let dmg = calcDamage(atkValue, def, guardFactorOf(target, ctx.guarding.has(target.id), opts.guardPierce ?? 0));
  const taken = factor(target, 'takenMult', ctx.round);
  if (taken !== 1) dmg = Math.max(1, Math.round(dmg * taken));
  let reduced = false;
  const boss = ctx.state.boss;
  // 반격의 자세: 기본 공격 피해가 줄고 일부가 되돌아온다 (스킬은 영향을 받지 않는다)
  let stanceReflect = 0;
  if (boss?.script.stance && target.role === 'boss' && boss.runtime.stance === 'counter' && opts.source === 'basic') {
    const cfg = boss.script.stance.counter;
    dmg = Math.max(1, Math.round(dmg * (1 - Math.min(0.95, cfg.reduction * boss.runtime.stanceBoost))));
    stanceReflect = Math.min(1.5, cfg.reflect * boss.runtime.stanceBoost);
  }
  if (boss && target.role === 'boss' && boss.script.vessel && vesselAlive(ctx)) {
    dmg = Math.max(1, Math.round(dmg * (1 - boss.script.vessel.damageReduction)));
    reduced = true;
  }
  const { absorbed } = takeDamage(ctx, target, dmg);
  if (boss && actor.side === 'player') boss.runtime.playerDamageThisRound += dmg;
  addGauge(actor, GAUGE_ON_DEAL);
  addGauge(target, GAUGE_ON_TAKE);
  const notes = `${reduced ? ' (영혼함이 피해를 줄였다)' : ''}${absorbed > 0 ? ` (보호막 ${absorbed} 흡수)` : ''}`;
  say(ctx, 'attack', actor.id, `${actor.name}의 ${opts.label ?? '공격'}! ${target.name}에게 ${dmg} 피해.${notes}`, {
    targetId: target.id, amount: dmg,
  });

  // 반격 태세: 받은 피해의 일부를 공격자에게 되돌린다
  if (!opts.noReflect && actor.hp > 0) {
    const reflect = Math.max(stanceReflect, activeOf(target, ctx.round).reduce((m, s) => Math.max(m, s.reflectPct ?? 0), 0));
    if (reflect > 0 && dmg > 0) {
      const back = Math.max(1, Math.round(dmg * reflect));
      takeDamage(ctx, actor, back);
      addGauge(actor, GAUGE_ON_TAKE);
      say(ctx, 'attack', target.id, `${target.name}의 반격! ${actor.name}에게 ${back} 피해를 되돌렸다.`, { targetId: actor.id, amount: back });
      if (actor.hp === 0) onDown(ctx, actor);
    }
  }
  if (target.hp === 0) onDown(ctx, target);
  return dmg;
}

/** 방어·반사와 무관한 고정 피해 (출혈 등) */
function directDamage(ctx: Ctx, target: Combatant, amount: number, text: string): void {
  if (amount <= 0 || target.hp <= 0) return;
  const { hpLost } = takeDamage(ctx, target, amount);
  say(ctx, 'attack', target.id, text.replace('{n}', String(hpLost)), { targetId: target.id, amount: hpLost });
  if (target.hp === 0) onDown(ctx, target);
}

function healTo(ctx: Ctx, target: Combatant, amount: number): number {
  const healed = Math.max(0, Math.min(Math.round(amount), target.stats.maxHp - target.hp));
  target.hp += healed;
  return healed;
}

function addStatus(c: Combatant, status: StatusEffect): void {
  c.statuses = [...(c.statuses ?? []).filter((s) => s.id !== status.id), status];
}

function applyWeaken(ctx: Ctx, target: Combatant, atkMult: number, turns: number): void {
  addStatus(target, { id: 'weaken', until: ctx.round + turns, atkMult, harmful: true });
}

function applySpec(ctx: Ctx, source: Combatant, holder: Combatant, id: string, spec: StatusSpec): void {
  const { turns, startsNextRound, dotAtkPct, hotIntPct, ...effect } = spec;
  const from = startsNextRound ? ctx.round + 1 : undefined;
  const until = (from ?? ctx.round) + turns - 1;
  const status: StatusEffect = { ...effect, id: effect.id || id, until };
  if (from !== undefined) status.from = from;
  if (dotAtkPct) status.dotAmount = Math.max(1, Math.round((effectiveAtk(source, ctx.round) * dotAtkPct) / 100));
  if (hotIntPct) status.hotAmount = Math.max(1, Math.round(((source.stats.int ?? 0) * hotIntPct) / 100));
  addStatus(holder, status);
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
  // 공세의 자세: 보스 공격력이 오르고 상대의 방어 효과 일부를 무시한다
  const stanceCfg = boss.script.stance;
  const offense = !!stanceCfg && actor.role === 'boss' && rt.stance === 'offense';
  const phaseMult = (actor.role === 'boss' ? (boss.script.phases[rt.phase - 1]?.atkMult ?? 1) : 1)
    * (offense ? 1 + (stanceCfg!.offense.atkMult - 1) * rt.stanceBoost : 1)
    * (actor.role === 'boss' && boss.script.hunger ? 1 + boss.script.hunger.atkPerStack * rt.hunger : 1);
  const pierce = offense ? Math.min(1, stanceCfg!.offense.guardPierce * rt.stanceBoost) : 0;

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
      if (target && target.hp > 0) hit(ctx, actor, target, effectiveAtk(actor, ctx.round));
      return;
    default:
      break;
  }

  const def = boss.script.patterns[intent.patternId];
  if (!def) return;

  if (def.kind === 'attack' && target && target.hp > 0) {
    for (let i = 0; i < (def.hits ?? 1) && target.hp > 0; i++) {
      hit(ctx, actor, target, effectiveAtk(actor, ctx.round) * def.mult * phaseMult, { label: def.name, guardPierce: pierce });
    }
  } else if (def.kind === 'stance') {
    addStatus(actor, { id: 'shell', until: ctx.round, takenMult: def.takenMult, reflectPct: def.reflectPct });
    say(ctx, 'status', actor.id, `${josa(actor.name, '이', '가')} ${def.name}! ${def.telegraph}`);
  } else if (def.kind === 'devour' && target && target.hp > 0) {
    rt.hunger = 0;
    const dmg = hit(ctx, actor, target, effectiveAtk(actor, ctx.round) * def.mult * phaseMult, { label: def.name, guardPierce: pierce });
    const healed = healTo(ctx, actor, Math.round(dmg * def.healPct));
    if (healed > 0) say(ctx, 'heal', actor.id, `${josa(actor.name, '은', '는')} 배를 채웠다! HP ${healed} 회복. 허기가 가셨다.`, { amount: healed });
  } else if (def.kind === 'copy_item') {
    const want = Math.min(rt.lastItemHeal, Math.round(actor.stats.maxHp * def.maxHealPct));
    const healed = healTo(ctx, actor, want);
    say(ctx, 'heal', actor.id, `“부족해!” ${josa(actor.name, '이', '가')} 당신이 쓴 아이템을 가로채 똑같이 썼다. HP ${healed} 회복.`, { amount: healed });
  } else if (def.kind === 'mirror' && target && target.hp > 0) {
    const raw = Math.round(rt.lastPlayerDamage * def.pct);
    if (raw <= 0) {
      say(ctx, 'skip', actor.id, '거울에 아무것도 비치지 않았다.');
    } else {
      const dmg = Math.max(1, Math.round(raw * guardFactorOf(target, ctx.guarding.has(target.id), pierce)));
      const { absorbed } = takeDamage(ctx, target, dmg);
      addGauge(target, GAUGE_ON_TAKE);
      say(ctx, 'attack', actor.id, `${actor.name}의 ${def.name}! 당신의 일격이 되돌아와 ${target.name}에게 ${dmg} 피해.${absorbed > 0 ? ` (보호막 ${absorbed} 흡수)` : ''}`, { targetId: target.id, amount: dmg });
      if (target.hp === 0) onDown(ctx, target);
    }
  } else if (def.kind === 'charge_attack' && intent.kind === 'release') {
    const need = Math.ceil(def.interruptPct[rt.phase - 1]! * actor.stats.maxHp);
    rt.charging = undefined;
    if (rt.damageThisRound >= need) {
      rt.stunned = true;
      say(ctx, 'interrupt', actor.id, `강한 일격이 ${def.name}을(를) 끊었다! ${josa(actor.name, '은', '는')} 경직된다.`);
    } else if (target && target.hp > 0) {
      hit(ctx, actor, target, effectiveAtk(actor, ctx.round) * def.mult * phaseMult, { label: def.name, guardPierce: pierce });
    }
  } else if (def.kind === 'debuff' && target && target.hp > 0) {
    applyWeaken(ctx, target, def.atkMult, def.turns);
    say(ctx, 'status', actor.id, `${josa(actor.name, '이', '가')} ${def.name}을(를) 걸었다! ${target.name}의 공격력이 약해졌다.`, { targetId: target.id });
  } else if (def.kind === 'drain' && target && target.hp > 0) {
    const raw = Math.ceil(target.stats.maxHp * def.pct);
    const want = Math.max(1, Math.round(raw * guardFactorOf(target, ctx.guarding.has(target.id))));
    const { hpLost: amount } = takeDamage(ctx, target, want);
    const healed = healTo(ctx, actor, amount);
    say(ctx, 'attack', actor.id, `${josa(actor.name, '이', '가')} ${target.name}의 생기를 빨아들였다! ${amount} 피해, ${josa(actor.name, '은', '는')} HP ${healed} 회복.`, {
      targetId: target.id, amount,
    });
    if (target.hp === 0) onDown(ctx, target);
  } else if (def.kind === 'summon') {
    say(ctx, 'summon', actor.id, `${josa(actor.name, '이', '가')} ${def.name}을(를) 외쳤다!`);
    spawnMinions(ctx, def.count);
  }
}

// ─── 스킬 실행 ────────────────────────────────────────────────────────────────

function execEffect(ctx: Ctx, actor: Combatant, skill: SkillDef, effect: SkillEffect, targets: Combatant[]): void {
  switch (effect.kind) {
    case 'damage': {
      for (const target of targets) {
        for (let i = 0; i < (effect.hits ?? 1); i++) {
          if (target.hp <= 0 || actor.hp <= 0) break;
          let coef = effect.coef;
          if (effect.executeBelowPct !== undefined && target.hp <= (target.stats.maxHp * effect.executeBelowPct) / 100) {
            coef = effect.executeCoef ?? coef;
          }
          if (effect.vsVulnerablePct && factor(target, 'takenMult', ctx.round) > 1) coef *= 1 + effect.vsVulnerablePct / 100;
          const base =
            effect.scale === 'def' ? effectiveDef(actor, ctx.round) * DEF_SCALE
              : effect.scale === 'int' ? (actor.stats.int ?? 0)
                : effectiveAtk(actor, ctx.round);
          hit(ctx, actor, target, (base * coef) / 100, { label: skill.name, ignoreDefPct: effect.ignoreDefPct, source: 'skill' });
        }
      }
      return;
    }
    case 'status': {
      const holders = effect.to === 'self' ? [actor] : targets;
      for (const h of holders) {
        if (h.hp <= 0) continue;
        applySpec(ctx, actor, h, effect.status.id, effect.status);
        if (effect.to === 'target') say(ctx, 'status', actor.id, `${h.name}에게 ${skill.name} 효과가 걸렸다.`, { targetId: h.id });
      }
      return;
    }
    case 'heal': {
      let amount = effect.scale === 'maxhp' ? (actor.stats.maxHp * effect.coef) / 100 : ((actor.stats.int ?? 0) * effect.coef) / 100;
      if (effect.doubleBelowPct !== undefined && actor.hp <= (actor.stats.maxHp * effect.doubleBelowPct) / 100) amount *= 2;
      const healed = healTo(ctx, actor, amount);
      addGauge(actor, GAUGE_ON_HEAL);
      say(ctx, 'heal', actor.id, `${josa(actor.name, '이', '가')} ${skill.name}으로 HP ${healed} 회복.`, { amount: healed });
      return;
    }
    case 'shield': {
      const amount = Math.max(1, Math.round((actor.stats.maxHp * effect.maxHpPct) / 100));
      addStatus(actor, { id: 'shield', shield: amount, until: ctx.round + effect.turns - 1 });
      say(ctx, 'status', actor.id, `${josa(actor.name, '은', '는')} 보호막 ${amount}을(를) 두른다.`);
      return;
    }
    case 'cleanse': {
      const harmful = (actor.statuses ?? []).filter((s) => s.harmful);
      const remove = new Set(harmful.slice(0, effect.count ?? harmful.length));
      if (remove.size > 0) {
        actor.statuses = (actor.statuses ?? []).filter((s) => !remove.has(s));
        say(ctx, 'status', actor.id, `${josa(actor.name, '은', '는')} 해로운 효과 ${remove.size}개를 정화했다.`);
      }
      return;
    }
    case 'ap':
      addAp(actor, effect.amount);
      say(ctx, 'status', actor.id, `${josa(actor.name, '은', '는')} AP ${effect.amount > 0 ? '+' : ''}${effect.amount}.`);
      return;
    case 'cooldown_reduce':
      for (const k of Object.keys(actor.cooldowns ?? {})) {
        actor.cooldowns![k] = Math.max(ctx.round + 1, (actor.cooldowns![k] ?? 0) - effect.amount);
      }
      say(ctx, 'status', actor.id, `${actor.name}의 스킬 쿨다운이 줄었다.`);
      return;
  }
}

function execSkill(ctx: Ctx, actor: Combatant, skill: SkillDef, targetId: string | undefined): void {
  const foes = enemiesOf(ctx, actor);
  let targets: Combatant[] = [];
  if (skill.target === 'self') targets = [actor];
  else if (skill.target === 'all_enemies') targets = foes;
  else {
    const t = foes.find((x) => x.id === targetId) ?? foes.find((x) => x.role !== 'vessel' && x.role !== 'minion') ?? foes[0];
    if (t) targets = [t];
  }
  if (skill.target !== 'self' && targets.length === 0) {
    say(ctx, 'skip', actor.id, `${skill.name}의 대상이 없다.`);
    return;
  }
  say(ctx, 'skill', actor.id, `${josa(actor.name, '이', '가')} ${skill.name}을(를) 사용했다!`);
  for (const effect of skill.effects) execEffect(ctx, actor, skill, effect, targets);
}

// ─── 라운드 종료 ──────────────────────────────────────────────────────────────

function endOfRound(ctx: Ctx): void {
  const { state } = ctx;

  // 지속 효과: 출혈(고정 피해)·재생(회복)
  for (const c of state.combatants) {
    if (c.hp <= 0) continue;
    for (const s of activeOf(c, ctx.round)) {
      if (s.dotAmount) directDamage(ctx, c, s.dotAmount, `${c.name}이(가) 출혈로 {n} 피해를 입었다.`);
      if (s.hotAmount && c.hp > 0) {
        const healed = healTo(ctx, c, s.hotAmount);
        if (healed > 0) say(ctx, 'heal', c.id, `${josa(c.name, '은', '는')} 재생으로 HP ${healed} 회복.`, { amount: healed });
      }
    }
  }
  // 만료 + 스킬 자원 재생
  for (const c of state.combatants) {
    if (c.statuses) c.statuses = c.statuses.filter((s) => s.until > ctx.round);
    if (c.hp > 0) addAp(c, AP_REGEN);
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
      const healed = healTo(ctx, bossC, heal);
      if (healed > 0) say(ctx, 'heal', bossC.id, `하수인들이 ${josa(bossC.name, '을', '를')} 회복시킨다. (HP +${healed})`, { amount: healed });
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
 * 다음 라운드의 자세를 정한다: 플레이어의 직전 행동의 '반대'.
 * 공격 → 반격의 자세, 방어 → 공세의 자세, 스킬·아이템 → 중립 (스킬로 풀어 갈 수 있다).
 */
function updateStance(ctx: Ctx): void {
  const boss = ctx.state.boss;
  const cfg = boss?.script.stance;
  if (!boss || !cfg) return;
  const rt = boss.runtime;
  const last = rt.lastActions[rt.lastActions.length - 1];
  const nextRound = ctx.round + 1;

  rt.reversed = rt.phase >= cfg.reversalFromPhase && nextRound % cfg.reversalEvery === 0;
  let stance: 'neutral' | 'counter' | 'offense' = last === 'attack' ? 'counter' : last === 'guard' ? 'offense' : 'neutral';
  if (rt.reversed) stance = stance === 'counter' ? 'offense' : stance === 'offense' ? 'counter' : 'neutral';
  rt.stance = stance;

  const repeated = rt.lastActions.length >= 2 && rt.lastActions[0] === rt.lastActions[1] && (last === 'attack' || last === 'guard');
  rt.stanceBoost = rt.phase >= cfg.enhancedFromPhase && repeated ? cfg.enhancedMult : 1;
}

// ─── 한 라운드 ────────────────────────────────────────────────────────────────

/** 실행 순서: 0 = 선행(방어·버프) → 1 = 속도순(공격·적 행동) → 2 = 후행(회복) */
interface Plan {
  c: Combatant;
  prio: 0 | 1 | 2;
  speed: number;
  run: () => void;
}

/**
 * 동시 선택 턴제 한 라운드를 처리한다.
 * 우선순위: 방어·선행 스킬 → 공격·스킬·적 행동(속도순) → 회복·후행 스킬
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
        // 새 필드가 없는 예전 저장 상태(배포 중 진행 중이던 전투)도 이어서 처리할 수 있게 기본값을 깐다
        ...RUNTIME_DEFAULTS,
        ...state.boss.runtime,
        recent: [...state.boss.runtime.recent],
        sinceUsed: { ...state.boss.runtime.sinceUsed },
        lastActions: [...(state.boss.runtime.lastActions ?? [])],
        damageThisRound: 0,
        playerDamageThisRound: 0,
      },
    },
    intents: state.intents && { ...state.intents },
  };
  const rng = mulberry32(state.rngSeed);
  const ctx: Ctx = { state: next, log: [], round: state.round, rng, guarding: new Set() };
  const { round } = ctx;

  const living = next.combatants.filter((c) => c.hp > 0);
  const bossMode = !!next.boss;
  // 보스전에서는 적의 행동이 예고(intent)로 정해져 있고, 일반 전투에서는 actions 로 받는다.
  const intentOf = (c: Combatant): Intent | undefined => (bossMode && c.side === 'enemy' ? next.intents?.[c.id] : undefined);
  const driven = (c: Combatant) => !!intentOf(c) || (bossMode && c.side === 'enemy');

  const plans: Plan[] = [];
  // 코에도스 같은 '반대 자세' 보스를 위해 플레이어가 이번 라운드에 실제로 한 행동 종류를 기록한다
  let playerKind: string | undefined;
  const firstFoe = (c: Combatant) => enemiesOf(ctx, c).find((x) => x.role !== 'vessel' && x.role !== 'minion') ?? enemiesOf(ctx, c)[0];

  for (const c of living) {
    const intent = intentOf(c);
    if (intent) {
      plans.push({ c, prio: intent.kind === 'stance' ? 0 : 1, speed: c.stats.spd, run: () => execIntent(ctx, c, intent) });
      continue;
    }
    if (driven(c)) continue;

    // 충전 중인 스킬이 이번 라운드에 발동하면 다른 행동은 선택할 수 없다
    let act: Action = actions[c.id] ?? { kind: 'guard' };
    if (c.pending && c.pending.fireRound === round) {
      const pend = c.pending;
      c.pending = undefined;
      if (c.side === 'player') playerKind = 'skill';
      const skill = next.skills?.[pend.skillId];
      if (skill) plans.push({ c, prio: 1, speed: -1, run: () => execSkill(ctx, c, skill, pend.targetId) });
      continue;
    }

    if (act.kind === 'skill') {
      const check = canUseSkill(next, c, act.skillId);
      if (!check.ok) {
        say(ctx, 'skip', c.id, `${josa(c.name, '은', '는')} 스킬을 쓰지 못해 기본 공격으로 대신했다.`);
        const foe = firstFoe(c);
        act = foe ? { kind: 'attack', targetId: act.targetId ?? foe.id } : { kind: 'guard' };
      } else {
        const { skill } = check;
        if (c.side === 'player') playerKind = 'skill';
        // 비용은 선택한 순간 낸다 (이후 쓰러져도 돌려받지 않는다)
        if (skill.ultimate) c.gauge = 0;
        else c.ap = Math.max(0, (c.ap ?? 0) - skillCost(c, skill, round));
        if (skill.cooldown > 0) c.cooldowns = { ...(c.cooldowns ?? {}), [skill.id]: round + skill.cooldown + 1 };
        const targetId = act.targetId;
        if (skill.priority === 'delayed') {
          const foe = enemiesOf(ctx, c).find((x) => x.id === targetId) ?? firstFoe(c);
          c.pending = { skillId: skill.id, targetId: foe?.id ?? '', fireRound: round + 1 };
          plans.push({
            c, prio: 1, speed: c.stats.spd,
            run: () => say(ctx, 'status', c.id, `${josa(c.name, '이', '가')} ${skill.name}을(를) 위해 힘을 모은다... (다음 라운드 발동)`),
          });
        } else {
          const prio = skill.priority === 'first' ? 0 : skill.priority === 'last' ? 2 : 1;
          plans.push({ c, prio, speed: c.stats.spd, run: () => execSkill(ctx, c, skill, targetId) });
        }
        continue;
      }
    }

    if (c.side === 'player') playerKind = act.kind;
    if (act.kind === 'guard') {
      ctx.guarding.add(c.id);
      say(ctx, 'guard', c.id, `${josa(c.name, '이', '가')} 방어 자세를 취했다.`);
    } else if (act.kind === 'attack') {
      const atk = act;
      plans.push({
        c, prio: 1, speed: c.stats.spd,
        run: () => {
          const target = next.combatants.find((x) => x.id === atk.targetId);
          if (!target || target.hp <= 0) {
            say(ctx, 'skip', c.id, `${c.name}의 공격 대상은 이미 쓰러졌다.`);
            return;
          }
          hit(ctx, c, target, effectiveAtk(c, round), { source: 'basic' });
          addAp(c, AP_ON_ATTACK);
        },
      });
    } else if (act.kind === 'item') {
      const item = act;
      plans.push({
        c, prio: 2, speed: c.stats.spd,
        run: () => {
          const healed = healTo(ctx, c, item.healHp);
          if (next.boss && c.side === 'player') next.boss.runtime.itemHealThisRound += item.healHp;
          addGauge(c, GAUGE_ON_HEAL);
          say(ctx, 'heal', c.id, `${josa(c.name, '이', '가')} 아이템으로 HP ${healed} 회복.`, { amount: healed });
        },
      });
    }
  }

  // 같은 우선순위 안에서는 (효과를 반영한) 속도 내림차순, 동속이면 시드 기반 무작위
  const ordered = plans
    .map((p) => ({ p, tie: rng() }))
    .sort((a, b) => a.p.prio - b.p.prio || (b.p.speed < 0 || a.p.speed < 0 ? b.p.speed - a.p.speed : effectiveSpd(b.p.c, round) - effectiveSpd(a.p.c, round)) || a.tie - b.tie)
    .map((x) => x.p);

  for (const plan of ordered) {
    if (plan.c.hp <= 0) {
      say(ctx, 'skip', plan.c.id, `${josa(plan.c.name, '은', '는')} 쓰러져 행동하지 못했다.`);
      continue;
    }
    plan.run();
  }

  for (const c of next.combatants) c.guardedLastRound = ctx.guarding.has(c.id);

  endOfRound(ctx);
  if (next.boss) {
    const rt = next.boss.runtime;
    if (playerKind) rt.lastActions = [...rt.lastActions, playerKind].slice(-2);
    rt.lastPlayerDamage = rt.playerDamageThisRound;
    rt.playerDamageThisRound = 0;
    rt.lastItemHeal = rt.itemHealThisRound;
    rt.itemHealThisRound = 0;
    const hg = next.boss.script.hunger;
    if (hg) rt.hunger = Math.min(hg.max, rt.hunger + hg.perRound);
    updateStance(ctx);
  }

  const playersAlive = next.combatants.some((c) => c.side === 'player' && c.hp > 0);
  // 보스전: 보스가 완전히 쓰러지면 승리 (하수인이 남아 있어도). 일반 전투: 적이 모두 쓰러지면 승리.
  const bossDead = bossMode && next.combatants.some((c) => c.role === 'boss' && c.hp <= 0);
  const enemiesAlive = next.combatants.some((c) => c.side === 'enemy' && c.hp > 0);
  next.status = !playersAlive ? 'defeat' : (bossMode ? bossDead : !enemiesAlive) ? 'victory' : 'ongoing';
  next.round = round + 1;
  if (next.status === 'ongoing' && bossMode) next.intents = planIntents(next, rng);
  if (next.status !== 'ongoing') next.intents = {};
  next.rngSeed = Math.floor(rng() * 0xffffffff) >>> 0;

  return { state: next, log: ctx.log };
}
