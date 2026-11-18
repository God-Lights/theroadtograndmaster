import { Hono } from 'hono';
import { BASE_STATS, ITEMS, MOBS, itemById, mobById } from '@rtgm/data';
import { authenticate, fetchPublicUser, AuthUpstreamError, type AppEnv } from './auth';
import {
  chooseEnemyAction,
  createBattle,
  resolveRound,
  type Action,
  type BattleState,
} from '@rtgm/engine';

export const app = new Hono<AppEnv>();

// /api/health 를 제외한 모든 요청(페이지·정적 파일·API)에 GL Account 로그인이 필요하다.
app.use('*', authenticate);

const PLAYER_ID = 'player';
const ENEMY_ID = 'enemy';

app.get('/api/health', (c) => c.json({ ok: true, game: 'RTGM' }));
app.get('/api/data/items', (c) => c.json(ITEMS));
app.get('/api/data/mobs', (c) => c.json(MOBS));

// 현재 사용자. 이메일은 화면에 필요 없으므로 돌려주지 않는다.
app.get('/api/me', async (c) => {
  const user = c.get('user');
  await c.env.DB.prepare('INSERT OR IGNORE INTO characters (user_id, created_at) VALUES (?, ?)')
    .bind(user.id, Date.now())
    .run();
  return c.json({ id: user.id, username: user.username, nickname: user.nickname, emailVerified: user.emailVerified });
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

// TODO(inventory): 장착 장비와 인벤토리를 DB에서 읽는다. (지금은 기본 장비로 고정)
app.post('/api/battle', async (c) => {
  const { mobId } = await c.req.json<{ mobId?: string }>();
  const mob = mobId ? mobById(mobId) : undefined;
  if (!mob) return c.json({ error: 'unknown mob' }, 404);

  const sword = itemById('rusted_sword');
  const armor = itemById('rusted_armor');
  const maxHp = BASE_STATS.maxHp + (armor?.hp ?? 0);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;

  const state = createBattle(
    [
      {
        id: PLAYER_ID, name: '모험가', side: 'player', hp: maxHp, guardedLastRound: false,
        stats: { maxHp, atk: BASE_STATS.atk + (sword?.atk ?? 0), def: BASE_STATS.def, spd: BASE_STATS.spd },
      },
      {
        id: ENEMY_ID, name: mob.name, side: 'enemy', hp: mob.hp, guardedLastRound: false,
        stats: { maxHp: mob.hp, atk: mob.atk, def: mob.def, spd: mob.spd },
      },
    ],
    seed,
  );

  const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO battles (id, user_id, mob_id, state, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, c.get('user').id, mob.id, JSON.stringify(state), Date.now())
    .run();
  return c.json({ id, state });
});

app.post('/api/battle/:id/round', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ action?: 'attack' | 'guard' | 'item'; itemId?: string }>();

  const row = await c.env.DB.prepare('SELECT state FROM battles WHERE id = ? AND user_id = ?')
    .bind(id, c.get('user').id)
    .first<{ state: string }>();
  // 남의 전투는 존재 여부도 알려주지 않는다
  if (!row) return c.json({ error: 'battle not found' }, 404);
  const state = JSON.parse(row.state) as BattleState;
  if (state.status !== 'ongoing') return c.json({ state, log: [] });

  let playerAction: Action;
  if (body.action === 'attack') {
    playerAction = { kind: 'attack', targetId: ENEMY_ID };
  } else if (body.action === 'guard') {
    playerAction = { kind: 'guard' };
  } else if (body.action === 'item') {
    const item = body.itemId ? itemById(body.itemId) : undefined;
    // TODO(inventory): 보유 수량 확인 및 차감
    if (!item || item.type !== 'consumable' || item.heal <= 0) return c.json({ error: 'invalid item' }, 400);
    playerAction = { kind: 'item', itemId: item.id, healHp: item.heal };
  } else {
    return c.json({ error: 'invalid action' }, 400);
  }

  const enemy = state.combatants.find((x) => x.id === ENEMY_ID)!;
  const enemyAction = chooseEnemyAction(state, enemy);
  const result = resolveRound(state, { [PLAYER_ID]: playerAction, [ENEMY_ID]: enemyAction });

  await c.env.DB.prepare('UPDATE battles SET state = ? WHERE id = ?').bind(JSON.stringify(result.state), id).run();
  return c.json(result);
});

// 인증을 통과한 나머지 요청은 빌드된 React 클라이언트(정적 에셋)로 넘긴다.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
