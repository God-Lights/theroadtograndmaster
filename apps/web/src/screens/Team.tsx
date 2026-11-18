import { useCallback, useEffect, useRef, useState } from 'react';
import { canUseSkill } from '@rtgm/engine';
import { api, type TeamMatchView, type TeamStatus } from '../api';
import { useGame } from '../game';
import { Icon } from '../Icon';
import { PartyCard, ROLE_ICON, ROLE_LABEL } from './Raid';

type Role = keyof typeof ROLE_LABEL;
const SIGN = (n: number) => (n > 0 ? `+${n}` : String(n));
const ROLES = Object.keys(ROLE_LABEL) as Role[];

function TeamBattle({ m, onChange, onExit }: { m: TeamMatchView; onChange: (v: TeamMatchView) => void; onExit: () => void }) {
  const { fail } = useGame();
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [pending, setPending] = useState<{ kind: 'attack' | 'skill'; skillId?: string; side: 'foe' | 'ally' }>();
  const [left, setLeft] = useState(0);
  const skew = useRef(Date.now() - m.serverNow);
  skew.current = Date.now() - m.serverNow;
  const arena = useRef<HTMLDivElement>(null);
  const state = m.state!;
  const me = state.combatants.find((c) => c.id === m.mySlot);
  const mySide = me?.side;
  const mine = state.combatants.filter((c) => c.side === mySide);
  const foes = state.combatants.filter((c) => c.side !== mySide);
  const active = m.status === 'active';
  const submitted = m.players.find((p) => p.slot === m.mySlot)?.submitted ?? false;
  const canAct = active && m.needsAction && !submitted && !busy && !!me && me.hp > 0;
  const taunter = foes.find((c) => c.hp > 0 && (c.statuses ?? []).some((s) => s.taunt && s.until >= state.round && (s.from ?? 0) <= state.round));
  const skills = Object.values(m.skills);

  useEffect(() => {
    const t = window.setInterval(() => setLeft(Math.max(0, Math.ceil((m.deadline + skew.current - Date.now()) / 1000))), 500);
    return () => window.clearInterval(t);
  }, [m.deadline]);

  // 대상을 골라야 할 때는 카드가 보이도록 화면 위로 올려 준다
  useEffect(() => { if (pending) arena.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, [pending]);

  const send = async (body: Parameters<typeof api.teamAct>[0]) => {
    setBusy(true); setMenu(false); setPending(undefined);
    try { onChange(await api.teamAct(body)); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const onPick = (targetId: string) => {
    if (!pending) return;
    void send(pending.kind === 'attack' ? { action: 'attack', targetId } : { action: 'skill', skillId: pending.skillId, targetId });
  };
  const useSkill = (id: string) => {
    const t = m.skills[id]!.target;
    if (t === 'enemy') setPending({ kind: 'skill', skillId: id, side: 'foe' });
    else if (t === 'ally') setPending({ kind: 'skill', skillId: id, side: 'ally' });
    else void send({ action: 'skill', skillId: id });
    setMenu(false);
  };
  const members = (c: { id: string }) => m.players.find((p) => p.slot === c.id);
  const aliveMine = m.players.filter((p) => (state.combatants.find((c) => c.id === p.slot)?.hp ?? 0) > 0);

  const column = (list: typeof mine, side: 'foe' | 'ally') =>
    list.map((c) => (
      <PartyCard key={c.id} c={c} m={members(c) as never} round={state.round} mine={c.id === m.mySlot}
        pickable={!!pending && pending.side === side && c.hp > 0 && (side !== 'foe' || !taunter || c.id === taunter.id)} onPick={() => onPick(c.id)} />
    ));

  return (
    <div className="battle-arena" ref={arena}>
      <div className="battle-title">{m.ranked ? '4v4 랭크전' : '4v4 친선전'} · {m.round}라운드 {active && <span className={`timer${left <= 10 ? ' hot' : ''}`}>⏱ {left}s</span>}</div>
      <div className="note">상대 팀</div>
      <div className={`battle-stack${foes.length > 4 ? ' party-wide' : ''}`}>{column(foes, 'foe')}</div>
      <div className="note">우리 팀</div>
      <div className={`battle-stack${mine.length > 4 ? ' party-wide' : ''}`}>{column(mine, 'ally')}</div>
      {taunter && active && <div className="note">⚠ {taunter.name}이(가) 도발 중이에요. 단일 공격은 {taunter.name}에게만 할 수 있어요.</div>}
      <div className="blog">
        {m.log.length === 0 ? <div className="le ls">대전 시작! 역할에 맞게 행동을 고르세요.</div> : m.log.map((l, i) => <div key={i} className="le la">{l.text}</div>)}
      </div>
      {m.result && (
        <div className={`turn-note pvp-result ${m.result === 'win' ? 'me' : m.result === 'loss' ? 'opponent' : ''}`}>
          {m.result === 'win' ? '🏆 승리!' : m.result === 'loss' ? '패배' : '무승부'}
          {m.ranked && (() => { const d = m.players.find((p) => p.slot === m.mySlot)?.delta ?? 0; return <> · 레이팅 {SIGN(d)}</>; })()}
        </div>
      )}
      {active && (
        <>
          <div className="turn-note">
            {!me || me.hp <= 0 ? '쓰러졌어요. 팀을 응원해 주세요.' : !m.needsAction ? '충전한 스킬이 발동해요.' : submitted
              ? `선택 완료 · 기다리는 중 (${aliveMine.filter((p) => p.submitted).length}/${aliveMine.length})`
              : pending ? (pending.side === 'foe' ? '공격할 상대 카드를 누르세요' : '대상 아군 카드를 누르세요') : '행동을 고르세요.'}
          </div>
          {menu && me && (
            <div className="skill-pick card">
              {skills.map((s) => {
                const ok = canUseSkill(state as Parameters<typeof canUseSkill>[0], me, s.id).ok;
                return (
                  <button key={s.id} className="skill-opt" disabled={!ok || !canAct} onClick={() => useSkill(s.id)}>
                    <b>{s.name}</b> <span className="muted">AP {s.apCost}{s.ultimate ? ' · 궁극기' : ''}{s.cooldown ? ` · 쿨 ${s.cooldown}` : ''}{!ok ? ' · 사용 불가' : ''}</span>
                    <span className="muted gdesc">{(m.skills[s.id] as unknown as { description?: string }).description ?? ''}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="bactions sticky">
            <button className="btn btn-danger" disabled={!canAct} onClick={() => { setMenu(false); const live = foes.filter((c) => c.hp > 0); if (live.length === 1 || taunter) void send({ action: 'attack', targetId: (taunter ?? live[0])!.id }); else setPending({ kind: 'attack', side: 'foe' }); }}><Icon name="sword" /> 공격</button>
            <button className="btn btn-warn" disabled={!canAct} onClick={() => send({ action: 'guard' })}><Icon name="shield" /> 방어</button>
            <button className="btn btn-skill" disabled={!canAct} onClick={() => { setPending(undefined); setMenu((v) => !v); }}><Icon name="star" /> 스킬</button>
          </div>
        </>
      )}
      {!active && <button className="btn btn-primary" onClick={onExit}>로비로</button>}
    </div>
  );
}

export function Team() {
  const { fail, toast, me } = useGame();
  const [st, setSt] = useState<TeamStatus>();
  const [role, setRole] = useState<Role>('dealer');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [waited, setWaited] = useState(0);

  const load = useCallback(async () => { try { setSt(await api.teamStatus()); } catch { /* 다음 주기 */ } }, []);
  useEffect(() => { void load(); }, [load]);
  const match = st?.match ?? null;
  useEffect(() => {
    const t = window.setInterval(() => { if (document.visibilityState === 'visible' && (!match || match.status !== 'done')) void load(); }, match?.status === 'active' ? 2000 : 3000);
    return () => window.clearInterval(t);
  }, [match, load]);
  useEffect(() => {
    if (!st?.queued) { setWaited(0); return; }
    const t = window.setInterval(() => setWaited(Math.floor((Date.now() - st.queued!.since) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [st?.queued]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { const r = await fn(); if (ok) toast(ok); await load(); return r; } catch (e) { fail(e); } finally { setBusy(false); }
  };
  if (!st) return <div className="empty">불러오는 중...</div>;

  if (match && match.status !== 'lobby') {
    return <TeamBattle m={match} onChange={(v) => setSt({ ...st, match: v })} onExit={() => run(() => api.teamRoomLeave())} />;
  }

  if (match) {
    const mine = match.players.find((p) => p.userId === me?.id);
    const isLeader = match.leaderId === me?.id;
    const takenInTeam = (r: Role) => match.players.some((p) => p.team === mine?.team && p.role === r && p.userId !== me?.id);
    const ready = match.players.every((p) => p.role && (p.ready || p.userId === match.leaderId));
    const hasBoth = match.players.some((p) => p.team === 'A') && match.players.some((p) => p.team === 'B');
    return (
      <>
        <div className="card">
          <div className="card-title">4v4 친선 방</div>
          <div className="stat-row"><span className="stat-label">초대 코드</span><b className="code">{match.code}</b></div>
          <div className="note">친구에게 코드를 알려 주세요. 팀마다 최대 {match.teamSize}명, 역할은 팀 안에서 겹치지 않게. 양 팀에 한 명 이상 있으면 시작할 수 있어요 (레이팅 변동 없음). 방은 30분 뒤 사라져요.</div>
          <div className="team-cols">
            {(['A', 'B'] as const).map((side) => (
              <div key={side} className="team-col">
                <div className="wiki-k">{side === 'A' ? '🔵 A팀' : '🔴 B팀'}</div>
                {match.players.filter((p) => p.team === side).map((p) => (
                  <div key={p.userId} className="muted gdesc">{p.role ? `${ROLE_ICON[p.role]} ${ROLE_LABEL[p.role]}` : '역할 미정'} · {p.nickname}{p.userId === match.leaderId && ' 👑'}{p.ready && p.userId !== match.leaderId ? ' ✔' : ''}</div>
                ))}
                {mine?.team !== side && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api.teamRoomTeam(side))}>이 팀으로</button>}
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-title">내 역할</div>
          <div className="role-grid">
            {ROLES.map((r) => (
              <button key={r} className={`role-btn${mine?.role === r ? ' active' : ''}`} disabled={busy || takenInTeam(r)} onClick={() => run(() => api.teamRoomRole(r))}>
                <b>{ROLE_ICON[r]} {ROLE_LABEL[r]}</b>
                <span className="muted gdesc">{st.roles.find((x) => x.id === r)?.desc}</span>
                {takenInTeam(r) && <span className="badge">선택됨</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="form-col">
          {!isLeader && <button className={`btn ${mine?.ready ? 'btn-ghost' : 'btn-success'}`} disabled={busy || !mine?.role} onClick={() => run(() => api.teamRoomReady(!mine?.ready))}>{mine?.ready ? '준비 취소' : '준비 완료'}</button>}
          {isLeader && <button className="btn btn-primary" disabled={busy || !ready || !hasBoth} onClick={() => run(() => api.teamRoomStart())}>{!hasBoth ? '양 팀에 한 명 이상 필요해요' : ready ? '대전 시작!' : '모두 역할을 고르고 준비해야 해요'}</button>}
          <button className="btn btn-ghost" disabled={busy} onClick={() => run(() => api.teamRoomLeave())}>방 나가기</button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="card">
        <div className="card-title"><Icon name="sword" /> 4v4 랭크전 · 레이팅 {st.rating}</div>
        <div className="note">{st.wins}승 {st.losses}패 {st.draws}무 · 팀마다 탱커·딜러·힐러·서포터 한 명씩. 역할을 고르고 대기하면 비슷한 레이팅의 8명이 모여 두 팀으로 나뉘어요. 아이템 사용 불가, 스탯은 PvP 상한(HP {st.cap.maxHp}·ATK {st.cap.atk}·DEF {st.cap.def})에 역할 배율. 도발하면 상대는 도발한 사람만 노릴 수 있어요.</div>
        {st.queued ? (
          <>
            <button className="btn btn-ghost" disabled={busy} onClick={() => run(() => api.teamQueueLeave(), '대기를 취소했어요.')}>{ROLE_LABEL[st.queued.role as Role]}로 대기 중… {waited}초 (취소)</button>
            <div className="note" style={{ marginTop: 8 }}>8명이 모여야 시작돼요. 기다릴수록 매칭 범위가 넓어져요. 이 화면을 열어 둬야 매칭이 이어져요.</div>
          </>
        ) : (
          <>
            <div className="role-grid">
              {ROLES.map((r) => (
                <button key={r} className={`role-btn${role === r ? ' active' : ''}`} onClick={() => setRole(r)}>
                  <b>{ROLE_ICON[r]} {ROLE_LABEL[r]}</b><span className="muted gdesc">{st.roles.find((x) => x.id === r)?.desc}</span>
                </button>
              ))}
            </div>
            <button className="btn btn-primary" style={{ width: '100%', marginTop: 8 }} disabled={busy} onClick={() => run(() => api.teamQueue(role))}>{ROLE_LABEL[role]}로 랭크전 찾기</button>
          </>
        )}
      </div>
      <div className="card">
        <div className="card-title">친구와 함께 (친선)</div>
        <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy} onClick={() => run(() => api.teamRoomCreate(), '방을 만들었어요!')}>친선 방 만들기</button>
        <form className="wiki-search" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); if (code.trim()) void run(() => api.teamRoomJoin(code.trim()), '입장했어요!'); }}>
          <input value={code} maxLength={6} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="초대 코드 6자리" autoCapitalize="characters" />
          <button className="btn btn-primary" type="submit" disabled={busy || code.trim().length < 6}>입장</button>
        </form>
      </div>
      <div className="card">
        <div className="card-title">팀전 랭킹 TOP 20</div>
        {st.ranking.length === 0 && <div className="muted">아직 전적이 있는 플레이어가 없어요.</div>}
        {st.ranking.map((r) => (
          <div key={r.id} className={`srow${r.me ? ' wiki-mine' : ''}`}><div className="sname">{r.rank}. {r.nickname} <span className="muted">{r.wins}승 {r.losses}패</span></div><b>{r.rating}</b></div>
        ))}
      </div>
    </>
  );
}
