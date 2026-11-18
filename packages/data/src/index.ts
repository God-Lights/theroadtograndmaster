import type { SkillDef } from '@rtgm/engine';
import itemsJson from '../data/items.json';
import skillsJson from '../data/skills.json';
import mobsJson from '../data/mobs.json';
import tiersJson from '../data/proficiency-tiers.json';
import recipesJson from '../data/recipes.json';
import bossesJson from '../data/bosses.json';
import dungeonsJson from '../data/dungeons.json';
import raidJson from '../data/raid.json';

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
  /** 지력 (지팡이·로브): 회복 스킬 계수의 기준 */
  int?: number;
  /** 속도: 높을수록 먼저 행동 */
  spd?: number;
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
  /** 이 몹이 나오는 던전 ID */
  dungeon: string;
  /** 화면에 보여 줄 공략 힌트 */
  note?: string;
  drops: { itemId: string; chance: number }[];
}

export const ITEMS = itemsJson as ItemData[];
export const MOBS = mobsJson as MobData[];

export const itemById = (id: string): ItemData | undefined => ITEMS.find((i) => i.id === id);
export const mobById = (id: string): MobData | undefined => MOBS.find((m) => m.id === id);

/** 신규 캐릭터 기본 스탯 (EDRPG BASE_ATK 8 / BASE_DEF 3 / BASE_HP 100 계승) */
export const BASE_STATS = { maxHp: 100, atk: 8, def: 3, spd: 10, int: 20 } as const;
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
  int: number;
}

