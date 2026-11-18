import itemsJson from '../data/items.json';
import mobsJson from '../data/mobs.json';

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
