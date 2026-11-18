-- RTGM 초기 스키마 (뼈대). 계정/인벤토리/전투 세션.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id),
  name        TEXT NOT NULL,
  proficiency INTEGER NOT NULL DEFAULT 0,   -- EDRPG 숙련도 점수 (Lv = 50단계)
  gold        INTEGER NOT NULL DEFAULT 0,   -- 달런트
  ed_money    REAL    NOT NULL DEFAULT 0,   -- 에드머니
  hp          INTEGER NOT NULL DEFAULT 100,
  max_hp      INTEGER NOT NULL DEFAULT 100,
  mana        INTEGER NOT NULL DEFAULT 0,
  max_mana    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inventory (
  user_id  INTEGER NOT NULL REFERENCES users(id),
  item_id  TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  equipped INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, item_id)
);

-- 서버 판정 전투 세션. 클라이언트는 행동만 보내고 결과는 서버가 계산한다.
CREATE TABLE IF NOT EXISTS battles (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  mob_id     TEXT NOT NULL,
  state      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
