import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './index';
import { clearAuthCache } from './auth';
import { createTestDb } from './test-db';
import { verifyDiscordSignature } from './bot/verify';
import { relayAnnouncements } from './bot/relay';
import { barsUrl, clip, hpText, pct } from './bot/ui';
import commands from './bot/commands.json';
import { DUNGEONS, MOBS } from '@rtgm/data';

const mk = (c: string, n: string) => ({ id: `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`, email: `${n}@x.com`, username: n, nickname: n, emailVerified: true });
const A = mk('a', '에이'), B = mk('b', '비이');
const USERS: Record<string, ReturnType<typeof mk>> = { tokA: A, tokB: B };
const KEY = 'bot-key', DA = '123456789012345678', DB_ID = '223456789012345678';
let env: Record<string, any>;
let sqlite: ReturnType<typeof createTestDb>['sqlite'];
let priv: CryptoKey;
/** 디스코드로 나간 전체 공개 메시지 (웹훅 후속 메시지) */
let hooks: { url: string; body: any }[] = [];
let pubHex: string;

const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
beforeEach(async () => {
  clearAuthCache();
  hooks = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string, init: { body: string }) => {
    if (String(u).includes('discord.com/api')) { hooks.push({ url: String(u), body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); }
    const user = USERS[JSON.parse(init.body).token as string];
    return user ? new Response(JSON.stringify({ user }), { status: 200 }) : new Response('{}', { status: 401 });
  }));
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' } as never, true, ['sign', 'verify'])) as CryptoKeyPair;
  priv = pair.privateKey;
  pubHex = toHex((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const t = createTestDb(); sqlite = t.sqlite;
  env = { GL_ACCOUNT_KEY: 'k', BOT_API_KEY: KEY, DISCORD_PUBLIC_KEY: pubHex, DB: t.db, ASSETS: { fetch: vi.fn() } };
});
afterEach(() => vi.unstubAllGlobals());

async function sign(body: string, ts = String(Math.floor(Date.now() / 1000))) {
  const sig = await crypto.subtle.sign({ name: 'Ed25519' } as never, priv, new TextEncoder().encode(ts + body));
  return { 'X-Signature-Ed25519': toHex(sig), 'X-Signature-Timestamp': ts };
}
async function interact(payload: object, userId = DA, opts: { badSig?: boolean; ts?: string } = {}) {
  const body = JSON.stringify({ application_id: 'app1', token: 'tok-abc', ...payload });
  const headers = { 'Content-Type': 'application/json', ...(await sign(body, opts.ts)) };
  if (opts.badSig) headers['X-Signature-Ed25519'] = '00'.repeat(64);
  const res = await app.request('https://rtgm.officialgl.com/discord/interactions', { method: 'POST', headers, body }, env);
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, userId };
}
const slash = (name: string, options: Record<string, unknown> = {}, userId = DA) =>
  interact({ type: 2, member: { user: { id: userId } }, data: { name, options: Object.entries(options).map(([k, v]) => ({ name: k, value: v })) } }, userId);
const press = (custom_id: string, values?: string[], userId = DA) =>
  interact({ type: 3, member: { user: { id: userId } }, data: { custom_id, values } }, userId);
const auto = (name: string, value: string, userId = DA) =>
  interact({ type: 4, user: { id: userId }, data: { name, options: [{ name: '아이템', value, focused: true }] } }, userId);
