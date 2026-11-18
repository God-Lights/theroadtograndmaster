-- 소셜: 프로필(닉네임 검색용), 친구, 채팅, 길드, 교환소.
-- 이메일 등 개인정보는 저장하지 않는다. 닉네임·아이디는 GL Account가 이미 공개하는 값이다.
CREATE TABLE profiles (
  user_id   TEXT PRIMARY KEY,
  nickname  TEXT NOT NULL,
  username  TEXT NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX idx_profiles_nickname ON profiles(nickname);

-- 친구: requester 가 보낸 요청. 수락하면 accepted.
CREATE TABLE friendships (
  requester  TEXT NOT NULL,
  addressee  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (requester, addressee)
);
CREATE INDEX idx_friendships_addressee ON friendships(addressee);

CREATE TABLE chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  nickname   TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_chat_channel ON chat_messages(channel, id);

CREATE TABLE guilds (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  leader_id   TEXT NOT NULL,
  gold        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE TABLE guild_members (
  user_id      TEXT PRIMARY KEY,           -- 한 사람은 한 길드에만
  guild_id     TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member',  -- leader / officer / member
  contribution INTEGER NOT NULL DEFAULT 0,
  joined_at    INTEGER NOT NULL
);
CREATE INDEX idx_guild_members_guild ON guild_members(guild_id);

-- 교환소: 아이템은 등록하는 순간 인벤토리에서 빠져 이 표에 보관(에스크로)된다.
CREATE TABLE listings (
  id         TEXT PRIMARY KEY,
  seller_id  TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  quantity   INTEGER NOT NULL,
  price      INTEGER NOT NULL,             -- 전체 가격 (달런트)
  buyer_only TEXT,                         -- 지정 거래: 이 사람만 살 수 있다
  status     TEXT NOT NULL DEFAULT 'active',  -- active / sold / cancelled
  buyer_id   TEXT,
  created_at INTEGER NOT NULL,
  closed_at  INTEGER
);
CREATE INDEX idx_listings_status ON listings(status, created_at);
CREATE INDEX idx_listings_seller ON listings(seller_id, status);
