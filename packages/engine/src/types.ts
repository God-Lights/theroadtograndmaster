/** 전투 엔진 공용 타입. 솔로/1v1/4v4/레이드가 같은 코어를 공유한다. */

export interface Stats {
  maxHp: number;
  atk: number;
  def: number;
  spd: number;
}

export type Side = 'player' | 'enemy';

export interface Combatant {
  id: string;
  name: string;
  side: Side;
  stats: Stats;
  hp: number;
  /** 직전 라운드에 방어를 선택했는가 (연속 방어 효과 감소용) */
  guardedLastRound: boolean;
}

/** 라운드 시작 시 모든 참가자가 동시에 선택하는 행동 */
export type Action =
  | { kind: 'attack'; targetId: string }
  | { kind: 'guard' }
  | { kind: 'item'; itemId: string; healHp: number };

export type BattleStatus = 'ongoing' | 'victory' | 'defeat';

export interface BattleState {
  round: number;
  status: BattleStatus;
  combatants: Combatant[];
  /** 결정론적 재현을 위한 RNG 시드 (라운드마다 갱신) */
  rngSeed: number;
}

export type LogType = 'attack' | 'guard' | 'heal' | 'down' | 'skip';

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
