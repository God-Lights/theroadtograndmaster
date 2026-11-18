import { useState } from 'react';
import { getProfTier } from '@rtgm/data';
import { ACCOUNT_ORIGIN } from './api';
import { GameProvider, useGame } from './game';
import { Icon } from './Icon';
import type { IconName } from './icon-paths';
import { Adventure } from './screens/Adventure';
import { Inventory } from './screens/Inventory';
import { Profile } from './screens/Profile';
import { Shop } from './screens/Shop';

const TABS = [
  { id: 'profile', label: '내 정보', icon: 'person', view: Profile },
  { id: 'adventure', label: '모험', icon: 'map', view: Adventure },
  { id: 'inventory', label: '인벤토리', icon: 'bag', view: Inventory },
  { id: 'shop', label: '상점', icon: 'shop', view: Shop },
] as const satisfies readonly { id: string; label: string; icon: IconName; view: () => JSX.Element | null }[];

type TabId = (typeof TABS)[number]['id'];

function Shell() {
  const [tab, setTab] = useState<TabId>('profile');
  const { me } = useGame();
  const View = TABS.find((t) => t.id === tab)!.view;
  const mobile = typeof window !== 'undefined' && window.innerWidth <= 600;
  const gold = me ? (mobile && me.gold >= 1000 ? `${Math.floor(me.gold / 1000)}k` : me.gold.toLocaleString()) : '';

  return (
    <div>
      <div className="top-bar">
        <span className="logo"><Icon name="sword" className="ico-hd" /> RTGM</span>
        {me && (
          <div className="uinfo">
            <span className="uname">{me.nickname}</span>
            <span className="ugold">{gold}D</span>
            <span className="utier">{getProfTier(me.proficiency).name}</span>
          </div>
        )}
        <a className="btn btn-ghost account-btn" href={ACCOUNT_ORIGIN} target="_blank" rel="noreferrer">
          계정
        </a>
      </div>
      <nav className="nav-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`nav-tab${t.id === tab ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} className="ico-nav" />
            {t.label}
          </button>
        ))}
      </nav>
      <div className="tab-content">{me ? <View /> : <div className="empty">불러오는 중...</div>}</div>
    </div>
  );
}

export function App() {
  return (
    <GameProvider>
      <Shell />
    </GameProvider>
  );
}
