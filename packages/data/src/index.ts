import itemsJson from '../data/items.json';
import mobsJson from '../data/mobs.json';
import tiersJson from '../data/proficiency-tiers.json';
import recipesJson from '../data/recipes.json';

export type ItemType = 'sword' | 'shield' | 'armor' | 'consumable' | 'material';

export interface ItemData {
  id: string;
  name: string;
  type: ItemType;
  rarity: 'basic' | 'normal' | 'rare' | 'epic';
  atk: number;
  def: number;
  hp: number;
  /** 소모품 HP 회복량 */
  heal: number;
  buy: number | null;
  sell: number;
  minProficiency: number;
}

export interface MobData {
  id: string;
  name: string;
  kind: 'normal' | 'boss';
  hp: number;
  atk: number;
  def: number;
  spd: number;
  gold: [number, number];
  /** 전투 승리/패배 시 얻는 숙련도 (EDRPG PROFICIENCY_GAINS 기준) */
  profWin: number;
  profLose: number;
  drops: { itemId: string; chance: number }[];
}

export const ITEMS = itemsJson as ItemData[];
export const MOBS = mobsJson as MobData[];

export const itemById = (id: string): ItemData | undefined => ITEMS.find((i) => i.id === id);
export const mobById = (id: string): MobData | undefined => MOBS.find((m) => m.id === id);

/** 신규 캐릭터 기본 스탯 (EDRPG BASE_ATK 8 / BASE_DEF 3 / BASE_HP 100 계승) */
export const BASE_STATS = { maxHp: 100, atk: 8, def: 3, spd: 10 } as const;
export const STARTER_ITEMS = ['rusted_sword', 'rusted_armor'] as const;

/** 상점 1회 구매 최대 수량 */
export const MAX_BUY_QUANTITY = 99;

/** 신규 캐릭터 시작 골드 (가제안) */
export const STARTER_GOLD = 500;

/** 장착 슬롯 = 아이템 종류. 슬롯마다 1개만 장착한다. */
export const EQUIP_TYPES = ['sword', 'shield', 'armor'] as const;
export type EquipType = (typeof EQUIP_TYPES)[number];
export const isEquipType = (t: ItemType): t is EquipType => (EQUIP_TYPES as readonly string[]).includes(t);

export interface CombatStats {
  maxHp: number;
  atk: number;
  def: number;
  spd: number;
}

/** 기본 스탯 + 장착 장비. 검=ATK, 방패=DEF, 갑옷=HP (EDRPG 규칙) */
export function computeStats(equipped: readonly ItemData[]): CombatStats {
  const stats: CombatStats = { ...BASE_STATS };
  for (const item of equipped) {
    stats.atk += item.atk;
    stats.def += item.def;
    stats.maxHp += item.hp;
  }
  return stats;
}

export interface ProficiencyTier {
  level: number;
  name: string;
  /** 이 티어에 필요한 숙련도 점수 */
  min: number;
}

/** EDRPG 숙련도 50단계 (초보자 → 최강자) */
export const PROFICIENCY_TIERS = tiersJson as ProficiencyTier[];

export function getProfTier(proficiency: number): ProficiencyTier {
  let tier = PROFICIENCY_TIERS[0]!;
  for (const t of PROFICIENCY_TIERS) if (proficiency >= t.min) tier = t;
  return tier;
}

export function getNextTier(proficiency: number): ProficiencyTier | null {
  return PROFICIENCY_TIERS.find((t) => t.min > proficiency) ?? null;
}

export interface RecipeData {
  id: string;
  resultId: string;
  resultQty: number;
  materials: { itemId: string; quantity: number }[];
  gold: number;
  /** 이 숙련도에 도달하면 레시피가 열린다 (EDRPG PROFICIENCY_RECIPE_UNLOCKS) */
  unlockProficiency: number;
}

export const RECIPES = recipesJson as RecipeData[];
export const recipeById = (id: string): RecipeData | undefined => RECIPES.find((r) => r.id === id);

/** 제작 1회로 얻는 숙련도 */
export const CRAFT_PROFICIENCY_GAIN = 3;
