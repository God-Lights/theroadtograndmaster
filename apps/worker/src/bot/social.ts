import { getProfTier, itemById } from '@rtgm/data';
import type { Caller, Result } from './types';
import { BLUE, GOLD, button, clip, row, select, type Msg } from './ui';

/** 친구 · 유저 · 길드 · 교환소 · 이벤트 · 랭킹 */
const fail = (r: { status: number; json: any }) => ({ error: r });
const dot = (on: boolean) => (on ? '🟢' : '⚫');
const ago = (t: number, now = Date.now()) => { const m = Math.floor((now - t) / 60000); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`; };
const won = (n: number) => `${n.toLocaleString()}D`;

export async function friendsShow(call: Caller): Promise<Result> {
  const r = await call('GET', '/api/friends');
  if (r.status !== 200) return fail(r);
  const { friends, incoming, outgoing } = r.json;
  const line = (p: any) => `${dot(p.online)} **${p.nickname}** · ${getProfTier(p.proficiency).name}`;
  const embed = {
    title: '👥 친구', color: BLUE,
    description: clip(`**친구 ${friends.length}/50**\n${friends.map(line).join('\n') || '아직 친구가 없어요. `/친구신청 닉네임` 또는 `/유저`로 찾아보세요.'}${incoming.length ? `\n\n**받은 신청**\n${incoming.map((p: any) => `· ${p.nickname}`).join('\n')}` : ''}${outgoing.length ? `\n\n**보낸 신청**\n${outgoing.map((p: any) => `· ${p.nickname}`).join('\n')}` : ''}`, 3800),
  };
  const rows: unknown[] = [];
  if (incoming.length) rows.push(row(select('fr:ac', '친구 신청 수락', incoming.slice(0, 25).map((p: any) => ({ label: p.nickname, value: p.id }))), ));
  if (incoming.length) rows.push(row(select('fr:dc', '친구 신청 거절', incoming.slice(0, 25).map((p: any) => ({ label: p.nickname, value: p.id })))));
  if (friends.length) rows.push(row(select('fr:rm', '친구 삭제', friends.slice(0, 25).map((p: any) => ({ label: p.nickname, value: p.id })))));
  return { msg: { embeds: [embed], components: rows } };
}

export async function friendRequest(call: Caller, nickname: string): Promise<Result> {
  const r = await call('GET', `/api/players/search?q=${encodeURIComponent(nickname)}`);
  if (r.status !== 200) return fail(r);
  const players = (r.json.players as any[]).filter((p) => p.relation === 'none');
  if (players.length === 0) return { msg: { embeds: [{ color: 0xef5350, description: '⚠️ 신청할 수 있는 유저를 찾지 못했어요. (2글자 이상, RTGM에 접속한 적 있는 유저)' }] } };
  const exact = players.find((p) => p.nickname === nickname) ?? (players.length === 1 ? players[0] : null);
  if (exact) {
    const q = await call('POST', '/api/friends/request', { userId: exact.id });
    return q.status === 200 ? { msg: { embeds: [{ color: 0x66bb6a, description: q.json.status === 'friend' ? `✅ **${exact.nickname}**님과 친구가 되었어요!` : `📨 **${exact.nickname}**님에게 친구 신청을 보냈어요.` }] } } : fail(q);
  }
  return { msg: { embeds: [{ color: BLUE, description: '여러 명이 검색됐어요. 신청할 유저를 고르세요.' }], components: [row(select('fr:rq', '친구 신청 보내기', players.slice(0, 25).map((p) => ({ label: p.nickname, value: p.id, description: `${getProfTier(p.proficiency).name} · ${p.online ? '접속 중' : '오프라인'}` }))))] } };
}

export async function usersShow(call: Caller, q = ''): Promise<Result> {
  const r = await call('GET', `/api/users?q=${encodeURIComponent(q)}&offset=0`);
  if (r.status !== 200) return fail(r);
  const { users, total, online, hasMore } = r.json;
  const lines = users.slice(0, 15).map((u: any) => `${dot(u.online)} **${u.nickname}** · ${getProfTier(u.proficiency).name} · ${u.online ? '접속 중' : `${ago(u.lastSeen)}`}${u.relation === 'friend' ? ' · 친구' : u.relation === 'sent' ? ' · 신청함' : u.relation === 'received' ? ' · 신청 받음' : ''}`);
  const addable = users.filter((u: any) => u.relation === 'none').slice(0, 25);
  return { msg: {
    embeds: [{ title: '🧑‍🤝‍🧑 유저', color: BLUE, description: `전체 ${total}명 · 접속 중 ${online}명${q ? ` · “${q}” 검색` : ''}\n\n${lines.join('\n') || '유저가 없어요.'}${hasMore || users.length > 15 ? '\n…' : ''}` }],
    components: addable.length ? [row(select('fr:rq', '친구 신청 보내기', addable.map((u: any) => ({ label: u.nickname, value: u.id, description: getProfTier(u.proficiency).name }))))] : [],
  } };
}

export async function friendPress(call: Caller, id: string, values: string[] | undefined): Promise<Result> {
  const [, act] = id.split(':');
  const userId = values?.[0];
  const path = act === 'ac' ? '/api/friends/accept' : act === 'rq' ? '/api/friends/request' : '/api/friends/remove';
  const r = await call('POST', path, { userId });
  if (r.status !== 200) return fail(r);
  return friendsShow(call);
}

// ─── 길드 ────────────────────────────────────────────────────────────────────

export async function guildShow(call: Caller, q = ''): Promise<Result> {
  const g = await call('GET', '/api/guild');
  if (g.status !== 200) return fail(g);
  const guild = g.json.guild;
  if (!guild) {
    const l = await call('GET', `/api/guilds?q=${encodeURIComponent(q)}`);
    if (l.status !== 200) return fail(l);
    const { guilds, capacity } = l.json;
    return { msg: {
      embeds: [{ title: '🏰 길드', color: BLUE, description: `길드에 가입하지 않았어요. 만들려면 \`/길드생성 이름\` (${won(g.json.createCost)})\n\n${guilds.map((x: any) => `**${x.name}** Lv.${x.level} · ${x.members}/${capacity}명 — ${x.description || '소개 없음'}`).join('\n') || '아직 길드가 없어요.'}` }],
      components: guilds.length ? [row(select('gl:j', '길드 가입', guilds.filter((x: any) => x.members < capacity).slice(0, 25).map((x: any) => ({ label: x.name, value: x.id, description: `Lv.${x.level} · ${x.members}/${capacity}명` }))))] : [],
    } };
  }
  const role: Record<string, string> = { leader: '길드장', officer: '간부', member: '길드원' };
  return { msg: {
    embeds: [{ title: `🏰 ${guild.name} Lv.${guild.level}`, color: GOLD, description: `${guild.description || '소개가 없어요.'}\n금고(누적 기부) ${won(guild.gold)} · 길드원 ${guild.members.length}/${guild.capacity}\n\n${guild.members.map((m: any) => `${dot(m.online)} **${m.nickname}** · ${role[m.role]} · ${getProfTier(m.proficiency).name} · 기여 ${won(m.contribution)}`).join('\n')}\n\n기부: \`/길드기부 금액\``, }],
    components: [row(button('길드 떠나기', 'gl:l', 4))],
  } };
}

