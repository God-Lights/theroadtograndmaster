import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './index';
import { clearAuthCache } from './auth';
import { createTestDb } from './test-db';
import { relayKakaoAnnouncements } from './kakao/relay';
import { chunkText, bar } from './kakao/text';
import { itemById } from '@rtgm/data';
import { claimOutbox, enqueueKakao, LEASE_MS } from './kakao/outbox';

const mk = (c: string, n: string) => ({ id: `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`, email: `${n}@x.com`, username: n, nickname: n, emailVerified: true });
const A = mk('a', '에이'), B = mk('b', '비이');
const USERS: Record<string, ReturnType<typeof mk>> = { tokA: A, tokB: B };
const KEY = 'kakao-key';
const URL = 'https://rtgm.officialgl.com';
let env: Record<string, any>;
let sqlite: ReturnType<typeof createTestDb>['sqlite'];
let seq = 0;

beforeEach(() => {
  clearAuthCache();
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
    const user = USERS[JSON.parse(init.body).token as string];
    return user ? new Response(JSON.stringify({ user }), { status: 200 }) : new Response('{}', { status: 401 });
  }));
  const t = createTestDb(); sqlite = t.sqlite;
  env = { GL_ACCOUNT_KEY: 'k', KAKAO_BOT_KEY: KEY, KAKAO_PUBLIC_ROOM: '모험가 광장', DB: t.db, ASSETS: { fetch: vi.fn() } };
});
afterEach(() => vi.unstubAllGlobals());

const post = (path: string, body: unknown, key: string | null = KEY, e = env) =>
  app.request(`${URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) }, e);
/** 카톡 메시지 한 통. 속도 제한은 매번 풀어 준다(테스트가 빠르게 연달아 보내므로) */
async function say(text: string, o: { room?: string; group?: boolean; name?: string; hash?: string; ts?: number; ver?: number } = {}) {
  sqlite.prepare("DELETE FROM bot_state WHERE key LIKE 'kkrl:%'").run();
  const res = await post('/api/kakao/message', { room: o.room ?? '봇', group: o.group ?? false, name: o.name ?? '에이', hash: o.hash ?? 'h-a', text, ver: o.ver ?? 1, ts: o.ts ?? ++seq });
  return { status: res.status, json: (await res.json()) as any };
}
const web = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await app.request(`${URL}${path}`, { method, headers: { Cookie: `gl_session=${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, env);
  return { status: res.status, json: (await res.json()) as any };
};
async function link(token = 'tokA', o: { name?: string; hash?: string } = {}) {
  const { json } = await web(token, 'POST', '/api/discord/link-code', {});
  return say(`!연동 ${json.code}`, o);
}

describe('카톡: 인증', () => {
  it('키가 없거나 틀리면 거절, 서버에 키가 없으면 꺼진 상태', async () => {
    expect((await post('/api/kakao/message', { room: 'r', name: 'n', hash: 'h', text: '!도움말' }, null)).status).toBe(401);
    expect((await post('/api/kakao/message', { room: 'r', name: 'n', hash: 'h', text: '!도움말' }, 'wrong')).status).toBe(401);
    expect((await post('/api/kakao/outbox', {}, 'wrong')).status).toBe(401);
    expect((await post('/api/kakao/message', { room: 'r', name: 'n', hash: 'h', text: '!도움말' }, KEY, { ...env, KAKAO_BOT_KEY: undefined })).status).toBe(503);
  });
  it('카톡 키로는 게임 API·관리자 API를 직접 부를 수 없다 (/api/kakao/* 만)', async () => {
    for (const p of ['/api/inventory', '/api/me', '/api/admin/events', '/']) {
      const res = await app.request(`${URL}${p}`, { headers: { Authorization: `Bearer ${KEY}`, 'X-Kakao-User': 'h-a|ei' } }, env);
      expect(res.status, p).not.toBe(200);
    }
  });
  it('잘못된 본문은 400', async () => {
    expect((await post('/api/kakao/message', { room: '', name: 'n', hash: 'h', text: '!a' })).status).toBe(400);
    expect((await post('/api/kakao/message', 'x')).status).toBe(400);
  });
});

