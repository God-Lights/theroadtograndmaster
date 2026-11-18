import { itemById, fmtWait, starLabel } from '@rtgm/data';
import { needsAllyTarget, partyBattleMessage, type PartyView } from './party';
import type { Caller, Publish, Result } from './types';
import { BLUE, button, publicPvp, publicRaid, publicTeam, row, select, type Msg } from './ui';

/** 레이드 · 1v1 PvP · 4v4 팀전 (동시 선택). 상태는 모두 서버에 있고, 봇은 조회→표시, 버튼→제출을 한다. */
const ROLE_ICON: Record<string, string> = { tank: '🛡', dealer: '⚔', healer: '✚', support: '★' };
const ROLE_LABEL: Record<string, string> = { tank: '탱커', dealer: '딜러', healer: '힐러', support: '서포터' };
const fail = (r: { status: number; json: any }) => ({ error: r });
/** 게임 계정 id (디스코드 id 가 아니다) */
const nickOf = async (call: Caller): Promise<string> => (await call('GET', '/api/me')).json?.nickname ?? '모험가';
/** 끝난 결과는 전체 공개로도 올린다 (같은 결과는 한 번만) */
const raidPublish = (room: any): Publish | undefined => (room.status === 'done' ? { key: `raid:${room.id}`, build: async () => publicRaid(room) } : undefined);
const pvpPublish = (m: any): Publish | undefined => (m.status === 'done' ? { key: `pvp:${m.id}`, build: async (call) => publicPvp(await nickOf(call), m) } : undefined);
const teamPublish = (m: any): Publish | undefined => (m.status === 'done' ? { key: `team:${m.id}`, build: async () => publicTeam(m) } : undefined);
const myId = async (call: Caller): Promise<string | undefined> => (await call('GET', '/api/me')).json?.id;
const refreshBtn = (k: string) => button('🔄 새로고침', `${k}:f`, 2);
const rewardLine = (r?: { gold: number; proficiency: number; items: { itemId: string; quantity: number }[] }) =>
  r ? `🎁 ${r.gold.toLocaleString()}D · 숙련도 +${r.proficiency}${r.items.map((i) => ` · ${itemById(i.itemId)?.name ?? i.itemId} ×${i.quantity}`).join('')}` : '';

// ─── 레이드 ──────────────────────────────────────────────────────────────────

function raidBattle(room: any, pendingSkill?: string): Msg {
  const mine = room.members.find((m: any) => m.slot === room.mySlot);
  const alive = room.members.filter((m: any) => (room.state.combatants.find((c: any) => c.id === m.slot)?.hp ?? 0) > 0);
  const done = room.status === 'done';
  const v: PartyView = {
    kind: 'ra', title: `🛡 ${starLabel(room.star ?? 0)} ${room.bossName}`, round: room.round, deadline: room.deadline, serverNow: room.serverNow,
    mySlot: room.mySlot, needsAction: room.needsAction, submitted: !!mine?.submitted, waiting: `파티원 ${alive.filter((m: any) => m.submitted).length}/${alive.length}`,
    state: room.state, skills: room.skills, log: room.log, done, pendingSkill,
    resultText: done ? `${room.result === 'victory' ? '🏆 레이드 성공!' : '레이드 실패…'}\n${rewardLine(mine?.rewards)}` : undefined,
  };
  return partyBattleMessage(v);
}

