# RTGM 디스코드 봇 연동 가이드

봇은 **게임 서버의 API를 사용자 대신 호출**하는 클라이언트예요. 게임 로직은 모두 서버에 있고, 봇은 슬래시 명령어·버튼·선택 메뉴를 API 호출로 바꿔 주면 돼요. 웹과 봇은 같은 데이터를 쓰기 때문에 웹에서 하던 전투를 봇에서 이어서 해도 돼요.

## 1. 인증

| 항목 | 내용 |
|---|---|
| 주소 | `https://rtgm.officialgl.com` (`/api/...` 만 사용) |
| 서비스 키 | Worker 시크릿 `BOT_API_KEY` (GitHub 시크릿 `BOT_API_KEY` → 배포 때 자동 동기화). **봇 서버의 환경 변수로만** 두세요. 코드·로그·디스코드 메시지에 절대 넣지 마세요. |
| 헤더 | `Authorization: Bearer <BOT_API_KEY>` |
| 사용자 지정 | `X-Discord-User: <디스코드 사용자 ID>` (숫자 15~22자리). 슬래시 명령어의 `interaction.user.id` |

- 서버에 `BOT_API_KEY`가 없으면 봇 요청은 전부 401이에요 (봇 기능 꺼짐).
- 연동되지 않은 디스코드 사용자는 `403 {"error":"not_linked"}` → 연동 안내를 보여 주세요.
- `X-Discord-User`가 없거나 형식이 틀리면 `400 {"error":"discord_user_required"}`.
- 사용자 없이 호출할 수 있는 경로: `GET /api/health`, `GET /api/announcements`, `GET /api/data/items`, `GET /api/data/mobs`, `POST /api/bot/link`.
- 봇으로는 **관리자 API(`/api/admin/*`)와 웹 전용 연동 API(`/api/discord/*`)를 쓸 수 없어요** (관리자와 연동돼 있어도 404/403).
- 에러는 `{ "error": "<코드>", ... }` 형식이고, 코드별 한글 문구는 `apps/web/src/api.ts`의 `ERROR_TEXT`를 그대로 가져다 쓰면 돼요.

## 2. 계정 연동 (처음 한 번)

1. 사용자가 **웹 → 내 정보 → 디스코드 연동**에서 “연동 코드 만들기”를 눌러요. (8자리, 10분 유효, 1회용)
2. 디스코드에서 봇의 연동 명령어(예: `/연동 코드:ABCD2345`)를 실행해요.
3. 봇이 호출해요:

```http
POST /api/bot/link
Authorization: Bearer <BOT_API_KEY>
Content-Type: application/json

{ "code": "ABCD2345", "discordId": "123456789012345678" }
```

- 성공 `200 {"ok":true,"nickname":"에이"}` / 잘못되었거나 만료·사용된 코드 `404 {"error":"invalid_code"}`.
- 연동은 1:1이에요. 같은 디스코드를 다른 계정에 연동하거나 같은 계정을 다른 디스코드에 연동하면 이전 연결은 끊어져요. 해제는 웹에서 해요.
- 이메일 인증 여부는 **연동 시점** 값을 써요 (전체 채팅 등은 인증이 필요). 인증을 나중에 했다면 다시 연동하세요.

## 3. 기능별 API (모두 `X-Discord-User` 필요)

> 요청/응답의 자세한 필드는 웹 클라이언트 `apps/web/src/api.ts`가 그대로 예시예요. 아래는 봇 명령어로 옮길 때 필요한 흐름이에요.

### 프로필·인벤토리·상점·제작·스킬
| 기능 | API |
|---|---|
| 내 정보 | `GET /api/me` |
| 인벤토리·스탯 | `GET /api/inventory` |
| 장착/해제/판매 | `POST /api/inventory/equip` `{itemId}` · `/unequip` · `/sell` `{itemId,quantity}` |
| 상점 구매 | `POST /api/shop/buy` `{itemId,quantity}` |
| 제작 | `POST /api/craft` `{recipeId}` |
| 스킬 | `GET /api/skills` · `POST /api/skills/equip` `{skillId}` · `/unequip` |
| 대기시간 | `GET /api/cooldowns` (탐험·던전 대기 중인 것의 종료 시각, epoch ms) |

