import { Hono } from 'hono';
import { ITEMS, MOBS } from '@rtgm/data';
import { authenticate, fetchPublicUser, AuthUpstreamError, type AppEnv } from './auth';
import { isAdmin } from './admin';
import { battle } from './battle';
import { handleInteraction } from './bot/handler';
import { relayAnnouncements } from './bot/relay';
import { verifyDiscordSignature } from './bot/verify';
import { discord } from './discord';
import { adminEvents, events } from './events';
import { craft } from './craft';
import { ensureCharacter, getCharacter } from './character';
import { exchange } from './exchange';
import { guilds } from './guild';
import { inventory } from './inventory';
import { pvp } from './pvp';
import { raid } from './raid';
import { runs } from './run';
import { announcements } from './announce';
import { team } from './team';
import { skills } from './skills';
import { social, touchProfile } from './social';

export const app = new Hono<AppEnv>();

// /api/health 를 제외한 모든 요청(페이지·정적 파일·API)에 GL Account 로그인이 필요하다.
app.use('*', authenticate);

// 게임 데이터를 쓰는 API는 캐릭터(시작 골드·시작 장비)가 만들어진 뒤에 처리한다.
app.use('/api/*', async (c, next) => {
  const user = c.get('user');
  if (user && c.req.path !== '/api/health') {
    await ensureCharacter(c.env.DB, user.id);
    await touchProfile(c.env.DB, user);
  }
  await next();
});

/**
 * 디스코드 봇 (HTTP 상호작용): 슬래시 명령어·버튼·선택 메뉴가 여기로 온다. 서명을 검증한 뒤,
 * 같은 서버의 게임 API를 '그 디스코드 사용자로' 호출해서 결과를 메시지로 바꾼다.
 */
app.post('/discord/interactions', async (c) => {
  const publicKey = c.env.DISCORD_PUBLIC_KEY;
  // 공개 키가 없으면 어떤 요청도 검증할 수 없다 (디스코드의 URL 검증도 실패하므로 원인을 알 수 있게 안내를 남긴다)
  if (!publicKey) return c.json({ error: 'bot_disabled', reason: 'DISCORD_PUBLIC_KEY 가 설정되지 않았습니다' }, 503);
  const body = await c.req.text();
  const ok = await verifyDiscordSignature(publicKey, c.req.header('X-Signature-Ed25519') ?? '', c.req.header('X-Signature-Timestamp') ?? '', body);
  if (!ok) return c.text('invalid request signature', 401);
  let interaction: { type?: number } | null;
  try { interaction = JSON.parse(body); } catch { return c.text('bad request', 400); }
  // PING(엔드포인트 검증)은 서비스 키 없이도 응답한다. 게임 명령은 BOT_API_KEY 가 있어야 한다.
  if (interaction?.type === 1) return c.json({ type: 1 });
  const botKey = c.env.BOT_API_KEY;
  if (!botKey) return c.json({ type: 4, data: { flags: 64, content: '⚠️ 봇 설정이 끝나지 않았어요. (운영자: BOT_API_KEY 시크릿을 설정하고 다시 배포해 주세요)' } });
  const callFor = (discordId: string) => async (method: string, path: string, payload?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { Authorization: `Bearer ${botKey}`, 'X-Discord-User': discordId, 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }, c.env);
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  return c.json(await handleInteraction(interaction, callFor));
});

app.get('/api/health', (c) => c.json({ ok: true, game: 'RTGM' }));
app.get('/api/data/items', (c) => c.json(ITEMS));
app.get('/api/data/mobs', (c) => c.json(MOBS));

// 현재 사용자. 이메일은 화면에 필요 없으므로 돌려주지 않는다.
app.get('/api/me', async (c) => {
  const user = c.get('user');
  const { gold, proficiency } = await getCharacter(c.env.DB, user.id);
  return c.json({
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    emailVerified: user.emailVerified,
    isAdmin: isAdmin(c.env.ADMIN_USER_IDS, user.id),
    gold,
    proficiency,
  });
});

// 다른 사용자의 닉네임 조회 (작성자·파티원 표시용)
app.get('/api/users/:id', async (c) => {
  const id = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: 'invalid id' }, 400);
  try {
    const user = await fetchPublicUser(c.env.GL_ACCOUNT_KEY!, id);
    return user ? c.json({ id: user.id, nickname: user.nickname }) : c.json({ error: 'not found' }, 404);
  } catch (e) {
    if (e instanceof AuthUpstreamError) return c.json({ error: 'upstream unavailable' }, 503);
    throw e;
  }
});

app.route('/api', inventory);
app.route('/api', craft);
app.route('/api', skills);
app.route('/api', battle);
app.route('/api', social);
app.route('/api', guilds);
app.route('/api', exchange);
app.route('/api', pvp);
app.route('/api', raid);
app.route('/api', runs);
app.route('/api', announcements);
app.route('/api', team);
app.route('/api', events);
app.route('/api', discord);
app.route('/api', adminEvents);

// 인증을 통과한 나머지 요청은 빌드된 React 클라이언트(정적 에셋)로 넘긴다.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  /** 1분마다: 새 전체 알림을 디스코드 채널로 중계 (설정이 없으면 아무것도 하지 않는다) */
  async scheduled(_event: unknown, env: Parameters<typeof relayAnnouncements>[0], ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(relayAnnouncements(env).catch(() => 0));
  },
};
