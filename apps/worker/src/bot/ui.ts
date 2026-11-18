import { ITEMS, RECIPES, getNextTier, getProfTier, itemById, errorMessage, fmtWait } from '@rtgm/data';
import { canUseSkill, type BattleState, type Combatant } from '@rtgm/engine';
import { rowsToQuery, type Row } from './barimg';

/** 디스코드 메시지를 만드는 순수 함수들 (API 응답 → embed·버튼·선택 메뉴) */
export interface Msg { embeds?: unknown[]; components?: unknown[]; content?: string }

export const GOLD = 0xffd700, GREEN = 0x66bb6a, RED = 0xef5350, BLUE = 0x42a5f5;
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const row = (...components: unknown[]) => ({ type: 1, components });
export const button = (label: string, custom_id: string, style: 1 | 2 | 3 | 4 = 2, disabled = false) => ({ type: 2, style, label: clip(label, 80), custom_id, disabled });
export const select = (custom_id: string, placeholder: string, options: { label: string; value: string; description?: string }[]) => ({
  type: 3, custom_id, placeholder: clip(placeholder, 150), min_values: 1, max_values: 1,
  options: options.slice(0, 25).map((o) => ({ label: clip(o.label, 100), value: o.value, ...(o.description ? { description: clip(o.description, 100) } : {}) })),
});

/** HP 숫자 문구 (막대는 아래 이미지로 그린다) */
export const hpText = (hp: number, max: number) => `HP ${Math.max(0, hp)}/${max}`;

/** 이미지가 올라올 서버 주소 (요청마다 index.ts 가 정한다) */
let assetOrigin = 'https://rtgm.officialgl.com';
export const setAssetOrigin = (origin: string) => { assetOrigin = origin; };
/** HP·AP 막대 이미지 주소. 같은 값이면 같은 주소라 디스코드가 캐시한다 */
export const barsUrl = (rows: Row[]) => `${assetOrigin}/bot/bars.png?r=${rowsToQuery(rows)}`;
export const pct = (hp: number, max: number) => (max > 0 ? Math.max(hp > 0 ? 1 : 0, Math.round((hp / max) * 100)) : 0);
/** 전투원 한 명의 막대 한 줄 */
export const hpRow = (c: { hp: number; stats: { maxHp: number }; role?: string }, side: 'a' | 'f' | 'b'): Row =>
  c.hp <= 0 ? { t: 'x', pct: 0 } : { t: side, pct: pct(c.hp, c.stats.maxHp) };
export const pips = (ap: number | undefined, max = 6) => (ap === undefined ? '' : `${'●'.repeat(ap)}${'○'.repeat(Math.max(0, max - ap))}`);
const STATUS: Record<string, string> = {
  weaken: '약화', vulnerable: '취약', bleed: '출혈', slow: '둔화', frenzy: '광란', counter: '반격', ironwall: '철벽', ironwall_next: '철벽 여운',
  will: '의지', regen: '재생', shield: '보호막', morale: '사기', overdrive: '극한 개방', command: '지휘', unyielding: '불굴', lastshield: '최후의 방패',
};
export const statuses = (c: Combatant, round: number) => (c.statuses ?? []).filter((s) => s.until >= round).map((s) => STATUS[s.id] ?? s.id).join(' · ');

export const errorMsg = (code: string, data: Record<string, unknown> = {}): Msg => {
  if (code === 'not_linked') {
    return { embeds: [{ title: '🔗 계정 연동이 필요해요', color: BLUE, description: '1. 웹 **내 정보 → 디스코드 연동**에서 연동 코드를 만들어요.\n2. 디스코드에서 `/연동 코드:XXXXXXXX` 를 실행해요.' }] };
  }
  const text = code === 'battle not found' ? '내 전투가 아니거나 이미 끝난 전투예요.' : code === 'unauthorized' ? '봇 설정에 문제가 있어요. 운영자에게 알려 주세요.' : errorMessage(code, data);
  return { embeds: [{ color: RED, description: `⚠️ ${text}` }] };
};

// ─── 전투 ────────────────────────────────────────────────────────────────────

export interface BattleView {
  battleId: string; state: BattleState; log?: { text: string }[]; rewards?: { gold: number; proficiency: number; items: { name: string; quantity: number }[] }; deferred?: boolean;
  note?: string; mobName?: string; announce?: string;
}

