import { useCallback, useEffect, useRef, useState } from 'react';
import { itemById, starLabel } from '@rtgm/data';
import { canUseSkill, type Combatant } from '@rtgm/engine';
import { api, fmtWait, type RaidLobbyPayload, type RaidMemberView, type RaidRoomView } from '../api';
import { StatusBadges, Resources } from '../components/status';
import { useGame } from '../game';
import { Icon } from '../Icon';

type Role = NonNullable<RaidMemberView['role']>;
export const ROLE_ICON: Record<Role, string> = { tank: '🛡', dealer: '⚔', healer: '✚', support: '★' };
export const ROLE_LABEL: Record<Role, string> = { tank: '탱커', dealer: '딜러', healer: '힐러', support: '서포터' };

function Rewards({ r }: { r: NonNullable<RaidMemberView['rewards']> }) {
  return (
    <div className="muted gdesc">
      +{r.gold.toLocaleString()}D · 숙련도 +{r.proficiency}
      {r.items.map((i) => ` · ${itemById(i.itemId)?.name ?? i.itemId} ×${i.quantity}`)}
    </div>
  );
}

export function PartyCard({ c, m, round, mine, pickable, onPick, picked }: {
  c: Combatant; m?: RaidMemberView; round: number; mine: boolean; pickable?: boolean; onPick?: () => void; picked?: boolean;
}) {
  const pct = Math.max(0, Math.round((c.hp / c.stats.maxHp) * 100));
  return (
    <div className={`fighter${mine ? ' you' : ''}${c.hp <= 0 ? ' dead' : ''}${pickable ? ' pickable' : ''}${picked ? ' picked' : ''}`} onClick={pickable ? onPick : undefined}>
      <div className="fighter-name">
        {m?.role && <span title={ROLE_LABEL[m.role]}>{ROLE_ICON[m.role]} </span>}{c.name}{mine && ' (나)'}
        {m && m.submitted && c.hp > 0 && <span className="badge good">제출</span>}
        <StatusBadges who={c} round={round} />
      </div>
      <div className="hp-bar-wrap"><div className="hp-bar" style={{ width: `${pct}%` }} /></div>
      <div className="hp-label">{c.hp <= 0 ? '쓰러짐' : `HP ${c.hp}/${c.stats.maxHp}`}</div>
      <Resources who={c} />
    </div>
  );
}

