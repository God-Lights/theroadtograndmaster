import { itemById, mobById } from '@rtgm/data';
import {
  battleMessage, buyChoices, errorMsg, helpMessage, inventoryMessage, newsMessage, profileMessage, recipeChoices, runMessage, runResultMessage,
  shopMessage, skillsMessage, withItems, type Msg,
} from './ui';

export interface CallResult { status: number; json: any }
export type Caller = (method: string, path: string, body?: unknown) => Promise<CallResult>;

const EPHEMERAL = 64;
const reply = (msg: Msg) => ({ type: 4, data: { ...msg, flags: EPHEMERAL } });
const update = (msg: Msg) => ({ type: 7, data: { content: '', embeds: [], components: [], ...msg } });
const optionOf = (i: any, name: string): any => i.data?.options?.find((o: any) => o.name === name)?.value;
const userIdOf = (i: any): string | undefined => i.member?.user?.id ?? i.user?.id;

/** 오류 응답을 메시지로. 명령어는 새 메시지, 버튼·메뉴는 원래 메시지를 그대로 두고 알림만 띄운다 */
const fail = (r: CallResult) => reply(errorMsg(r.json?.error ?? 'unknown', r.json ?? {}));

/** 한 라운드를 진행하고 전투 메시지를 만든다 */
async function round(call: Caller, battleId: string, body: Record<string, unknown>) {
  const r = await call('POST', `/api/battle/${battleId}/round`, body);
  if (r.status !== 200) return { error: r };
  const { state, log, rewards, deferred } = r.json;
  let msg = battleMessage({ battleId, state, log, rewards, deferred });
  if (state.status === 'ongoing') {
    const inv = await call('GET', '/api/inventory');
    if (inv.status === 200) msg = withItems(msg, battleId, inv.json);
  } else if (deferred) {
    // 던전 전투가 끝났다: 런이 끝났으면(쓰러짐·완주) 결과를 이어서 보여 준다
    const run = await call('GET', '/api/run');
    if (run.status === 200 && !run.json.run) {
      const last = await call('GET', '/api/run/last');
      if (last.status === 200 && last.json.run) msg = { embeds: [...(msg.embeds ?? []), ...(runResultMessage(last.json.run).embeds ?? [])], components: [] };
    }
  }
  return { msg };
}

async function startedBattle(call: Caller, r: CallResult, note?: string): Promise<Msg> {
  const { id, state, mobId } = r.json;
  let msg = battleMessage({ battleId: id, state, note: note ?? `야생의 ${mobById(mobId)?.name ?? '몬스터'}이(가) 나타났다!`, mobName: mobById(mobId)?.name });
  const inv = await call('GET', '/api/inventory');
  if (inv.status === 200) msg = withItems(msg, id, inv.json);
  return msg;
}

async function showRun(call: Caller, extra?: string): Promise<{ msg: Msg } | { error: CallResult }> {
  const r = await call('GET', '/api/run');
  if (r.status !== 200) return { error: r };
  const data = r.json;
  if (data.run?.status === 'battle' && data.run.battle) {
    const b = data.run.battle;
    return { msg: await startedBattle(call, { status: 200, json: { id: b.id, state: b.state, mobId: b.mobId } }, extra ?? '던전에서 전투 중이에요!') };
  }
  const msg = runMessage(data);
  if (extra && msg.embeds?.[0]) (msg.embeds[0] as any).description = `${extra}\n\n${(msg.embeds[0] as any).description}`;
  return { msg };
}

async function advanceRun(call: Caller) {
  const r = await call('POST', '/api/run/advance');
  if (r.status !== 200) return { error: r };
  const run = r.json;
  const note = run.room ? `${{ monster: '⚔️', treasure: '💰', trap: '🪤', nothing: '🌫️' }[run.room.kind as string] ?? ''} ${run.room.text}` : undefined;
  if (run.status === 'battle' && run.battle) return { msg: await startedBattle(call, { status: 200, json: { id: run.battle.id, state: run.battle.state, mobId: run.battle.mobId } }, note) };
  const msg = runMessage({ run });
  if (note && msg.embeds?.[0]) (msg.embeds[0] as any).description = `${note}\n\n${(msg.embeds[0] as any).description}`;
  return { msg };
}

