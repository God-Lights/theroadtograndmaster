import { useState } from 'react';
import { ITEMS, getProfTier, type ItemData } from '@rtgm/data';
import { api } from '../api';
import { useGame } from '../game';
import { Icon } from '../Icon';
import type { IconName } from '../icon-paths';
import { ItemStats, rarityClass } from './ItemInfo';

const SHOP_TABS: { id: string; label: string; icon: IconName; match: (i: ItemData) => boolean }[] = [
  { id: 'all', label: '전체', icon: 'shop', match: () => true },
  { id: 'sword', label: '검', icon: 'sword', match: (i) => i.type === 'sword' },
  { id: 'defense', label: '방패·갑옷', icon: 'shield', match: (i) => i.type === 'shield' || i.type === 'armor' },
  { id: 'consumable', label: '소모품', icon: 'heart', match: (i) => i.type === 'consumable' },
];

export function Shop() {
  const { me, inv, refresh, toast, fail } = useGame();
  const [tabId, setTabId] = useState('all');
  const [busy, setBusy] = useState(false);
  if (!me || !inv) return null;

  const tab = SHOP_TABS.find((t) => t.id === tabId)!;
  const items = ITEMS.filter((i) => i.buy !== null && tab.match(i));
  const owned = new Map(inv.items.map((i) => [i.itemId, i.quantity]));

  const buy = async (item: ItemData) => {
    setBusy(true);
    try { await api.buy(item.id, 1); await refresh(); toast('구매 완료!'); } catch (e) { fail(e); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="section-hd">
        <h2><Icon name="shop" className="ico-hd" /> 상점</h2>
        <span style={{ color: 'var(--gold2)' }}><Icon name="coin" /> {inv.gold.toLocaleString()} D</span>
      </div>

      <div className="pill-tabs">
        {SHOP_TABS.map((t) => (
          <button key={t.id} className={`pill${t.id === tabId ? ' active' : ''}`} onClick={() => setTabId(t.id)}>
            <Icon name={t.icon} /> {t.label}
          </button>
        ))}
      </div>

      <div className="card">
        {items.length === 0 && <div className="empty">해당 탭에 구매 가능한 아이템이 없습니다.</div>}
        {items.map((item) => {
          const locked = me.proficiency < item.minProficiency;
          const canBuy = !locked && item.buy !== null && inv.gold >= item.buy;
          const count = owned.get(item.id) ?? 0;
          return (
            <div key={item.id} className={`shop-row${locked ? ' item-locked' : ''}`}>
              <div className="shop-info">
                <div className={`item-name ${rarityClass(item)}`}>
                  {item.name}
                  {count > 0 && <span className="muted" style={{ fontSize: '.72rem' }}> (보유 {count})</span>}
                </div>
                {locked && (
                  <div className="lock-label"><Icon name="lock" /> 숙련도 {item.minProficiency} ({getProfTier(item.minProficiency).name}) 필요</div>
                )}
                <ItemStats item={item} />
                <div style={{ display: 'flex', gap: 10, marginTop: 3, fontSize: '.75rem' }}>
                  <span className="item-price">구매: {item.buy?.toLocaleString()}D</span>
                  <span className="muted">판매: {item.sell.toLocaleString()}D</span>
                </div>
              </div>
              <button className="btn btn-primary" disabled={!canBuy || busy} onClick={() => buy(item)}>구매</button>
            </div>
          );
        })}
      </div>
    </>
  );
}
