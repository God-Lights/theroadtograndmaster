import type { BattleState, LogEntry } from '@rtgm/engine';
import type { ItemData, MobData } from '@rtgm/data';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export const api = {
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
