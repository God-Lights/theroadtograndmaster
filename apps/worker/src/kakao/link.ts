import type { GlUser } from '../auth';

/**
 * 카카오톡 사용자 식별: 메신저봇R 은 고유 ID 없이 '프로필 해시'와 '표시 이름'만 준다.
 * 기본 프로필 사진은 해시가 같을 수 있어서 이름과 함께 묶어 키로 쓴다 (둘 중 하나가 바뀌면 다시 연동).
 */
export const kakaoKey = (hash: string, name: string): string => `${hash}|${name}`;

export async function userForKakao(db: D1Database, key: string): Promise<GlUser | null> {
  if (!key) return null;
  const row = await db
    .prepare('SELECT l.user_id, p.nickname, p.username FROM kakao_links l JOIN profiles p ON p.user_id = l.user_id WHERE l.kakao_key = ?')
    .bind(key)
    .first<{ user_id: string; nickname: string; username: string }>();
  return row ? { id: row.user_id, email: '', username: row.username, nickname: row.nickname, emailVerified: true } : null;
}
