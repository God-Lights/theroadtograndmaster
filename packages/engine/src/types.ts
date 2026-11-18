/** 전투 엔진 공용 타입. 솔로/1v1/4v4/레이드가 같은 코어를 공유한다. */

export interface Stats {
  maxHp: number;
  atk: number;
  def: number;
  spd: number;
}

export type Side = 'player' | 'enemy';

/** normal: 일반 / boss: 보스 / minion: 보스가 소환한 하수인 / vessel: 보스 보호물(영혼함 등) */
export type Role = 'normal' | 'boss' | 'minion' | 'vessel';

export type StatusId = 'weaken';

export interface StatusEffect {
  id: StatusId;
  /** 이 라운드까지 효과가 유지된다 (라운드 종료 시 만료) */
  until: number;
  /** 공격력 배율 (약화 = 0.8) */
  atkMult: number;
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
}

/** 라운드 시작 시 모든 참가자가 동시에 선택하는 행동 */
export type Action =
  | { kind: 'attack'; targetId: string }
  | { kind: 'guard' }
  | { kind: 'item'; itemId: string; healHp: number };

export type BattleStatus = 'ongoing' | 'victory' | 'defeat';

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
  /** 보스전에서 적들의 다음 행동 예고 (적 id → 예고) */
  intents?: Record<string, Intent>;
}

export type LogType = 'attack' | 'guard' | 'heal' | 'down' | 'skip' | 'status' | 'summon' | 'phase' | 'interrupt';

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
