import type { BattleState, LogEntry } from '@rtgm/engine';
import type { ItemData, MobData } from '@rtgm/data';

/** 로그인·로그아웃·회원가입 화면은 GL Account가 담당한다. 로그인 후 현재 주소로 돌아온다. */
export const ACCOUNT_ORIGIN = 'https://account.officialgl.com';
export const loginUrl = () => `${ACCOUNT_ORIGIN}/?return=${encodeURIComponent(location.href)}`;

export interface Me {
  id: string;
  username: string;
  nickname: string;
  emailVerified: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (res.status === 401) {
    location.href = loginUrl();
    return new Promise<T>(() => {}); // 이동하는 동안 이후 처리를 멈춘다
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const api = {
  me: () => request<Me>('/api/me'),
  items: () => request<ItemData[]>('/api/data/items'),
  mobs: () => request<MobData[]>('/api/data/mobs'),
  startBattle: (mobId: string) =>
    request<{ id: string; state: BattleState }>('/api/battle', { method: 'POST', body: JSON.stringify({ mobId }) }),
  round: (id: string, action: 'attack' | 'guard' | 'item', itemId?: string) =>
    request<{ state: BattleState; log: LogEntry[] }>(`/api/battle/${id}/round`, {
      method: 'POST',
      body: JSON.stringify({ action, itemId }),
    }),
};
