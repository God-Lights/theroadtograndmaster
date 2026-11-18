import { useCallback, useEffect, useState } from 'react';
import { getProfTier } from '@rtgm/data';
import { api, type FriendsPayload, type Person, type Relation } from '../api';
import { useGame } from '../game';

const Dot = ({ on }: { on: boolean }) => <span className={`dot${on ? ' on' : ''}`} title={on ? '접속 중' : '오프라인'} />;

export function Friends({ onWhisper }: { onWhisper: (p: Person) => void }) {
  const { toast, fail } = useGame();
  const [data, setData] = useState<FriendsPayload>();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<(Person & { relation: Relation })[]>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.friends().then(setData).catch(fail), [fail]);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); await load(); if (q.trim().length >= 2) setHits((await api.searchPlayers(q.trim())).players); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 2) return toast('닉네임을 2글자 이상 입력해 주세요.', 'warn');
    try { setHits((await api.searchPlayers(q.trim())).players); } catch (err) { fail(err); }
  };
  const tier = (p: Person) => getProfTier(p.proficiency).name;

  return (
    <>
      <form className="wiki-search" onSubmit={search}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="닉네임으로 플레이어 찾기" enterKeyHint="search" />
        <button className="btn btn-primary" type="submit">검색</button>
      </form>
      {hits && (
        <div className="card">
          <div className="card-title">검색 결과</div>
          {hits.length === 0 && <div className="muted">찾지 못했어요. (RTGM에 접속한 적 있는 플레이어만 찾을 수 있어요)</div>}
          {hits.map((p) => (
            <div key={p.id} className="srow">
              <div className="sname"><Dot on={p.online} /> {p.nickname} <span className="muted">{tier(p)}</span></div>
              {p.relation === 'none' && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(() => api.friendRequest(p.id), '친구 신청을 보냈어요.')}>친구 신청</button>}
              {p.relation === 'friend' && <span className="muted">친구</span>}
              {p.relation === 'sent' && <span className="muted">신청함</span>}
              {p.relation === 'received' && <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act(() => api.friendAccept(p.id), '친구가 되었어요!')}>수락</button>}
            </div>
          ))}
        </div>
      )}
      {data && data.incoming.length > 0 && (
        <div className="card">
          <div className="card-title">받은 신청 ({data.incoming.length})</div>
          {data.incoming.map((p) => (
            <div key={p.id} className="srow">
              <div className="sname">{p.nickname} <span className="muted">{tier(p)}</span></div>
              <div className="sbtns">
                <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act(() => api.friendAccept(p.id), '친구가 되었어요!')}>수락</button>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(() => api.friendRemove(p.id), '거절했어요.')}>거절</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="card">
        <div className="card-title">친구 {data ? `(${data.friends.length}/50)` : ''}</div>
        {!data && <div className="muted">불러오는 중...</div>}
        {data && data.friends.length === 0 && <div className="muted">아직 친구가 없어요. 닉네임으로 찾아서 신청해 보세요.</div>}
        {data?.friends.map((p) => (
          <div key={p.id} className="srow">
            <div className="sname"><Dot on={p.online} /> {p.nickname} <span className="muted">{tier(p)}</span></div>
            <div className="sbtns">
              <button className="btn btn-info btn-sm" onClick={() => onWhisper(p)}>귓속말</button>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { if (confirm(`${p.nickname}님을 친구에서 삭제할까요?`)) void act(() => api.friendRemove(p.id), '삭제했어요.'); }}>삭제</button>
            </div>
          </div>
        ))}
      </div>
      {data && data.outgoing.length > 0 && (
        <div className="card">
          <div className="card-title">보낸 신청</div>
          {data.outgoing.map((p) => (
            <div key={p.id} className="srow">
              <div className="sname">{p.nickname}</div>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(() => api.friendRemove(p.id), '신청을 취소했어요.')}>취소</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