function raidRoomLobby(room: any, roles: Record<string, any>): Msg {
  const lines = room.members.map((m: any) => `${m.role ? `${ROLE_ICON[m.role]} ${ROLE_LABEL[m.role]}` : '역할 미정'} · ${m.nickname}${m.userId === room.leaderId ? ' 👑' : m.ready ? ' ✔' : ''}`).join('\n');
  const count = (r: string) => room.members.filter((m: any) => m.role === r).length;
  const embed = {
    title: `🛡 ${starLabel(room.star)} ${room.bossName} · 대기실`, color: BLUE,
    description: `초대 코드 **${room.code}**  (친구는 \`/레이드입장 코드:${room.code}\`)\n파티원 ${room.members.length}/${room.maxParty}명 · 최소 ${room.minParty}명 · 적정 ${room.recParty}명\n역할은 ${room.roleCap === 1 ? '겹칠 수 없어요' : `역할마다 ${room.roleCap}명까지`}.\n\n${lines}`,
  };
  const myRole = room.myRole;
  const options = Object.keys(roles).filter((r) => count(r) < room.roleCap || myRole === r).map((r) => ({ label: `${ROLE_ICON[r]} ${roles[r].label}`, value: r, description: `${count(r)}/${room.roleCap} · ${roles[r].desc}` }));
  return { embeds: [embed], components: [row(select('ra:r', '내 역할 고르기', options)), row(button('✔ 준비/취소', 'ra:y', 3), button('▶ 시작 (방장)', 'ra:s', 1), button('나가기', 'ra:l', 4), refreshBtn('ra'))] };
}

export async function raidShow(call: Caller, pendingSkill?: string): Promise<Result> {
  const r = await call('GET', '/api/raid');
  if (r.status !== 200) return fail(r);
  const d = r.json;
  const room = d.room;
  if (!room) {
    const now = Date.now();
    const lines = d.bosses.map((b: any) => {
      const wait = Math.max(0, (d.cooldowns?.[b.id] ?? 0) - now);
      return `${starLabel(b.star)} **${b.name}** · ${b.recParty}~${b.maxParty}명 · ${d.proficiency < b.minProficiency ? `🔒 숙련도 ${b.minProficiency}` : wait > 0 ? `⏳ ${fmtWait(wait)}` : `숙련도 ${b.minProficiency}+`}`;
    });
    const friends = (d.friendRooms ?? []).map((f: any) => `\`${f.code}\` ${f.leader}님의 ${f.bossName} (${f.members}/${f.max})`);
    const options = d.bosses.filter((b: any) => d.proficiency >= b.minProficiency && (d.cooldowns?.[b.id] ?? 0) <= now).map((b: any) => ({ label: `${starLabel(b.star)} ${b.name}`, value: b.id, description: `${b.recParty}~${b.maxParty}명` }));
    return { msg: {
      embeds: [{ title: '🛡 레이드', color: BLUE, description: `${lines.join('\n')}\n\n방을 만들거나 친구의 코드로 입장해요: \`/레이드입장 코드:XXXXXX\`${friends.length ? `\n\n**친구가 연 방**\n${friends.join('\n')}` : ''}` }],
      components: [...(options.length ? [row(select('ra:c', '방 만들기 — 보스 고르기', options))] : []), row(refreshBtn('ra'))],
    } };
  }
  return room.status === 'lobby' ? { msg: raidRoomLobby(room, d.roles) } : { msg: raidBattle(room, pendingSkill), publish: raidPublish(room) };
}

export async function raidPress(call: Caller, id: string, values: string[] | undefined): Promise<Result> {
  const [, act, extra] = id.split(':');
  const post = async (path: string, body: unknown = {}) => { const r = await call('POST', path, body); return r.status === 200 ? null : fail(r); };
  let err: { error: any } | null = null;
  switch (act) {
    case 'c': err = await post('/api/raid/create', { bossId: values?.[0] }); break;
    case 'r': err = await post('/api/raid/role', { role: values?.[0] }); break;
    case 'y': {
      const [cur, meId] = [await call('GET', '/api/raid'), await myId(call)];
      const me = cur.json?.room?.members?.find((m: any) => m.userId === meId);
      err = await post('/api/raid/ready', { ready: !me?.ready }); break;
    }
    case 's': err = await post('/api/raid/start'); break;
    case 'l': err = await post('/api/raid/leave'); break;
    case 'f': break;
    case 'a': return actionResult(await call('POST', '/api/raid/action', { action: 'attack', targetId: extra }), (room) => raidBattle(room), raidPublish);
    case 'g': return actionResult(await call('POST', '/api/raid/action', { action: 'guard' }), (room) => raidBattle(room), raidPublish);
    case 'k': {
      const skillId = values?.[0] ?? '';
      const cur = await call('GET', '/api/raid');
      if (cur.status !== 200) return fail(cur);
      if (needsAllyTarget(cur.json.room?.skills ?? {}, skillId)) return raidShow(call, skillId);
      return actionResult(await call('POST', '/api/raid/action', { action: 'skill', skillId }), (room) => raidBattle(room), raidPublish);
    }
    case 't': return actionResult(await call('POST', '/api/raid/action', { action: 'skill', skillId: extra, targetId: values?.[0] }), (room) => raidBattle(room), raidPublish);
    default: break;
  }
  return err ?? raidShow(call);
}

