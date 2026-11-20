import { enqueueKakao } from './outbox';

/**
 * 전체 알림을 카톡 공개 방으로 보낸다 (1분 크론). 보낼 방(KAKAO_PUBLIC_ROOM)과 봇 키가 모두 있어야 동작하고,
 * 처음 실행할 때는 지난 알림을 쏟아내지 않는다.
 */
export interface KakaoRelayEnv { DB: D1Database; KAKAO_BOT_KEY?: string; KAKAO_PUBLIC_ROOM?: string }
const MAX_PER_RUN = 10;

export async function relayKakaoAnnouncements(env: KakaoRelayEnv): Promise<number> {
  const room = env.KAKAO_PUBLIC_ROOM;
  if (!env.KAKAO_BOT_KEY || !room) return 0;
  const cursor = await env.DB.prepare("SELECT value FROM bot_state WHERE key = 'kakao_announce_cursor'").first<{ value: string }>();
  if (!cursor) {
    const latest = (await env.DB.prepare('SELECT MAX(id) AS id FROM announcements').first<{ id: number | null }>())?.id ?? 0;
    await env.DB.prepare("INSERT OR IGNORE INTO bot_state (key, value) VALUES ('kakao_announce_cursor', ?)").bind(String(latest)).run();
    return 0;
  }
  const { results } = await env.DB.prepare('SELECT id, text FROM announcements WHERE id > ? ORDER BY id LIMIT ?').bind(Number(cursor.value), MAX_PER_RUN).all<{ id: number; text: string }>();
  let sent = 0;
  for (const a of results ?? []) {
    await enqueueKakao(env.DB, room, `📢 ${a.text}`, 'announce');
    await env.DB.prepare("UPDATE bot_state SET value = ? WHERE key = 'kakao_announce_cursor'").bind(String(a.id)).run();
    sent++;
  }
  return sent;
}
