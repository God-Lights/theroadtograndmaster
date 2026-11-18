-- 이벤트: 관리자(GL ID)가 만든다. kind = notice(공지) / bonus(보상 배율) / gift(1회 수령 선물)
CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL,
  config      TEXT NOT NULL DEFAULT '{}',
  starts_at   INTEGER NOT NULL,
  ends_at     INTEGER NOT NULL,
  cancelled   INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_events_window ON events(ends_at, starts_at);
CREATE TABLE event_claims (
  event_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
