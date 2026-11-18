/** 전투 엔진 공용 타입. 솔로/1v1/4v4/레이드가 같은 코어를 공유한다. */

export interface Stats {
  maxHp: number;
  atk: number;
  def: number;
  spd: number;
  /** 지력: 회복·마법 스킬 계수의 기준 (없으면 0) */
  int?: number;
}

export type Side = 'player' | 'enemy';

/** normal: 일반 / boss: 보스 / minion: 보스가 소환한 하수인 / vessel: 보스 보호물(영혼함 등) */
export type Role = 'normal' | 'boss' | 'minion' | 'vessel';

/** 상태이상·버프 종류 ID (효과는 아래 필드 조합으로 정해진다) */
export type StatusId = string;

/**
 * 상태 효과. 라운드 `from`~`until`(포함) 동안 유효하다.
 * 스킬/패턴이 필드를 조합해 약화·취약·출혈·재생·보호막·반사 등을 표현한다.
 */
export interface StatusEffect {
  id: StatusId;
  /** 이 라운드까지 효과가 유지된다 (라운드 종료 시 만료) */
  until: number;
  /** 이 라운드부터 효과가 시작된다 (없으면 즉시) */
  from?: number;
  /** 해로운 효과인가 (정화 대상) */
  harmful?: boolean;
  /** 공격력 배율 (약화 = 0.8, 광란 = 1.25) */
  atkMult?: number;
  defMult?: number;
  spdMult?: number;
  /** 받는 피해 배율 (취약 = 1.15, 철벽 = 0.5) */
  takenMult?: number;
  /** 라운드 종료 시 이 만큼 고정 피해 (출혈) */
  dotAmount?: number;
  /** 라운드 종료 시 이 만큼 회복 (재생) */
  hotAmount?: number;
  /** 남은 보호막 피해 흡수량 */
  shield?: number;
  /** 받은 피해의 이 비율(0~1)을 공격자에게 되돌린다 (반격 태세) */
  reflectPct?: number;
  /** HP가 1 아래로 내려가지 않는다 (최후의 방패) */
  undying?: boolean;
  /** 스킬 AP 비용 감소량 (극한 개방) */
  apDiscount?: number;
}


export interface Combatant {
  id: string;
  name: string;
  side: Side;
  stats: Stats;
  hp: number;
  /** 직전 라운드에 방어를 선택했는가 (연속 방어 효과 감소용) */
  guardedLastRound: boolean;
  role?: Role;
  statuses?: StatusEffect[];
  /** 스킬 자원. 없으면 스킬을 쓰지 못한다 (일반 몹·보스) */
  ap?: number;
  /** 궁극기 게이지 0~100 */
  gauge?: number;
  /** 스킬 ID → 다시 쓸 수 있는 라운드 */
  cooldowns?: Record<string, number>;
  /** 충전 중인 스킬 (일점 집중): fireRound 라운드에 대상에게 발동한다 */
  pending?: { skillId: string; targetId: string; fireRound: number };
}

/** 라운드 시작 시 모든 참가자가 동시에 선택하는 행동 */
export type Action =
  | { kind: 'attack'; targetId: string }
  | { kind: 'guard' }
  | { kind: 'item'; itemId: string; healHp: number }
  | { kind: 'skill'; skillId: string; targetId?: string };

export type BattleStatus = 'ongoing' | 'victory' | 'defeat';

// ─── 스킬 ─────────────────────────────────────────────────────────────────────

export type SkillTarget = 'enemy' | 'all_enemies' | 'self';

/** 상태 효과를 거는 효과. turns 는 현재 라운드를 포함한 지속 라운드 수 */
export type StatusSpec = Omit<StatusEffect, 'until' | 'from'> & {
  turns: number;
  /** true 면 다음 라운드부터 시작한다 (출혈·재생처럼 라운드 종료 때 작동하는 효과, 철벽의 다음 턴 보너스) */
  startsNextRound?: boolean;
  /** 출혈: 시전자 ATK 의 이 비율(%)을 매 라운드 종료 시 고정 피해로 */
  dotAtkPct?: number;
  /** 재생: 시전자 지력의 이 비율(%)을 매 라운드 종료 시 회복 */
  hotIntPct?: number;
};

export type SkillEffect =
  | {
      kind: 'damage';
      /** 계수(%) */
      coef: number;
      hits?: number;
      scale?: 'atk' | 'def' | 'int';
      /** 대상 방어력을 이 비율(%)만큼 무시 */
      ignoreDefPct?: number;
      /** 대상이 취약(받는 피해 증가) 상태이면 피해 계수에 이 비율(%)을 더한다 */
      vsVulnerablePct?: number;
      /** 대상 HP가 이 비율(%) 이하이면 executeCoef 로 계수를 바꾼다 */
      executeBelowPct?: number;
      executeCoef?: number;
    }
  | { kind: 'status'; to: 'self' | 'target'; status: StatusSpec }
  | { kind: 'heal'; scale: 'int' | 'maxhp'; coef: number; doubleBelowPct?: number }
  | { kind: 'shield'; maxHpPct: number; turns: number }
  | { kind: 'cleanse'; count?: number }
  | { kind: 'ap'; amount: number }
  | { kind: 'cooldown_reduce'; amount: number };