export async function guildPress(call: Caller, id: string, values: string[] | undefined): Promise<Result> {
  const act = id.split(':')[1];
  const r = act === 'j' ? await call('POST', '/api/guild/join', { guildId: values?.[0] }) : await call('POST', '/api/guild/leave');
  return r.status === 200 ? guildShow(call) : fail(r);
}

// ─── 교환소 ──────────────────────────────────────────────────────────────────

export async function exchangeShow(call: Caller): Promise<Result> {
  const [all, mine] = [await call('GET', '/api/exchange'), await call('GET', '/api/exchange/mine')];
  if (all.status !== 200) return fail(all);
  if (mine.status !== 200) return fail(mine);
  const name = (l: any) => `${itemById(l.itemId)?.name ?? l.itemId} ×${l.quantity}`;
  const buy = all.json.listings.slice(0, 25);
  const my = (mine.json.listings as any[]).filter((l) => l.status === 'active');
  const sold = (mine.json.listings as any[]).filter((l) => l.status === 'sold').slice(0, 3);
  const embed = {
    title: '🧺 교환소', color: GOLD,
    description: clip(`판매 수수료 ${Math.round(all.json.feeRate * 100)}% · 등록은 \`/등록 아이템 수량 가격\`\n\n**사기**\n${buy.map((l: any) => `${name(l)} — ${won(l.price)} (${l.seller}${l.private ? ' · 지정' : ''})`).join('\n') || '올라온 물품이 없어요.'}${my.length ? `\n\n**내가 올린 물품**\n${my.map((l: any) => `${name(l)} — ${won(l.price)}`).join('\n')}` : ''}${sold.length ? `\n\n**최근 판매**\n${sold.map((l: any) => `${name(l)} → ${l.buyer ?? ''} (+${won(l.proceeds ?? 0)})`).join('\n')}` : ''}`, 3800),
  };
  const rows: unknown[] = [];
  if (buy.length) rows.push(row(select('ex:b', '구매하기', buy.map((l: any) => ({ label: `${name(l)} — ${won(l.price)}`, value: l.id, description: `판매자 ${l.seller}` })))));
  if (my.length) rows.push(row(select('ex:x', '내 물품 거두기', my.slice(0, 25).map((l: any) => ({ label: `${name(l)} — ${won(l.price)}`, value: l.id })))));
  return { msg: { embeds: [embed], components: rows } };
}

