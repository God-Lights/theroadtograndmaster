/**
 * 전체 알림 중계: 1분마다(크론) 새 알림을 디스코드 채널에 올린다.
 * DISCORD_BOT_TOKEN 과 DISCORD_ANNOUNCE_CHANNEL_ID 가 모두 있어야 동작한다. 처음 실행할 때는 지난 알림을 올리지 않는다.
 */
export interface RelayEnv { DB: D1Database; DISCORD_BOT_TOKEN?: string; DISCORD_ANNOUNCE_CHANNEL_ID?: string }
const MAX_PER_RUN = 10;

export async function relayAnnouncements(env: RelayEnv, post: typeof fetch = fetch): Promise<number> {
  const token = env.DISCORD_BOT_TOKEN, channel = env.DISCORD_ANNOUNCE_CHANNEL_ID;
  if (!token || !channel || !/^\d{15,22}$/.test(channel)) return 0;
  const cursor = await env.DB.prepare("SELECT value FROM bot_state WHERE key = 'announce_cursor'").first<{ value: string }>();
  if (!cursor) {
    const latest = (await env.DB.prepare('SELECT MAX(id) AS id FROM announcements').first<{ id: number | null }>())?.id ?? 0;
    await env.DB.prepare("INSERT OR IGNORE INTO bot_state (key, value) VALUES ('announce_cursor', ?)").bind(String(latest)).run();
    return 0;
  }
  const { results } = await env.DB
    .prepare('SELECT id, text FROM announcements WHERE id > ? ORDER BY id LIMIT ?')
    .bind(Number(cursor.value), MAX_PER_RUN)
    .all<{ id: number; text: string }>();
  let sent = 0;
  for (const a of results ?? []) {
    const res = await post(`https://discord.com/api/v10/channels/${channel}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: a.text.slice(0, 1900), allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) break; // 실패하면 이 번호부터 다음 실행에서 다시 시도한다
    await env.DB.prepare("UPDATE bot_state SET value = ? WHERE key = 'announce_cursor'").bind(String(a.id)).run();
    sent++;
  }
  return sent;
}