/**
 * first: 선행(방어·버프) → normal: 속도순 → last: 후행(회복).
 * delayed: 이번 라운드는 충전만 하고 다음 라운드에 가장 마지막으로 발동한다.
 */
export type SkillPriority = 'first' | 'normal' | 'last' | 'delayed';

export interface SkillDef {
  id: string;
  name: string;
  ultimate?: boolean;
  apCost: number;
  cooldown: number;
  priority: SkillPriority;
  target: SkillTarget;
  effects: SkillEffect[];
}

// ─── 보스 스크립트 (데이터로 정의하고 엔진이 실행한다) ─────────────────────────

export type PatternDef =
  | { kind: 'attack'; name: string; mult: number; telegraph: string }
  | { kind: 'debuff'; name: string; atkMult: number; turns: number; telegraph: string }
  | { kind: 'drain'; name: string; pct: number; telegraph: string }
  | { kind: 'summon'; name: string; count: number; minPhase: number; telegraph: string }
  | {
      kind: 'charge_attack';
      name: string;
      mult: number;
      /** 페이즈별 충전 라운드 수. 1이면 충전 없이 바로 발동(예고만 보여 줌) */
      chargeRounds: [number, number, number];
      /** 페이즈별 끊기 기준: 한 라운드에 보스 최대 HP의 이 비율 이상 피해를 주면 끊긴다 */
      interruptPct: [number, number, number];
      /** 마지막 사용 후 최소 이 라운드가 지나야 다시 쓴다 */
      minGap: number;
      minPhase: number;
      telegraphCharge: string;
      telegraphRelease: string;
    };

export interface BossPhase {
  /** 보스 HP가 이 비율(%) 이하이면 이 페이즈 (1페이즈는 100) */
  fromHpPct: number;
  pool: { id: string; weight: number }[];
  /** 페이즈 보스 공격력 배율 */
  atkMult: number;
  /** 페이즈에 진입할 때 보여 줄 연출 문구 */
  enterText?: string;
}

export interface BossScript {
  bossId: string;
  patterns: Record<string, PatternDef>;
  /** 1 → 3 순서. fromHpPct 내림차순 */
  phases: BossPhase[];
  vessel?: {
    name: string;
    hp: number;
    def: number;
    /** 영혼함이 살아 있는 동안 보스가 받는 피해 감소율 */
    damageReduction: number;
    /** 영혼함이 살아 있을 때 보스가 쓰러지면 이 비율의 HP로 한 번 부활 */
    reviveHpPct: number;
    appearsAtPhase: number;
  };
  minion?: { name: string; stats: Stats; max: number; healBossPct: number };
}

export type IntentKind =
  | 'attack' | 'debuff' | 'drain' | 'summon' | 'charge' | 'release'
  | 'stunned' | 'phase_shift' | 'minion_attack';

/** 다음 라운드 적의 행동 예고. 선택 단계에서 플레이어에게 보여 준다. */
export interface Intent {
  patternId: string;
  kind: IntentKind;
  name: string;
  telegraph: string;
  targetId?: string;
}

export interface BossRuntime {
  phase: number;
  revived: boolean;
  /** 다음 라운드 행동 불가 (영혼함 파괴·끊김) */
  stunned: boolean;
  /** 페이즈 전환 라운드 (행동 없음) */
  phaseShift: boolean;
  charging?: string;
  recent: string[];
  sinceUsed: Record<string, number>;
  /** 이번 라운드에 보스가 실제로 잃은 HP (끊기 판정용) */
  damageThisRound: number;
  minionSeq: number;
}

export interface BattleState {
  round: number;
  status: BattleStatus;
  combatants: Combatant[];
  /** 결정론적 재현을 위한 RNG 시드 (라운드마다 갱신) */
  rngSeed: number;
  boss?: { script: BossScript; runtime: BossRuntime };
  /** 이 전투에서 쓸 수 있는 스킬 정의 (장착한 스킬) */
  skills?: Record<string, SkillDef>;
  /** 보스전에서 적들의 다음 행동 예고 (적 id → 예고) */
  intents?: Record<string, Intent>;
}

export type LogType = 'attack' | 'guard' | 'heal' | 'down' | 'skip' | 'status' | 'summon' | 'phase' | 'interrupt' | 'skill';

export interface LogEntry {
  round: number;
  type: LogType;
  actorId: string;
  targetId?: string;
  amount?: number;
  text: string;
}

export interface RoundResult {
  state: BattleState;
  log: LogEntry[];
}
