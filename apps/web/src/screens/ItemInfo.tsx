import type { ItemData } from '@rtgm/data';
import { Icon } from '../Icon';

export const rarityClass = (i: ItemData) => `rarity-${i.rarity}`;

/** 아이템 효과 줄 (EDRPG의 item-stat) */
export function ItemStats({ item }: { item: ItemData }) {
  return (
    <>
      {item.atk > 0 && <div className="item-stat"><Icon name="sword" /> ATK +{item.atk}</div>}
      {item.def > 0 && <div className="item-stat"><Icon name="shield" /> DEF +{item.def}</div>}
      {item.hp > 0 && <div className="item-stat hp"><Icon name="heart" /> 최대 HP +{item.hp}</div>}
      {item.heal > 0 && (
        <div className="item-stat heal"><Icon name="heart" /> HP {item.heal >= 9999 ? '완전 회복' : `+${item.heal}`}</div>
      )}
    </>
  );
}
