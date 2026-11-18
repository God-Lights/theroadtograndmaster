import { useState } from 'react';
import { RECIPES, getProfTier, itemById, type RecipeData } from '@rtgm/data';
import { api } from '../api';
import { useGame } from '../game';
import { Icon } from '../Icon';
import { ItemStats, rarityClass } from './ItemInfo';

export function Craft() {
  const { me, inv, refresh, toast, modal, fail } = useGame();
  const [busy, setBusy] = useState(false);
  if (!me || !inv) return null;

  // 장착 중인 1개는 재료로 쓸 수 없으므로 보유 수량에서 뺀다
  const usable = new Map(inv.items.map((i) => [i.itemId, i.quantity - (i.equipped ? 1 : 0)]));
  const sorted = [...RECIPES].sort((a, b) => a.unlockProficiency - b.unlockProficiency);

  const make = async (recipe: RecipeData) => {
    setBusy(true);
    try {
      const res = await api.craft(recipe.id);
      await refresh();
      const before = getProfTier(me.proficiency).level;
      const after = getProfTier(res.proficiency).level;
      toast(`${res.crafted.name} 제작 완료!`);
      if (after > before) {
        modal({
          title: <><Icon name="star" className="ico-hd" /> 티어 상승!</>,
          body: <p>{getProfTier(res.proficiency).name} (Lv.{after}) 달성!</p>,
          buttons: [{ text: '확인', cls: 'btn-primary', onClick: () => modal(null) }],
        });
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="section-hd">
        <h2><Icon name="hammer" className="ico-hd" /> 제작</h2>
        <span style={{ color: 'var(--gold2)' }}><Icon name="coin" /> {inv.gold.toLocaleString()} D</span>
      </div>
      <div className="note">재료를 모아 장비와 소모품을 만드세요. 장착 중인 아이템은 재료로 쓸 수 없고, 제작할 때마다 숙련도가 올라요.</div>

      {sorted.map((recipe) => {
        const result = itemById(recipe.resultId);
        if (!result) return null;
        const locked = me.proficiency < recipe.unlockProficiency;
        const enoughMaterials = recipe.materials.every((m) => (usable.get(m.itemId) ?? 0) >= m.quantity);
        const canMake = !locked && enoughMaterials && inv.gold >= recipe.gold;
        return (
          <div key={recipe.id} className={`card${locked ? ' item-locked' : ''}`}>
            <div className="shop-row" style={{ border: 'none', padding: 0, margin: 0, background: 'none' }}>
              <div className="shop-info">
                <div className={`item-name ${rarityClass(result)}`}>
                  {result.name}{recipe.resultQty > 1 ? ` x${recipe.resultQty}` : ''}
                </div>
                {locked && (
                  <div className="lock-label">
                    <Icon name="lock" /> 숙련도 {recipe.unlockProficiency} ({getProfTier(recipe.unlockProficiency).name}) 필요
                  </div>
                )}
                <ItemStats item={result} />
              </div>
              <button className="btn btn-primary" disabled={!canMake || busy} onClick={() => make(recipe)}>제작</button>
            </div>
            <div className="recipe-mats">
              {recipe.materials.map((m) => {
                const have = usable.get(m.itemId) ?? 0;
                const mat = itemById(m.itemId);
                return (
                  <div key={m.itemId} className="stat-row">
                    <span className={mat ? rarityClass(mat) : ''}>{mat?.name ?? m.itemId}</span>
                    <span style={{ color: have >= m.quantity ? 'var(--success)' : 'var(--danger)' }}>{have} / {m.quantity}</span>
                  </div>
                );
              })}
              {recipe.gold > 0 && (
                <div className="stat-row">
                  <span className="stat-label">비용</span>
                  <span style={{ color: inv.gold >= recipe.gold ? 'var(--gold2)' : 'var(--danger)' }}><Icon name="coin" /> {recipe.gold.toLocaleString()} D</span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