export async function exchangePress(call: Caller, id: string, values: string[] | undefined): Promise<Result> {
  const act = id.split(':')[1];
  const r = await call('POST', act === 'b' ? '/api/exchange/buy' : '/api/exchange/cancel', { listingId: values?.[0] });
  return r.status === 200 ? exchangeShow(call) : fail(r);
}

// ─── 이벤트·랭킹 ──────────────────────────────────────────────────────────────

export async function eventsShow(call: Caller): Promise<Result> {
  const r = await call('GET', '/api/events');
  if (r.status !== 200) return fail(r);
  const { events, bonus } = r.json;
  const kind: Record<string, string> = { notice: '📢 공지', bonus: '✨ 보너스', gift: '🎁 선물' };
  const cfg = (e: any) => e.kind === 'bonus'
    ? [e.config.gold && `골드 ×${e.config.gold}`, e.config.proficiency && `숙련도 ×${e.config.proficiency}`, e.config.drop && `드롭률 ×${e.config.drop}`].filter(Boolean).join(' · ')
    : e.kind === 'gift' ? [e.config.gold ? won(e.config.gold) : '', ...(e.config.items ?? []).map((i: any) => `${itemById(i.itemId)?.name ?? i.itemId} ×${i.quantity}`)].filter(Boolean).join(', ') : '';
  const lines = events.map((e: any) => `${kind[e.kind]} **${e.title}**${e.status === 'upcoming' ? ' (예정)' : ''}${e.description ? `\n${e.description}` : ''}${cfg(e) ? `\n> ${cfg(e)}` : ''}${e.kind === 'gift' && e.status === 'active' ? (e.claimed ? '\n> ✔ 받았어요' : '\n> 아래에서 받을 수 있어요') : ''}`);
  const claimable = events.filter((e: any) => e.kind === 'gift' && e.status === 'active' && !e.claimed);
  return { msg: {
    embeds: [{ title: '🎉 이벤트', color: GOLD, description: clip(`${bonus.gold > 1 || bonus.proficiency > 1 || bonus.drop > 1 ? `**지금 적용 중인 보너스**: 골드 ×${bonus.gold} · 숙련도 ×${bonus.proficiency} · 드롭률 ×${bonus.drop}\n\n` : ''}${lines.join('\n\n') || '진행 중인 이벤트가 없어요.'}`, 3800) }],
    components: claimable.length ? [row(select('ev:c', '선물 받기', claimable.slice(0, 25).map((e: any) => ({ label: e.title, value: e.id, description: cfg(e) }))))] : [],
  } };
}

export async function eventPress(call: Caller, _id: string, values: string[] | undefined): Promise<Result> {
  const r = await call('POST', `/api/events/${values?.[0]}/claim`);
  return r.status === 200 ? eventsShow(call) : fail(r);
}

export async function rankingShow(call: Caller): Promise<Result> {
  const [pvp, team] = [await call('GET', '/api/pvp/ranking'), await call('GET', '/api/team/status')];
  if (pvp.status !== 200) return fail(pvp);
  const fmt = (list: any[]) => list.slice(0, 10).map((x) => `${x.rank}. ${x.me ? '**' : ''}${x.nickname}${x.me ? '**' : ''} — ${x.rating} (${x.wins}승 ${x.losses}패)`).join('\n') || '아직 전적이 없어요.';
  return { msg: { embeds: [{ title: '🏆 랭킹', color: GOLD, fields: [{ name: '⚔️ PvP 1v1', value: clip(fmt(pvp.json.ranking), 1000) }, { name: '🛡 4v4 팀전', value: clip(fmt(team.json?.ranking ?? []), 1000) }] }] } };
}

export type { Msg };
