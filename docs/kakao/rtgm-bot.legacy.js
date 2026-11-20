/**
 * RTGM 카카오톡 봇 — 메신저봇R 레거시 API 스크립트
 *
 * 이 스크립트가 하는 일은 두 가지뿐이다.
 *  1) 받은 명령(!…)과 번호 답을 서버로 보내고, 돌아온 글을 그대로 방에 보낸다.
 *  2) 서버가 먼저 보내려는 글(전체 알림 등)을 주기적으로 가져가서 방에 보낸다.
 * 명령어·화면·게임 규칙은 모두 서버에 있으니 기능이 늘어도 이 파일은 고치지 않는다.
 *
 * 사용: 아래 KEY 를 GitHub 시크릿 KAKAO_BOT_KEY 와 같은 값으로 바꾸고 컴파일한다. (이 파일을 공개하지 말 것)
 * 문법은 ES5(var, function)만 쓴다. 레거시 엔진(Rhino)이 let/const/화살표 함수를 모르기 때문이다.
 */
var BASE = "https://rtgm.officialgl.com/api/kakao";
var KEY = "여기에_KAKAO_BOT_KEY";
var VER = 1; // 서버가 요구하는 최소 버전보다 낮으면 서버가 업데이트 안내를 보낸다

var running = true;

/** 서버에 JSON 을 POST 하고 JSON 으로 돌려받는다 (HttpURLConnection: 어떤 버전에서도 동작) */
function post(path, body) {
  var conn = new java.net.URL(BASE + path).openConnection();
  conn.setRequestMethod("POST");
  conn.setConnectTimeout(6000);
  conn.setReadTimeout(8000);
  conn.setDoOutput(true);
  conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
  conn.setRequestProperty("Authorization", "Bearer " + KEY);
  var out = conn.getOutputStream();
  out.write(new java.lang.String(JSON.stringify(body)).getBytes("UTF-8"));
  out.close();
  var code = conn.getResponseCode();
  var stream = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
  var text = "";
  if (stream != null) {
    var reader = new java.io.BufferedReader(new java.io.InputStreamReader(stream, "UTF-8"));
    var line, sb = [];
    while ((line = reader.readLine()) != null) sb.push(String(line));
    reader.close();
    text = sb.join("\n");
  }
  conn.disconnect();
  try { return JSON.parse(text); } catch (e) { return {}; }
}

/** 프로필 사진으로 사람을 구분하는 해시(SHA-256). 사진이 없으면 고정값 */
function profileHash(ImageDB) {
  var img = "";
  try { img = String(ImageDB.getProfileImage() || ""); } catch (e) {}
  if (img === "") return "noimg";
  var md = java.security.MessageDigest.getInstance("SHA-256");
  var bytes = md.digest(new java.lang.String(img).getBytes("UTF-8"));
  var hex = "";
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    hex += (b < 16 ? "0" : "") + b.toString(16);
  }
  return hex;
}

function isForServer(text) {
  if (text.charAt(0) === "!") return true;            // 명령
  return /^(\d{1,2}|취소)$/.test(text.replace(/^\s+|\s+$/g, "")); // 번호 메뉴 답
}

function response(room, msg, sender, isGroupChat, replier, ImageDB, packageName) {
  var text = String(msg);
  if (!isForServer(text)) return; // 일반 대화는 서버로 보내지 않는다
  try {
    var r = post("/message", {
      room: String(room), group: !!isGroupChat, name: String(sender),
      hash: profileHash(ImageDB), text: text, ver: VER, ts: new Date().getTime()
    });
    var replies = r.replies || [];
    for (var i = 0; i < replies.length; i++) {
      if (i > 0) java.lang.Thread.sleep(700); // 연달아 보내면 카톡이 제한할 수 있다
      replier.reply(String(replies[i]));
    }
  } catch (e) { /* 서버가 안 열려 있으면 조용히 넘어간다 */ }
}

// 서버가 먼저 보내는 글: 4초마다 가져가서 보내고, 보냈다고 다음 요청에 알린다(ack).
// 레거시 API는 '그 방에서 메시지를 한 번이라도 받은 뒤'에야 그 방으로 보낼 수 있다.
// 보내지 못하면 ack 하지 않아서 서버가 잠시 뒤 다시 내보낸다 (최대 4번, 1시간).
var acks = [];
var worker = new java.lang.Thread(new java.lang.Runnable({
  run: function () {
    while (running) {
      try {
        var r = post("/outbox", { ver: VER, ack: acks, max: 5 });
        acks = [];
        var items = r.items || [];
        for (var i = 0; i < items.length; i++) {
          var ok = false;
          try { ok = Api.replyRoom(String(items[i].room), String(items[i].text)); } catch (e2) {}
          if (ok) acks.push(items[i].id);
          java.lang.Thread.sleep(1000);
        }
      } catch (e) { /* 다음 주기에 다시 */ }
      java.lang.Thread.sleep(4000);
    }
  }
}));
worker.start();

// 다시 컴파일할 때 이전 반복을 멈춘다
function onStartCompile() { running = false; }
