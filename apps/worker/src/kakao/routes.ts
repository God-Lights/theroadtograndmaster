import { Hono } from 'hono';
import { getProfTier, itemById } from '@rtgm/data';
import type { AppEnv } from '../auth';
import { kakaoKey } from './link';
import { ackOutbox, claimOutbox } from './outbox';
import { clearSession, getSession, setSession, sweepSessions } from './session';
import { bar, chunkText, numbered, won } from './text';

/**
 * 카카오톡 봇 서버 쪽. 폰(메신저봇R)의 스크립트는 받은 메시지를 /api/kakao/message 로 보내고,
 * 돌아온 문장을 그대로 방에 보내기만 한다. 명령어 해석·화면·게임 규칙은 모두 여기서 처리해서 스크립트를 고칠 일이 없게 한다.
 *   POST /api/kakao/message  { room, group, name, hash, text, ver, ts? } → { v, replies: string[] }
 *   POST /api/kakao/outbox   { ack?: number[], max? }                    → { v, items: {id, room, text}[] }
 */
export const MIN_CLIENT = 1;
export const PREFIX = '!';
const RATE_MS = 1500;

interface In { room: string; group: boolean; name: string; hash: string; text: string; ver: number; ts?: number }
type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;
interface Ctx { c: { env: AppEnv['Bindings'] }; msg: In; key: string; isPublic: boolean; call: Call }
/** 서버 안에서 게임 API 를 부르는 함수 (index.ts 가 app.request 를 넘겨 준다) */
export type AppRequest = (path: string, init: RequestInit, env: AppEnv['Bindings']) => Response | Promise<Response>;

const clean = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

function parseIn(raw: unknown): In | null {
  const b = raw as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return null;
  const room = clean(b.room, 100), name = clean(b.name, 60), hash = clean(b.hash, 200), text = typeof b.text === 'string' ? b.text.slice(0, 500) : null;
  if (!room || !name || !hash || text === null) return null;
  return { room, group: b.group === true, name, hash, text, ver: Number(b.ver) || 0, ts: typeof b.ts === 'number' ? b.ts : undefined };
}

// ─── 화면 ────────────────────────────────────────────────────────────────────

const HELP_TOPICS = ['처음 시작하기 (연동)', '명령어 목록', '방 이용 규칙'];
const helpHome = (): string =>
  `⚔ RTGM — 길을 걸어 그랜드마스터로\n명령어는 ${PREFIX}로 시작해요.\n\n${numbered(HELP_TOPICS)}\n\n보고 싶은 번호를 보내 주세요. (3분 안에)`;
const HELP_DETAIL: string[] = [
  `[처음 시작하기]\n1. 웹(rtgm.officialgl.com)의 내 정보 → 연동 코드 만들기\n2. 봇과의 1:1 대화에서 ${PREFIX}연동 코드\n\n연동은 한 계정에 하나만 돼요. 프로필 사진이나 카톡 이름을 바꾸면 다시 연동해야 해요.`,
  `[명령어 목록]\n${PREFIX}도움말\n${PREFIX}연동 코드 / ${PREFIX}연동해제\n${PREFIX}내정보\n${PREFIX}소식 (최근 전체 알림)\n\n게임 명령어는 앞으로 계속 추가돼요.`,
  `[방 이용 규칙]\n개인 행동(내 정보·전투·상점 등)은 봇과 1:1 대화에서만 받아요. 단체방에는 공개 결과와 알림만 나와요.\n너무 빠르게 보내면 일부 메시지는 무시돼요.`,
];

const NOT_LINKED = `🔗 먼저 계정을 연동해 주세요.\n웹의 내 정보에서 연동 코드를 만들고, 이 대화에서 ${PREFIX}연동 코드 를 보내세요.`;
const DM_ONLY = '🔒 이 명령은 봇과의 1:1 대화에서만 쓸 수 있어요.';

// ─── 명령어 ──────────────────────────────────────────────────────────────────