export function battleMessage(v: BattleView): Msg {
  const { state } = v;
  const me = state.combatants.find((c) => c.id === 'player')!;
  const enemies = state.combatants.filter((c) => c.side === 'enemy');
  const boss = enemies.find((c) => c.id === 'enemy') ?? enemies[0]!;
  const over = state.status !== 'ongoing';
  const phase = state.boss?.runtime.phase;
  const intent = state.intents?.['enemy'];
  const fields: unknown[] = [
    { name: `🧑 ${me.name}`, value: `${hpText(me.hp, me.stats.maxHp)}${me.ap !== undefined ? ` · AP ${me.ap}/6` : ''}${me.gauge !== undefined ? ` · 궁극 ${me.gauge}%` : ''}${statuses(me, state.round) ? `\n${statuses(me, state.round)}` : ''}`, inline: false },
    ...enemies.map((e) => ({
      name: `${e.id === 'enemy' ? '👹' : e.role === 'minion' ? '👾' : '🛡️'} ${e.name}${e.id === 'enemy' && phase ? ` (${phase}페이즈)` : ''}`,
      value: `${hpText(e.hp, e.stats.maxHp)}${statuses(e, state.round) ? `\n${statuses(e, state.round)}` : ''}`, inline: false,
    })),
  ];
  if (!over && intent && state.boss) fields.push({ name: `⚠️ 다음 행동: ${intent.name}`, value: clip(intent.telegraph, 1000), inline: false });
  if (v.rewards) {
    fields.push({
      name: v.deferred ? '🎒 전리품에 추가 (탈출해야 받아요)' : state.status === 'victory' ? '🏆 보상' : '보상',
      value: `${v.rewards.gold.toLocaleString()}D · 숙련도 +${v.rewards.proficiency}${v.rewards.items.map((i) => ` · ${i.name} ×${i.quantity}`).join('')}`, inline: false,
    });
  }
  const logText = (v.log ?? []).slice(-8).map((l) => l.text).join('\n');
  const embed = {
    title: `⚔️ ${v.mobName ?? boss.name} · ${state.round}라운드`,
    description: clip([v.note, logText].filter(Boolean).join('\n\n') || '행동을 고르세요!', 3500),
    color: over ? (state.status === 'victory' ? GREEN : RED) : GOLD,
    fields,
    // 막대 그림: 적(위) → 나(아래, AP 점·궁극기 게이지 포함)
    image: { url: barsUrl([...enemies.map((e) => hpRow(e, e.id === 'enemy' && state.boss ? 'b' : 'f')), { t: 'gap' }, hpRow(me, 'a'), ...(me.ap !== undefined ? [{ t: 'pips', n: me.ap } as Row] : []), ...(me.gauge !== undefined ? [{ t: 'gauge', pct: me.gauge } as Row] : [])]) },
    footer: { text: over ? (state.status === 'victory' ? '승리!' : '패배…') : '행동은 라운드마다 동시에 처리돼요' },
  };
  if (over) return { embeds: [embed], components: v.deferred ? [row(button('던전으로 돌아가기', 'rv', 1))] : [] };

  const live = enemies.filter((e) => e.hp > 0);
  const charging = !!me.pending && me.pending.fireRound === state.round;
  const rows: unknown[] = [];
  if (charging) {
    rows.push(row(button('충전한 스킬 발동', `bt:${v.battleId}:grd`, 1)));
  } else {
    rows.push(row(
      ...live.slice(0, 4).map((e) => button(live.length === 1 ? '⚔ 공격' : `⚔ ${clip(e.name.split(' ')[0]!, 12)}`, `bt:${v.battleId}:atk:${e.id}`, 4)),
      button('🛡 방어', `bt:${v.battleId}:grd`, 1),
    ));
    const skills = Object.values(state.skills ?? {}).filter((s) => canUseSkill(state, me, s.id).ok);
    if (skills.length > 0) {
      rows.push(row(select(`bs:${v.battleId}`, '스킬 사용', skills.map((s) => ({ label: `${s.name}${s.ultimate ? ' (궁극기)' : ''}`, value: s.id, description: `AP ${s.apCost}${s.cooldown ? ` · 쿨 ${s.cooldown}` : ''}` })))));
    }
  }
  return { embeds: [embed], components: rows };
}

