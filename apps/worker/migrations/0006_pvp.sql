-- PvP 1v1: 레이팅, 매칭 대기열, 대전, 친구 도전장
CREATE TABLE pvp_ratings (
  user_id TEXT PRIMARY KEY,
  rating  INTEGER NOT NULL DEFAULT 1000,
  wins    INTEGER NOT NULL DEFAULT 0,
  losses  INTEGER NOT NULL DEFAULT 0,
  draws   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE pvp_queue (
  user_id   TEXT PRIMARY KEY,
  rating    INTEGER NOT NULL,
  queued_at INTEGER NOT NULL
);
CREATE TABLE pvp_matches (
  id          TEXT PRIMARY KEY,
  p1          TEXT NOT NULL,
  p2          TEXT NOT NULL,
  ranked      INTEGER NOT NULL DEFAULT 1,
  state       TEXT NOT NULL,
  skills1     TEXT NOT NULL DEFAULT '[]',   -- 각자 장착한 스킬 id (서버가 검증)
  skills2     TEXT NOT NULL DEFAULT '[]',
  round_no    INTEGER NOT NULL DEFAULT 1,   -- 라운드 처리 선점용 버전
  a1          TEXT,                         -- 이번 라운드에 제출한 행동 (상대에게는 숨긴다)
  a2          TEXT,
  miss1       INTEGER NOT NULL DEFAULT 0,   -- 연속 미제출 (3회면 기권패)
  miss2       INTEGER NOT NULL DEFAULT 0,
  deadline    INTEGER NOT NULL,
  last_log    TEXT NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'active', -- active / done
  winner      TEXT,                         -- user_id 또는 'draw'
  delta1      INTEGER NOT NULL DEFAULT 0,   -- 레이팅 변동
  delta2      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_pvp_matches_p1 ON pvp_matches(p1, status);
CREATE INDEX idx_pvp_matches_p2 ON pvp_matches(p2, status);
CREATE TABLE pvp_challenges (
  id         TEXT PRIMARY KEY,
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (from_id, to_id)
);
CREATE INDEX idx_pvp_challenges_to ON pvp_challenges(to_id);