type Handler = (x: Ctx, args: string[]) => Promise<string[]>;
const COMMANDS: { names: string[]; where: 'any' | 'dm' | 'dm_or_public'; run: Handler }[] = [
  {
    names: ['도움말', '도움', 'help', '명령어'], where: 'any',
    run: async (x) => {
      if (x.msg.group) return [helpHome().split('\n\n')[0]! + `\n\n자세한 안내는 봇과 1:1 대화에서 ${PREFIX}도움말 을 보내 주세요.`];
      await setSession(x.c.env.DB, x.msg.room, x.msg.hash, { menu: 'help' });
      return [helpHome()];
    },
  },
  {
    names: ['연동'], where: 'dm',
    run: async (x, args) => {
      const code = (args[0] ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9]{8}$/.test(code)) return [`연동 코드는 8자리예요.\n예) ${PREFIX}연동 ABCD2345`];
      const now = Date.now();
      const db = x.c.env.DB;
      const row = await db.prepare('DELETE FROM discord_link_codes WHERE code = ? AND expires_at > ? RETURNING user_id').bind(code, now).first<{ user_id: string }>();
      if (!row) return ['❌ 코드가 틀렸거나 만료됐어요. 웹에서 새 코드를 만들어 주세요.'];
      await db.batch([
        db.prepare('DELETE FROM kakao_links WHERE user_id = ? OR kakao_key = ?').bind(row.user_id, x.key),
        db.prepare('INSERT INTO kakao_links (kakao_key, user_id, name, linked_at) VALUES (?, ?, ?, ?)').bind(x.key, row.user_id, x.msg.name, now),
      ]);
      const prof = await db.prepare('SELECT nickname FROM profiles WHERE user_id = ?').bind(row.user_id).first<{ nickname: string }>();
      return [`✅ 연동 완료! ${prof?.nickname ?? '모험가'}님, 환영해요.\n${PREFIX}내정보 로 내 상태를 볼 수 있어요.`];
    },
  },
  {
    names: ['연동해제'], where: 'dm',
    run: async (x) => {
      const res = await x.c.env.DB.prepare('DELETE FROM kakao_links WHERE kakao_key = ?').bind(x.key).run();
      return [res.meta.changes ? '연동을 해제했어요.' : '연동된 계정이 없어요.'];
    },
  },
  {
    names: ['내정보', '정보', '프로필'], where: 'dm',
    run: async (x) => {
      const me = await x.call('GET', '/api/me');
      const inv = await x.call('GET', '/api/inventory');
      if (me.status === 403) return [NOT_LINKED];
      if (me.status !== 200 || inv.status !== 200) return ['잠시 후 다시 시도해 주세요.'];
      const tier = getProfTier(inv.json.proficiency);
      const s = inv.json.stats;
      const gear = (inv.json.items as { itemId: string; equipped: boolean }[]).filter((i) => i.equipped).map((i) => itemById(i.itemId)?.name ?? i.itemId);
      return [[
        `📋 ${me.json.nickname}`,
        `🏅 ${tier.name} · 숙련도 ${inv.json.proficiency}`,
        `💰 ${won(inv.json.gold)}`,
        `HP ${s.maxHp} · 공격 ${s.atk} · 방어 ${s.def} · 속도 ${s.spd}`,
        `장비: ${gear.length ? gear.join(', ') : '없음'}`,
        `체력 ${bar(100)}`,
      ].join('\n')];
    },
  },
  {
    names: ['소식', '공지', '알림'], where: 'dm_or_public',
    run: async (x) => {
      const r = await x.call('GET', '/api/announcements');
      const list = (r.json?.announcements ?? []) as { text: string }[];
      if (r.status !== 200 || list.length === 0) return ['아직 전해진 소식이 없어요.'];
      return [`📢 최근 소식\n${list.slice(-5).map((a) => `• ${a.text}`).join('\n')}`];
    },
  },
];
const byName = new Map(COMMANDS.flatMap((cmd) => cmd.names.map((n) => [n, cmd] as const)));

/** 메뉴에 대한 번호 답 */
async function menuReply(x: Ctx, choice: string): Promise<string[] | null> {
  const s = await getSession(x.c.env.DB, x.msg.room, x.msg.hash);
  if (!s) return null;
  if (choice === '취소') { await clearSession(x.c.env.DB, x.msg.room, x.msg.hash); return ['닫았어요.']; }
  if (s.menu === 'help') {
    const n = Number(choice);
    if (!Number.isInteger(n) || n < 1 || n > HELP_DETAIL.length) return [`1~${HELP_DETAIL.length} 중에서 골라 주세요.`];
    await setSession(x.c.env.DB, x.msg.room, x.msg.hash, { menu: 'help' }); // 다시 고를 수 있게 유지
    return [HELP_DETAIL[n - 1]!];
  }
  return null;
}

// ─── 중복·속도 제한 ──────────────────────────────────────────────────────────