describe('카톡: 메시지 처리', () => {
  it('일반 대화와 명령이 아닌 숫자는 무시한다', async () => {
    expect((await say('안녕하세요')).json.replies).toEqual([]);
    expect((await say('3')).json.replies).toEqual([]); // 열린 메뉴가 없다
  });
  it('모르는 명령은 1:1 에서만 안내하고 단체방에서는 조용하다 (다른 봇의 ! 명령일 수 있다)', async () => {
    expect((await say('!zzz')).json.replies[0]).toContain('모르는 명령어');
    expect((await say('!zzz', { group: true, room: '아무방' })).json.replies).toEqual([]);
  });
  it('같은 메시지가 두 번 오면 한 번만 처리한다', async () => {
    const a = await say('!도움말', { ts: 9001 });
    const b = await say('!도움말', { ts: 9001 });
    expect(a.json.replies.length).toBeGreaterThan(0);
    expect(b.json.replies).toEqual([]);
  });
  it('너무 빠르게 연달아 보내면 무시한다', async () => {
    const send = async (ts: number) => (await (await post('/api/kakao/message', { room: '봇', group: false, name: '에이', hash: 'h-a', text: '!도움말', ver: 1, ts })).json()) as any;
    sqlite.prepare("DELETE FROM bot_state WHERE key LIKE 'kkrl:%'").run();
    expect((await send(1)).replies.length).toBeGreaterThan(0);
    expect((await send(2)).replies).toEqual([]);
  });
  it('오래된 스크립트 버전은 업데이트 안내', async () => {
    expect((await say('!도움말', { ver: 0 })).json.replies[0]).toContain('업데이트');
  });
  it('도움말은 1:1 에서 번호 메뉴, 숫자로 고르면 안내가 나온다. 단체방은 짧게', async () => {
    const h = await say('!도움말');
    expect(h.json.replies[0]).toContain('1. 처음 시작하기');
    expect((await say('2')).json.replies[0]).toContain('명령어 목록');
    expect((await say('9')).json.replies[0]).toContain('골라 주세요');
    expect((await say('취소')).json.replies[0]).toBe('닫았어요.');
    expect((await say('2')).json.replies).toEqual([]);
    const g = await say('!도움말', { group: true, room: '아무방' });
    expect(g.json.replies[0]).toContain('1:1');
    expect(g.json.replies[0]).not.toContain('1. 처음');
  });
  it('메뉴 상태는 방·사용자별이고 시간이 지나면 사라진다', async () => {
    await say('!도움말');
    expect((await say('1', { hash: 'h-other', name: '남' })).json.replies).toEqual([]);
    sqlite.prepare('UPDATE kakao_sessions SET expires_at = 1').run();
    expect((await say('1')).json.replies).toEqual([]);
  });
});

describe('카톡: 연동', () => {
  it('연동 안 된 사용자는 안내를 받고, 단체방에서는 연동·내정보를 쓸 수 없다', async () => {
    expect((await say('!내정보')).json.replies[0]).toContain('연동');
    expect((await say('!연동 ABCD2345', { group: true, room: '아무방' })).json.replies[0]).toContain('1:1');
    expect((await say('!내정보', { group: true, room: '모험가 광장' })).json.replies[0]).toContain('1:1');
  });
  it('웹 코드로 연동 → 내정보 → 해제, 코드는 한 번만 쓸 수 있다', async () => {
    await web('tokA', 'GET', '/api/me');
    const { json } = await web('tokA', 'POST', '/api/discord/link-code', {});
    const ok = await say(`!연동 ${json.code}`);
    expect(ok.json.replies[0]).toContain('연동 완료');
    expect((await say(`!연동 ${json.code}`, { hash: 'h-b', name: '비' })).json.replies[0]).toContain('틀렸거나');
    const me = (await say('!내정보')).json.replies.join('\n');
    expect(me).toContain('에이');
    expect(me).toContain('숙련도');
    expect(me).toContain(itemById('rusted_sword')!.name);
    expect((await web('tokA', 'GET', '/api/discord/status')).json).toMatchObject({ kakaoLinked: true, kakaoEnabled: true });
    expect((await say('!연동해제')).json.replies[0]).toContain('해제');
    expect((await say('!내정보')).json.replies[0]).toContain('연동');
  });
  it('이름이나 프로필 해시가 다르면 다른 사람으로 본다 (같은 사진, 다른 이름 포함)', async () => {
    await web('tokA', 'GET', '/api/me');
    await link('tokA', { hash: 'h-a', name: '에이' });
    expect((await say('!내정보', { hash: 'h-a', name: '다른이름' })).json.replies[0]).toContain('연동');
    expect((await say('!내정보', { hash: 'h-x', name: '에이' })).json.replies[0]).toContain('연동');
  });
  it('계정 하나에는 카톡 하나: 새로 연동하면 이전 연동은 풀린다', async () => {
    await web('tokA', 'GET', '/api/me');
    await link('tokA', { hash: 'h-1', name: '에이' });
    await link('tokA', { hash: 'h-2', name: '에이2' });
    expect((await say('!내정보', { hash: 'h-1', name: '에이' })).json.replies[0]).toContain('연동');
    expect((await say('!내정보', { hash: 'h-2', name: '에이2' })).json.replies.join('')).toContain('숙련도');
  });
  it('연동 코드 형식이 틀리면 안내, 웹에서 카톡 연동 해제', async () => {
    expect((await say('!연동 12')).json.replies[0]).toContain('8자리');
    await web('tokA', 'GET', '/api/me');
    await link();
    expect((await web('tokA', 'POST', '/api/discord/kakao-unlink', {})).status).toBe(200);
    expect((await say('!내정보')).json.replies[0]).toContain('연동');
  });
});

