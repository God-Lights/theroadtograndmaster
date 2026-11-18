import type { BattleState, LogEntry } from '@rtgm/engine';
import type { CombatStats, ItemData, MobData, SkillData } from '@rtgm/data';

/** 로그인·로그아웃·회원가입 화면은 GL Account가 담당한다. 로그인 후 현재 주소로 돌아온다. */
export const ACCOUNT_ORIGIN = 'https://account.officialgl.com';
export const loginUrl = () => `${ACCOUNT_ORIGIN}/?return=${encodeURIComponent(location.href)}`;

export interface Me {
  id: string;
  username: string;
  nickname: string;
  emailVerified: boolean;
  gold: number;
  proficiency: number;
}

export interface InventorySnapshot {
  gold: number;
  proficiency: number;
  items: { itemId: string; quantity: number; equipped: boolean }[];
  stats: CombatStats;
}

export interface Rewards {
  gold: number;
  proficiency: number;
  items: { itemId: string; name: string; quantity: number }[];
}

export type CraftResult = InventorySnapshot & {
  crafted: { itemId: string; name: string; quantity: number };
  proficiencyGained: number;
};

export interface SkillView extends SkillData {
  unlocked: boolean;
  equipped: boolean;
}
export interface SkillsPayload {
  slots: number;
  ultimateSlots: number;
  proficiency: number;
  skills: SkillView[];
}

export class ApiError extends Error {
  constructor(public code: string, public data: Record<string, unknown> = {}) {
    super(code);
  }
}

const ERROR_TEXT: Record<string, (d: Record<string, unknown>) => string> = {
  not_enough_gold: () => '달런트가 부족합니다.',
  proficiency_too_low: (d) => `숙련도 ${d.required ?? ''} 이상이 필요합니다.`,
  cannot_sell: () => '팔 수 없습니다. (장착 중인 마지막 1개는 팔 수 없어요)',
  not_owned: () => '보유하지 않은 아이템입니다.',
  not_equippable: () => '장착할 수 없는 아이템입니다.',
  no_item: () => '아이템이 없습니다.',
  invalid_target: () => '공격할 수 없는 대상입니다.',
  skill_locked: (d) => `숙련도 ${d.required ?? ''} 이상이 되면 장착할 수 있어요.`,
  slots_full: (d) => `일반 스킬 슬롯(${d.slots ?? 4}개)이 가득 찼어요. 하나를 해제해 주세요.`,
  unknown_skill: () => '알 수 없는 스킬입니다.',
  skill_unavailable: (d) =>
    ({ ap: 'AP가 부족해요.', cooldown: '아직 쿨다운 중이에요.', gauge: '궁극기 게이지가 부족해요.', charging: '충전 중에는 다른 스킬을 쓸 수 없어요.' } as Record<string, string>)[String(d.reason)] ?? '쓸 수 없는 스킬입니다.',
  invalid_request: () => '잘못된 요청입니다.',
  recipe_locked: (d) => `숙련도 ${d.required ?? ''} 이상이 되면 제작할 수 있어요.`,
  material_equipped: () => '장착 중인 아이템은 재료로 쓸 수 없어요. 먼저 해제해 주세요.',
  not_enough_material: () => '재료가 부족합니다.',
  unknown_recipe: () => '알 수 없는 레시피입니다.',
  craft_failed: () => '제작에 실패했어요. 다시 시도해 주세요.',
  network: () => '네트워크 연결을 확인해 주세요.',
  timeout: () => '응답이 늦어지고 있어요. 잠시 후 다시 시도해 주세요.',
};
export const errorText = (e: unknown): string =>
  e instanceof ApiError ? (ERROR_TEXT[e.code]?.(e.data) ?? e.code) : '오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';

/** 모바일 회선에서 요청이 멈춰 화면이 굳는 것을 막는다 */
const REQUEST_TIMEOUT_MS = 15_000;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (e) {
    throw new ApiError(e instanceof DOMException && e.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    location.href = loginUrl();
    return new Promise<T>(() => {}); // 이동하는 동안 이후 처리를 멈춘다
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error ?? `http_${res.status}`, data as Record<string, unknown>);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  me: () => request<Me>('/api/me'),
  inventory: () => request<InventorySnapshot>('/api/inventory'),
  items: () => request<ItemData[]>('/api/data/items'),
  mobs: () => request<MobData[]>('/api/data/mobs'),
  equip: (itemId: string) => post<InventorySnapshot>('/api/inventory/equip', { itemId }),
  unequip: (itemId: string) => post<InventorySnapshot>('/api/inventory/unequip', { itemId }),
  sell: (itemId: string, quantity: number) => post<InventorySnapshot>('/api/inventory/sell', { itemId, quantity }),
  buy: (itemId: string, quantity = 1) => post<InventorySnapshot>('/api/shop/buy', { itemId, quantity }),
  craft: (recipeId: string) => post<CraftResult>('/api/craft', { recipeId }),
  startBattle: (mobId: string) => post<{ id: string; state: BattleState }>('/api/battle', { mobId }),
  round: (id: string, body: { action: 'attack' | 'guard' | 'item' | 'skill'; itemId?: string; targetId?: string; skillId?: string }) =>
    post<{ state: BattleState; log: LogEntry[]; rewards?: Rewards }>(`/api/battle/${id}/round`, body),
  skills: () => request<SkillsPayload>('/api/skills'),
  equipSkill: (skillId: string) => post<SkillsPayload>('/api/skills/equip', { skillId }),
  unequipSkill: (skillId: string) => post<SkillsPayload>('/api/skills/unequip', { skillId }),
};
