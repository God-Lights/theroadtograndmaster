# 카카오톡 봇 (메신저봇R)

폰의 메신저봇R 스크립트는 **받은 메시지를 서버로 보내고, 돌아온 글을 그대로 방에 보내는 일만** 한다. 명령어·화면·게임 규칙은 모두 서버(Worker)에 있어서, 기능이 늘어도 스크립트는 고치지 않는다.

```
카톡 방/DM ─▶ 메신저봇R(폰) ─POST /api/kakao/message─▶ Worker ─▶ 게임 로직
                  ▲                                          │
                  └──── 답장 · 알림(outbox, 폰이 주기적으로 가져감) ◀─┘
```

## 설정 (운영자)

1. **게임 전용 서브 계정**으로 카톡을 쓰는 폰에 메신저봇R을 설치한다. (짧은 시간에 많이 보내면 계정이 제재될 수 있어 본 계정은 권하지 않는다.)
2. GitHub 시크릿 `KAKAO_BOT_KEY` 에 길고 무작위인 문자열을 넣는다. (디스코드 `BOT_API_KEY`와 **다른 값**.) 이 키는 폰 스크립트에도 넣는다.
3. (선택) GitHub 변수 `KAKAO_PUBLIC_ROOM` 에 공개 결과·전체 알림을 받을 **단체방 이름**을 넣는다.
4. 배포하면 서버가 켜진다. 키가 비어 있으면 `/api/kakao/*` 는 503 이다.
5. 아래 스크립트를 메신저봇R에 붙여 넣고 `KEY` 를 채운 뒤 컴파일한다.
6. 웹 **내 정보 → 봇 연동**에서 코드를 만들고, 봇과의 **1:1 대화**에서 `!연동 코드` 를 보낸다. (코드는 디스코드·카톡 모두에 쓸 수 있고 한 번만 쓴다.)

## 스크립트 (API2 기준 초안)

> API 이름은 메신저봇R 문서 기준 기억이라 실제 버전에서 한 번 확인한다. 특히 HTTP 호출과 반복 실행(스레드) 부분.

```js
const bot = BotManager.getCurrentBot();
const BASE = "https://rtgm.officialgl.com/api/kakao";
const KEY = "여기에_KAKAO_BOT_KEY";
const VER = 1; // 서버가 요구하는 최소 버전보다 낮으면 서버가 업데이트 안내를 보낸다

function post(path, body) {
  const res = org.jsoup.Jsoup.connect(BASE + path)
    .header("Authorization", "Bearer " + KEY)
    .header("Content-Type", "application/json")
    .requestBody(JSON.stringify(body))
    .ignoreContentType(true).ignoreHttpErrors(true).timeout(8000)
    .method(org.jsoup.Connection.Method.POST).execute();
  return JSON.parse(res.body());
}

bot.addListener(Event.MESSAGE, function (msg) {
  const t = String(msg.content);
  if (t.charAt(0) !== "!" && !/^(\d{1,2}|취소)$/.test(t.trim())) return; // 명령·번호 답만 서버로 (나머지는 보내지 않는다)
  try {
    const r = post("/message", { room: msg.room, group: msg.isGroupChat, name: msg.author.name, hash: msg.author.hash, text: t, ver: VER, ts: Date.now() });
    (r.replies || []).forEach(function (line, i) { java.lang.Thread.sleep(i ? 700 : 0); msg.reply(line); });
  } catch (e) { /* 서버가 안 열려 있으면 조용히 */ }
});

// 서버가 먼저 보내는 알림(전체 알림 등): 4초마다 가져가서 보내고, 다음 요청에 ack 로 알린다
let acks = [];
const worker = new java.lang.Thread({ run: function () {
  while (!java.lang.Thread.currentThread().isInterrupted()) {
    try {
      const r = post("/outbox", { ver: VER, ack: acks, max: 5 });
      acks = [];
      (r.items || []).forEach(function (it) { bot.send(it.room, it.text); acks.push(it.id); java.lang.Thread.sleep(1000); });
    } catch (e) {}
    java.lang.Thread.sleep(4000);
  }
} });
worker.start();
bot.addListener(Event.START_COMPILE, function () { worker.interrupt(); }); // 다시 컴파일할 때 이전 반복을 멈춘다
```

## 규칙

- 명령어는 `!`로 시작한다. 모르는 `!명령`은 **단체방에서는 조용히** 넘긴다(다른 봇의 명령일 수 있다). 1:1 대화에서만 안내한다.
- **개인 행동(연동·내 정보 등)은 1:1 대화에서만** 받는다. 단체방은 공개 방(`KAKAO_PUBLIC_ROOM`)의 공개 명령과 알림만 다룬다.
- 버튼이 없어서 **번호 메뉴**를 쓴다. 번호 답은 방+사용자별로 3분만 유효하다.
- 사용자당 1.5초에 한 건만 처리하고, 같은 메시지가 두 번 오면 한 번만 처리한다(`ts`).
- 서버가 보낸 글은 한 메시지 450자 안으로 나뉘고, 한 번에 최대 6개까지 돌려준다.

## 연동과 보안

- 카톡은 고유 ID를 주지 않아서 **프로필 해시 + 표시 이름**을 키로 묶는다. 둘 중 하나가 바뀌면 다시 연동해야 한다. 기본 프로필 사진을 쓰는 사람이 여럿이면 해시가 같을 수 있어 이름도 함께 본다. 이름을 똑같이 바꾼 사람이 같은 해시를 가진 경우는 막지 못하므로, 거래처럼 민감한 기능은 추가 확인을 넣는다.
- `KAKAO_BOT_KEY` 는 폰에 있으므로 유출 위험이 더 크다. 이 키로는 `/api/kakao/*` 만 열리고, 게임 API·관리자 API는 서버가 안에서 대신 부른다. 유출되면 GitHub 시크릿을 바꾸고 다시 배포한 뒤 스크립트의 `KEY`를 갱신한다.
- 스크립트 파일을 공개 저장소·단체방에 올리지 않는다.

## 운영 주의

- 폰은 계속 켜 두고, 메신저봇R·카톡의 **배터리 최적화를 끄고** 알림 접근 권한을 유지한다. 꺼지면 봇이 멈추고, 서버의 알림은 폰이 돌아올 때까지 쌓여 있다가(최대 1시간) 전달된다.
- 단체방에는 한꺼번에 많이 보내지 않는다(방당 초당 1건 이하).

## 구현 단계

1. (현재) 뼈대: 프로토콜, 연동, 도움말, 내정보, 소식, 알림 큐와 전체 알림 중계
2. 핵심 루프: 탐험·전투·인벤토리·상점·제작
3. 모드: 던전·레이드·PvP·팀전과 라운드 알림
4. 소셜: 친구·길드·교환소
5. 마무리: 요청 제한·중복 방지 점검