/** 같은 메시지가 두 번 오면(폰 재시도 등) 한 번만 처리한다. 처음이면 true */
async function firstTime(db: D1Database, m: In): Promise<boolean> {
  const id = m.ts ?? `${Math.floor(Date.now() / 3000)}:${m.text}`;
  const res = await db.prepare('INSERT OR IGNORE INTO bot_state (key, value) VALUES (?, ?)').bind(`kkd:${m.room}|${m.hash}|${id}`, String(Date.now())).run();
  return res.meta.changes === 1;
}
/** 사용자당 RATE_MS 안에 또 보내면 거절 */
async function withinRate(db: D1Database, hash: string): Promise<boolean> {
  const now = Date.now();
  const res = await db
    .prepare('INSERT INTO bot_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(bot_state.value AS INTEGER) < ?')
    .bind(`kkrl:${hash}`, String(now), now - RATE_MS)
    .run();
  return res.meta.changes === 1;
}
async function housekeeping(db: D1Database): Promise<void> {
  if (Math.random() > 0.05) return;
  const old = String(Date.now() - 600_000);
  await db.batch([
    db.prepare("DELETE FROM bot_state WHERE key LIKE 'kkd:%' AND CAST(value AS INTEGER) < ?").bind(old),
    db.prepare("DELETE FROM bot_state WHERE key LIKE 'kkrl:%' AND CAST(value AS INTEGER) < ?").bind(old),
  ]);
  await sweepSessions(db);
}

// ─── 라우트 ──────────────────────────────────────────────────────────────────

export function kakaoRoutes(appRequest: AppRequest): Hono<AppEnv> {
  const k = new Hono<AppEnv>();

  k.post('/kakao/message', async (c) => {
    const msg = parseIn(await c.req.json().catch(() => null));
    if (!msg) return c.json({ error: 'invalid_request' }, 400);
    const reply = (replies: string[]) => c.json({ v: MIN_CLIENT, replies: replies.flatMap((t) => chunkText(t)).slice(0, 6) });
    const db = c.env.DB;
    const isCommand = msg.text.startsWith(PREFIX);
    const isChoice = /^(\d{1,2}|취소)$/.test(msg.text.trim());
    if (!isCommand && !isChoice) return reply([]); // 일반 대화는 건드리지 않는다
    if (msg.ver < MIN_CLIENT) return reply(['⚠️ 봇 스크립트가 오래돼서 이용할 수 없어요. 운영자에게 업데이트를 요청해 주세요.']);

    const publicRoom = c.env.KAKAO_PUBLIC_ROOM ?? '';
    const isPublic = msg.group && publicRoom !== '' && msg.room === publicRoom;
    if (!isCommand && msg.group && !isPublic) return reply([]); // 남의 방에서 숫자만 보낸 말은 무시
    if (!(await firstTime(db, msg))) return reply([]);
    if (!(await withinRate(db, msg.hash))) return reply([]);
    void housekeeping(db).catch(() => undefined);

    const key = kakaoKey(msg.hash, msg.name);
    const env = { ...c.env, KAKAO_INTERNAL: true };
    const call: Call = async (method, path, body) => {
      const res = await appRequest(path, {
        method,
        headers: { 'X-Kakao-User': encodeURIComponent(key), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }, env);
      return { status: res.status, json: await res.json().catch(() => ({})) };
    };
    const x: Ctx = { c, msg, key, isPublic, call };

    if (isChoice && !isCommand) { const r = await menuReply(x, msg.text.trim()); return reply(r ?? []); }

    const [name, ...args] = msg.text.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = byName.get(name ?? '');
    if (!cmd) return reply(msg.group ? [] : [`모르는 명령어예요. ${PREFIX}도움말 을 보내 보세요.`]); // 단체방에서는 다른 봇의 명령일 수 있어 조용히 넘어간다
    if (cmd.where === 'dm' && msg.group) return reply([DM_ONLY]);
    if (cmd.where === 'dm_or_public' && msg.group && !isPublic) return reply([DM_ONLY]);
    return reply(await cmd.run(x, args));
  });

  k.post('/kakao/outbox', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ack?: unknown; max?: unknown; ver?: unknown };
    if (Array.isArray(body.ack)) await ackOutbox(c.env.DB, body.ack.map(Number));
    const items = Number(body.ver) >= MIN_CLIENT ? await claimOutbox(c.env.DB, Number(body.max) || 10) : [];
    return c.json({ v: MIN_CLIENT, items });
  });

  return k;
}