describe('카톡: 소식·알림 전달', () => {
  it('소식은 1:1 과 공개 방에서 보이고 다른 단체방에서는 안내', async () => {
    sqlite.prepare("INSERT INTO announcements (kind, text, created_at) VALUES ('boss', '👑 누가 리치를 쓰러뜨렸다!', 1)").run();
    expect((await say('!소식')).json.replies[0]).toContain('리치');
    expect((await say('!소식', { group: true, room: '모험가 광장' })).json.replies[0]).toContain('리치');
    expect((await say('!소식', { group: true, room: '아무방' })).json.replies[0]).toContain('1:1');
  });
  it('알림 큐: 가져가면 대여, ack 하면 끝, ack 가 없으면 다시 나온다', async () => {
    await enqueueKakao(env.DB, '모험가 광장', '첫 번째');
    await enqueueKakao(env.DB, '모험가 광장', '두 번째');
    const first = ((await (await post('/api/kakao/outbox', { ver: 1 })).json()) as any).items;
    expect(first.map((i: any) => i.text)).toEqual(['첫 번째', '두 번째']);
    expect(((await (await post('/api/kakao/outbox', { ver: 1 })).json()) as any).items).toEqual([]); // 대여 중
    const res2 = (await (await post('/api/kakao/outbox', { ver: 1, ack: [first[0].id] })).json()) as any;
    expect(res2.items).toEqual([]);
    sqlite.prepare('UPDATE kakao_outbox SET lease_until = 0').run(); // 대여 시간이 지났다
    const again = ((await (await post('/api/kakao/outbox', { ver: 1 })).json()) as any).items;
    expect(again.map((i: any) => i.text)).toEqual(['두 번째']); // ack 한 것은 다시 안 나온다
    expect(LEASE_MS).toBeGreaterThan(0);
  });
  it('여러 번 실패하거나 너무 오래된 알림은 버린다', async () => {
    await enqueueKakao(env.DB, 'r', '오래된');
    sqlite.prepare('UPDATE kakao_outbox SET created_at = 1').run();
    expect(await claimOutbox(env.DB)).toEqual([]);
    await enqueueKakao(env.DB, 'r', '실패만');
    for (let i = 0; i < 5; i++) { sqlite.prepare('UPDATE kakao_outbox SET lease_until = 0').run(); await claimOutbox(env.DB); }
    expect(await claimOutbox(env.DB)).toEqual([]);
  });
  it('전체 알림 중계: 처음엔 쏟아내지 않고, 새 알림만 공개 방 큐에 넣는다', async () => {
    sqlite.prepare("INSERT INTO announcements (kind, text, created_at) VALUES ('boss', '옛날 알림', 1)").run();
    expect(await relayKakaoAnnouncements(env as any)).toBe(0);
    expect(await relayKakaoAnnouncements(env as any)).toBe(0);
    sqlite.prepare("INSERT INTO announcements (kind, text, created_at) VALUES ('raid', '새 알림', 2)").run();
    expect(await relayKakaoAnnouncements(env as any)).toBe(1);
    expect(await relayKakaoAnnouncements(env as any)).toBe(0);
    const items = await claimOutbox(env.DB);
    expect(items).toMatchObject([{ room: '모험가 광장', text: '📢 새 알림' }]);
    expect(await relayKakaoAnnouncements({ ...env, KAKAO_PUBLIC_ROOM: '' } as any)).toBe(0); // 방이 없으면 꺼짐
  });
});

describe('카톡: 글 도우미', () => {
  it('긴 글은 줄 단위로 나누고, 너무 긴 한 줄은 자른다', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `줄 ${i} ${'가'.repeat(20)}`).join('\n');
    const chunks = chunkText(lines, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join('\n')).toBe(lines);
    expect(chunkText('a'.repeat(250), 100).map((c) => c.length)).toEqual([100, 100, 50]);
    expect(chunkText('')).toEqual(['']);
  });
  it('막대', () => {
    expect(bar(50)).toBe('■■■■■□□□□□ 50%');
    expect(bar(0)).toBe('□□□□□□□□□□ 0%');
    expect(bar(150)).toContain('100%');
  });
});
