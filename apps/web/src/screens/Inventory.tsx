import { useState } from 'react';
import { isEquipType, itemById, type ItemData } from '@rtgm/data';
import { api } from '../api';
import { useGame } from '../game';
import { Icon } from '../Icon';
import { ItemStats, rarityClass } from './ItemInfo';

function SellForm({ item, max, onChange }: { item: ItemData; max: number; onChange: (n: number) => void }) {
  const [qty, setQty] = useState(1);
  const set = (n: number) => { const v = Math.max(1, Math.min(max, n)); setQty(v); onChange(v); };
  return (
    <>
      <p className={rarityClass(item)}>{item.name}</p>
      <p style={{ color: 'var(--gold2)' }}>개당 판매가: {item.sell.toLocaleString()}D</p>
      <div className="qty-row">
        <button className="qty-btn" aria-label="수량 줄이기" onClick={() => set(qty - 1)}>−</button>
        <input
          id="sell-qty" type="text" inputMode="numeric" pattern="[0-9]*" value={qty} aria-label="판매 수량"
          onChange={(e) => set(Number(e.target.value.replace(/\D/g, '')) || 1)}
        />
        <button className="qty-btn" aria-label="수량 늘리기" onClick={() => set(qty + 1)}>+</button>
        <button className="qty-btn" style={{ minWidth: 56, fontSize: '.8rem' }} onClick={() => set(max)}>최대</button>
      </div>
      <p className="muted" style={{ fontSize: '.78rem', marginTop: 6 }}>최대 {max}개 · 합계 {(item.sell * qty).toLocaleString()}D</p>
    </>
  );
}

export function Inventory() {
  const { inv, refresh, toast, modal, fail } = useGame();
  const [busy, setBusy] = useState(false);
  if (!inv) return null;

  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true); // 연타·중복 요청 방지
    try { await fn(); await refresh(); if (okMsg) toast(okMsg); } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const openSell = (item: ItemData, owned: number, equipped: boolean) => {
    const max = equipped ? owned - 1 : owned; // 장착 중인 마지막 1개는 팔 수 없다
    let qty = 1;
    modal({
      title: '아이템 판매',
      body: <SellForm item={item} max={max} onChange={(n) => { qty = n; }} />,
      buttons: [
        { text: '판매', cls: 'btn-success', onClick: () => { modal(null); void run(() => api.sell(item.id, qty), '판매 완료!'); } },
        { text: '취소', cls: 'btn-ghost', onClick: () => modal(null) },
      ],
    });
  };

  return (
    <>
      <div className="section-hd"><h2><Icon name="bag" className="ico-hd" /> 가방</h2></div>
      {inv.items.length === 0 ? (
        <div className="empty"><Icon name="bag" className="ico-xl" /><div>아이템이 없습니다</div></div>
      ) : (
        <div className="item-grid">
          {inv.items.map((row) => {
            const item = itemById(row.itemId);
            if (!item) return null;
            const canEquip = isEquipType(item.type);
            const canSell = item.sell > 0 && (!row.equipped || row.quantity > 1);
            return (
              <div key={row.itemId} className={`item-card${row.equipped ? ' equipped' : ''}`}>
                {row.equipped && <div className="eq-badge">장착</div>}
                <div className={`item-name ${rarityClass(item)}`}>{item.name}{row.quantity > 1 ? ` x${row.quantity}` : ''}</div>
                <ItemStats item={item} />
                <div className="item-actions">
                  {canEquip && !row.equipped && (
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(() => api.equip(item.id), '장착 완료!')}>장착</button>
                  )}
                  {canEquip && row.equipped && (
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api.unequip(item.id))}>해제</button>
                  )}
                  {canSell && (
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => openSell(item, row.quantity, row.equipped)}>팔기({item.sell}D)</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
