// 디스코드 슬래시 명령어를 등록(덮어쓰기)한다. 배포 워크플로우가 부르고, 직접 실행해도 된다.
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... [DISCORD_GUILD_ID=...] node scripts/register-discord-commands.mjs
// DISCORD_GUILD_ID 가 있으면 그 서버에만 즉시 등록(테스트용), 없으면 전역 등록(반영까지 최대 1시간).
import { readFileSync } from 'node:fs';

const { DISCORD_APP_ID: app, DISCORD_BOT_TOKEN: token, DISCORD_GUILD_ID: guild } = process.env;
if (!app || !token) {
  console.log('DISCORD_APP_ID / DISCORD_BOT_TOKEN 이 없어 명령어 등록을 건너뜁니다.');
  process.exit(0);
}
const commands = JSON.parse(readFileSync(new URL('../apps/worker/src/bot/commands.json', import.meta.url), 'utf8'));
const url = guild
  ? `https://discord.com/api/v10/applications/${app}/guilds/${guild}/commands`
  : `https://discord.com/api/v10/applications/${app}/commands`;
const res = await fetch(url, { method: 'PUT', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(commands) });
if (!res.ok) {
  console.error(`명령어 등록 실패: ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(`명령어 ${commands.length}개를 ${guild ? `서버(${guild})` : '전역'}에 등록했습니다.`);
