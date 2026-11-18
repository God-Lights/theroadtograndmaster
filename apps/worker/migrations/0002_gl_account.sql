-- 로그인은 GL Account가 담당한다. 이 서비스는 비밀번호·이메일을 저장하지 않고,
-- GL Account의 user.id(UUID)만 사용자 키로 쓴다. 아직 배포 전이라 기존 개발용 테이블은 폐기한다.
DROP TABLE IF EXISTS battles;
DROP TABLE IF EXISTS inventory;
DROP TABLE IF EXISTS characters;
DROP TABLE IF EXISTS users;

CREATE TABLE characters (
  user_id     TEXT PRIMARY KEY,             -- GL Account user.id (UUID)
  proficiency INTEGER NOT NULL DEFAULT 0,   -- EDRPG 숙련도 점수
  gold        INTEGER NOT NULL DEFAULT 0,   -- 달런트
  ed_money    REAL    NOT NULL DEFAULT 0,   -- 에드머니
  hp          INTEGER NOT NULL DEFAULT 100,
  max_hp      INTEGER NOT NULL DEFAULT 100,
  mana        INTEGER NOT NULL DEFAULT 0,
  max_mana    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE inventory (
  user_id  TEXT NOT NULL,
  item_id  TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  equipped INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE battles (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  mob_id     TEXT NOT NULL,
  state      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_battles_user ON battles(user_id);