/** 소모품은 인벤토리에서 고른다 (전투 화면 선택 메뉴) */
export function withItems(msg: Msg, battleId: string, inv: { items: { itemId: string; quantity: number }[] }): Msg {
  const potions = inv.items.map((i) => ({ i, it: itemById(i.itemId) })).filter((x) => x.it?.type === 'consumable' && x.it.heal > 0);
  if (potions.length === 0 || !msg.components || msg.components.length === 0 || msg.components.length >= 5) return msg;
  return {
    ...msg,
    components: [...msg.components, row(select(`bi:${battleId}`, '아이템 사용', potions.map(({ i, it }) => ({ label: `${it!.name} ×${i.quantity}`, value: it!.id, description: it!.heal >= 9999 ? 'HP 완전 회복' : `HP +${it!.heal}` }))))],
  };
}

// ─── 로그라이크 던전 ───────────────────────────────────────────────────────────

const ROOM: Record<string, string> = { monster: '⚔️', treasure: '💰', trap: '🪤', nothing: '🌫️', clear: '🏆' };
const lootLine = (l: { gold: number; proficiency: number; items: { itemId: string; quantity: number }[] }) =>
  `${l.gold.toLocaleString()}D · 숙련도 +${l.proficiency}${l.items.map((i) => ` · ${itemById(i.itemId)?.name ?? i.itemId} ×${i.quantity}`).join('')}`;

export function runMessage(data: { proficiency?: number; gold?: number; dungeons?: any[]; run: any | null }, now = Date.now()): Msg {
  const run = data.run;
  if (run && run.status !== 'done') {
    const embed = {
      title: `🗺️ ${run.name} · ${run.floor}/${run.floors}층`, color: GOLD,
      image: { url: barsUrl([hpRow({ hp: run.hp, stats: { maxHp: run.maxHp } }, 'a')]) },
      description: `${hpText(run.hp, run.maxHp)}\n\n**전리품** (탈출해야 받아요)\n${lootLine(run.loot)}\n\n${(run.events ?? []).slice(-5).map((e: any) => `${ROOM[e.kind] ?? '·'} ${e.floor}층 · ${e.text}`).join('\n') || '아직 아무 방에도 들어가지 않았어요.'}`,
    };
    const last = run.floor + 1 >= run.floors;
    return { embeds: [embed], components: [row(button(last ? '⚠ 마지막 층으로' : `${run.floor + 1}층으로 내려가기`, 'rn', 1), button('후퇴하고 전리품 받기', 'rr', 2))] };
  }
  const list = (data.dungeons ?? []).map((d) => {
    const wait = Math.max(0, d.until - now);
    const locked = (data.proficiency ?? 0) < d.minProficiency;
    return { d, text: `**${d.name}** · ${d.floors}층 · ${d.entryGold > 0 ? `${d.entryGold}D` : '무료'}\n${locked ? `🔒 숙련도 ${d.minProficiency} 필요` : wait > 0 ? `⏳ 대기 ${fmtWait(wait)}` : `권장 숙련도 ${d.recommendedProficiency}`}`, locked, wait };
  });
  const embed = {
    title: '🗺️ 로그라이크 던전', color: BLUE,
    description: `층마다 ⚔️ 몬스터 · 💰 보물 · 🪤 함정 · 🌫️ 빈 방. 마지막 층은 최종 보스!\n모은 전리품은 완주하거나 후퇴해야 받고, 쓰러지면 잃어요.\n\n${list.map((x) => x.text).join('\n\n')}`,
  };
  const options = list.filter((x) => !x.locked && x.wait === 0 && (data.gold ?? 0) >= x.d.entryGold).map((x) => ({ label: x.d.name, value: x.d.id, description: `${x.d.floors}층 · ${x.d.entryGold > 0 ? `${x.d.entryGold}D` : '무료'}` }));
  return { embeds: [embed], components: options.length ? [row(select('rs', '입장할 던전 고르기', options))] : [] };
}

export function runResultMessage(run: any): Msg {
  const text = run.result === 'clear' ? '🏆 던전을 완주했어요!' : run.result === 'retreat' ? '전리품을 챙겨 빠져나왔어요.' : '💀 쓰러졌어요… 전리품을 잃었어요.';
  return { embeds: [{ title: `${run.name} · 결과`, color: run.result === 'dead' ? RED : GREEN, description: `${text}\n\n${run.result === 'dead' ? '받은 것 (숙련도만 조금)' : '받은 전리품'}\n${lootLine(run.loot)}` }] };
}

// ─── 프로필·인벤토리·스킬·상점 ──────────────────────────────────────────────────

