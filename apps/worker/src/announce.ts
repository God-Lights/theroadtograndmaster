import { Hono } from 'hono';
import type { AppEnv } from './auth';

/**
 * 전체 알림: 보스·큰 몹을 쓰러뜨리거나 레이드·던전을 완주하면 모두에게 알린다.
 * (이 표는 나중에 디스코드 봇이 읽어 갈 수 있게 종류·문구·시각을 그대로 남긴다.)
 */
export type AnnounceKind = 'boss' | 'raid' | 'dungeon';
const KEEP = 200;

export const announceStmts = (db: D1Database, kind: AnnounceKind, text: string): D1PreparedStatement[] => [
  db.prepare('INSERT INTO announcements (kind, text, created_at) VALUES (?, ?, ?)').bind(kind, text, Date.now()),
  db.prepare('DELETE FROM announcements WHERE id <= (SELECT id FROM announcements ORDER BY id DESC LIMIT 1 OFFSET ?)').bind(KEEP),
];

export async function announce(db: D1Database, kind: AnnounceKind, text: string): Promise<void> {
  await db.batch(announceStmts(db, kind, text));
}

export const announcements = new Hono<AppEnv>();

/** after 보다 새 알림 (없으면 최근 20개). latest 는 현재 마지막 번호 — 처음 접속한 화면이 지난 알림을 한꺼번에 보여 주지 않게 쓴다 */
announcements.get('/announcements', async (c) => {
  const after = Math.max(0, Number.parseInt(c.req.query('after') ?? '', 10) || 0);
  const { results } = await c.env.DB
    .prepare(after > 0
      ? 'SELECT id, kind, text, created_at FROM announcements WHERE id > ? ORDER BY id LIMIT 20'
      : 'SELECT * FROM (SELECT id, kind, text, created_at FROM announcements ORDER BY id DESC LIMIT 20) ORDER BY id')
    .bind(...(after > 0 ? [after] : []))
    .all<{ id: number; kind: AnnounceKind; text: string; created_at: number }>();
  const latest = (await c.env.DB.prepare('SELECT MAX(id) AS id FROM announcements').first<{ id: number | null }>())?.id ?? 0;
  return c.json({ latest, announcements: (results ?? []).map((r) => ({ id: r.id, kind: r.kind, text: r.text, at: r.created_at })) });
});
