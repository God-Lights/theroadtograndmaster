import { useCallback, useEffect, useState } from 'react';
import { getProfTier } from '@rtgm/data';
import { api, type GuildDetail, type GuildListItem } from '../api';
import { useGame } from '../game';

const ROLE = { leader: '길드장', officer: '간부', member: '길드원' } as const;

export function Guild() {
  const { me, refresh, toast, fail } = useGame();
  const [mine, setMine] = useState<GuildDetail | null>();
  const [cost, setCost] = useState(1000);
  const [list, setList] = useState<GuildListItem[]>([]);
  const [cap, setCap] = useState(20);
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const g = await api.guild();
      setMine(g.guild); setCost(g.createCost);
      if (!g.guild) { const l = await api.guilds(); setList(l.guilds); setCap(l.capacity); }
    } catch (e) { fail(e); }
  }, [fail]);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); await Promise.all([load(), refresh()]); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const find = async (e: React.FormEvent) => { e.preventDefault(); try { setList((await api.guilds(q.trim())).guilds); } catch (err) { fail(err); } };

  if (mine === undefined) return <div className="empty">불러오는 중...</div>;

  if (!mine) {
    return (
      <>
        <div className="card">
          <div className="card-title">길드 만들기</div>
          <div className="note">만드는 데 {cost.toLocaleString()}D가 들어요. 길드원 최대 {cap}명.</div>
          <div className="form-col">
            <input value={name} maxLength={12} onChange={(e) => setName(e.target.value)} placeholder="길드 이름 (한글·영문·숫자 2~12자)" />
            <input value={desc} maxLength={100} onChange={(e) => setDesc(e.target.value)} placeholder="소개 (선택)" />
            <button className="btn btn-primary" disabled={busy || name.trim().length < 2 || (me?.gold ?? 0) < cost} onClick={() => act(() => api.guildCreate(name.trim(), desc), '길드를 만들었어요!')}>
              {(me?.gold ?? 0) < cost ? `달런트가 부족해요 (${cost.toLocaleString()}D)` : `만들기 (${cost.toLocaleString()}D)`}
            </button>
          </div>
        </div>
        <div className="card">
          <div className="card-title">길드 찾기</div>
          <form className="wiki-search" onSubmit={find}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="길드 이름 검색" enterKeyHint="search" />
            <button className="btn btn-ghost" type="submit">검색</button>
          </form>
          {list.length === 0 && <div className="muted">아직 길드가 없어요. 첫 길드를 만들어 보세요!</div>}
          {list.map((g) => (
            <div key={g.id} className="srow">
              <div className="sname">
                <b>{g.name}</b> <span className="badge">Lv.{g.level}</span>
                <div className="muted gdesc">{g.description || '소개가 없어요.'} · {g.members}/{cap}명</div>
              </div>
              <button className="btn btn-primary btn-sm" disabled={busy || g.members >= cap} onClick={() => act(() => api.guildJoin(g.id), `${g.name}에 가입했어요!`)}>{g.members >= cap ? '정원' : '가입'}</button>
            </div>
          ))}
        </div>
      </>
    );
  }

  const leader = mine.myRole === 'leader';
  const canKick = (role: string) => leader || (mine.myRole === 'officer' && role === 'member');
  const confirmDo = (msg: string, fn: () => Promise<unknown>, ok: string) => { if (confirm(msg)) void act(fn, ok); };
  return (
    <>
      <div className="card">
        <div className="card-title">{mine.name} <span className="badge">Lv.{mine.level}</span></div>
        <div className="note">{mine.description || '소개가 없어요.'}</div>
        <div className="stat-row"><span className="stat-label">길드원</span><span>{mine.members.length}/{mine.capacity}</span></div>
        <div className="stat-row"><span className="stat-label">길드 금고 (누적 기부)</span><span>{mine.gold.toLocaleString()}D</span></div>
        <div className="qty-row">
          <input inputMode="numeric" className="donate" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} placeholder="기부할 달런트" />
          <button className="btn btn-warn" disabled={busy || !amount || Number(amount) < 1 || Number(amount) > (me?.gold ?? 0)} onClick={() => { const n = Number(amount); setAmount(''); void act(() => api.guildDonate(n), `${n.toLocaleString()}D를 기부했어요.`); }}>기부</button>
        </div>
        <div className="note" style={{ marginTop: 8 }}>기부하면 길드 레벨이 올라가요. 금고의 돈은 꺼낼 수 없어요.</div>
      </div>
      <div className="card">
        <div className="card-title">길드원</div>
        {mine.members.map((m) => (
          <div key={m.id} className="srow">
            <div className="sname">
              <span className={`dot${m.online ? ' on' : ''}`} /> {m.nickname} {m.id === me?.id && <span className="muted">(나)</span>}
              <div className="muted gdesc"><span className={`role role-${m.role}`}>{ROLE[m.role]}</span> · {getProfTier(m.proficiency).name} · 기여 {m.contribution.toLocaleString()}D</div>
            </div>
            {m.id !== me?.id && (
              <div className="sbtns">
                {leader && m.role === 'member' && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(() => api.guildRole(m.id, 'officer'), '간부로 임명했어요.')}>간부</button>}
                {leader && m.role === 'officer' && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(() => api.guildRole(m.id, 'member'), '간부를 해임했어요.')}>해임</button>}
                {leader && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => confirmDo(`${m.nickname}님에게 길드장을 넘길까요?`, () => api.guildRole(m.id, 'leader'), '길드장을 넘겼어요.')}>위임</button>}
                {canKick(m.role) && m.role !== 'leader' && <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => confirmDo(`${m.nickname}님을 내보낼까요?`, () => api.guildKick(m.id), '내보냈어요.')}>추방</button>}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="form-col">
        {leader ? (
          <button className="btn btn-danger" disabled={busy} onClick={() => confirmDo('길드를 해산할까요? 되돌릴 수 없어요.', () => api.guildDisband(), '길드를 해산했어요.')}>길드 해산</button>
        ) : null}
        {!(leader && mine.members.length > 1) && (
          <button className="btn btn-ghost" disabled={busy} onClick={() => confirmDo('길드를 떠날까요?', () => api.guildLeave(), '길드를 떠났어요.')}>길드 떠나기</button>
        )}
        {leader && mine.members.length > 1 && <div className="note">길드장은 길드장을 넘긴 뒤에 떠날 수 있어요.</div>}
      </div>
    </>
  );
}
