import { useCallback, useEffect, useState } from 'react';
import { getProfTier } from '@rtgm/data';
import { api, type UserRow } from '../api';
import { useGame } from '../game';

const ago = (t: number) => {
  const m = Math.floor((Date.now() - t) / 60000);
  return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`;
};

/** 유저 목록: 접속 중인 사람이 먼저. 닉네임으로 찾고 바로 친구 신청 */
export function Users() {
  const { toast, fail } = useGame();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [meta, setMeta] = useState({ total: 0, online: 0, hasMore: false });
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (text: string, offset: number) => {
    try {
      const r = await api.users(text, offset);
      setRows((prev) => (offset === 0 ? r.users : [...prev, ...r.users]));
      setMeta({ total: r.total, online: r.online, hasMore: r.hasMore });
      setLoaded(true);
    } catch (e) { fail(e); }
  }, [fail]);
  useEffect(() => { void load(query, 0); }, [load, query]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); await load(query, 0); } catch (e) { fail(e); } finally { setBusy(false); }
  };

  return (
    <>
      <form className="wiki-search" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="닉네임 검색" enterKeyHint="search" />
        <button className="btn btn-primary" type="submit">검색</button>
      </form>
      <div className="note">전체 {meta.total}명 · 지금 접속 중 {meta.online}명 (RTGM에 접속한 적 있는 유저)</div>
      <div className="card">
        {loaded && rows.length === 0 && <div className="muted">찾는 유저가 없어요.</div>}
        {rows.map((u) => (
          <div key={u.id} className="srow">
            <div className="sname">
              <span className={`dot${u.online ? ' on' : ''}`} /> {u.nickname} <span className="muted">{getProfTier(u.proficiency).name}</span>
              <div className="muted gdesc">{u.online ? '접속 중' : `${ago(u.lastSeen)} 접속`}</div>
            </div>
            {u.relation === 'none' && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(() => api.friendRequest(u.id), '친구 신청을 보냈어요.')}>친구 신청</button>}
            {u.relation === 'friend' && <span className="muted">친구</span>}
            {u.relation === 'sent' && <span className="muted">신청함</span>}
            {u.relation === 'received' && <button className="btn btn-success btn-sm" disabled={busy} onClick={() => act(() => api.friendAccept(u.id), '친구가 되었어요!')}>수락</button>}
          </div>
        ))}
        {meta.hasMore && <button className="btn btn-ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => load(query, rows.length)}>더 보기</button>}
      </div>
    </>
  );
}