function actionResult(r: { status: number; json: any }, build: (room: any) => Msg, publish?: (room: any) => Publish | undefined): Result {
  return r.status === 200 ? { msg: build(r.json), publish: publish?.(r.json) } : fail(r);
}

// ─── 1v1 PvP ─────────────────────────────────────────────────────────────────

function pvpBattle(m: any): Msg {
  const done = m.status === 'done';
  const winner = m.result?.winner;
  return partyBattleMessage({
    kind: 'pv', title: `⚔️ ${m.ranked ? '랭크전' : '친선전'} vs ${m.opponent.nickname}`, round: m.round, deadline: m.deadline, serverNow: m.serverNow,
    mySlot: m.mine, needsAction: m.needsAction, submitted: m.submitted, waiting: m.opponentSubmitted ? '곧 처리돼요' : '상대를 기다리는 중',
    state: m.state, skills: m.skills, log: m.log, done,
    resultText: done ? `${winner === 'me' ? '🏆 승리!' : winner === 'draw' ? '무승부' : '패배'}${m.ranked ? ` · 레이팅 ${m.result.ratingChange > 0 ? '+' : ''}${m.result.ratingChange}` : ''}` : undefined,
  });
}

export async function pvpShow(call: Caller): Promise<Result> {
  const s = await call('GET', '/api/pvp/status');
  if (s.status !== 200) return fail(s);
  const st = s.json;
  if (st.matchId) {
    const m = await call('GET', `/api/pvp/match/${st.matchId}`);
    return m.status === 200 ? { msg: pvpBattle(m.json), publish: pvpPublish(m.json) } : fail(m);
  }
  const hist = (st.history ?? []).slice(0, 5).map((h: any) => `${h.result === 'win' ? '🟢 승' : h.result === 'loss' ? '🔴 패' : '⚪ 무'} vs ${h.opponent}${h.ranked ? ` (${h.ratingChange > 0 ? '+' : ''}${h.ratingChange})` : ' (친선)'}`);
  const embed = {
    title: `⚔️ PvP 1v1 · 레이팅 ${st.rating}`, color: BLUE,
    description: `${st.wins}승 ${st.losses}패 ${st.draws}무 · 아이템 불가, 스탯은 PvP 상한으로 보정, 라운드당 45초\n${st.queued ? '⏳ **상대를 찾는 중…** (🔄로 확인)' : '랭크전을 찾거나 친구에게 `/도전 유저`로 대전을 신청해요.'}${st.incoming?.length ? `\n\n**받은 도전장**\n${st.incoming.map((c: any) => `· ${c.nickname}`).join('\n')}` : ''}${hist.length ? `\n\n**최근 전적**\n${hist.join('\n')}` : ''}`,
  };
  const rows: unknown[] = [row(st.queued ? button('대기 취소', 'pv:ql', 4) : button('랭크전 찾기', 'pv:q', 1), refreshBtn('pv'))];
  if (st.incoming?.length) rows.unshift(row(select('pv:ac', '도전장 수락', st.incoming.slice(0, 25).map((c: any) => ({ label: `${c.nickname}님의 도전`, value: c.id })))));
  return { msg: { embeds: [embed], components: rows } };
}

