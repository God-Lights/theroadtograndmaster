import { useCallback, useEffect, useState } from 'react';
import { itemById, ITEMS } from '@rtgm/data';
import { api, type GameEvent } from '../api';
import { useGame } from '../game';

const fmtDate = (t: number) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const KIND: Record<GameEvent['kind'], string> = { notice: '공지', bonus: '보너스', gift: '선물' };

export function describeConfig(e: Pick<GameEvent, 'kind' | 'config'>): string {
  if (e.kind === 'bonus') {
    const c = e.config;
    return [c.gold && `골드 ×${c.gold}`, c.proficiency && `숙련도 ×${c.proficiency}`, c.drop && `드롭률 ×${c.drop}`].filter(Boolean).join(' · ');
  }
  if (e.kind === 'gift') {
    const c = e.config;
    return [c.gold ? `${c.gold.toLocaleString()}D` : '', ...(c.items ?? []).map((i) => `${itemById(i.itemId)?.name ?? i.itemId} ×${i.quantity}`)].filter(Boolean).join(', ');
  }
  return '';
}

/** 진행 중·예정 이벤트 (내 정보 화면). 선물은 여기서 받는다. */
export function Events() {
  const { refresh, toast, fail } = useGame();
  const [list, setList] = useState<GameEvent[]>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.events().then((r) => setList(r.events)).catch(() => setList([])), []);
  useEffect(() => { void load(); }, [load]);
  if (!list || list.length === 0) return null;

  const claim = async (e: GameEvent) => {
    setBusy(true);
    try { await api.claimEvent(e.id); toast(`${e.title} 선물을 받았어요!`); await Promise.all([load(), refresh()]); } catch (err) { fail(err); await load(); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <div className="card-title">이벤트</div>
      {list.map((e) => (
        <div key={e.id} className="wiki-def">
          <div className="wiki-k">{e.title} <span className="badge">{KIND[e.kind]}</span>{e.status === 'upcoming' && <span className="badge">예정</span>}</div>
          {e.description && <div>{e.description}</div>}
          {describeConfig(e) && <div className="item-stat">{describeConfig(e)}</div>}
          <div className="muted gdesc">{fmtDate(e.startsAt)} ~ {fmtDate(e.endsAt)}</div>
          {e.kind === 'gift' && e.status === 'active' && (
            e.claimed ? <div className="muted">받았어요 ✔</div>
              : <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => claim(e)}>선물 받기</button>
          )}
        </div>
      ))}
    </div>
  );
}

const toLocalInput = (t: number) => { const d = new Date(t - new Date().getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
const GIFT_ITEMS = ITEMS.filter((i) => i.type !== 'material' || i.sell > 0);

/** 관리자 전용: 이벤트 만들기·중단. 권한은 서버가 매번 검사한다. */
export function AdminEvents() {
  const { toast, fail } = useGame();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<GameEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<GameEvent['kind']>('notice');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [start, setStart] = useState(() => toLocalInput(Date.now()));
  const [end, setEnd] = useState(() => toLocalInput(Date.now() + 7 * 86_400_000));
  const [gold, setGold] = useState('');
  const [item, setItem] = useState('');
  const [qty, setQty] = useState('1');
  const [mult, setMult] = useState({ gold: '', proficiency: '', drop: '' });

  const load = useCallback(() => api.adminEvents().then((r) => setList(r.events)).catch(fail), [fail]);
  useEffect(() => { if (open) void load(); }, [open, load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const config = kind === 'bonus'
      ? { gold: mult.gold, proficiency: mult.proficiency, drop: mult.drop }
      : kind === 'gift' ? { gold: Number(gold || 0), items: item ? [{ itemId: item, quantity: Number(qty) }] : [] } : {};
    setBusy(true);
    try {
      await api.adminCreateEvent({ title, description: desc, kind, config, startsAt: new Date(start).getTime(), endsAt: new Date(end).getTime() });
      toast('이벤트를 만들었어요!'); setTitle(''); setDesc(''); await load();
    } catch (err) { fail(err); } finally { setBusy(false); }
  };
  const cancel = async (ev: GameEvent) => {
    if (!confirm(`‘${ev.title}’ 이벤트를 중단할까요?`)) return;
    try { await api.adminCancelEvent(ev.id); toast('중단했어요.'); await load(); } catch (err) { fail(err); }
  };

  return (
    <div className="card">
      <div className="card-title">관리자 · 이벤트 관리 <button className="btn btn-ghost btn-sm" onClick={() => setOpen((v) => !v)}>{open ? '접기' : '열기'}</button></div>
      {open && (
        <>
          <form className="form-col" onSubmit={submit}>
            <select value={kind} onChange={(e) => setKind(e.target.value as GameEvent['kind'])}>
              <option value="notice">공지 (알림만)</option>
              <option value="bonus">보너스 (보상 배율)</option>
              <option value="gift">선물 (1인 1회 수령)</option>
            </select>
            <input value={title} maxLength={40} onChange={(e) => setTitle(e.target.value)} placeholder="제목 (2~40자)" />
            <input value={desc} maxLength={300} onChange={(e) => setDesc(e.target.value)} placeholder="설명 (선택)" />
            <label className="note">시작<input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
            <label className="note">종료<input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
            {kind === 'bonus' && (
              <div className="qty-row">
                {(['gold', 'proficiency', 'drop'] as const).map((k) => (
                  <input key={k} inputMode="decimal" value={mult[k]} onChange={(e) => setMult({ ...mult, [k]: e.target.value })} placeholder={{ gold: '골드 ×', proficiency: '숙련도 ×', drop: '드롭률 ×' }[k]} aria-label={k} />
                ))}
              </div>
            )}
            {kind === 'gift' && (
              <>
                <input inputMode="numeric" value={gold} onChange={(e) => setGold(e.target.value.replace(/\D/g, ''))} placeholder="달런트 (0~1,000,000)" />
                <div className="qty-row">
                  <select value={item} onChange={(e) => setItem(e.target.value)}>
                    <option value="">아이템 없음</option>
                    {GIFT_ITEMS.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                  </select>
                  <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} placeholder="수량" aria-label="수량" />
                </div>
              </>
            )}
            <button className="btn btn-primary" type="submit" disabled={busy || title.trim().length < 2}>이벤트 만들기</button>
          </form>
          <div className="card-title" style={{ marginTop: 14 }}>만든 이벤트</div>
          {list.length === 0 && <div className="muted">아직 없어요.</div>}
          {list.map((e) => (
            <div key={e.id} className="srow">
              <div className="sname">
                {e.title} <span className="badge">{KIND[e.kind]}</span>
                <div className="muted gdesc">{{ active: '진행 중', upcoming: '예정', ended: '종료', cancelled: '중단됨' }[e.status]} · {describeConfig(e) || '공지'}{e.kind === 'gift' ? ` · 수령 ${e.claims ?? 0}명` : ''}</div>
              </div>
              {(e.status === 'active' || e.status === 'upcoming') && <button className="btn btn-danger btn-sm" onClick={() => cancel(e)}>중단</button>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
