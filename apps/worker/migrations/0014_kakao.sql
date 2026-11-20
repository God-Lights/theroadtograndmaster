-- 카카오톡 봇(메신저봇R) 연동.
-- 카톡은 고유 ID를 주지 않아서 '프로필 해시|표시 이름'을 키로 쓴다 (프로필 사진이나 이름이 바뀌면 다시 연동해야 한다).
CREATE TABLE kakao_links (
  kakao_key TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  linked_at INTEGER NOT NULL
);
-- 번호 메뉴 상태: 버튼이 없어서 서버가 '지금 보고 있는 화면'을 기억한다 (방+사용자별, 몇 분 뒤 만료)
CREATE TABLE kakao_sessions (
  skey       TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
-- 서버가 먼저 보내는 메시지(전체 알림, 라운드 결과 등). 폰이 가져가서 보내고 확인(ack)하면 끝난다.
CREATE TABLE kakao_outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room        TEXT NOT NULL,
  text        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'info',
  created_at  INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,   -- 가져간 뒤 이 시각까지 확인이 없으면 다시 내보낸다
  attempts    INTEGER NOT NULL DEFAULT 0,
  done_at     INTEGER
);
CREATE INDEX idx_kakao_outbox_open ON kakao_outbox (done_at, lease_until, id);