export async function pvpPress(call: Caller, id: string, values: string[] | undefined): Promise<Result> {
  const [, act] = id.split(':');
  const matchId = async () => (await call('GET', '/api/pvp/status')).json?.matchId as string | null;
  const act2 = async (body: unknown) => {
    const mid = await matchId();
    if (!mid) return pvpShow(call);
    const r = await call('POST', `/api/pvp/match/${mid}/action`, body);
    return r.status === 200 ? { msg: pvpBattle(r.json), publish: pvpPublish(r.json) } : fail(r);
  };
  switch (act) {
    case 'q': { const r = await call('POST', '/api/pvp/queue'); if (r.status !== 200) return fail(r); break; }
    case 'ql': await call('POST', '/api/pvp/queue/leave'); break;
    case 'ac': { const r = await call('POST', '/api/pvp/challenge/accept', { id: values?.[0] }); if (r.status !== 200) return fail(r); break; }
    case 'a': return act2({ action: 'attack' });
    case 'g': return act2({ action: 'guard' });
    case 'k': return act2({ action: 'skill', skillId: values?.[0] });
    default: break;
  }
  return pvpShow(call);
}

// ─── 4v4 팀전 ────────────────────────────────────────────────────────────────

function teamBattle(m: any, pendingSkill?: string): Msg {
  const mine = m.players.find((p: any) => p.slot === m.mySlot);
  const alive = m.players.filter((p: any) => (m.state.combatants.find((c: any) => c.id === p.slot)?.hp ?? 0) > 0);
  const done = m.status === 'done';
  return partyBattleMessage({
    kind: 'tm', title: `⚔️ 4v4 ${m.ranked ? '랭크전' : '친선전'}`, round: m.round, deadline: m.deadline, serverNow: m.serverNow,
    mySlot: m.mySlot, needsAction: m.needsAction, submitted: !!mine?.submitted, waiting: `${alive.filter((p: any) => p.submitted).length}/${alive.length}명 제출`,
    state: m.state, skills: m.skills, log: m.log, done, pendingSkill,
    resultText: done ? `${m.result === 'win' ? '🏆 승리!' : m.result === 'draw' ? '무승부' : '패배'}${m.ranked ? ` · 레이팅 ${(mine?.delta ?? 0) > 0 ? '+' : ''}${mine?.delta ?? 0}` : ''}` : undefined,
  });
}

function teamRoom(m: any, roles: any[]): Msg {
  const col = (t: string) => m.players.filter((p: any) => p.team === t).map((p: any) => `${p.role ? `${ROLE_ICON[p.role]} ${ROLE_LABEL[p.role]}` : '역할 미정'} · ${p.nickname}${p.userId === m.leaderId ? ' 👑' : p.ready ? ' ✔' : ''}`).join('\n') || '-';
  const taken = (r: string) => m.myRole !== r && m.players.some((p: any) => p.team === m.myTeam && p.role === r);
  return {
    embeds: [{ title: '⚔️ 4v4 친선 방', color: BLUE, description: `초대 코드 **${m.code}** (친구는 \`/팀입장 코드:${m.code}\`)\n팀마다 최대 ${m.teamSize}명 · 역할은 팀 안에서 겹치지 않게 · 양 팀에 1명 이상이면 시작 (레이팅 변동 없음)`, fields: [{ name: '🔵 A팀', value: col('A'), inline: true }, { name: '🔴 B팀', value: col('B'), inline: true }] }],
    components: [
      row(select('tm:r', '내 역할 고르기', roles.filter((r) => !taken(r.id)).map((r) => ({ label: `${ROLE_ICON[r.id]} ${r.label}`, value: r.id, description: r.desc })))),
      row(button('🔵 A팀으로', 'tm:tA', 2), button('🔴 B팀으로', 'tm:tB', 2), button('✔ 준비/취소', 'tm:y', 3), button('▶ 시작 (방장)', 'tm:s', 1), button('나가기', 'tm:l', 4)),
      row(refreshBtn('tm')),
    ],
  };
}

