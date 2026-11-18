/**
 * 직전 UPDATE가 아무 행도 바꾸지 못했으면 SQL 오류를 일으켜 batch 전체를 되돌린다.
 * (D1 batch는 한 트랜잭션이라 중간에 오류가 나면 앞선 변경도 모두 취소된다.)
 */
export const guard = (db: D1Database) =>
  db.prepare("SELECT CASE WHEN changes() = 0 THEN json('guard_failed') ELSE 1 END");
