/** 행동 대기시간 (모험 탐험, 로그라이크 던전). 키: explore / run:<던전 id> */
export async function cooldownUntil(db: D1Database, userId: string, key: string): Promise<number> {
  const row = await db.prepare('SELECT until FROM action_cooldowns WHERE user_id = ? AND key = ?').bind(userId, key).first<{ until: number }>();
  return row && row.until > Date.now() ? row.until : 0;
}

export const setCooldownStmt = (db: D1Database, userId: string, key: string, until: number) =>
  db.prepare('INSERT INTO action_cooldowns (user_id, key, until) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET until = excluded.until').bind(userId, key, until);

/** 지금 대기 중인 것들 (지난 것은 제외) */
export async function activeCooldowns(db: D1Database, userId: string): Promise<Record<string, number>> {
  const { results } = await db.prepare('SELECT key, until FROM action_cooldowns WHERE user_id = ? AND until > ?').bind(userId, Date.now()).all<{ key: string; until: number }>();
  return Object.fromEntries((results ?? []).map((r) => [r.key, r.until]));
}