export async function teamShow(call: Caller, pendingSkill?: string): Promise<Result> {
  const r = await call('GET', '/api/team/status');
  if (r.status !== 200) return fail(r);
  const d = r.json, m = d.match;
  if (m && m.status === 'lobby') return { msg: teamRoom(m, d.roles) };
  if (m) return { msg: teamBattle(m, pendingSkill), publish: teamPublish(m) };
  const top = (d.ranking ?? []).slice(0, 5).map((x: any) => `${x.rank}. ${x.nickname} — ${x.rating}`);
  return { msg: {
    embeds: [{ title: `⚔️ 4v4 팀전 · 레이팅 ${d.rating}`, color: BLUE,
      description: `${d.wins}승 ${d.losses}패 ${d.draws}무 · 팀마다 탱커·딜러·힐러·서포터 한 명씩\n${d.queued ? `⏳ **${ROLE_LABEL[d.queued.role]}로 대기 중…** 8명이 모이면 시작돼요 (🔄로 확인)` : '역할을 골라 랭크전 대기열에 들어가거나, 친선 방을 만들어요.'}${top.length ? `\n\n**랭킹**\n${top.join('\n')}` : ''}` }],
    components: [
      ...(d.queued ? [row(button('대기 취소', 'tm:ql', 4), refreshBtn('tm'))] : [
        row(select('tm:q', '랭크전 — 역할 고르고 대기', d.roles.map((x: any) => ({ label: `${ROLE_ICON[x.id]} ${x.label}`, value: x.id, description: x.desc })))),
        row(button('친선 방 만들기', 'tm:c', 1), refreshBtn('tm')),
      ]),
    ],
  } };
}

export async function teamPress(call: Caller, id: string, values: string[] | undefined): Promise<Result> {
  const [, act, extra] = id.split(':');
  const post = async (path: string, body: unknown = {}) => { const r = await call('POST', path, body); return r.status === 200 ? null : fail(r); };
  let err: { error: any } | null = null;
  switch (act) {
    case 'q': err = await post('/api/team/queue', { role: values?.[0] }); break;
    case 'ql': err = await post('/api/team/queue/leave'); break;
    case 'c': err = await post('/api/team/room/create'); break;
    case 'tA': err = await post('/api/team/room/team', { team: 'A' }); break;
    case 'tB': err = await post('/api/team/room/team', { team: 'B' }); break;
    case 'r': err = await post('/api/team/room/role', { role: values?.[0] }); break;
    case 'y': {
      const [cur, meId] = [await call('GET', '/api/team/status'), await myId(call)];
      const me = cur.json?.match?.players?.find((p: any) => p.userId === meId);
      err = await post('/api/team/room/ready', { ready: !me?.ready }); break;
    }
    case 's': err = await post('/api/team/room/start'); break;
    case 'l': err = await post('/api/team/room/leave'); break;
    case 'f': break;
    case 'a': return actionResult(await call('POST', '/api/team/action', { action: 'attack', targetId: extra }), (m) => teamBattle(m), teamPublish);
    case 'g': return actionResult(await call('POST', '/api/team/action', { action: 'guard' }), (m) => teamBattle(m), teamPublish);
    case 'k': {
      const skillId = values?.[0] ?? '';
      const cur = await call('GET', '/api/team/status');
      if (cur.status !== 200) return fail(cur);
      if (needsAllyTarget(cur.json.match?.skills ?? {}, skillId)) return teamShow(call, skillId);
      // 적 단일 대상 스킬: 도발 중인 상대가 있으면 서버가 그 대상을 기본으로 고른다
      return actionResult(await call('POST', '/api/team/action', { action: 'skill', skillId }), (m) => teamBattle(m), teamPublish);
    }
    case 't': return actionResult(await call('POST', '/api/team/action', { action: 'skill', skillId: extra, targetId: values?.[0] }), (m) => teamBattle(m), teamPublish);
    default: break;
  }
  return err ?? teamShow(call);
}

