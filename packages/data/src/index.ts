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
