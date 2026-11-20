/**
 * 서버가 먼저 보내는 카톡 메시지 대기열. 서버는 폰으로 직접 보낼 수 없으므로 여기에 쌓아 두고, 폰의 스크립트가 주기적으로 가져간다.
 * 가져가면 잠시(LEASE) 빌려 준 상태가 되고, 폰이 보낸 뒤 ack 하면 끝난다. ack 가 없으면 다시 내보낸다(최대 MAX_ATTEMPTS번).
 */
export const LEASE_MS = 60_000;
export const MAX_ATTEMPTS = 4;
export const EXPIRE_MS = 60 * 60_000; // 한 시간 지난 알림은 의미가 없어서 버린다
export const MAX_TEXT = 1000;

export async function enqueueKakao(db: D1Database, room: string, text: string, kind = 'info'): Promise<void> {
  if (!room) return;
  await db.prepare('INSERT INTO kakao_outbox (room, text, kind, created_at) VALUES (?, ?, ?, ?)').bind(room.slice(0, 100), text.slice(0, MAX_TEXT), kind, Date.now()).run();
}

export async function ackOutbox(db: D1Database, ids: number[]): Promise<void> {
  const clean = ids.filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
  if (clean.length === 0) return;
  await db.prepare(`UPDATE kakao_outbox SET done_at = ? WHERE done_at IS NULL AND id IN (${clean.map(() => '?').join(',')})`).bind(Date.now(), ...clean).run();
}

/** 보낼 메시지를 가져가고(대여), 오래된 것은 정리한다 */
export async function claimOutbox(db: D1Database, limit = 10): Promise<{ id: number; room: string; text: string }[]> {
  const now = Date.now();
  await db.prepare('DELETE FROM kakao_outbox WHERE (done_at IS NOT NULL AND done_at < ?) OR created_at < ? OR attempts >= ?').bind(now - 86_400_000, now - EXPIRE_MS, MAX_ATTEMPTS).run();
  const { results } = await db
    .prepare(`UPDATE kakao_outbox SET lease_until = ?, attempts = attempts + 1
      WHERE id IN (SELECT id FROM kakao_outbox WHERE done_at IS NULL AND lease_until < ? ORDER BY id LIMIT ?)
      RETURNING id, room, text`)
    .bind(now + LEASE_MS, now, Math.min(Math.max(limit, 1), 20))
    .all<{ id: number; room: string; text: string }>();
  return (results ?? []).sort((a, b) => a.id - b.id);
}
