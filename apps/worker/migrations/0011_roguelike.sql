-- 로그라이크 던전, 행동 대기시간(모험·던전), 전체 알림
ALTER TABLE battles ADD COLUMN run_id TEXT;

CREATE TABLE action_cooldowns (
  user_id TEXT NOT NULL,
  key     TEXT NOT NULL,           -- explore / run:<던전 id>
  until   INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE dungeon_runs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  dungeon_id  TEXT NOT NULL,
  floor       INTEGER NOT NULL DEFAULT 0,   -- 지금까지 내려온 층
  floors      INTEGER NOT NULL,
  hp          INTEGER NOT NULL,             -- 층을 오르내려도 이어지는 HP
  max_hp      INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'idle', -- idle(다음 방 대기) / battle(전투 중) / done
  loot        TEXT NOT NULL DEFAULT '{"gold":0,"proficiency":0,"items":[]}',  -- 탈출해야 받는 전리품
  events      TEXT NOT NULL DEFAULT '[]',   -- 지금까지의 방 기록
  battle_id   TEXT,
  result      TEXT,                         -- clear / retreat / dead
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_dungeon_runs_user ON dungeon_runs(user_id, status);

CREATE TABLE announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,                 -- boss / raid / dungeon
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
