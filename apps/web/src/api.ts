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

export interface Person { id: string; nickname: string; online: boolean; proficiency: number }
export type Relation = 'none' | 'friend' | 'sent' | 'received';
export interface FriendsPayload { friends: Person[]; incoming: Person[]; outgoing: Person[] }
export interface ChatMessage { id: number; userId: string; nickname: string; body: string; at: number }
export interface GuildListItem { id: string; name: string; description: string; level: number; members: number }
export interface GuildMember { id: string; nickname: string; role: 'leader' | 'officer' | 'member'; contribution: number; online: boolean; proficiency: number }
export interface GuildDetail {
  id: string; name: string; description: string; level: number; gold: number; capacity: number;
  myRole: 'leader' | 'officer' | 'member'; members: GuildMember[];
}
export interface Listing {
  id: string; sellerId: string; seller: string; itemId: string; quantity: number; price: number; private: boolean;
  status: 'active' | 'sold' | 'cancelled'; buyer?: string; proceeds?: number;
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
  dungeon_locked: (d) => `숙련도 ${d.required ?? ''} 이상이어야 입장할 수 있어요.`,
  key_missing: () => '이 보스에 도전하려면 열쇠가 필요해요.',
  entry_failed: () => '입장에 실패했어요. 다시 시도해 주세요.',
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
  player_not_found: () => '그런 플레이어를 찾을 수 없어요.',
  already_friends: () => '이미 친구예요.',
  already_requested: () => '이미 친구 신청을 보냈어요.',
  friends_full: () => '친구는 최대 50명까지예요.',
  request_not_found: () => '친구 신청이 없어요.',
  no_channel: () => '이 채팅방에는 들어갈 수 없어요.',
  email_required: () => '전체 채팅은 이메일 인증 후에 쓸 수 있어요.',
  slow_down: () => '조금 천천히 보내 주세요.',
  invalid_message: () => '메시지는 1~200자로 써 주세요.',
  invalid_guild_name: () => '길드 이름은 한글·영문·숫자 2~12자예요.',
  guild_name_taken: () => '이미 있는 길드 이름이에요.',
  already_in_guild: () => '이미 길드에 가입해 있어요.',
  not_in_guild: () => '길드에 가입해 있지 않아요.',
  guild_full_or_missing: () => '정원이 찼거나 없는 길드예요.',
  leader_must_transfer: () => '길드장은 다른 사람에게 길드장을 넘긴 뒤에 떠날 수 있어요.',
  not_allowed: () => '권한이 없어요.',
  invalid_price: () => '가격은 1 ~ 99,999,999D로 정해 주세요.',
  cannot_list: () => '등록할 수 없어요. (수량 부족이거나 장착 중인 마지막 1개예요)',
  too_many_listings: () => '동시에 등록할 수 있는 물품은 20개까지예요.',
  listing_unavailable: () => '이미 팔렸거나 없어진 물품이에요.',
  own_listing: () => '내가 올린 물품은 살 수 없어요.',
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
  startBattle: (mobId: string) =>
    post<{ id: string; state: BattleState; paid: { gold: number; key: string | null } }>('/api/battle', { mobId }),
  round: (id: string, body: { action: 'attack' | 'guard' | 'item' | 'skill'; itemId?: string; targetId?: string; skillId?: string }) =>
    post<{ state: BattleState; log: LogEntry[]; rewards?: Rewards }>(`/api/battle/${id}/round`, body),
  skills: () => request<SkillsPayload>('/api/skills'),
  equipSkill: (skillId: string) => post<SkillsPayload>('/api/skills/equip', { skillId }),
  unequipSkill: (skillId: string) => post<SkillsPayload>('/api/skills/unequip', { skillId }),

  friends: () => request<FriendsPayload>('/api/friends'),
  searchPlayers: (q: string) => request<{ players: (Person & { relation: Relation })[] }>(`/api/players/search?q=${encodeURIComponent(q)}`),
  friendRequest: (userId: string) => post<{ status: 'sent' | 'friend' }>('/api/friends/request', { userId }),
  friendAccept: (userId: string) => post<{ ok: true }>('/api/friends/accept', { userId }),
  friendRemove: (userId: string) => post<{ ok: true }>('/api/friends/remove', { userId }),
  chat: (channel: string, after = 0) => request<{ messages: ChatMessage[] }>(`/api/chat/${encodeURIComponent(channel)}?after=${after}`),
  chatSend: (channel: string, body: string) => post<{ ok: true }>(`/api/chat/${encodeURIComponent(channel)}`, { body }),
  guilds: (q = '') => request<{ capacity: number; guilds: GuildListItem[] }>(`/api/guilds?q=${encodeURIComponent(q)}`),
  guild: () => request<{ guild: GuildDetail | null; createCost: number }>('/api/guild'),
  guildCreate: (name: string, description: string) => post<{ id: string }>('/api/guild/create', { name, description }),
  guildJoin: (guildId: string) => post<{ ok: true }>('/api/guild/join', { guildId }),
  guildLeave: () => post<{ ok: true }>('/api/guild/leave', {}),
  guildDisband: () => post<{ ok: true }>('/api/guild/disband', {}),
  guildKick: (userId: string) => post<{ ok: true }>('/api/guild/kick', { userId }),
  guildRole: (userId: string, role: 'officer' | 'member' | 'leader') => post<{ ok: true }>('/api/guild/role', { userId, role }),
  guildDonate: (amount: number) => post<{ ok: true }>('/api/guild/donate', { amount }),
  exchange: () => request<{ feeRate: number; listings: Listing[] }>('/api/exchange'),
  exchangeMine: () => request<{ feeRate: number; listings: Listing[] }>('/api/exchange/mine'),
  exchangeList: (itemId: string, quantity: number, price: number, to: string | null) =>
    post<{ id: string }>('/api/exchange/list', { itemId, quantity, price, to }),
  exchangeBuy: (listingId: string) => post<{ ok: true }>('/api/exchange/buy', { listingId }),
  exchangeCancel: (listingId: string) => post<{ ok: true }>('/api/exchange/cancel', { listingId }),
};
