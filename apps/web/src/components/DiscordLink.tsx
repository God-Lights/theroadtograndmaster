import { useCallback, useEffect, useState } from 'react';
import { DISCORD_INVITE_URL } from '@rtgm/data';
import { api, fmtWait } from '../api';
import { useGame } from '../game';

/** 봇 연동(디스코드·카카오톡): 코드를 만들어 봇에게 입력하면 이 계정으로 봇에서 게임을 할 수 있다. 코드는 두 봇 모두에 쓸 수 있다 */
export function DiscordLink() {
  const { toast, fail } = useGame();
  const [st, setSt] = useState<{ linked: boolean; linkedAt: number | null; botEnabled: boolean; kakaoLinked: boolean; kakaoLinkedAt: number | null; kakaoEnabled: boolean }>();
  const [code, setCode] = useState<{ code: string; expiresAt: number }>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(() => api.discordStatus().then(setSt).catch(() => {}), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
  // 연동이 끝났는지 코드가 떠 있는 동안 몇 초마다 확인한다
  useEffect(() => {
    if (!code || (st?.linked && st?.kakaoLinked)) return;
    const t = window.setInterval(() => { void load(); }, 4000);
    return () => window.clearInterval(t);
  }, [code, st?.linked, st?.kakaoLinked, load]);
  useEffect(() => { if (st?.linked || st?.kakaoLinked) setCode(undefined); }, [st?.linked, st?.kakaoLinked]);

  if (!st || (!st.botEnabled && !st.kakaoEnabled)) return null; // 봇이 켜져 있지 않으면 보여 주지 않는다
  const anyLinked = st.linked || st.kakaoLinked;
  const left = code ? code.expiresAt - now : 0;

  return (
    <div className="card">
      <div className="card-title">봇 연동</div>
      {st.linked && (
        <div className="stat-row"><span className="stat-label">디스코드</span><span>연동됨 ({new Date(st.linkedAt!).toLocaleDateString('ko-KR')}) <button className="btn btn-ghost" disabled={busy} onClick={async () => { if (!confirm('디스코드 연동을 해제할까요?')) return; setBusy(true); try { await api.discordUnlink(); toast('연동을 해제했어요.'); await load(); } catch (e) { fail(e); } finally { setBusy(false); } }}>해제</button></span></div>
      )}
      {st.kakaoLinked && (
        <div className="stat-row"><span className="stat-label">카카오톡</span><span>연동됨 ({new Date(st.kakaoLinkedAt!).toLocaleDateString('ko-KR')}) <button className="btn btn-ghost" disabled={busy} onClick={async () => { if (!confirm('카카오톡 연동을 해제할까요?')) return; setBusy(true); try { await api.kakaoUnlink(); toast('연동을 해제했어요.'); await load(); } catch (e) { fail(e); } finally { setBusy(false); } }}>해제</button></span></div>
      )}
      {code && left > 0 ? (
        <>
          <div className="note">디스코드는 봇의 <b>/연동</b>, 카카오톡은 봇과의 1:1 대화에서 <b>!연동 코드</b>로 아래 코드를 입력하세요. ({fmtWait(left)} 안에 한 번만 쓸 수 있어요)</div>
          <div className="stat-row"><span className="stat-label">연동 코드</span><b className="code">{code.code}</b></div>
        </>
      ) : (
        <>
          <div className="note">{anyLinked ? '다른 봇도 연동하려면 새 코드를 만드세요.' : '코드를 만들어 봇에 입력하면 이 계정으로 봇에서 게임을 할 수 있어요.'}{st.botEnabled && <> 디스코드가 처음이면 <a className="wlink" href={DISCORD_INVITE_URL} target="_blank" rel="noreferrer">여기서 입장</a>하세요.</>}</div>
          <button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); try { setCode(await api.discordLinkCode()); } catch (e) { fail(e); } finally { setBusy(false); } }}>연동 코드 만들기</button>
        </>
      )}
    </div>
  );
}
