import { START_AP, bossScriptFor, computeStats, type MobData } from '@rtgm/data';
import { createBattle, type BattleState, type BossScript } from '@rtgm/engine';
import { equippedItems, getCharacter, getInventory } from './character';
import { battleSkills } from './skills';

export const PLAYER_ID = 'player';
export const ENEMY_ID = 'enemy';

/**
 * 전투 상태를 만든다 (장착 장비·스킬 반영, 보스는 패턴 스크립트).
 * hp: 로그라이크 던전에서 이어받는 현재 HP, mult: 최종 보스 강화 배율(HP·공격력)
 */
export async function createBattleState(
  db: D1Database, userId: string, mob: MobData, opts: { seed: number; hp?: number; mult?: number },
): Promise<BattleState> {
  const stats = computeStats(equippedItems(await getInventory(db, userId)));
  const { proficiency } = await getCharacter(db, userId);
  const skillDefs = await battleSkills(db, userId, proficiency);
  const raw = bossScriptFor(mob.id);
  const script = raw ? ({ ...raw, bossId: ENEMY_ID } as unknown as BossScript) : undefined;
  const mult = opts.mult ?? 1;
  const enemyHp = Math.round(mob.hp * mult);
  return createBattle(
    [
      { id: PLAYER_ID, name: '모험가', side: 'player', hp: Math.max(1, Math.min(opts.hp ?? stats.maxHp, stats.maxHp)), guardedLastRound: false, stats, ap: START_AP, gauge: 0, cooldowns: {} },
      { id: ENEMY_ID, name: mob.name, side: 'enemy', hp: enemyHp, guardedLastRound: false, stats: { maxHp: enemyHp, atk: Math.round(mob.atk * mult), def: mob.def, spd: mob.spd } },
    ],
    opts.seed, script, skillDefs,
  );
}
