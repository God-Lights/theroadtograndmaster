-- PvP 4v4 (역할 팀전): 팀 레이팅, 역할 대기열, 대전(랭크/친선 방), 참가자
CREATE TABLE team_ratings (
  user_id TEXT PRIMARY KEY,
  rating  INTEGER NOT NULL DEFAULT 1000,
  wins    INTEGER NOT NULL DEFAULT 0,
  losses  INTEGER NOT NULL DEFAULT 0,
  draws   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE team_queue (
  user_id   TEXT PRIMARY KEY,
  role      TEXT NOT NULL,
  rating    INTEGER NOT NULL,
  queued_at INTEGER NOT NULL
);
CREATE TABLE team_matches (
  id          TEXT PRIMARY KEY,
  code        TEXT UNIQUE,                    -- 친선 방 초대 코드 (랭크전은 NULL)
  ranked      INTEGER NOT NULL DEFAULT 0,
  leader_id   TEXT,
  status      TEXT NOT NULL DEFAULT 'lobby',  -- lobby / active / done
  state       TEXT,
  round_no    INTEGER NOT NULL DEFAULT 1,
  deadline    INTEGER NOT NULL DEFAULT 0,
  last_log    TEXT NOT NULL DEFAULT '[]',
  winner      TEXT,                           -- A / B / draw
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE team_players (
  match_id  TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  team      TEXT,                             -- A / B
  role      TEXT,
  ready     INTEGER NOT NULL DEFAULT 0,
  slot      TEXT,                             -- a1..a4 / b1..b4
  action    TEXT,
  miss      INTEGER NOT NULL DEFAULT 0,
  delta     INTEGER NOT NULL DEFAULT 0,       -- 레이팅 변동
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, user_id)
);
CREATE INDEX idx_team_players_user ON team_players(user_id);