// ─── 슬래시 명령어 ─────────────────────────────────────────────────────────────

async function command(i: any, uid: string, call: Caller): Promise<object> {
  const name: string = i.data.name;
  switch (name) {
    case '도움말': return reply(helpMessage());
    case '연동': {
      const r = await call('POST', '/api/bot/link', { code: String(optionOf(i, '코드') ?? ''), discordId: uid });
      if (r.status === 200) return reply({ embeds: [{ color: 0x66bb6a, title: '✅ 연동 완료!', description: `${r.json.nickname ?? '모험가'}님, 이제 디스코드에서 게임을 할 수 있어요.\n\`/탐험\`, \`/프로필\`, \`/도움말\` 을 해 보세요.` }] });
      return reply({ embeds: [{ color: 0xef5350, description: r.json?.error === 'invalid_code' ? '⚠️ 코드가 틀렸거나 만료됐어요. 웹에서 새 코드를 만들어 주세요.' : '⚠️ 연동하지 못했어요. 잠시 후 다시 시도해 주세요.' }] });
    }
    case '프로필': {
      const [me, inv, cd] = [await call('GET', '/api/me'), await call('GET', '/api/inventory'), await call('GET', '/api/cooldowns')];
      for (const r of [me, inv, cd]) if (r.status !== 200) return fail(r);
      return reply(profileMessage(me.json, inv.json, cd.json.cooldowns ?? {}));
    }
    case '탐험': {
      const r = await call('POST', '/api/explore', { biomeId: optionOf(i, '지역') });
      return r.status === 200 ? reply(await startedBattle(call, r)) : fail(r);
    }
    case '보스': {
      const r = await call('POST', '/api/battle', { mobId: optionOf(i, '보스') });
      return r.status === 200 ? reply(await startedBattle(call, r, `${mobById(r.json.mobId)?.name ?? '보스'}에게 도전한다!`)) : fail(r);
    }
    case '던전': { const r = await showRun(call); return 'msg' in r ? reply(r.msg) : fail(r.error); }
    case '인벤토리': { const r = await call('GET', '/api/inventory'); return r.status === 200 ? reply(inventoryMessage(r.json)) : fail(r); }
    case '스킬': { const r = await call('GET', '/api/skills'); return r.status === 200 ? reply(skillsMessage(r.json)) : fail(r); }
    case '상점': { const r = await call('GET', '/api/me'); return r.status === 200 ? reply(shopMessage(r.json.proficiency)) : fail(r); }
    case '구매': {
      const itemId = String(optionOf(i, '아이템')), qty = Number(optionOf(i, '수량') ?? 1);
      const r = await call('POST', '/api/shop/buy', { itemId, quantity: qty });
      if (r.status !== 200) return fail(r);
      return reply({ embeds: [{ color: 0x66bb6a, description: `🛒 **${itemById(itemId)?.name ?? itemId}** ×${qty} 구매 완료! (남은 달런트 ${r.json.gold.toLocaleString()}D)` }] });
    }
    case '판매': {
      const itemId = String(optionOf(i, '아이템')), qty = Number(optionOf(i, '수량') ?? 1);
      const r = await call('POST', '/api/inventory/sell', { itemId, quantity: qty });
      if (r.status !== 200) return fail(r);
      return reply({ embeds: [{ color: 0x66bb6a, description: `💰 **${itemById(itemId)?.name ?? itemId}** ×${qty} 판매 완료! (달런트 ${r.json.gold.toLocaleString()}D)` }] });
    }
    case '제작': {
      const r = await call('POST', '/api/craft', { recipeId: String(optionOf(i, '레시피')) });
      if (r.status !== 200) return fail(r);
      return reply({ embeds: [{ color: 0x66bb6a, description: `🔨 **${r.json.crafted.name}** ×${r.json.crafted.quantity} 제작 완료! (숙련도 +${r.json.proficiencyGained})` }] });
    }
    case '소식': {
      const r = await call('GET', '/api/announcements?after=0');
      return r.status === 200 ? reply(newsMessage(r.json.announcements)) : fail(r);
    }
    default: return reply({ content: '알 수 없는 명령어예요.' });
  }
}