/** 기본 스탯 + 장착 장비. 검=ATK, 방패=DEF, 갑옷=HP (EDRPG 규칙) */
export function computeStats(equipped: readonly ItemData[]): CombatStats {
  const stats: CombatStats = { ...BASE_STATS };
  for (const item of equipped) {
    stats.atk += item.atk;
    stats.def += item.def;
    stats.maxHp += item.hp;
    stats.int += item.int ?? 0;
    stats.spd += item.spd ?? 0;
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

/**
 * 보스 패턴 스크립트 (몹 ID → 스크립트). 형식은 @rtgm/engine 의 BossScript 에서 bossId 를 뺀 것이다.
 * 데이터 패키지는 엔진에 의존하지 않으므로 여기서는 구조만 열어 두고, 서버가 엔진 타입으로 변환한다.
 */
export const BOSS_SCRIPTS = bossesJson as unknown as Record<string, Record<string, unknown>>;
export const bossScriptFor = (mobId: string): Record<string, unknown> | undefined => BOSS_SCRIPTS[mobId];

/** 스킬 정의(엔진 SkillDef) + 해금·설명 */
export interface SkillData extends SkillDef {
  /** 시트의 출처 역할 (탱커/딜러/힐러/서포터). 솔로에서는 역할과 상관없이 장착할 수 있다 */
  role: string;
  /** 이 숙련도 이상이면 장착할 수 있다 */
  unlockProficiency: number;
  description: string;
}

export const SKILLS = skillsJson as unknown as SkillData[];
export const skillById = (id: string): SkillData | undefined => SKILLS.find((s) => s.id === id);

/** 일반 스킬 슬롯 수 (궁극기는 별도 1개) */
export const SKILL_SLOTS = 4;
export const ULTIMATE_SLOTS = 1;
/** 신규 캐릭터의 기본 장착 스킬 */
export const DEFAULT_LOADOUT = ['strike', 'bash', 'heal', 'shield'] as const;
/** 전투 시작 AP */
export const START_AP = 4;

export interface DungeonData {
  id: string;
  name: string;
  description: string;
  /** 이 숙련도 이상이어야 입장할 수 있다 (하드 제한) */
  minProficiency: number;
  /** 전투 1회 입장 비용. 보스는 열쇠를 1개 소모하고 보스 비용을 낸다 */
  entry: { normalGold: number; bossGold: number; bossKey: string | null };
  mobs: string[];
}

export const DUNGEONS = dungeonsJson as DungeonData[];
export const dungeonById = (id: string): DungeonData | undefined => DUNGEONS.find((d) => d.id === id);

/** 이 몹과 싸우려면 내야 하는 입장 비용 */
export function entryCost(mob: MobData): { gold: number; key: string | null } {
  const d = dungeonById(mob.dungeon);
  if (!d) return { gold: 0, key: null };
  return mob.kind === 'boss'
    ? { gold: d.entry.bossGold, key: d.entry.bossKey }
    : { gold: d.entry.normalGold, key: null };
}

// ─── 레이드 (4인 역할 파티) ───────────────────────────────────────────────────

export type RaidRole = 'tank' | 'dealer' | 'healer' | 'support';
export const RAID_ROLE_IDS: readonly RaidRole[] = ['tank', 'dealer', 'healer', 'support'];

export interface RaidRoleData {
  label: string;
  desc: string;
  /** 장비 스탯에 곱하는 배율 */
  hp: number; atk: number; def: number;
  /** 이 역할의 지력 (회복량 기준) */
  int: number;
  kit: string[];
  ultimate: string;
}
export interface RaidBossData {
  id: string; name: string;
  /** 난이도 (1~5성) */
  star: number;
  /** 최대 인원 / 적정 인원. hp 는 적정 인원 기준이다 */
  maxParty: number; recParty: number;
  /** 끝난 뒤 다시 입장하기까지 대기시간(분). 승리 기준이고 패배하면 절반 */
  cooldownMinutes: number;
  hp: number; atk: number; def: number; spd: number;
  minProficiency: number; gold: [number, number]; profWin: number; profLose: number;
  drops: { itemId: string; chance: number }[]; note: string;
  script: Record<string, unknown>;
}

export const RAID_CAPS = raidJson.caps as { maxHp: number; atk: number; def: number };
export const RAID_ROLES = raidJson.roles as unknown as Record<RaidRole, RaidRoleData>;
export const RAID_SKILLS = raidJson.skills as unknown as SkillData[];
export const RAID_BOSSES = raidJson.bosses as unknown as Record<string, RaidBossData>;
export const raidSkillById = (id: string): SkillData | undefined => RAID_SKILLS.find((s) => s.id === id);
/** 역할 킷의 스킬 id (일반 4 + 궁극기 1) */
export const raidKit = (role: RaidRole): string[] => [...RAID_ROLES[role].kit, RAID_ROLES[role].ultimate];
export const RAID_MIN_PARTY = 2;
export const RAID_MISS_LIMIT = 3;

/** 레이드 스탯: 장비 스탯을 상한으로 보정한 뒤 역할 배율을 곱한다 */
export function raidStats(role: RaidRole, gear: CombatStats): CombatStats {
  const r = RAID_ROLES[role];
  return {
    ...gear,
    maxHp: Math.round(Math.min(gear.maxHp, RAID_CAPS.maxHp) * r.hp),
    atk: Math.round(Math.min(gear.atk, RAID_CAPS.atk) * r.atk),
    def: Math.round(Math.min(gear.def, RAID_CAPS.def) * r.def),
    int: r.int,
  };
}
/** 보스 HP: 적정 인원일 때 기본 HP. 인원이 적으면 줄고 많으면 는다 (인원 1명당 비례 70% + 고정 30%) */
export function raidBossHp(bossId: string, partySize: number): number {
  const b = RAID_BOSSES[bossId]!;
  return Math.round(b.hp * (0.3 + 0.7 * (partySize / b.recParty)));
}
/** 한 역할을 맡을 수 있는 최대 인원 (4인 레이드는 역할당 1명, 8인은 2명) */
export const raidRoleCap = (bossId: string): number => Math.max(1, Math.floor(RAID_BOSSES[bossId]!.maxParty / RAID_ROLE_IDS.length));

// ─── PvP 규칙 (서버 판정과 위키가 같은 값을 쓴다) ─────────────────────────────

export const PVP_RULES = {
  /** PvP 스탯 상한: 장비 스탯을 이 값으로 자른 뒤 (팀전은 역할 배율을 곱한다) */
  cap: { maxHp: 300, atk: 60, def: 30 },
  roundSeconds: 45,
  maxRounds: 40,
  missLimit: 3,
  startRating: 1000,
  kFactor: 32,
  teamSize: 4,
  queueSeconds: 180,
} as const;
