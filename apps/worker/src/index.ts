import { Hono } from 'hono';
import { ITEMS, MOBS } from '@rtgm/data';
import { authenticate, fetchPublicUser, AuthUpstreamError, type AppEnv } from './auth';
import { battle } from './battle';
import { ensureCharacter, getCharacter } from './character';
import { inventory } from './inventory';

export const app = new Hono<AppEnv>();

// /api/health 를 제외한 모든 요청(페이지·정적 파일·API)에 GL Account 로그인이 필요하다.
app.use('*', authenticate);

// 게임 데이터를 쓰는 API는 캐릭터(시작 골드·시작 장비)가 만들어진 뒤에 처리한다.
app.use('/api/*', async (c, next) => {
  const user = c.get('user');
  if (user && c.req.path !== '/api/health') await ensureCharacter(c.env.DB, user.id);
  await next();
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
app.route('/api', battle);

// 인증을 통과한 나머지 요청은 빌드된 React 클라이언트(정적 에셋)로 넘긴다.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
