import { useCallback, useEffect, useState } from 'react';
import { DISCORD_INVITE_URL } from '@rtgm/data';
import { api, fmtWait } from '../api';
import { useGame } from '../game';

/** 디스코드 봇 연동: 코드를 만들어 디스코드에서 봇에게 입력하면 이 계정으로 봇에서 게임을 할 수 있다 */
export function DiscordLink() {
  const { toast, fail } = useGame();
  const [st, setSt] = useState<{ linked: boolean; linkedAt: number | null; botEnabled: boolean }>();
  const [code, setCode] = useState<{ code: string; expiresAt: number }>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(() => api.discordStatus().then(setSt).catch(() => {}), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
  // 연동이 끝났는지 코드가 떠 있는 동안 몇 초마다 확인한다
  useEffect(() => {
    if (!code || st?.linked) return;
    const t = window.setInterval(() => { void load(); }, 4000);
    return () => window.clearInterval(t);
  }, [code, st?.linked, load]);
  useEffect(() => { if (st?.linked) setCode(undefined); }, [st?.linked]);

  if (!st || !st.botEnabled) return null; // 봇이 켜져 있지 않으면 보여 주지 않는다
  const left = code ? code.expiresAt - now : 0;

  return (
    <div className="card">
      <div className="card-title">디스코드 연동</div>
      {st.linked ? (
        <>
          <div className="note">디스코드 봇과 연동돼 있어요. 봇에서 이 계정으로 게임을 할 수 있어요. (연동일 {new Date(st.linkedAt!).toLocaleDateString('ko-KR')})</div>
          <button className="btn btn-ghost" disabled={busy} onClick={async () => { if (!confirm('연동을 해제할까요?')) return; setBusy(true); try { await api.discordUnlink(); toast('연동을 해제했어요.'); await load(); } catch (e) { fail(e); } finally { setBusy(false); } }}>연동 해제</button>
        </>
      ) : code && left > 0 ? (
        <>
          <div className="note">디스코드에서 봇의 <b>연동 명령어</b>에 아래 코드를 입력하세요. ({fmtWait(left)} 안에 한 번만 쓸 수 있어요)</div>
          <div className="stat-row"><span className="stat-label">연동 코드</span><b className="code">{code.code}</b></div>
        </>
      ) : (
        <>
          <div className="note">코드를 만들어 디스코드 봇에 입력하면 이 계정으로 디스코드에서 게임을 할 수 있어요. 아직 서버에 없다면 <a className="wlink" href={DISCORD_INVITE_URL} target="_blank" rel="noreferrer">여기서 입장</a>하세요.</div>
          <button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); try { setCode(await api.discordLinkCode()); } catch (e) { fail(e); } finally { setBusy(false); } }}>연동 코드 만들기</button>
        </>
      )}
    </div>
  );
}
