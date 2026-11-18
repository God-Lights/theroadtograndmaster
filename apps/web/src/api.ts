import type { BattleState, LogEntry, SkillDef } from '@rtgm/engine';
import type { CombatStats, ItemData, MobData, SkillData } from '@rtgm/data';

/** 로그인·로그아웃·회원가입 화면은 GL Account가 담당한다. 로그인 후 현재 주소로 돌아온다. */
export const ACCOUNT_ORIGIN = 'https://account.officialgl.com';
export const loginUrl = () => `${ACCOUNT_ORIGIN}/?return=${encodeURIComponent(location.href)}`;

export interface Me {
  id: string;
  username: string;
  nickname: string;
  emailVerified: boolean;
  isAdmin?: boolean;
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

export interface PvpStatus {
  rating: number; wins: number; losses: number; draws: number; matchId: string | null; queued: boolean; queuedAt: number | null;
  incoming: { id: string; nickname: string }[]; outgoing: { id: string; nickname: string }[];
  history: { id: string; opponent: string; ranked: boolean; result: 'win' | 'loss' | 'draw'; ratingChange: number }[];
}
export interface PvpMatchView {
  id: string; mine: 'p1' | 'p2'; opponent: { id: string; nickname: string }; ranked: boolean; status: 'active' | 'done';
  round: number; deadline: number; serverNow: number; needsAction: boolean; submitted: boolean; opponentSubmitted: boolean;
  state: Omit<BattleState, 'rngSeed'>; skills: Record<string, SkillDef>; log: LogEntry[];
  result?: { winner: 'me' | 'opponent' | 'draw'; ratingChange: number };
}
export interface RankRow { rank: number; id: string; nickname: string; rating: number; wins: number; losses: number; draws: number; me: boolean }

export type EventKind = 'notice' | 'bonus' | 'gift';
export interface GameEvent {
  id: string; title: string; description: string; kind: EventKind; startsAt: number; endsAt: number;
  status: 'cancelled' | 'upcoming' | 'active' | 'ended'; claimed?: boolean; claims?: number;
  config: { gold?: number; proficiency?: number; drop?: number; items?: { itemId: string; quantity: number }[] };
}

export interface RaidMemberView {
  userId: string; nickname: string; role: 'tank' | 'dealer' | 'healer' | 'support' | null; ready: boolean; slot: string | null; submitted: boolean; miss: number;
  rewards?: Rewards;
}
export interface RaidRoomView {
  id: string; code: string; status: 'lobby' | 'active' | 'done'; bossId: string; bossName: string; leaderId: string; maxParty: number; recParty: number; star: number; roleCap: number; minParty: number; roundSeconds: number;
  members: RaidMemberView[]; mySlot: string | null; myRole: RaidMemberView['role'];
  round: number; deadline: number; serverNow: number; needsAction: boolean;
  state: Omit<BattleState, 'rngSeed'> | null; skills: Record<string, SkillDef>; log: LogEntry[]; result?: 'victory' | 'defeat';
}
export interface RaidLobbyPayload {
  proficiency: number;
  bosses: { id: string; name: string; star: number; maxParty: number; recParty: number; minProficiency: number; note: string; cooldownMinutes: number; hp: number; gold: [number, number]; drops: { itemId: string; chance: number }[] }[];
  roles: Record<string, { label: string; desc: string; skills: SkillData[] }>;
  cooldowns: Record<string, number>;
  lobbyMinutes: number;
  friendRooms: { code: string; leader: string; members: number; max: number; bossName: string }[];
  room: RaidRoomView | null;
}

export interface TeamPlayerView {
  userId: string; nickname: string; team: 'A' | 'B' | null; role: RaidMemberView['role']; ready: boolean; slot: string | null; submitted: boolean; miss: number; delta: number;
}
export interface TeamMatchView {
  id: string; code: string | null; ranked: boolean; status: 'lobby' | 'active' | 'done'; leaderId: string | null; teamSize: number; roundSeconds: number;
  players: TeamPlayerView[]; mySlot: string | null; myTeam: 'A' | 'B' | null; myRole: RaidMemberView['role'];
  round: number; deadline: number; serverNow: number; needsAction: boolean;
  state: Omit<BattleState, 'rngSeed'> | null; skills: Record<string, SkillDef>; log: LogEntry[]; result?: 'win' | 'loss' | 'draw';
}
export interface TeamStatus {
  rating: number; wins: number; losses: number; draws: number; queued: { role: string; since: number } | null;
  roles: { id: string; label: string; desc: string; skills: SkillData[] }[];
  cap: { maxHp: number; atk: number; def: number };
  ranking: { rank: number; id: string; nickname: string; rating: number; wins: number; losses: number; me: boolean }[];
  match: TeamMatchView | null;
}

export interface Loot { gold: number; proficiency: number; items: { itemId: string; quantity: number }[] }
export interface RunView {
  id: string; dungeonId: string; name: string; floor: number; floors: number; hp: number; maxHp: number;
  status: 'idle' | 'battle' | 'done'; result: 'clear' | 'retreat' | 'dead' | null; loot: Loot;
  events: { floor: number; kind: 'monster' | 'treasure' | 'trap' | 'nothing' | 'clear'; text: string }[];
  battle: { id: string; mobId: string; state: BattleState } | null;
  room?: { kind: string; text: string };
}
export interface RogueInfo {
  id: string; name: string; description: string; minProficiency: number; recommendedProficiency: number; entryGold: number; floors: number;
  cooldownMinutes: number; monsters: string[]; finalBoss: { mobId: string; mult: number; title: string };
  clearBonus: { gold: [number, number]; proficiency: number; items: { itemId: string; chance: number }[] }; until: number;
}
export interface Announcement { id: number; kind: 'boss' | 'raid' | 'dungeon'; text: string; at: number }
export interface UserRow { id: string; nickname: string; online: boolean; proficiency: number; lastSeen: number; relation: Relation }

export class ApiError extends Error {
  constructor(public code: string, public data: Record<string, unknown> = {}) {
    super(code);
  }
}

/** 남은 시간을 '1시간 20분' 처럼 */
export function fmtWait(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}시간 ${m}분` : m > 0 ? `${m}분 ${s}초` : `${s}초`;
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
  already_in_match: () => '이미 진행 중인 대전이 있어요.',
  not_friends: () => '친구에게만 도전할 수 있어요.',
  challenge_not_found: () => '도전장이 없어졌어요.',
  match_not_found: () => '대전을 찾을 수 없어요.',
  already_submitted: () => '이번 라운드의 선택은 이미 제출했어요.',
  invalid_action: () => '낼 수 없는 행동이에요. (PvP에서는 아이템을 쓸 수 없어요)',
  event_unavailable: () => '지금은 받을 수 없는 이벤트예요.',
  already_claimed: () => '이미 받았어요.',
  invalid_title: () => '제목은 2~40자로 써 주세요.',
  invalid_description: () => '설명은 300자까지예요.',
  invalid_kind: () => '이벤트 종류를 골라 주세요.',
  invalid_period: () => '기간이 올바르지 않아요. (끝이 시작보다 뒤, 지금보다 뒤, 최대 60일)',
  invalid_bonus: () => '보너스 배율은 1 초과 5 이하로, 하나 이상 넣어 주세요.',
  invalid_gift: () => '선물 내용이 올바르지 않아요. (달런트 0~100만, 아이템 최대 5종·각 999개)',
  unknown_boss: () => '알 수 없는 레이드예요.',
  already_in_raid: () => '이미 레이드 방에 들어가 있어요.',
  room_not_found: () => '그 코드의 방이 없거나 이미 시작했어요.',
  room_full: () => '방이 가득 찼어요.',
  role_taken: () => '그 역할은 자리가 모두 찼어요.',
  role_required: () => '먼저 역할을 골라 주세요.',
  not_in_lobby: () => '대기실에 있지 않아요.',
  not_in_raid: () => '레이드에 참가 중이 아니에요.',
  party_too_small: (d) => `최소 ${d.min ?? 2}명이 모여야 시작할 수 있어요.`,
  not_ready: () => '모든 파티원이 역할을 고르고 준비해야 해요.',
  raid_active: () => '진행 중인 레이드에서는 나갈 수 없어요.',
  raid_cooldown: (d) => `아직 대기시간이에요. ${fmtWait(Number(d.until) - Date.now())} 뒤에 다시 도전할 수 있어요.`,
  need_both_teams: () => '양 팀에 한 명 이상 있어야 시작할 수 있어요.',
  match_active: () => '진행 중인 대전에서는 나갈 수 없어요.',
  not_in_match: () => '대전에 참가 중이 아니에요.',
  taunted: () => '상대가 도발 중이에요. 도발한 상대만 노릴 수 있어요.',
  use_explore: () => '일반 몬스터는 지역을 탐험해서 만나요.',
  unknown_biome: () => '알 수 없는 지역이에요.',
  explore_cooldown: (d) => `탐험 대기시간이에요. ${fmtWait(Number(d.until) - Date.now())} 뒤에 다시 탐험할 수 있어요.`,
  run_cooldown: (d) => `이 던전은 대기시간이에요. ${fmtWait(Number(d.until) - Date.now())} 뒤에 다시 들어갈 수 있어요.`,
  already_in_run: () => '이미 던전에 들어가 있어요.',
  no_run: () => '진행 중인 던전이 없어요.',
  run_busy: () => '지금은 할 수 없어요. (전투 중이거나 이미 처리됐어요)',
  unknown_dungeon: () => '알 수 없는 던전이에요.',
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
  explore: (biomeId: string) =>
    post<{ id: string; state: BattleState; mobId: string; paid: { gold: number; key: string | null } }>('/api/explore', { biomeId }),
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
  pvpStatus: () => request<PvpStatus>('/api/pvp/status'),
  pvpQueue: () => post<{ matchId?: string; queued?: boolean }>('/api/pvp/queue', {}),
  pvpLeave: () => post<{ ok: true }>('/api/pvp/queue/leave', {}),
  pvpChallenge: (userId: string) => post<{ ok: true }>('/api/pvp/challenge', { userId }),
  pvpAccept: (id: string) => post<{ matchId: string }>('/api/pvp/challenge/accept', { id }),
  pvpDecline: (id: string) => post<{ ok: true }>('/api/pvp/challenge/decline', { id }),
  pvpMatch: (id: string) => request<PvpMatchView>(`/api/pvp/match/${id}`),
  pvpAct: (id: string, body: { action: 'attack' | 'guard' | 'skill'; skillId?: string }) => post<PvpMatchView>(`/api/pvp/match/${id}/action`, body),
  pvpForfeit: (id: string) => post<PvpMatchView>(`/api/pvp/match/${id}/forfeit`, {}),
  pvpRanking: () => request<{ ranking: RankRow[] }>('/api/pvp/ranking'),
  events: () => request<{ events: GameEvent[]; bonus: { gold: number; proficiency: number; drop: number } }>('/api/events'),
  claimEvent: (id: string) => post<{ ok: true }>(`/api/events/${id}/claim`, {}),
  adminEvents: () => request<{ events: GameEvent[] }>('/api/admin/events'),
  adminCreateEvent: (body: Record<string, unknown>) => post<{ id: string }>('/api/admin/events', body),
  adminCancelEvent: (id: string) => post<{ ok: true }>(`/api/admin/events/${id}/cancel`, {}),
  raid: () => request<RaidLobbyPayload>('/api/raid'),
  raidCreate: (bossId: string) => post<{ id: string }>('/api/raid/create', { bossId }),
  raidJoin: (code: string) => post<{ ok: true }>('/api/raid/join', { code }),
  raidRole: (role: string) => post<{ ok: true }>('/api/raid/role', { role }),
  raidReady: (ready: boolean) => post<{ ok: true }>('/api/raid/ready', { ready }),
  raidLeave: () => post<{ ok: true }>('/api/raid/leave', {}),
  raidStart: () => post<{ ok: true }>('/api/raid/start', {}),
  raidAct: (body: { action: 'attack' | 'guard' | 'skill'; skillId?: string; targetId?: string }) => post<RaidRoomView>('/api/raid/action', body),
  teamStatus: () => request<TeamStatus>('/api/team/status'),
  teamQueue: (role: string) => post<{ queued: boolean; matchId?: string }>('/api/team/queue', { role }),
  teamQueueLeave: () => post<{ ok: true }>('/api/team/queue/leave', {}),
  teamRoomCreate: () => post<{ id: string }>('/api/team/room/create', {}),
  teamRoomJoin: (code: string) => post<{ ok: true }>('/api/team/room/join', { code }),
  teamRoomTeam: (team: 'A' | 'B') => post<{ ok: true }>('/api/team/room/team', { team }),
  teamRoomRole: (role: string) => post<{ ok: true }>('/api/team/room/role', { role }),
  teamRoomReady: (ready: boolean) => post<{ ok: true }>('/api/team/room/ready', { ready }),
  teamRoomLeave: () => post<{ ok: true }>('/api/team/room/leave', {}),
  teamRoomStart: () => post<{ ok: true }>('/api/team/room/start', {}),
  teamAct: (body: { action: 'attack' | 'guard' | 'skill'; skillId?: string; targetId?: string }) => post<TeamMatchView>('/api/team/action', body),
  cooldowns: () => request<{ cooldowns: Record<string, number> }>('/api/cooldowns'),
  runInfo: () => request<{ proficiency: number; gold: number; dungeons: RogueInfo[]; run: RunView | null }>('/api/run'),
  runStart: (dungeonId: string) => post<RunView>('/api/run/start', { dungeonId }),
  runAdvance: () => post<RunView>('/api/run/advance', {}),
  runRetreat: () => post<RunView>('/api/run/retreat', {}),
  runLast: () => request<{ run: RunView | null }>('/api/run/last'),
  announcements: (after = 0) => request<{ latest: number; announcements: Announcement[] }>(`/api/announcements?after=${after}`),
  users: (q = '', offset = 0) => request<{ total: number; online: number; hasMore: boolean; users: UserRow[] }>(`/api/users?q=${encodeURIComponent(q)}&offset=${offset}`),
  discordStatus: () => request<{ linked: boolean; linkedAt: number | null; botEnabled: boolean }>('/api/discord/status'),
  discordLinkCode: () => post<{ code: string; expiresAt: number }>('/api/discord/link-code', {}),
  discordUnlink: () => post<{ ok: true }>('/api/discord/unlink', {}),
  exchangeCancel: (listingId: string) => post<{ ok: true }>('/api/exchange/cancel', { listingId }),
};
