-- 레이드: 4인 역할 파티. 방(room)과 멤버. 라운드 진행은 PvP와 같은 동시 선택 방식(폴링)이다.
CREATE TABLE raid_rooms (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  boss_id     TEXT NOT NULL,
  leader_id   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'lobby',   -- lobby / active / done
  state       TEXT,
  round_no    INTEGER NOT NULL DEFAULT 1,      -- 라운드 처리 선점용 버전
  deadline    INTEGER NOT NULL DEFAULT 0,
  last_log    TEXT NOT NULL DEFAULT '[]',
  result      TEXT,                            -- victory / defeat
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE raid_members (
  room_id   TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  role      TEXT,
  ready     INTEGER NOT NULL DEFAULT 0,
  slot      TEXT,                              -- p1..p4 (전투 시작 때 배정)
  action    TEXT,                              -- 이번 라운드에 낸 행동 (다른 멤버에게는 숨긴다)
  miss      INTEGER NOT NULL DEFAULT 0,        -- 연속 미제출
  rewards   TEXT,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX idx_raid_members_user ON raid_members(user_id);