export function profileMessage(me: any, inv: any, cooldowns: Record<string, number>, now = Date.now()): Msg {
  const tier = getProfTier(me.proficiency), next = getNextTier(me.proficiency);
  const equipped = inv.items.filter((i: any) => i.equipped).map((i: any) => itemById(i.itemId)?.name ?? i.itemId);
  const wait = cooldowns.explore ? Math.max(0, cooldowns.explore - now) : 0;
  return { embeds: [{
    title: `🧑 ${me.nickname}`, color: GOLD,
    fields: [
      { name: '달런트', value: `${me.gold.toLocaleString()} D`, inline: true },
      { name: '숙련도', value: `${me.proficiency} · ${tier.name}${next ? `\n다음 ${next.name}까지 ${next.min - me.proficiency}` : ''}`, inline: true },
      { name: '스탯', value: `HP ${inv.stats.maxHp} · ATK ${inv.stats.atk} · DEF ${inv.stats.def}`, inline: false },
      { name: '장비', value: equipped.join(', ') || '없음', inline: false },
      { name: '탐험', value: wait > 0 ? `⏳ ${fmtWait(wait)} 뒤에 가능` : '✅ 지금 탐험할 수 있어요', inline: false },
    ],
  }] };
}

export function inventoryMessage(inv: any): Msg {
  const rows = inv.items.map((r: any) => ({ r, it: itemById(r.itemId) })).filter((x: any) => x.it);
  const line = (x: any) => `${x.it.name}${x.r.quantity > 1 ? ` ×${x.r.quantity}` : ''}${x.r.equipped ? ' **[장착]**' : ''}`;
  const group = (types: string[]) => rows.filter((x: any) => types.includes(x.it.type)).map(line).join('\n') || '없음';
  const embed = {
    title: '🎒 인벤토리', color: BLUE,
    description: clip(`💰 ${inv.gold.toLocaleString()} D · HP ${inv.stats.maxHp} · ATK ${inv.stats.atk} · DEF ${inv.stats.def}`, 300),
    fields: [
      { name: '장비', value: clip(group(['sword', 'shield', 'armor']), 1000), inline: false },
      { name: '소모품', value: clip(group(['consumable']), 1000), inline: false },
      { name: '재료', value: clip(group(['material']), 1000), inline: false },
    ],
    footer: { text: '판매는 /판매, 장비 장착은 아래 메뉴' },
  };
  const eq = rows.filter((x: any) => ['sword', 'shield', 'armor'].includes(x.it.type));
  const components: unknown[] = [];
  const canEquip = eq.filter((x: any) => !x.r.equipped && inv.proficiency >= x.it.minProficiency);
  const isEquipped = eq.filter((x: any) => x.r.equipped);
  if (canEquip.length) components.push(row(select('ie', '장비 장착', canEquip.map((x: any) => ({ label: x.it.name, value: x.it.id, description: `${x.it.atk ? `ATK +${x.it.atk} ` : ''}${x.it.def ? `DEF +${x.it.def} ` : ''}${x.it.hp ? `HP +${x.it.hp}` : ''}`.trim() || undefined })))));
  if (isEquipped.length) components.push(row(select('iu', '장비 해제', isEquipped.map((x: any) => ({ label: x.it.name, value: x.it.id })))));
  return { embeds: [embed], components };
}

export function skillsMessage(data: any): Msg {
  const eq = data.skills.filter((s: any) => s.equipped);
  const normal = eq.filter((s: any) => !s.ultimate), ult = eq.filter((s: any) => s.ultimate);
  const fmt = (s: any) => `**${s.name}** · AP ${s.apCost}${s.cooldown ? ` · 쿨 ${s.cooldown}` : ''} — ${s.description}`;
  const embed = {
    title: '✨ 스킬', color: BLUE,
    description: `일반 ${normal.length}/${data.slots} · 궁극기 ${ult.length}/${data.ultimateSlots}\n\n${eq.map(fmt).join('\n') || '장착한 스킬이 없어요.'}`.slice(0, 4000),
  };
  const free = data.skills.filter((s: any) => s.unlocked && !s.equipped);
  const components: unknown[] = [];
  if (free.length) components.push(row(select('se', '스킬 장착', free.map((s: any) => ({ label: `${s.name}${s.ultimate ? ' (궁극기)' : ''}`, value: s.id, description: `AP ${s.apCost} · ${s.description}` })))));
  if (eq.length) components.push(row(select('su', '스킬 해제', eq.map((s: any) => ({ label: s.name, value: s.id })))));
  return { embeds: [embed], components };
}