async function web(token: string, method: string, path: string, body?: unknown) {
  const res = await app.request(`https://rtgm.officialgl.com${path}`, { method, headers: { Cookie: `gl_session=${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, env);
  return { status: res.status, json: (await res.json()) as any };
}
async function linked(token = 'tokA', did = DA) {
  const { json } = await web(token, 'POST', '/api/discord/link-code');
  const r = await slash('연동', { 코드: json.code }, did);
  expect(r.json.data.embeds[0].title).toContain('연동 완료');
}
const embedText = (r: any) => JSON.stringify(r.json.data?.embeds ?? []);
const customIds = (r: any): string[] => (r.json.data.components ?? []).flatMap((row: any) => row.components.map((c: any) => c.custom_id));

async function linkedA() { await linked('tokA', DA); }

describe('서명 검증·기본 응답', () => {
  it('PING 에 응답하고, 서명이 틀리거나 오래된 요청은 거절한다', async () => {
    expect((await interact({ type: 1 })).json).toEqual({ type: 1 });
    expect((await interact({ type: 1 }, DA, { badSig: true })).status).toBe(401);
    expect((await interact({ type: 1 }, DA, { ts: String(Math.floor(Date.now() / 1000) - 3600) })).status).toBe(401);
    const res = await app.request('https://rtgm.officialgl.com/discord/interactions', { method: 'POST', body: '{"type":1}' }, env);
    expect(res.status).toBe(401); // 서명 헤더 없음
  });
  it('공개 키가 없으면 안내와 함께 503, 서비스 키만 없으면 PING 은 통과하고 명령은 설정 안내를 보여 준다', async () => {
    env.DISCORD_PUBLIC_KEY = undefined;
    const off = await interact({ type: 1 });
    expect(off.status).toBe(503);
    expect(off.json.reason).toContain('DISCORD_PUBLIC_KEY');
    env.DISCORD_PUBLIC_KEY = pubHex; env.BOT_API_KEY = undefined;
    expect((await interact({ type: 1 })).json).toEqual({ type: 1 }); // 디스코드의 URL 검증은 통과해야 한다
    const cmd = await slash('프로필');
    expect(cmd.json.data.content).toContain('BOT_API_KEY');
    expect((await interact({ type: 1 }, DA, { badSig: true })).status).toBe(401); // 서명 검증은 그대로
  });
  it('verifyDiscordSignature: 다른 키·잘못된 형식은 false', async () => {
    const body = '{"type":1}'; const h = await sign(body);
    expect(await verifyDiscordSignature(pubHex, h['X-Signature-Ed25519'], h['X-Signature-Timestamp'], body)).toBe(true);
    expect(await verifyDiscordSignature(pubHex, h['X-Signature-Ed25519'], h['X-Signature-Timestamp'], body + ' ')).toBe(false);
    expect(await verifyDiscordSignature('00'.repeat(32), h['X-Signature-Ed25519'], h['X-Signature-Timestamp'], body)).toBe(false);
    expect(await verifyDiscordSignature('zz', 'zz', '1', body)).toBe(false);
    expect(await verifyDiscordSignature(pubHex, h['X-Signature-Ed25519'], 'abc', body)).toBe(false);
  });
});

describe('연동과 프로필', () => {
  it('연동 전에는 안내를 보여 주고, 연동 후 프로필이 나온다 (내 화면만 보이게 ephemeral)', async () => {
    const before = await slash('프로필');
    expect(before.json.data.flags).toBe(64);
    expect(embedText(before)).toContain('계정 연동이 필요해요');
    await web('tokA', 'GET', '/api/me');
    await linked();
    const p = await slash('프로필');
    expect(embedText(p)).toContain('에이');
    expect(embedText(p)).toContain('500 D');
    expect(embedText(p)).toContain('지금 탐험할 수 있어요');
  });
  it('틀린 코드는 안내 문구로 거절한다', async () => {
    const r = await slash('연동', { 코드: 'ZZZZZZZZ' });
    expect(embedText(r)).toContain('코드가 틀렸거나 만료');
  });
  it('도움말과 모르는 명령어', async () => {
    expect(embedText(await slash('도움말'))).toContain('/탐험');
    expect((await slash('없는명령')).json.data.content).toContain('알 수 없는');
  });
});

describe('전투 (탐험·보스)', () => {
  beforeEach(async () => { await web('tokA', 'GET', '/api/me'); await web('tokB', 'GET', '/api/me'); await linked('tokA', DA); await linked('tokB', DB_ID); });

  it('탐험하면 몬스터가 나오고, 버튼으로 공격하면 메시지가 갱신된다', async () => {
    const r = await slash('탐험', { 지역: 'plains' });
    expect(r.json.data.flags).toBe(64);
    expect(r.json.data.embeds[0].title).toMatch(/⚔️/);
    expect(r.json.data.embeds[0].description).toContain('나타났다');
    const ids = customIds(r);
    const atk = ids.find((x) => x.includes(':atk:'))!;
    expect(atk).toMatch(/^bt:[0-9a-f-]{36}:atk:enemy$/);
    expect(ids.some((x) => x.endsWith(':grd'))).toBe(true);
    const next = await press(atk);
    expect(next.json.type).toBe(7); // 원래 메시지를 갱신
    expect(next.json.data.embeds[0].title).toContain('2라운드');
    expect(next.json.data.embeds[0].description).toContain('공격');
    // 방어
    const guard = await press(atk.replace(/:atk:enemy$/, ':grd'));
    expect(guard.json.data.embeds[0].title).toContain('3라운드');
  });
  it('스킬 선택 메뉴와 아이템 메뉴가 나오고 쓸 수 있다', async () => {
    sqlite.prepare("INSERT INTO inventory (user_id, item_id, quantity, equipped) VALUES (?, 'hp_potion', 2, 0)").run(A.id);
    const r = await slash('탐험', { 지역: 'plains' });
    const ids = customIds(r);
    const bs = ids.find((x) => x.startsWith('bs:'))!;
    const bi = ids.find((x) => x.startsWith('bi:'))!;
    expect(bs && bi).toBeTruthy();
    const skillOpts = r.json.data.components.find((c: any) => c.components[0].custom_id === bs).components[0].options;
    expect(skillOpts.map((o: any) => o.value)).toContain('strike');
    const used = await press(bs, ['strike']);
    expect(used.json.data.embeds[0].description).toContain('강타');
    const heal = await press(bi, ['hp_potion']);
    expect(heal.json.type).toBe(7);
    expect(sqlite.prepare("SELECT quantity FROM inventory WHERE user_id = ? AND item_id = 'hp_potion'").get(A.id)).toEqual({ quantity: 1 });
  });
  it('탐험 대기시간 안내와 남의 전투 버튼은 거절된다', async () => {
    const r = await slash('탐험', { 지역: 'plains' });
    expect(embedText(await slash('탐험', { 지역: 'plains' }))).toContain('탐험 대기시간');
    const atk = customIds(r).find((x) => x.includes(':atk:'))!;
    const other = await press(atk, undefined, DB_ID);
    expect(other.json.type).toBe(4); // 새 알림(ephemeral), 원래 메시지는 그대로
    expect(embedText(other)).toContain('내 전투가 아니');
  });
  it('전투가 끝나면 보상이 보이고 버튼이 사라진다', async () => {
    const r = await slash('탐험', { 지역: 'plains' });
    const id = customIds(r).find((x) => x.includes(':atk:'))!.split(':')[1]!;
    const st = JSON.parse((sqlite.prepare('SELECT state FROM battles WHERE id = ?').get(id) as any).state);
    st.combatants.find((c: any) => c.id === 'enemy').hp = 1;
    sqlite.prepare('UPDATE battles SET state = ? WHERE id = ?').run(JSON.stringify(st), id);
    let last: any;
    for (let n = 0; n < 8; n++) { last = await press(`bt:${id}:atk:enemy`); if (!last.json.data.components.length) break; }
    expect(last.json.data.components).toEqual([]);
    expect(last.json.data.embeds[0].footer.text).toBe('승리!');
    expect(JSON.stringify(last.json.data.embeds[0].fields)).toContain('보상');
  });
  it('보스 도전: 숙련도·열쇠가 부족하면 안내, 리치는 시작된다', async () => {
    expect(embedText(await slash('보스', { 보스: 'oppoko' }))).toMatch(/숙련도|열쇠/);
    const rich = await slash('보스', { 보스: 'rich' });
    expect(rich.json.data.embeds[0].title).toContain('리치');
    expect(JSON.stringify(rich.json.data.embeds[0].fields)).toContain('다음 행동'); // 보스 예고
  });
});

describe('던전·인벤토리·스킬·상점', () => {
  beforeEach(async () => { await web('tokA', 'GET', '/api/me'); await linked(); });

  it('던전 목록 → 입장 → 내려가기 → 후퇴 (전리품 정산)', async () => {
    const list = await slash('던전');
    expect(customIds(list)).toEqual(['rs']);
    const start = await press('rs', ['catacomb']);
    expect(start.json.type).toBe(7);
    expect(start.json.data.embeds[0].title).toContain('지하 묘지');
    expect(customIds(start)).toEqual(['rn', 'rr']);
    const adv = await press('rn');
    expect(adv.json.type).toBe(7);
    const retreat = adv.json.data.components.some((c: any) => c.components.some((x: any) => x.custom_id === 'rr'));
    if (retreat) {
      const done = await press('rr');
      expect(embedText(done)).toContain('결과');
    } else {
      expect(customIds(adv).some((x) => x.startsWith('bt:'))).toBe(true); // 몬스터 방: 전투 화면으로 (공격·방어 버튼)
      expect(adv.json.data.embeds[0].title).toContain('1라운드');
    }
  });
  it('인벤토리에서 장비를 해제/장착한다', async () => {
    const inv = await slash('인벤토리');
    expect(customIds(inv)).toContain('iu');
    const un = await press('iu', ['rusted_sword']);
    expect(un.json.type).toBe(7);
    expect(customIds(un)).toContain('ie');
    const eq = await press('ie', ['rusted_sword']);
    expect(embedText(eq)).toContain('[장착]');
  });
  it('스킬 장착/해제', async () => {
    const sk = await slash('스킬');
    expect(customIds(sk)).toEqual(expect.arrayContaining(['su']));
    const un = await press('su', ['strike']);
    expect(customIds(un)).toContain('se');
    expect(embedText(await press('se', ['strike']))).toContain('강타');
  });
  it('상점 보기·구매·판매와 자동 완성', async () => {
    expect(embedText(await slash('상점'))).toContain('빵');
    const buy = await slash('구매', { 아이템: 'bread', 수량: 3 });
    expect(embedText(buy)).toContain('구매 완료');
    expect(sqlite.prepare("SELECT quantity FROM inventory WHERE user_id = ? AND item_id = 'bread'").get(A.id)).toEqual({ quantity: 3 });
    expect(embedText(await slash('구매', { 아이템: 'bread', 수량: 99 }))).toContain('달런트가 부족');
    const choices = (await auto('구매', '빵')).json.data.choices;
    expect(choices.some((c: any) => c.value === 'bread')).toBe(true);
    expect((await auto('판매', '빵')).json.data.choices[0]).toMatchObject({ value: 'bread' });
    expect(embedText(await slash('판매', { 아이템: 'bread', 수량: 2 }))).toContain('판매 완료');
    expect((await auto('구매', '없는물건')).json.data.choices).toEqual([]);
  });
  it('제작: 재료가 부족하면 안내, 소식 목록', async () => {
    expect(embedText(await slash('제작', { 레시피: 'grilled_meat' }))).toMatch(/재료|숙련도/);
    sqlite.prepare("INSERT INTO announcements (kind, text, created_at) VALUES ('boss', '👑 에이님이 리치를 쓰러뜨렸다!', ?)").run(Date.now());
    expect(embedText(await slash('소식'))).toContain('리치를 쓰러뜨렸다');
  });
});

describe('전체 알림 중계', () => {
  const post = (ok = true) => vi.fn(async () => new Response('{}', { status: ok ? 200 : 500 }));
  it('설정이 없으면 아무것도 하지 않고, 처음에는 지난 알림을 올리지 않는다', async () => {
    const p = post();
    expect(await relayAnnouncements({ DB: env.DB }, p as never)).toBe(0);
    const cfg = { DB: env.DB, DISCORD_BOT_TOKEN: 'tkn', DISCORD_ANNOUNCE_CHANNEL_ID: '323456789012345678' };
    sqlite.prepare("INSERT INTO announcements (kind, text, created_at) VALUES ('boss', '옛날 소식', 1)").run();
    expect(await relayAnnouncements(cfg, p as never)).toBe(0);
    expect(p).not.toHaveBeenCalled();
    sqlite.prepare("INSERT INTO announcements (kind, text, created_at) VALUES ('boss', '새 소식', 2)").run();
    expect(await relayAnnouncements(cfg, p as never)).toBe(1);
    expect(p).toHaveBeenCalledTimes(1);
    const [url, init] = (p.mock.calls[0] as unknown) as [string, { headers: Record<string, string>; body: string }];
    expect(url).toContain('/channels/323456789012345678/messages');
    expect(init.headers.Authorization).toBe('Bot tkn');
    expect(JSON.parse(init.body)).toMatchObject({ content: '새 소식', allowed_mentions: { parse: [] } });
    expect(await relayAnnouncements(cfg, p as never)).toBe(0); // 이미 올림
  });
  it('전송에 실패하면 같은 알림을 다음에 다시 시도한다', async () => {
    const cfg = { DB: env.DB, DISCORD_BOT_TOKEN: 'tkn', DISCORD_ANNOUNCE_CHANNEL_ID: '323456789012345678' };
    await relayAnnouncements(cfg, post() as never); // 커서 초기화
    sqlite.prepare("INSERT INTO announcements (kind, text, created_at) VALUES ('raid', '레이드 클리어', 3)").run();
    expect(await relayAnnouncements(cfg, post(false) as never)).toBe(0);
    expect(await relayAnnouncements(cfg, post(true) as never)).toBe(1);
  });
});

describe('명령어 정의·화면 유틸', () => {
  it('명령어 정의가 게임 데이터와 맞는다 (지역·보스 선택지, 이름 길이)', () => {
    const names = (commands as any[]).map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of commands as any[]) { expect(c.name.length).toBeLessThanOrEqual(32); expect(c.description.length).toBeLessThanOrEqual(100); }
    const choices = (name: string) => (commands as any[]).find((c) => c.name === name).options[0].choices.map((x: any) => x.value);
    expect(choices('탐험')).toEqual(DUNGEONS.map((d) => d.id));
    for (const id of choices('보스')) expect(MOBS.find((m) => m.id === id)?.kind).toBe('boss');
    expect(names).toEqual(expect.arrayContaining(['연동', '프로필', '탐험', '보스', '던전', '인벤토리', '스킬', '상점', '구매', '판매', '제작', '소식', '도움말']));
  });
  it('막대 이미지 주소·hpText·clip', () => {
    expect(hpText(62, 110)).toBe('HP 62/110');
    expect(hpText(-5, 110)).toBe('HP 0/110');
    expect(pct(1, 100)).toBe(1); // 살아 있으면 최소 1%
    expect(pct(0, 100)).toBe(0);
    expect(barsUrl([{ t: 'f', pct: 40 }, { t: 'gap' }, { t: 'a', pct: 62 }, { t: 'pips', n: 4 }, { t: 'gauge', pct: 30 }])).toBe('https://rtgm.officialgl.com/bot/bars.png?r=f40,_,a62,p4,u30');
    expect(clip('abcdef', 4)).toBe('abc…');
  });
});


describe('막대 이미지', () => {
  const png = async (q: string) => app.request(`https://rtgm.officialgl.com/bot/bars.png?r=${q}`, {}, env); // 쿠키 없이 (디스코드가 가져간다)
  it('로그인 없이 PNG 를 돌려주고 캐시된다', async () => {
    const res = await png('f40,_,a62,p4,u30');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toContain('immutable');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(bytes.buffer);
    expect(dv.getUint32(16)).toBe(480); // 너비
    expect(dv.getUint32(20)).toBeGreaterThan(60); // 높이
    expect(bytes.length).toBeGreaterThan(500);
    expect(new Uint8Array(await (await png('f40,_,a62,p4,u30')).arrayBuffer())).toEqual(bytes); // 같은 값이면 같은 그림
  });
  it('잘못된 값·너무 많은 줄은 400', async () => {
    for (const q of ['', 'f40,zz', 'a1000', 'p9', '<script>', 'a50,'.repeat(20) + 'a1']) expect((await png(encodeURIComponent(q))).status, q).toBe(400);
    const none = await app.request('https://rtgm.officialgl.com/bot/bars.png', {}, env);
    expect(none.status).toBe(400);
  });
  it('전투 화면은 유니코드 막대 대신 이미지를 쓴다', async () => {
    await web('tokA', 'GET', '/api/me');
    await linkedA();
    const r = await slash('탐험', { 지역: 'plains' });
    const e = r.json.data.embeds[0];
    expect(e.image.url).toMatch(/^https:\/\/rtgm\.officialgl\.com\/bot\/bars\.png\?r=f\d+,_,a\d+,p4,u0$/);
    expect(JSON.stringify(e)).not.toMatch(/[█░●○]/);
    expect(JSON.stringify(e.fields)).toContain('HP ');
    const png2 = await app.request(e.image.url.replace('https://rtgm.officialgl.com', 'https://rtgm.officialgl.com'), {}, env);
    expect(png2.status).toBe(200);
  });
});

describe('전체 공개 결과', () => {
  const finishBattle = async (mobKind: 'explore' | 'boss') => {
    const r = mobKind === 'explore' ? await slash('탐험', { 지역: 'plains' }) : await slash('보스', { 보스: 'rich' });
    const id = r.json.data.components[0].components.find((c: any) => c.custom_id.includes(':atk:')).custom_id.split(':')[1] as string;
    const st = JSON.parse((sqlite.prepare('SELECT state FROM battles WHERE id = ?').get(id) as any).state);
    st.combatants.find((c: any) => c.id === 'enemy').hp = 1;
    sqlite.prepare('UPDATE battles SET state = ? WHERE id = ?').run(JSON.stringify(st), id);
    let last: any;
    for (let n = 0; n < 8; n++) { last = await press(`bt:${id}:atk:enemy`); if (!last.json.data.components.length) break; }
    return { id, last };
  };
  beforeEach(async () => { await web('tokA', 'GET', '/api/me'); await linkedA(); });

  it('전투에서 이기면 전체 공개 메시지가 나가고, 내 화면(ephemeral)과 별개다', async () => {
    const { last } = await finishBattle('explore');
    expect(last.json.type).toBe(7); // 내 화면은 그대로 갱신
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.url).toBe('https://discord.com/api/v10/webhooks/app1/tok-abc');
    expect(hooks[0]!.body.flags).toBeUndefined(); // 플래그 없음 = 전체 공개
    expect(hooks[0]!.body.allowed_mentions).toEqual({ parse: [] });
    const e = hooks[0]!.body.embeds[0];
    expect(e.title).toContain('에이님이');
    expect(e.title).toContain('쓰러뜨렸다');
    expect(e.description).toContain('🎁');
  });
  it('같은 결과는 한 번만 올라간다 (다시 눌러도 중복 없음)', async () => {
    const { id } = await finishBattle('explore');
    await press(`bt:${id}:atk:enemy`);
    await press(`bt:${id}:grd`);
    expect(hooks).toHaveLength(1);
  });
  it('진행 중에는 아무것도 올라가지 않는다', async () => {
    const r = await slash('탐험', { 지역: 'plains' });
    await press(r.json.data.components[0].components.find((c: any) => c.custom_id.includes(':atk:')).custom_id);
    expect(hooks).toHaveLength(0);
  });
  it('보스 처치는 왕관 문구로 올라간다', async () => {
    sqlite.prepare("UPDATE characters SET proficiency = 500 WHERE user_id = ?").run(A.id);
    const r = await slash('보스', { 보스: 'rich' });
    const id = r.json.data.components[0].components.find((c: any) => c.custom_id.includes(':atk:')).custom_id.split(':')[1] as string;
    const st = JSON.parse((sqlite.prepare('SELECT state FROM battles WHERE id = ?').get(id) as any).state);
    for (const c of st.combatants) if (c.side === 'enemy') c.hp = 1;
    st.boss.runtime.revived = true; // 부활 없이 끝나게
    sqlite.prepare('UPDATE battles SET state = ? WHERE id = ?').run(JSON.stringify(st), id);
    for (let n = 0; n < 10; n++) { const last = await press(`bt:${id}:atk:enemy`); if (!last.json.data.components.length) break; }
    expect(hooks.length).toBeGreaterThanOrEqual(1);
    expect(hooks[0]!.body.embeds[0].title).toMatch(/👑|💀/);
  });
  it('던전 후퇴는 전체 공개로 알린다', async () => {
    await press('rs', ['catacomb']);
    await press('rn');
    const view = await slash('던전');
    if (view.json.data.components.some((c: any) => c.components.some((x: any) => x.custom_id === 'rr'))) {
      await press('rr');
      expect(hooks).toHaveLength(1);
      expect(hooks[0]!.body.embeds[0].title).toContain('돌아왔다');
      expect(hooks[0]!.body.embeds[0].description).toContain('층 도달');
    } else {
      expect(hooks).toHaveLength(0); // 몬스터 방: 전투 중에는 올리지 않는다
    }
  });
  it('개인 전용 안내(프로필·상점·오류)는 전체 공개되지 않는다', async () => {
    await slash('프로필'); await slash('상점'); await slash('구매', { 아이템: 'bread', 수량: 99 });
    expect(hooks).toHaveLength(0);
  });
});
