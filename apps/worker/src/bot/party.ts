import { canUseSkill, type BattleState, type Combatant } from '@rtgm/engine';
import { barsUrl, button, clip, hpRow, hpText, row, select, statuses, GOLD, GREEN, RED, type Msg } from './ui';

/**
 * 동시 선택 전투(레이드·1v1·4v4) 공용 화면.
 * 디스코드 메시지는 자동으로 갱신되지 않으므로 '🔄 새로고침' 버튼으로 다른 사람의 선택을 확인한다.
 */
export interface PartyView {
  /** custom_id 접두사: ra(레이드) / tm(팀전) / pv(1v1) */
  kind: 'ra' | 'tm' | 'pv';
  title: string;
  round: number;
  deadline: number;
  serverNow: number;
  mySlot: string | null;
  needsAction: boolean;
  submitted: boolean;
  waiting?: string;
  state: BattleState;
  skills: Record<string, any>;
  log: { text: string }[];
  done: boolean;
  resultText?: string;
  extra?: { name: string; value: string }[];
  /** 아군을 고르는 중인 스킬 (대상 선택 단계) */
  pendingSkill?: string;
  names?: Record<string, string>;
}

const side = (c: Combatant) => c.side;
const label = (c: Combatant, mine: boolean) => `${mine ? '⭐ ' : ''}${c.name}`;

export function partyBattleMessage(v: PartyView): Msg {
  const { state } = v;
  const me = state.combatants.find((c) => c.id === v.mySlot);
  const mySide = me ? side(me) : 'player';
  const allies = state.combatants.filter((c) => side(c) === mySide && c.role !== 'minion');
  const foes = state.combatants.filter((c) => side(c) !== mySide);
  const boss = state.boss ? foes.find((c) => c.role === 'boss' || c.id === 'enemy') : undefined;
  const phase = state.boss?.runtime.phase;
  const intent = state.intents?.['enemy'];
  const left = Math.max(0, Math.ceil((v.deadline + (Date.now() - v.serverNow) - Date.now()) / 1000));

  const fmt = (c: Combatant) => `${c.hp <= 0 ? '💀' : '·'} **${label(c, c.id === v.mySlot)}** ${c.hp <= 0 ? '쓰러짐' : hpText(c.hp, c.stats.maxHp)}${c.ap !== undefined && c.hp > 0 ? ` · AP ${c.ap}` : ''}${statuses(c, state.round) ? ` _${statuses(c, state.round)}_` : ''}`;
  const fields: unknown[] = [
    { name: state.boss ? '🛡 파티' : '🔵 우리 팀', value: clip(allies.map(fmt).join('\n') || '-', 1000) },
    { name: state.boss ? `👹 ${boss?.name ?? '보스'}${phase ? ` (${phase}페이즈)` : ''}` : '🔴 상대 팀', value: clip(foes.map(fmt).join('\n') || '-', 1000) },
  ];
  if (!v.done && intent && state.boss) fields.push({ name: `⚠️ 다음 행동: ${intent.name}`, value: clip(intent.telegraph, 1000) });
  for (const f of v.extra ?? []) fields.push(f);

  const status = v.done ? '' : !me || me.hp <= 0 ? '쓰러졌어요. 🔄로 진행을 지켜보세요.'
    : !v.needsAction ? '충전한 스킬이 발동해요. 🔄로 확인하세요.'
      : v.submitted ? `✅ 선택 완료 · ${v.waiting ?? '다른 참가자를 기다리는 중'} (⏱ ${left}초)`
        : v.pendingSkill ? '스킬을 쓸 **아군 대상**을 고르세요.' : `행동을 고르세요. (⏱ ${left}초)`;
  const embed = {
    title: `${v.title} · ${state.round}라운드`,
    description: clip([status, v.resultText, (v.log ?? []).slice(-6).map((l) => l.text).join('\n')].filter(Boolean).join('\n\n') || '시작!', 3600),
    color: v.done ? (v.resultText?.includes('승리') || v.resultText?.includes('성공') ? GREEN : RED) : GOLD,
    fields,
    // 막대 그림은 위 목록과 같은 순서 (우리 팀 → 상대 팀). 초록=우리, 빨강=상대, 금색=보스
    image: { url: barsUrl([...allies.map((c) => hpRow(c, 'a')), { t: 'gap' }, ...foes.map((c) => hpRow(c, c.role === 'boss' || (state.boss && c.id === 'enemy') ? 'b' : 'f'))]) },
  };

  const refresh = button('🔄 새로고침', `${v.kind}:f`, 2);
  if (v.done) return { embeds: [embed], components: [row(button('로비로', `${v.kind}:l`, 1), refresh)] };
  const canAct = !!me && me.hp > 0 && v.needsAction && !v.submitted;
  if (!canAct) return { embeds: [embed], components: [row(refresh)] };

  // 아군 대상 선택 단계
  if (v.pendingSkill) {
    const liveAllies = allies.filter((c) => c.hp > 0);
    return { embeds: [embed], components: [row(select(`${v.kind}:t:${v.pendingSkill}`, '대상 아군 고르기', liveAllies.map((c) => ({ label: c.name, value: c.id, description: `HP ${c.hp}/${c.stats.maxHp}` })))), row(refresh)] };
  }
  const live = foes.filter((c) => c.hp > 0);
  const rows: unknown[] = [row(
    ...live.slice(0, 4).map((c) => button(live.length === 1 ? '⚔ 공격' : `⚔ ${clip(c.name.split(' ')[0]!, 10)}`, `${v.kind}:a:${c.id}`, 4)),
    button('🛡 방어', `${v.kind}:g`, 1),
  )];
  const usable = Object.values(v.skills ?? {}).filter((s: any) => state.skills?.[s.id] ? canUseSkill(state, me, s.id).ok : false);
  if (usable.length) {
    rows.push(row(select(`${v.kind}:k`, '스킬 사용', usable.map((s: any) => ({ label: `${s.name}${s.ultimate ? ' (궁극기)' : ''}`, value: s.id, description: `AP ${s.apCost}${s.cooldown ? ` · 쿨 ${s.cooldown}` : ''} · ${s.target === 'ally' ? '아군 선택' : s.target === 'all_allies' ? '아군 전체' : s.target === 'self' ? '자신' : '적'}` })))));
  }
  rows.push(row(refresh));
  return { embeds: [embed], components: rows };
}

/** 스킬 선택 값 → 대상이 필요한 스킬인가 */
export const needsAllyTarget = (skills: Record<string, any>, id: string) => skills?.[id]?.target === 'ally';