// ─── 버튼·선택 메뉴 ────────────────────────────────────────────────────────────

async function component(i: any, call: Caller): Promise<object> {
  const id: string = i.data.custom_id;
  const value: string | undefined = i.data.values?.[0];
  const [kind, battleId, act, target] = id.split(':');

  if (kind === 'bt' || kind === 'bs' || kind === 'bi') {
    const body = kind === 'bt'
      ? (act === 'grd' ? { action: 'guard' } : { action: 'attack', targetId: target })
      : kind === 'bs' ? { action: 'skill', skillId: value } : { action: 'item', itemId: value };
    // 선택 메뉴의 custom_id 는 'bs:<battleId>' 라서 두 번째 칸이 전투 id
    const r = await round(call, battleId!, body);
    return 'msg' in r ? update(r.msg!) : fail(r.error!);
  }
  switch (id) {
    case 'rs': { const r = await call('POST', '/api/run/start', { dungeonId: value }); if (r.status !== 200) return fail(r); const v = await showRun(call, `**${r.json.name}** 에 입장했다!`); return 'msg' in v ? update(v.msg) : fail(v.error); }
    case 'rn': { const r = await advanceRun(call); return 'msg' in r ? update(r.msg!) : fail(r.error!); }
    case 'rr': {
      const r = await call('POST', '/api/run/retreat');
      return r.status === 200 ? update(runResultMessage(r.json)) : fail(r);
    }
    case 'rv': { const v = await showRun(call); return 'msg' in v ? update(v.msg) : fail(v.error); }
    case 'ie': case 'iu': {
      const r = await call('POST', id === 'ie' ? '/api/inventory/equip' : '/api/inventory/unequip', { itemId: value });
      return r.status === 200 ? update(inventoryMessage(r.json)) : fail(r);
    }
    case 'se': case 'su': {
      const r = await call('POST', id === 'se' ? '/api/skills/equip' : '/api/skills/unequip', { skillId: value });
      return r.status === 200 ? update(skillsMessage(r.json)) : fail(r);
    }
    default: return reply({ content: '이 버튼은 더 이상 쓸 수 없어요. 명령어를 다시 실행해 주세요.' });
  }
}

async function autocomplete(i: any, call: Caller): Promise<object> {
  const focused = i.data.options?.find((o: any) => o.focused);
  const q = String(focused?.value ?? '');
  const norm = (s: string) => s.replace(/\s/g, '');
  let choices: { name: string; value: string }[] = [];
  if (i.data.name === '구매') choices = buyChoices(q);
  else if (i.data.name === '제작') choices = recipeChoices(q);
  else if (i.data.name === '판매') {
    const inv = await call('GET', '/api/inventory');
    if (inv.status === 200) {
      choices = inv.json.items
        .map((r: any) => ({ r, it: itemById(r.itemId) }))
        .filter((x: any) => x.it && x.it.sell > 0 && norm(x.it.name).includes(norm(q)))
        .slice(0, 25)
        .map((x: any) => ({ name: `${x.it.name} ×${x.r.quantity} (${x.it.sell}D)`, value: x.it.id }));
    }
  }
  return { type: 8, data: { choices } };
}

/** 디스코드 상호작용 하나를 처리해 응답(JSON)을 돌려준다. callFor(디스코드 ID) → 그 사용자로 게임 API를 부르는 함수 */
export async function handleInteraction(i: any, callFor: (discordId: string) => Caller): Promise<object> {
  if (i.type === 1) return { type: 1 };
  const uid = userIdOf(i);
  if (!uid) return reply({ content: '사용자를 확인할 수 없어요.' });
  const call = callFor(uid);
  try {
    if (i.type === 2) return await command(i, uid, call);
    if (i.type === 3) return await component(i, call);
    if (i.type === 4) return await autocomplete(i, call);
  } catch {
    return reply({ embeds: [{ color: 0xef5350, description: '⚠️ 처리하지 못했어요. 잠시 후 다시 시도해 주세요.' }] });
  }
  return reply({ content: '지원하지 않는 요청이에요.' });
}
