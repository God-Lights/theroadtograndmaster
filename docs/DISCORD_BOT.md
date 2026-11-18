# RTGM 디스코드 봇

RTGM 서버(Cloudflare Worker)에 **봇이 내장**돼 있어요. 별도 서버 없이 디스코드의 *상호작용 엔드포인트(HTTP)* 로 슬래시 명령어·버튼·선택 메뉴를 받아서 게임 API를 호출해요. (게이트웨이 상시 접속이 필요 없어요.)

## 설정 (처음 한 번)

1. **디스코드 앱 만들기**: [Developer Portal](https://discord.com/developers/applications) → New Application.
   - *General Information*의 **Application ID**, **Public Key**를 적어 둬요.
   - *Bot* 탭에서 봇을 만들고 **Token**을 복사해요 (한 번만 보여요).
2. **Interactions Endpoint URL** 설정: *General Information* → `https://rtgm.officialgl.com/discord/interactions` 를 저장해요. (저장할 때 디스코드가 서명 검증 요청을 보내서, 아래 3번 값이 배포돼 있어야 저장돼요.)
3. **GitHub 저장소 설정**에 값을 넣어요 (Settings → Secrets and variables → Actions):

| 종류 | 이름 | 값 |
|---|---|---|
| Variable | `DISCORD_PUBLIC_KEY` | 앱의 Public Key (공개 값) |
| Variable | `DISCORD_APP_ID` | Application ID |
| Variable | `DISCORD_GUILD_ID` | (선택) 테스트용 서버 ID — 있으면 그 서버에만 명령어가 즉시 등록돼요. 비우면 전역 등록(반영까지 최대 1시간) |
| Variable | `DISCORD_ANNOUNCE_CHANNEL_ID` | (선택) 보스·레이드·던전 소식을 올릴 채널 ID |
| Secret | `BOT_API_KEY` | 임의의 긴 문자열 (봇이 게임 API를 부를 때 쓰는 내부 키) |
| Secret | `DISCORD_BOT_TOKEN` | 봇 토큰 (명령어 등록과 소식 채널 게시에 쓰여요) |

4. **배포**(main에 머지 또는 워크플로우 수동 실행)하면 값이 Worker에 반영되고 슬래시 명령어가 등록돼요.
5. **서버에 초대**: OAuth2 → URL Generator에서 scope `applications.commands` (+ 소식 채널을 쓰면 `bot`, 권한 *메시지 보내기*)를 골라 만든 링크로 초대해요.
6. 웹 **내 정보 → 디스코드 연동**에서 코드를 만들고 디스코드에서 `/연동 코드:XXXXXXXX` 를 실행하면 끝이에요.

> 키와 토큰은 GitHub 시크릿으로만 두세요. 코드·로그·채팅에 붙여 넣지 마세요. 유출됐다면 디스코드에서 토큰을 재발급하고 시크릿을 바꾼 뒤 다시 배포하세요.

## 전체 공개 결과와 HP 막대 이미지

- **조작 화면(전투·메뉴 등)은 나만 보이지만, 게임 결과는 채널에 전체 공개**로 올라가요: 탐험·보스 전투 결과(보스 처치는 👑), 로그라이크 던전 완주·후퇴·사망, 레이드 클리어/실패(파티원·보상), PvP 1v1·4v4 결과(승자·레이팅). 진행 중인 전투와 프로필·상점·오류 같은 개인 안내는 공개되지 않아요.
- 같은 결과는 한 번만 올라가요 (여러 명이 새로고침해도 중복 없음). 결과 메시지는 멘션 없이(`allowed_mentions: none`) 올라가요.
- 전체 공개는 슬래시 명령어를 실행한 채널에 *후속 메시지*로 올라가요 (명령어를 쓴 사람의 상호작용 토큰으로 15분 안에 게시).
- HP·AP·궁극기 막대는 **서버가 그리는 PNG 이미지**(`/bot/bars.png?r=...`)로 보여요. 로그인 없이 열리고(디스코드가 가져가요), 값은 숫자 토큰만 허용돼요 (`a`=아군 HP%, `f`=적, `b`=보스, `x`=쓰러짐, `_`=간격, `p0~6`=AP 점, `u`=궁극기).

## 명령어

| 명령어 | 설명 |
|---|---|
| `/연동 코드` · `/도움말` | 계정 연동 · 사용법 |
| `/프로필` | 달런트·숙련도·스탯·장비·탐험 대기시간 |
| `/탐험 지역` · `/보스 보스` | 지역 탐험(1분 30초 대기), 보스 도전 — 버튼으로 공격·방어, 메뉴로 스킬·아이템 |
| `/던전` | 로그라이크 던전: 입장 → 층 내려가기 → 후퇴 (전투는 같은 화면에서) |
| `/인벤토리` · `/스킬` | 장비·스킬 장착/해제 (메뉴) |
| `/상점` · `/구매` · `/판매` · `/제작` | 이름은 자동 완성돼요 |
| `/소식` | 최근 전체 알림 |

**함께 하기**

| 명령어 | 설명 |
|---|---|
| `/레이드` · `/레이드입장 코드` | 레이드 로비(방 만들기)·대기실(역할·준비·시작)·전투. 힐·보호막은 아군 대상 메뉴가 나와요 |
| `/대전` · `/도전 유저` | PvP 1v1 랭크 대기열, 친구에게 도전(수락은 상대의 `/대전`) |
| `/팀전` · `/팀입장 코드` | 4v4 랭크 대기열(역할 선택), 친선 방(팀·역할·준비·시작) |
| `/랭킹` | PvP·팀전 TOP 10 |
| `/친구` · `/친구신청 닉네임` · `/유저 검색` | 친구 목록·수락/거절/삭제, 닉네임으로 신청, 유저 목록 |
| `/길드` · `/길드생성` · `/길드기부` | 길드 가입·탈퇴·정보, 만들기(1000D), 기부 |
| `/교환소` · `/등록 아이템 수량 가격` | 구매·내 물품 거두기·판매 내역, 물품 올리기 |
| `/이벤트` | 진행 중인 이벤트·보너스, 선물 받기 |

레이드·PvP·팀전은 **동시 선택**이라 다른 사람이 고를 때까지 기다려야 해요. 디스코드 메시지는 자동으로 갱신되지 않으므로 **🔄 새로고침** 버튼으로 확인하세요 (내가 행동을 제출하면 메시지가 갱신돼요). 아직 봇에 없는 것: 채팅(웹에서), 관리자 기능, 레이드·팀전 보상 상세는 결과 화면에 요약만 나와요.

명령어 목록은 `apps/worker/src/bot/commands.json` 에 있고, 바꾸면 배포 때 자동으로 다시 등록돼요.

## 내부 구조

- `POST /discord/interactions` (공개 경로, Ed25519 서명 검증·5분 지난 요청 거절) → `apps/worker/src/bot/handler.ts` 가 명령을 해석하고, 같은 Worker의 게임 API를 **그 디스코드 사용자로** 호출해요 (아래 API 연동 방식과 동일).
- 화면(embed·버튼·메뉴) 생성은 `bot/ui.ts`, 오류 문구는 웹과 같은 `ERROR_TEXT`(`packages/data`)를 써요.
- 소식 중계: 크론(1분)이 새 `announcements`를 채널에 올려요 (`bot/relay.ts`). 처음에는 지난 소식을 올리지 않아요.
- 서명이나 키 설정이 없으면 엔드포인트는 404/401로 꺼져 있어요.

---

# 외부 봇을 직접 만들 때 (API 연동 가이드)

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