### 지역 탐험·보스 (PvE 전투)
1. `POST /api/explore` `{biomeId}` → `{id, state, mobId, paid}` 전투 시작. 보스는 `POST /api/battle` `{mobId}`.
2. 매 라운드 `POST /api/battle/{id}/round` `{action:"attack"|"guard"|"item"|"skill", itemId?, skillId?, targetId?}` → `{state, log, rewards?}`.
3. `state.status`가 `ongoing`이 아니면 끝. `rewards`에 골드·숙련도·아이템.
4. 보스는 `state.intents`에 **다음 행동 예고**가 있어요 → 버튼/설명으로 보여 주세요.
- 탐험은 지역별 대기시간이 있어요 (`429 explore_cooldown`, `until` = 종료 시각).

### 로그라이크 던전
`GET /api/run` (목록+진행 중인 런) → `POST /api/run/start` `{dungeonId}` → `POST /api/run/advance` (다음 방; 몬스터 방이면 `battle`이 오고 위 전투 API로 진행) → `POST /api/run/retreat`. 끝난 런의 결과는 `GET /api/run/last`.

### 레이드·PvP·팀전 (동시 선택, 폴링)
- 모두 “행동을 내면 상대/파티가 다 낼 때까지 대기 → 서버가 한꺼번에 처리”예요. 봇은 **제출 후 2~3초 간격으로 상태를 조회**해 메시지를 갱신하세요 (디스코드 상호작용은 15분 안에 응답 갱신 가능).
- 레이드: `GET /api/raid` → `POST /api/raid/create|join|role|ready|start|action|leave`
- PvP 1v1: `GET /api/pvp/status` → `POST /api/pvp/queue`, `/challenge`, `/match/{id}/action`, `GET /api/pvp/match/{id}`
- 팀전 4v4: `GET /api/team/status` → `POST /api/team/queue`, `/room/*`, `/action`

### 소셜·교환소·이벤트
- 유저 목록 `GET /api/users?q=&offset=` · 친구 `GET /api/friends`, `POST /api/friends/request|accept|remove`
- 채팅 `GET /api/chat/{global|guild|dm:<userId>}?after=<id>` · `POST /api/chat/{채널}` `{body}`
- 길드 `GET /api/guild`, `POST /api/guild/create|join|leave|donate...`
- 교환소 `GET /api/exchange`, `POST /api/exchange/list|buy|cancel`
- 이벤트 `GET /api/events`, `POST /api/events/{id}/claim`

## 4. 전체 알림 (채널로 중계)

보스·큰 몹·레이드·던전 완주 소식이 `announcements` 표에 쌓여요. 사용자 연동 없이 봇 키만으로 읽을 수 있어요.

```http
GET /api/announcements?after=<마지막으로 본 id>
→ { "latest": 42, "announcements": [ { "id": 41, "kind": "boss|raid|dungeon", "text": "👑 …", "at": 1735000000000 } ] }
```

- 봇이 켜질 때 `after=0`으로 `latest`만 저장하고(지난 알림은 버림), 이후 10~15초마다 `after=<id>`로 새 알림만 가져와 공지 채널에 올리면 돼요.

## 5. 봇을 만들 때 권장 사항

- **슬래시 명령어 + 버튼/선택 메뉴**로 만들고, 전투 한 판은 **하나의 메시지를 계속 수정**하는 방식이 좋아요 (스팸 방지). 행동 버튼은 `공격 / 방어 / 스킬(선택 메뉴)`.
- 버튼에 `customId`로 `전투id:행동`을 넣고, 누른 사람이 전투 주인인지(= 같은 디스코드 ID로 서버가 판단)는 서버가 보장해요. 남의 전투 ID를 넣어도 `404`예요.
- 요청 타임아웃은 10초 이내로 두고, 디스코드 상호작용은 3초 안에 `defer` 한 뒤 처리하세요.
- 같은 사용자의 연타를 막기 위해 봇 쪽에서도 짧은 쿨다운(1초)을 두면 좋아요. 서버는 행동을 라운드당 한 번만 받아요.
- 키가 유출됐다면 GitHub 시크릿 `BOT_API_KEY`를 바꾸고 배포하세요 (이전 키는 즉시 무효).
