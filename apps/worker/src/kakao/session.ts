/** 번호 메뉴 상태 (방+사용자별). 버튼이 없는 카톡에서 "1" 같은 답을 어느 화면에 대한 것인지 알려 준다. */
export const SESSION_TTL_MS = 3 * 60_000;
export interface Session { menu: string; [k: string]: unknown }

export const sessionKey = (room: string, who: string): string => `${room}\u0000${who}`;

export async function setSession(db: D1Database, room: string, who: string, state: Session): Promise<void> {
  await db
    .prepare('INSERT INTO kakao_sessions (skey, state, expires_at) VALUES (?, ?, ?) ON CONFLICT(skey) DO UPDATE SET state = excluded.state, expires_at = excluded.expires_at')
    .bind(sessionKey(room, who), JSON.stringify(state), Date.now() + SESSION_TTL_MS)
    .run();
}
export async function getSession(db: D1Database, room: string, who: string): Promise<Session | null> {
  const row = await db.prepare('SELECT state FROM kakao_sessions WHERE skey = ? AND expires_at > ?').bind(sessionKey(room, who), Date.now()).first<{ state: string }>();
  if (!row) return null;
  try { return JSON.parse(row.state) as Session; } catch { return null; }
}
export async function clearSession(db: D1Database, room: string, who: string): Promise<void> {
  await db.prepare('DELETE FROM kakao_sessions WHERE skey = ?').bind(sessionKey(room, who)).run();
}
export async function sweepSessions(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM kakao_sessions WHERE expires_at < ?').bind(Date.now()).run();
}
