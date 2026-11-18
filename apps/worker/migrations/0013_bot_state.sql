-- 봇이 마지막으로 중계한 전체 알림 번호 등 봇 상태
CREATE TABLE bot_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