export function shopMessage(proficiency: number): Msg {
  const items = ITEMS.filter((i) => i.buy !== null);
  const line = (i: (typeof ITEMS)[number]) => `${proficiency < i.minProficiency ? '🔒 ' : ''}${i.name} — ${i.buy!.toLocaleString()}D${i.atk ? ` · ATK ${i.atk}` : ''}${i.def ? ` · DEF ${i.def}` : ''}${i.hp ? ` · HP ${i.hp}` : ''}${i.heal ? ` · 회복 ${i.heal >= 9999 ? '완전' : i.heal}` : ''}${i.minProficiency > proficiency ? ` (숙련도 ${i.minProficiency})` : ''}`;
  const group = (types: string[]) => items.filter((i) => types.includes(i.type)).map(line).join('\n');
  return { embeds: [{
    title: '🏪 상점', color: GOLD, description: '`/구매 아이템:이름 수량:개수` 로 살 수 있어요. 🔒는 숙련도가 부족해요.',
    fields: [
      { name: '무기·방어구', value: clip(group(['sword', 'shield', 'armor']) || '없음', 1000) },
      { name: '소모품', value: clip(group(['consumable']) || '없음', 1000) },
    ],
  }] };
}

export function newsMessage(list: { text: string; at: number }[], now = Date.now()): Msg {
  const ago = (t: number) => { const m = Math.floor((now - t) / 60000); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`; };
  return { embeds: [{ title: '📢 최근 소식', color: GOLD, description: list.length ? clip([...list].reverse().map((a) => `${a.text}  ·  ${ago(a.at)}`).join('\n'), 4000) : '아직 소식이 없어요. 보스를 쓰러뜨리면 모두에게 알려져요!' }] };
}

export const helpMessage = (): Msg => ({ embeds: [{
  title: '⚔️ RTGM 봇', color: GOLD,
  description: [
    '웹과 같은 계정으로 디스코드에서 게임을 해요. (내 화면은 나만 볼 수 있어요)', '',
    '**시작하기**', '`/연동 코드:XXXXXXXX` — 웹 *내 정보 → 디스코드 연동*에서 코드를 만드세요', '',
    '**모험**', '`/탐험 지역` · `/보스 보스` · `/던전`', '',
    '**캐릭터**', '`/프로필` · `/인벤토리` · `/스킬`', '',
    '**경제**', '`/상점` · `/구매` · `/판매` · `/제작`', '',
    '**기타**', '`/소식` — 보스·레이드·던전 전체 알림',
    '', '**함께 하기**', '`/레이드` `/레이드입장` · `/대전` `/도전` · `/팀전` `/팀입장` · `/랭킹`', '`/친구` `/친구신청` `/유저` · `/길드` `/길드생성` `/길드기부`', '`/교환소` `/등록` · `/이벤트`',
    '', '동시 선택 전투는 다른 사람이 고를 때까지 🔄 새로고침으로 확인해요.',
  ].join('\n'),
}] });

/** 자동 완성에 쓰는 이름 → id 목록 */
export const recipeChoices = (q: string) =>
  RECIPES.map((r) => ({ name: itemById(r.resultId)?.name ?? r.resultId, value: r.id })).filter((x) => x.name.replace(/\s/g, '').includes(q.replace(/\s/g, ''))).slice(0, 25);
export const buyChoices = (q: string) =>
  ITEMS.filter((i) => i.buy !== null && i.name.replace(/\s/g, '').includes(q.replace(/\s/g, ''))).map((i) => ({ name: `${i.name} (${i.buy}D)`, value: i.id })).slice(0, 25);


// ─── 전체 공개 결과 ───────────────────────────────────────────────────────────

const pubFooter = { text: 'RTGM · 디스코드에서 즐기는 모험' };
const rewardText = (r?: { gold: number; proficiency: number; items?: { name?: string; itemId?: string; quantity: number }[] } | null) =>
  r ? `${r.gold.toLocaleString()}D · 숙련도 +${r.proficiency}${(r.items ?? []).map((i) => ` · ${i.name ?? (i.itemId ? itemById(i.itemId)?.name : '') ?? i.itemId} ×${i.quantity}`).join('')}` : '';

/** 일반 전투(탐험·보스) 결과 */
export function publicBattle(nick: string, mobName: string, state: BattleState, rewards: { gold: number; proficiency: number; items: { name: string; quantity: number }[] } | undefined, boss: boolean): Msg {
  const won = state.status === 'victory';
  const me = state.combatants.find((c) => c.id === 'player');
  return { embeds: [{
    color: won ? (boss ? GOLD : GREEN) : RED,
    title: won ? `${boss ? '👑' : '⚔️'} ${nick}님이 ${mobName}을(를) 쓰러뜨렸다!` : `💀 ${nick}님이 ${mobName}에게 쓰러졌다…`,
    description: [`**${state.round - 1}라운드**${me && won ? ` · 남은 HP ${me.hp}/${me.stats.maxHp}` : ''}`, won && rewards ? `🎁 ${rewardText(rewards)}` : ''].filter(Boolean).join('\n'),
    footer: pubFooter,
  }] };
}

/** 로그라이크 던전 결과 (완주·후퇴·사망) */
export function publicRun(nick: string, run: any): Msg {
  const title = run.result === 'clear' ? `🏆 ${nick}님이 ${run.name}을(를) 완주했다!` : run.result === 'retreat' ? `🎒 ${nick}님이 ${run.name}에서 전리품을 챙겨 돌아왔다` : `💀 ${nick}님이 ${run.name}에서 쓰러졌다…`;
  return { embeds: [{
    color: run.result === 'dead' ? RED : run.result === 'clear' ? GOLD : BLUE, title,
    description: `${run.floor}/${run.floors}층 도달\n${run.result === 'dead' ? '전리품을 모두 잃었다' : `🎁 ${rewardText(run.loot)}`}`,
    footer: pubFooter,
  }] };
}

const roleIcon: Record<string, string> = { tank: '🛡', dealer: '⚔', healer: '✚', support: '★' };
/** 레이드 결과: 파티원과 보상 */
export function publicRaid(room: any): Msg {
  const won = room.result === 'victory';
  const lines = room.members.map((m: any) => `${m.role ? `${roleIcon[m.role]} ` : ''}**${m.nickname}**${m.rewards ? ` — 🎁 ${rewardText(m.rewards)}` : ''}${m.miss >= 3 ? ' (자리 비움)' : ''}`);
  return { embeds: [{
    color: won ? GOLD : RED,
    title: won ? `🛡️ ${'★'.repeat(room.star ?? 0)} ${room.bossName} 레이드 클리어!` : `🛡️ ${room.bossName} 레이드 실패…`,
    description: clip(lines.join('\n'), 3800), footer: pubFooter,
  }] };
}

/** 1v1 PvP 결과 */
export function publicPvp(me: string, view: any): Msg {
  const w = view.result?.winner;
  const [winner, loser] = w === 'me' ? [me, view.opponent.nickname] : [view.opponent.nickname, me];
  const delta = view.result?.ratingChange ?? 0;
  return { embeds: [{
    color: w === 'draw' ? BLUE : GOLD,
    title: w === 'draw' ? `⚔️ ${me} vs ${view.opponent.nickname} — 무승부` : `⚔️ ${winner}님이 ${loser}님을 이겼다!`,
    description: `${view.ranked ? '랭크전' : '친선전'} · ${view.round}라운드${view.ranked && w !== 'draw' ? `\n${me}님 레이팅 ${delta > 0 ? '+' : ''}${delta}` : ''}`, footer: pubFooter,
  }] };
}

/** 4v4 팀전 결과: 양 팀 구성 */
export function publicTeam(view: any): Msg {
  const myTeam = view.myTeam as 'A' | 'B';
  const winner = view.result === 'win' ? myTeam : view.result === 'loss' ? (myTeam === 'A' ? 'B' : 'A') : null;
  const col = (t: string) => view.players.filter((p: any) => p.team === t).map((p: any) => `${roleIcon[p.role] ?? ''} ${p.nickname}${view.ranked ? ` (${p.delta > 0 ? '+' : ''}${p.delta})` : ''}`).join('\n') || '-';
  return { embeds: [{
    color: winner ? GOLD : BLUE,
    title: winner ? `⚔️ 4v4 ${view.ranked ? '랭크전' : '친선전'} — ${winner === 'A' ? '🔵 A팀' : '🔴 B팀'} 승리!` : `⚔️ 4v4 ${view.ranked ? '랭크전' : '친선전'} — 무승부`,
    fields: [{ name: `🔵 A팀${winner === 'A' ? ' 🏆' : ''}`, value: col('A'), inline: true }, { name: `🔴 B팀${winner === 'B' ? ' 🏆' : ''}`, value: col('B'), inline: true }],
    footer: pubFooter,
  }] };
}
