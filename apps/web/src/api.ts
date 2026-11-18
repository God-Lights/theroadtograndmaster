import type { BattleState, LogEntry } from '@rtgm/engine';
import type { CombatStats, ItemData, MobData } from '@rtgm/data';

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
  items: { itemId: string; name: string; quantity: number }[];
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
  invalid_request: () => '잘못된 요청입니다.',
};
export const errorText = (e: unknown): string =>
  e instanceof ApiError ? (ERROR_TEXT[e.code]?.(e.data) ?? e.code) : '오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
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
  startBattle: (mobId: string) => post<{ id: string; state: BattleState }>('/api/battle', { mobId }),
  round: (id: string, action: 'attack' | 'guard' | 'item', itemId?: string) =>
    post<{ state: BattleState; log: LogEntry[]; rewards?: Rewards }>(`/api/battle/${id}/round`, { action, itemId }),
};
