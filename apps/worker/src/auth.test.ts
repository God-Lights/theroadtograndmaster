import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './index';
import { clearAuthCache } from './auth';
import { createTestDb } from './test-db';

const KEY = 'test-service-key-should-never-leak';
const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'a@example.com',
  username: 'adventurer',
  nickname: '모험가닉',
  emailVerified: true,
};

function makeEnv() {
  return {
    GL_ACCOUNT_KEY: KEY,
    DB: createTestDb().db,
    ASSETS: { fetch: vi.fn().mockResolvedValue(new Response('<html>client</html>')) },
  };
}

const withCookie = (token: string) => ({ headers: { Cookie: `gl_session=${token}` } });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearAuthCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('GL Account 로그인 연동', () => {
  it('비로그인 페이지 요청은 로그인 화면으로 리다이렉트하고 return 주소를 인코딩해 붙인다', async () => {
    const res = await app.request('https://rtgm.officialgl.com/dungeon?x=1', {}, makeEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(
      `https://account.officialgl.com/?return=${encodeURIComponent('https://rtgm.officialgl.com/dungeon?x=1')}`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('비로그인 API 요청은 401 JSON', async () => {
    const res = await app.request('https://rtgm.officialgl.com/api/me', {}, makeEnv());
    expect(res.status).toBe(401);
  });

  it('쿠키를 서버에서 verify-session 으로 검증한다 (Bearer 키 + 본문 token)', async () => {
    fetchMock.mockResolvedValue(ok({ user: USER }));
    const res = await app.request('https://rtgm.officialgl.com/api/me', withCookie('tok-1'), makeEnv());
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://account.officialgl.com/api/internal/verify-session');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body)).toEqual({ token: 'tok-1' });
  });

  it('/api/me 는 닉네임을 돌려주고 이메일과 서비스 키는 노출하지 않는다', async () => {
    fetchMock.mockResolvedValue(ok({ user: USER }));
    const res = await app.request('https://rtgm.officialgl.com/api/me', withCookie('tok-2'), makeEnv());
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ id: USER.id, username: USER.username, nickname: USER.nickname, emailVerified: true });
    expect(text).not.toContain(USER.email);
    expect(text).not.toContain(KEY);
  });

  it('401 이면 비로그인 처리 (페이지는 로그인으로 이동)', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    const res = await app.request('https://rtgm.officialgl.com/', withCookie('expired'), makeEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('https://account.officialgl.com/?return=');
  });

  it('GL Account 장애(5xx/네트워크)는 로그인 반복 없이 503', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    expect((await app.request('https://rtgm.officialgl.com/', withCookie('t3'), makeEnv())).status).toBe(503);
    fetchMock.mockRejectedValue(new Error('network'));
    expect((await app.request('https://rtgm.officialgl.com/', withCookie('t4'), makeEnv())).status).toBe(503);
  });

  it('검증 결과 캐시는 짧게만 유지된다 (같은 토큰 2회 → 호출 1회, 30초 뒤 재검증)', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(async () => ok({ user: USER }));
      const env = makeEnv();
      await app.request('https://rtgm.officialgl.com/api/me', withCookie('cache-me'), env);
      await app.request('https://rtgm.officialgl.com/api/me', withCookie('cache-me'), env);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(31_000);
      await app.request('https://rtgm.officialgl.com/api/me', withCookie('cache-me'), env);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('/api/health 는 로그인 없이 열려 있다', async () => {
    const res = await app.request('https://rtgm.officialgl.com/api/health', {}, makeEnv());
    expect(res.status).toBe(200);
  });

  it('서비스 키가 설정되지 않으면 500 (키 값은 노출하지 않음)', async () => {
    const env = { ...makeEnv(), GL_ACCOUNT_KEY: undefined };
    const res = await app.request('https://rtgm.officialgl.com/api/me', withCookie('x'), env);
    expect(res.status).toBe(500);
  });

  it('로그인한 페이지 요청은 정적 클라이언트로 넘어간다', async () => {
    fetchMock.mockResolvedValue(ok({ user: USER }));
    const env = makeEnv();
    const res = await app.request('https://rtgm.officialgl.com/', withCookie('t5'), env);
    expect(await res.text()).toContain('client');
    expect(env.ASSETS.fetch).toHaveBeenCalled();
  });

  it('존재하지 않거나 남의 전투는 404', async () => {
    fetchMock.mockResolvedValue(ok({ user: USER }));
    const res = await app.request(
      'https://rtgm.officialgl.com/api/battle/abc/round',
      { method: 'POST', headers: { Cookie: 'gl_session=t6', 'Content-Type': 'application/json' }, body: '{"action":"attack"}' },
      makeEnv(),
    );
    expect(res.status).toBe(404);
  });

  it('닉네임 조회는 /api/internal/users/:id 를 쓰고 이메일 없이 id·닉네임만 돌려준다', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('verify-session')
        ? ok({ user: USER })
        : ok({ user: { id: other, username: 'other', nickname: '다른사람' } }),
    );
    const res = await app.request(`https://rtgm.officialgl.com/api/users/${other}`, withCookie('t7'), makeEnv());
    expect(await res.json()).toEqual({ id: other, nickname: '다른사람' });
    const lookup = fetchMock.mock.calls.find((c) => String(c[0]).includes('/users/'))!;
    expect(lookup[0]).toBe(`https://account.officialgl.com/api/internal/users/${other}`);
    expect(lookup[1].headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('잘못된 사용자 id 는 GL Account 로 보내지 않고 400', async () => {
    fetchMock.mockResolvedValue(ok({ user: USER }));
    const res = await app.request('https://rtgm.officialgl.com/api/users/..%2Fadmin', withCookie('t8'), makeEnv());
    expect(res.status).toBe(400);
    expect(fetchMock.mock.calls.every((c) => String(c[0]).includes('verify-session'))).toBe(true);
  });
});
