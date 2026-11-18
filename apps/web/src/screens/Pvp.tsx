import { useCallback, useEffect, useRef, useState } from 'react';
import { canUseSkill } from '@rtgm/engine';
import { api, type FriendsPayload, type PvpMatchView, type PvpStatus, type RankRow } from '../api';
import { Resources, StatusBadges } from '../components/status';
import { useGame } from '../game';
import { Icon } from '../Icon';

const SIGN = (n: number) => (n > 0 ? `+${n}` : String(n));

function Fighter({ c, round, you }: { c: PvpMatchView['state']['combatants'][number]; round: number; you?: boolean }) {
  const pct = Math.max(0, Math.round((c.hp / c.stats.maxHp) * 100));
  return (
    <div className={`fighter${you ? ' you' : ''}`}>
      <div className="fighter-name">{you ? '나' : c.name} {you && <span className="muted">({c.name})</span>}<StatusBadges who={c} round={round} /></div>
      <div className="hp-bar-wrap"><div className="hp-bar" style={{ width: `${pct}%` }} /></div>
      <div className="hp-label">HP {c.hp}/{c.stats.maxHp}</div>
      <Resources who={c} />
    </div>
  );
}

function Match({ id, onExit }: { id: string; onExit: () => void }) {
  const { toast, fail } = useGame();
  const [m, setM] = useState<PvpMatchView>();
  const [busy, setBusy] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [left, setLeft] = useState(0);
  const skew = useRef(0);
  const doneRef = useRef(false);

  const apply = useCallback((v: PvpMatchView) => {
    skew.current = Date.now() - v.serverNow; // 서버와 폰 시계의 차이를 보정한다
    doneRef.current = v.status === 'done';
    setM(v);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () => api.pvpMatch(id).then((v) => alive && apply(v)).catch(() => {});
    void tick();
    const t = window.setInterval(() => { if (!doneRef.current && document.visibilityState === 'visible') void tick(); }, 2000);
    return () => { alive = false; window.clearInterval(t); };
  }, [id, apply]);

  useEffect(() => {
    const t = window.setInterval(() => { if (m) setLeft(Math.max(0, Math.ceil((m.deadline + skew.current - Date.now()) / 1000))); }, 500);
    return () => window.clearInterval(t);
  }, [m]);

  if (!m) return <div className="empty">대전을 불러오는 중...</div>;
  const me = m.state.combatants.find((c) => c.id === m.mine)!;
  const foe = m.state.combatants.find((c) => c.id !== m.mine)!;
  const act = async (body: { action: 'attack' | 'guard' | 'skill'; skillId?: string }) => {
    setBusy(true); setShowSkills(false);
    try { apply(await api.pvpAct(id, body)); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const skillList = Object.values(m.skills);
  const full = m.state as Parameters<typeof canUseSkill>[0];
  const ready = (sid: string) => canUseSkill(full, me, sid).ok;
  const active = m.status === 'active';

  return (
    <div className="battle-arena">
      <div className="battle-title">
        {m.ranked ? '랭크전' : '친구 대전'} · {m.round}라운드 {active && <span className={`timer${left <= 10 ? ' hot' : ''}`}>⏱ {left}s</span>}
      </div>
      <div className="battle-stack">
        <Fighter c={me} round={m.round} you />
        <Fighter c={foe} round={m.round} />
      </div>
      <div className="blog">
        {m.log.length === 0 ? <div className="le ls">대전 시작! 행동을 고르면 상대와 동시에 처리돼요.</div> : m.log.map((l, i) => <div key={i} className="le la">{l.text}</div>)}
      </div>
      {m.result && (
        <div className={`turn-note pvp-result ${m.result.winner}`}>
          {m.result.winner === 'me' ? '🏆 승리!' : m.result.winner === 'draw' ? '무승부' : '패배'}
          {m.ranked && <> · 레이팅 {SIGN(m.result.ratingChange)}</>}
        </div>
      )}
      {active && (
        <>
          <div className="turn-note">
            {!m.needsAction ? '충전한 스킬이 발동해요.' : m.submitted ? (m.opponentSubmitted ? '처리 중…' : '선택 완료 · 상대를 기다리는 중…') : m.opponentSubmitted ? '상대가 선택했어요. 서두르세요!' : '행동을 고르세요.'}
          </div>
          {showSkills && (
            <div className="skill-pick card">
              {skillList.map((s) => {
                const ok = ready(s.id);
                return (
                  <button key={s.id} className="skill-opt" disabled={!ok || busy} onClick={() => act({ action: 'skill', skillId: s.id })}>
                    <b>{s.name}</b> <span className="muted">AP {s.apCost}{s.ultimate ? ' · 궁극기' : ''}{!ok ? ' · 사용 불가' : ''}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="bactions sticky">
            <button className="btn btn-danger" disabled={busy || m.submitted || !m.needsAction} onClick={() => act({ action: 'attack' })}><Icon name="sword" /> 공격</button>
            <button className="btn btn-warn" disabled={busy || m.submitted || !m.needsAction} onClick={() => act({ action: 'guard' })}><Icon name="shield" /> 방어</button>
            {skillList.length > 0 && <button className="btn btn-skill" disabled={busy || m.submitted || !m.needsAction} onClick={() => setShowSkills((v) => !v)}><Icon name="star" /> 스킬</button>}
          </div>
          <button className="btn btn-ghost forfeit" disabled={busy} onClick={() => { if (confirm('기권하면 패배로 처리돼요. 기권할까요?')) api.pvpForfeit(id).then(apply).catch(fail); }}>기권</button>
        </>
      )}
      {!active && <button className="btn btn-primary" onClick={() => { toast('대전이 끝났어요.'); onExit(); }}>로비로</button>}
    </div>
  );
}

export function Pvp() {
  const { fail, toast } = useGame();
  const [st, setSt] = useState<PvpStatus>();
  const [matchId, setMatchId] = useState<string>();
  const [friends, setFriends] = useState<FriendsPayload['friends']>([]);
  const [ranking, setRanking] = useState<RankRow[]>();
  const [busy, setBusy] = useState(false);
  const [waited, setWaited] = useState(0);

  const load = useCallback(async () => {
    try { const s = await api.pvpStatus(); setSt(s); if (s.matchId) setMatchId((cur) => cur ?? s.matchId!); } catch { /* 다음 주기에 다시 */ }
  }, []);
  useEffect(() => {
    void load();
    api.friends().then((d) => setFriends(d.friends)).catch(() => {});
    api.pvpRanking().then((r) => setRanking(r.ranking)).catch(() => {});
  }, [load]);
  // 로비에 있는 동안 3초마다: 대기 중 매칭 확인, 도전장 확인
  useEffect(() => {
    if (matchId) return;
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 3000);
    return () => window.clearInterval(t);
  }, [matchId, load]);
  useEffect(() => {
    if (!st?.queued || !st.queuedAt) { setWaited(0); return; }
    const t = window.setInterval(() => setWaited(Math.floor((Date.now() - st.queuedAt!) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [st?.queued, st?.queuedAt]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { const r = await fn(); if (ok) toast(ok); await load(); return r; } catch (e) { fail(e); } finally { setBusy(false); }
  };

  if (matchId) return <Match id={matchId} onExit={() => { setMatchId(undefined); void load(); api.pvpRanking().then((r) => setRanking(r.ranking)).catch(() => {}); }} />;
  if (!st) return <div className="empty">불러오는 중...</div>;

  return (
    <>
      <div className="card">
        <div className="card-title"><Icon name="sword" /> 랭크전 · 레이팅 {st.rating}</div>
        <div className="note">{st.wins}승 {st.losses}패 {st.draws}무 · 동시 선택 1:1. 아이템은 쓸 수 없고, 스탯은 PvP 상한(HP 300 · ATK 60 · DEF 30)으로 보정돼요. 라운드당 45초.</div>
        {st.queued ? (
          <button className="btn btn-ghost" disabled={busy} onClick={() => run(() => api.pvpLeave(), '대기를 취소했어요.')}>상대 찾는 중… {waited}초 (취소)</button>
        ) : (
          <button className="btn btn-primary" disabled={busy} onClick={async () => { const r = (await run(() => api.pvpQueue())) as { matchId?: string } | undefined; if (r?.matchId) setMatchId(r.matchId); }}>랭크전 찾기</button>
        )}
        {st.queued && <div className="note" style={{ marginTop: 8 }}>기다릴수록 매칭 범위가 넓어져요. 이 화면을 열어 둬야 매칭이 이어져요.</div>}
      </div>

      {st.incoming.length > 0 && (
        <div className="card">
          <div className="card-title">받은 도전장</div>
          {st.incoming.map((c) => (
            <div key={c.id} className="srow">
              <div className="sname">{c.nickname}님이 대전을 신청했어요</div>
              <div className="sbtns">
                <button className="btn btn-success btn-sm" disabled={busy} onClick={async () => { const r = (await run(() => api.pvpAccept(c.id))) as { matchId?: string } | undefined; if (r?.matchId) setMatchId(r.matchId); }}>수락</button>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api.pvpDecline(c.id))}>거절</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-title">친구에게 도전 (레이팅 변동 없음)</div>
        {friends.length === 0 ? <div className="muted">소셜 탭에서 친구를 먼저 추가해 보세요.</div> : (
          <select className="chat-dm" value="" onChange={(e) => { if (e.target.value) void run(() => api.pvpChallenge(e.target.value), '도전장을 보냈어요!'); }}>
            <option value="">도전할 친구 고르기…</option>
            {friends.map((f) => <option key={f.id} value={f.id}>{f.nickname}{f.online ? ' (접속 중)' : ''}</option>)}
          </select>
        )}
        {st.outgoing.map((c) => (
          <div key={c.id} className="srow">
            <div className="sname muted">{c.nickname}님의 수락을 기다리는 중</div>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api.pvpDecline(c.id), '취소했어요.')}>취소</button>
          </div>
        ))}
      </div>

      {st.history.length > 0 && (
        <div className="card">
          <div className="card-title">최근 전적</div>
          {st.history.map((h) => (
            <div key={h.id} className="srow">
              <div className="sname">vs {h.opponent} <span className="badge">{h.ranked ? '랭크' : '친선'}</span></div>
              <span className={h.result === 'win' ? 'res-win' : h.result === 'loss' ? 'res-loss' : 'muted'}>{h.result === 'win' ? '승' : h.result === 'loss' ? '패' : '무'}{h.ranked ? ` ${SIGN(h.ratingChange)}` : ''}</span>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-title">랭킹 TOP 20</div>
        {!ranking && <div className="muted">불러오는 중...</div>}
        {ranking?.length === 0 && <div className="muted">아직 전적이 있는 플레이어가 없어요.</div>}
        {ranking?.map((r) => (
          <div key={r.id} className={`srow${r.me ? ' wiki-mine' : ''}`}>
            <div className="sname">{r.rank}. {r.nickname} <span className="muted">{r.wins}승 {r.losses}패</span></div>
            <b>{r.rating}</b>
          </div>
        ))}
      </div>
    </>
  );
}
