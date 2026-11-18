import { useCallback, useEffect, useMemo, useState } from 'react';
import { itemById } from '@rtgm/data';
import { api, type FriendsPayload, type Listing } from '../api';
import { useGame } from '../game';
import { rarityClass } from '../screens/ItemInfo';

type Sub = 'buy' | 'mine' | 'list';
const won = (n: number) => `${n.toLocaleString()}D`;

function ListingRow({ l, children }: { l: Listing; children: React.ReactNode }) {
  const item = itemById(l.itemId);
  return (
    <div className="srow">
      <div className="sname">
        <span className={item ? rarityClass(item) : ''}>{item?.name ?? l.itemId}</span> ×{l.quantity}
        {l.private && <span className="badge">지정</span>}
        <div className="muted gdesc">{won(l.price)} · {l.seller}</div>
      </div>
      <div className="sbtns">{children}</div>
    </div>
  );
}

export function Exchange() {
  const { inv, refresh, toast, fail } = useGame();
  const [sub, setSub] = useState<Sub>('buy');
  const [rows, setRows] = useState<Listing[]>();
  const [fee, setFee] = useState(0.05);
  const [busy, setBusy] = useState(false);
  const [friends, setFriends] = useState<FriendsPayload['friends']>([]);
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    try {
      const r = sub === 'buy' ? await api.exchange() : sub === 'mine' ? await api.exchangeMine() : null;
      if (r) { setRows(r.listings); setFee(r.feeRate); }
    } catch (e) { fail(e); }
  }, [sub, fail]);
  useEffect(() => { setRows(undefined); void load(); }, [load]);
  useEffect(() => { if (sub === 'list') api.friends().then((d) => setFriends(d.friends)).catch(() => {}); }, [sub]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); await Promise.all([load(), refresh()]); } catch (e) { fail(e); await load(); } finally { setBusy(false); }
  };

  const sellable = useMemo(
    () => (inv?.items ?? []).map((r) => ({ ...r, avail: r.equipped ? r.quantity - 1 : r.quantity })).filter((r) => r.avail > 0 && itemById(r.itemId)),
    [inv],
  );
  const chosen = sellable.find((r) => r.itemId === itemId);
  const qn = Number(qty), pn = Number(price);
  const valid = !!chosen && Number.isInteger(qn) && qn >= 1 && qn <= chosen.avail && Number.isInteger(pn) && pn >= 1;
  const net = pn - Math.floor(pn * fee);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    await run(() => api.exchangeList(itemId, qn, pn, to || null), '교환소에 올렸어요!');
    setItemId(''); setQty('1'); setPrice(''); setTo(''); setSub('mine');
  };

  return (
    <>
      <div className="pill-tabs">
        {([['buy', '사기'], ['mine', '내 물품'], ['list', '올리기']] as const).map(([id, label]) => (
          <button key={id} className={`pill${sub === id ? ' active' : ''}`} onClick={() => setSub(id)}>{label}</button>
        ))}
      </div>

      {sub === 'buy' && (
        <div className="card">
          <div className="note">다른 플레이어가 올린 물품이에요. 보유 {won(inv?.gold ?? 0)}</div>
          {!rows && <div className="muted">불러오는 중...</div>}
          {rows?.length === 0 && <div className="muted">지금 올라온 물품이 없어요.</div>}
          {rows?.map((l) => (
            <ListingRow key={l.id} l={l}>
              <button className="btn btn-primary btn-sm" disabled={busy || (inv?.gold ?? 0) < l.price} onClick={() => run(() => api.exchangeBuy(l.id), '구매 완료!')}>{won(l.price)}에 사기</button>
            </ListingRow>
          ))}
        </div>
      )}

      {sub === 'mine' && (
        <div className="card">
          <div className="note">팔리면 수수료 {Math.round(fee * 100)}%를 뺀 금액이 바로 들어와요.</div>
          {!rows && <div className="muted">불러오는 중...</div>}
          {rows?.length === 0 && <div className="muted">올린 물품이 없어요.</div>}
          {rows?.map((l) => (
            <ListingRow key={l.id} l={l}>
              {l.status === 'active' ? (
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api.exchangeCancel(l.id), '거두어 왔어요.')}>거두기</button>
              ) : (
                <span className="muted">{l.buyer ?? ''} 구매 · +{won(l.proceeds ?? 0)}</span>
              )}
            </ListingRow>
          ))}
        </div>
      )}

      {sub === 'list' && (
        <form className="card form-col" onSubmit={submit}>
          <div className="card-title">물품 올리기</div>
          <select value={itemId} onChange={(e) => { setItemId(e.target.value); setQty('1'); }}>
            <option value="">아이템 고르기…</option>
            {sellable.map((r) => <option key={r.itemId} value={r.itemId}>{itemById(r.itemId)!.name} (보유 {r.avail})</option>)}
          </select>
          <div className="qty-row">
            <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} placeholder="수량" aria-label="수량" />
            <input inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))} placeholder="전체 가격(D)" aria-label="전체 가격" />
          </div>
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">누구나 살 수 있게</option>
            {friends.map((f) => <option key={f.id} value={f.id}>{f.nickname}에게만 (지정 거래)</option>)}
          </select>
          {valid && <div className="note">팔리면 {won(net)}을 받아요 (수수료 {won(pn - net)}). 올리는 동안 아이템은 교환소에 보관돼요.</div>}
          <button className="btn btn-primary" type="submit" disabled={busy || !valid}>올리기</button>
        </form>
      )}
    </>
  );
}
