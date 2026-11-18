-- 디스코드 봇 연동: 게임 계정(GL user id)과 디스코드 사용자를 1:1로 묶는다.
CREATE TABLE discord_links (
  discord_id     TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,   -- 연동 시점의 이메일 인증 여부 (전체 채팅 등에 쓰인다)
  linked_at      INTEGER NOT NULL
);
-- 게임(웹)에서 만든 1회용 연동 코드. 디스코드에서 봇에게 입력하면 연동된다.
CREATE TABLE discord_link_codes (
  code           TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  expires_at     INTEGER NOT NULL
);