function RaidBattle({ room, onChange }: { room: RaidRoomView; onChange: (r: RaidRoomView) => void }) {
  const { fail, refresh } = useGame();
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [pending, setPending] = useState<string>();
  const [left, setLeft] = useState(0);
  const skew = useRef(Date.now() - room.serverNow);
  skew.current = Date.now() - room.serverNow;
  const state = room.state!;
  const me = state.combatants.find((c) => c.id === room.mySlot);
  const boss = state.combatants.find((c) => c.id === 'enemy')!;
  const minions = state.combatants.filter((c) => c.role === 'minion' && c.hp > 0);
  const party = state.combatants.filter((c) => c.side === 'player');
  const active = room.status === 'active';
  const intent = state.intents?.enemy;
  const phase = state.boss?.runtime.phase ?? 1;
  const intentDef = intent ? (state.boss?.script.patterns[intent.patternId] as { kind?: string; interruptPct?: number[] } | undefined) : undefined;
  const need = (intent?.kind === 'charge' || intent?.kind === 'release') && intentDef?.kind === 'charge_attack' && intentDef.interruptPct ? Math.ceil(intentDef.interruptPct[phase - 1]! * boss.stats.maxHp) : undefined;
  const enrage = state.boss?.script.enrage;

  useEffect(() => {
    const t = window.setInterval(() => setLeft(Math.max(0, Math.ceil((room.deadline + skew.current - Date.now()) / 1000))), 500);
    return () => window.clearInterval(t);
  }, [room.deadline]);
  useEffect(() => { if (room.status === 'done') void refresh(); }, [room.status, refresh]);

  const act = async (body: Parameters<typeof api.raidAct>[0]) => {
    setBusy(true); setMenu(false); setPending(undefined);
    try { onChange(await api.raidAct(body)); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const submitted = room.members.find((m) => m.slot === room.mySlot)?.submitted ?? false;
  const canAct = active && room.needsAction && !submitted && !busy && !!me && me.hp > 0;
  const aliveMembers = room.members.filter((m) => (party.find((p) => p.id === m.slot)?.hp ?? 0) > 0);
  const skills = Object.values(room.skills);
  const pickSkill = (id: string) => {
    const s = room.skills[id]!;
    if (s.target === 'ally') { setMenu(false); setPending(id); } else void act({ action: 'skill', skillId: id });
  };

  return (
    <div className="battle-arena">
      <div className="battle-title">레이드 · {room.bossName} · {room.round}라운드 {active && <span className={`timer${left <= 10 ? ' hot' : ''}`}>⏱ {left}s</span>}</div>
      <div className="fighter boss">
        <div className="fighter-name">{boss.name} <span className="badge">{phase}페이즈</span>
          {enrage && room.round >= enrage.fromRound && <span className="badge bad">격노!</span>}
          <StatusBadges who={boss} round={state.round} /></div>
        <div className="hp-bar-wrap"><div className="hp-bar boss-hp" style={{ width: `${Math.max(0, Math.round((boss.hp / boss.stats.maxHp) * 100))}%` }} /></div>
        <div className="hp-label">HP {boss.hp}/{boss.stats.maxHp}</div>
        {minions.length > 0 && <div className="muted gdesc">{minions.map((m) => `${m.name} ${m.hp}`).join(' · ')} (보스를 회복시켜요)</div>}
      </div>
      {active && intent && (
        <div className={`intent${intent.kind === 'charge' || intent.kind === 'release' ? ' danger' : ''}`}>
          <div className="intent-head"><Icon name="info" /> <b>{intent.name}</b></div>
          <div>{intent.telegraph}</div>
          {need !== undefined && <div className="intent-hint">{intent.kind === 'charge' ? '충전 중 ' : '발동 전 '}파티가 한 라운드에 합계 {need} 이상 피해를 주면 끊을 수 있어요.</div>}
        </div>
      )}
      <div className={`battle-stack${party.length > 4 ? ' party-wide' : ''}`}>
        {party.map((c) => (
          <PartyCard key={c.id} c={c} m={room.members.find((m) => m.slot === c.id)} round={state.round} mine={c.id === room.mySlot}
            pickable={!!pending && c.hp > 0} picked={false} onPick={() => void act({ action: 'skill', skillId: pending, targetId: c.id })} />
        ))}
      </div>
      <div className="blog">
        {room.log.length === 0 ? <div className="le ls">레이드 시작! 역할에 맞게 행동을 고르세요.</div> : room.log.map((l, i) => <div key={i} className="le la">{l.text}</div>)}
      </div>
      {room.status === 'done' && (
        <div className={`turn-note pvp-result ${room.result === 'victory' ? 'me' : 'opponent'}`}>
          {room.result === 'victory' ? '🏆 레이드 성공!' : '레이드 실패…'}
          {room.members.find((m) => m.slot === room.mySlot)?.rewards && <Rewards r={room.members.find((m) => m.slot === room.mySlot)!.rewards!} />}
        </div>
      )}
      {active && (
        <>
          <div className="turn-note">
            {!me || me.hp <= 0 ? '쓰러졌어요. 파티를 지켜봐 주세요.' : !room.needsAction ? '충전한 스킬이 발동해요.' : submitted ? `선택 완료 · 파티원을 기다리는 중 (${aliveMembers.filter((m) => m.submitted).length}/${aliveMembers.length})` : pending ? '대상을 눌러 고르세요 (파티원 카드)' : '행동을 고르세요.'}
          </div>
          {menu && me && (
            <div className="skill-pick card">
              {skills.map((s) => {
                const ok = canUseSkill(state as Parameters<typeof canUseSkill>[0], me, s.id).ok;
                return (
                  <button key={s.id} className="skill-opt" disabled={!ok || !canAct} onClick={() => pickSkill(s.id)}>
                    <b>{s.name}</b> <span className="muted">AP {s.apCost}{s.ultimate ? ' · 궁극기' : ''}{s.cooldown ? ` · 쿨 ${s.cooldown}` : ''}{!ok ? ' · 사용 불가' : ''}</span>
                    <span className="muted gdesc">{(room.skills[s.id] as unknown as { description?: string }).description ?? ''}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="bactions sticky">
            <button className="btn btn-danger" disabled={!canAct} onClick={() => act({ action: 'attack' })}><Icon name="sword" /> 공격</button>
            <button className="btn btn-warn" disabled={!canAct} onClick={() => act({ action: 'guard' })}><Icon name="shield" /> 방어</button>
            <button className="btn btn-skill" disabled={!canAct} onClick={() => { setPending(undefined); setMenu((v) => !v); }}><Icon name="star" /> 스킬</button>
          </div>
        </>
      )}
    </div>
  );
}

export function Raid() {
  const { fail, toast, me } = useGame();
  const [data, setData] = useState<RaidLobbyPayload>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const room = data?.room ?? null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);

  const load = useCallback(async () => { try { setData(await api.raid()); } catch { /* 다음 주기 */ } }, []);
  useEffect(() => { void load(); }, [load]);
  // 대기실·전투 중에는 2초마다 최신 상태를 받는다
  useEffect(() => {
    const t = window.setInterval(() => { if (document.visibilityState === 'visible' && (!room || room.status !== 'done')) void load(); }, room?.status === 'active' ? 2000 : 3000);
    return () => window.clearInterval(t);
  }, [room, load]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast(ok); await load(); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  if (!data) return <div className="empty">불러오는 중...</div>;

  if (room && room.status !== 'lobby') {
    return (
      <>
        <RaidBattle room={room} onChange={(r) => setData({ ...data, room: r })} />
        {room.status === 'done' && (
          <div className="members-rewards card">
            <div className="card-title">파티원 보상</div>
            {room.members.map((m) => (
              <div key={m.userId} className="srow"><div className="sname">{m.role && ROLE_ICON[m.role]} {m.nickname}{m.miss >= 3 && <span className="muted"> (자리 비움)</span>}{m.rewards && <Rewards r={m.rewards} />}</div></div>
            ))}
            <button className="btn btn-primary" style={{ width: '100%', marginTop: 8 }} onClick={() => run(() => api.raidLeave())}>로비로</button>
          </div>
        )}
      </>
    );
  }

  if (room) {
    const mine = room.members.find((m) => m.userId === me?.id);
    const isLeader = room.leaderId === me?.id;
    const roleCount = (r: Role) => room.members.filter((m) => m.role === r).length;
    const allReady = room.members.length >= room.minParty && room.members.every((m) => m.role && (m.ready || m.userId === room.leaderId));
    return (
      <>
        <div className="card">
          <div className="card-title"><span className="stars">{starLabel(room.star)}</span> {room.bossName} · 대기실</div>
          <div className="stat-row"><span className="stat-label">초대 코드</span><b className="code">{room.code}</b></div>
          <div className="note">친구에게 코드를 알려 주세요. 대기실은 {data.lobbyMinutes}분 뒤에 사라져요. 파티원 {room.members.length}/{room.maxParty}명 · 최소 {room.minParty}명 · 적정 {room.recParty}명. 역할은 {room.roleCap === 1 ? '한 명에 하나씩 겹칠 수 없어요' : `역할마다 ${room.roleCap}명까지 고를 수 있어요`}.</div>
          {room.members.map((m) => (
            <div key={m.userId} className="srow">
              <div className="sname">{m.role ? `${ROLE_ICON[m.role]} ${ROLE_LABEL[m.role]}` : '역할 미정'} · {m.nickname}{m.userId === room.leaderId && ' 👑'}</div>
              <span className={m.ready || m.userId === room.leaderId ? 'res-win' : 'muted'}>{m.userId === room.leaderId ? '방장' : m.ready ? '준비 완료' : '대기'}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="card-title">내 역할</div>
          <div className="role-grid">
            {(Object.keys(ROLE_LABEL) as Role[]).map((r) => {
              const full = roleCount(r) >= room.roleCap && mine?.role !== r;
              const info = data.roles[r];
              return (
                <button key={r} className={`role-btn${mine?.role === r ? ' active' : ''}`} disabled={busy || full} onClick={() => run(() => api.raidRole(r))}>
                  <b>{ROLE_ICON[r]} {ROLE_LABEL[r]}</b>
                  <span className="muted gdesc">{info?.desc}</span>
                  <span className="badge">{roleCount(r)}/{room.roleCap}</span>
                </button>
              );
            })}
          </div>
          {mine?.role && data.roles[mine.role] && (
            <div className="note" style={{ marginTop: 8 }}>스킬: {data.roles[mine.role]!.skills.map((s) => s.name).join(' · ')}</div>
          )}
        </div>
        <div className="form-col">
          {!isLeader && <button className={`btn ${mine?.ready ? 'btn-ghost' : 'btn-success'}`} disabled={busy || !mine?.role} onClick={() => run(() => api.raidReady(!mine?.ready))}>{mine?.ready ? '준비 취소' : '준비 완료'}</button>}
          {isLeader && <button className="btn btn-primary" disabled={busy || !allReady} onClick={() => run(() => api.raidStart())}>{allReady ? '레이드 시작!' : '모두 역할을 고르고 준비해야 해요'}</button>}
          <button className="btn btn-ghost" disabled={busy} onClick={() => run(() => api.raidLeave())}>방 나가기</button>
        </div>
      </>
    );
  }

  return (
    <>
      {data.bosses.map((b) => {
        const locked = data.proficiency < b.minProficiency;
        const wait = Math.max(0, (data.cooldowns[b.id] ?? 0) - now);
        return (
          <div key={b.id} className="card">
            <div className="card-title"><Icon name={locked ? 'lock' : 'skull'} /> <span className="stars">{b.star > 0 ? '★'.repeat(b.star) + '☆'.repeat(5 - b.star) : '입문'}</span> {b.name}</div>
            <div className="note">{b.note}</div>
            <div className="stat-row"><span className="stat-label">입장 숙련도</span><span>{b.minProficiency}+ (현재 {data.proficiency})</span></div>
            <div className="stat-row"><span className="stat-label">파티</span><span>2~{b.maxParty}명 (적정 {b.recParty}명){b.maxParty >= 8 ? ' · 역할당 2명까지' : ' · 역할 1인 1개'}</span></div>
            <div className="stat-row"><span className="stat-label">재입장 대기</span><span>{b.cooldownMinutes >= 60 ? `${b.cooldownMinutes / 60}시간` : `${b.cooldownMinutes}분`} (패배 시 절반)</span></div>
            {wait > 0 && <div className="lock-label"><Icon name="lock" /> 대기 중 · {fmtWait(wait)} 남음</div>}
            <div className="stat-row"><span className="stat-label">보상</span><span>{b.gold[0].toLocaleString()}~{b.gold[1].toLocaleString()}D · {b.drops.map((d) => itemById(d.itemId)?.name).join(', ')}</span></div>
            <button className="btn btn-primary" style={{ width: '100%', marginTop: 8 }} disabled={busy || locked || wait > 0} onClick={() => run(() => api.raidCreate(b.id), '방을 만들었어요!')}>{locked ? `숙련도 ${b.minProficiency} 필요` : wait > 0 ? `대기 중 (${fmtWait(wait)})` : '방 만들기'}</button>
          </div>
        );
      })}
      <div className="card">
        <div className="card-title">코드로 입장</div>
        <form className="wiki-search" onSubmit={(e) => { e.preventDefault(); if (code.trim()) void run(() => api.raidJoin(code.trim()), '입장했어요!'); }}>
          <input value={code} maxLength={6} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="초대 코드 6자리" autoCapitalize="characters" />
          <button className="btn btn-primary" type="submit" disabled={busy || code.trim().length < 6}>입장</button>
        </form>
      </div>
      {data.friendRooms.length > 0 && (
        <div className="card">
          <div className="card-title">친구가 연 방</div>
          {data.friendRooms.map((r) => (
            <div key={r.code} className="srow">
              <div className="sname">{r.leader}님의 {r.bossName}<div className="muted gdesc">{r.members}/{r.max}명</div></div>
              <button className="btn btn-primary btn-sm" disabled={busy || r.members >= r.max} onClick={() => run(() => api.raidJoin(r.code), '입장했어요!')}>입장</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
