import { useState } from 'react';
import { getProfTier } from '@rtgm/data';
import { ACCOUNT_ORIGIN } from './api';
import { GameProvider, useGame } from './game';
import { Icon } from './Icon';
import type { IconName } from './icon-paths';
import { Adventure } from './screens/Adventure';
import { Craft } from './screens/Craft';
import { Inventory } from './screens/Inventory';
import { Profile } from './screens/Profile';
import { Skills } from './screens/Skills';
import { Shop } from './screens/Shop';
import { Social } from './screens/Social';
import { Wiki, isWikiHash, openWiki, useWikiPath } from './wiki/Wiki';

const TABS = [
  { id: 'profile', label: '내 정보', icon: 'person', view: Profile },
  { id: 'adventure', label: '모험', icon: 'map', view: Adventure },
  { id: 'inventory', label: '인벤토리', icon: 'bag', view: Inventory },
  { id: 'skills', label: '스킬', icon: 'star', view: Skills },
  { id: 'craft', label: '제작', icon: 'hammer', view: Craft },
  { id: 'shop', label: '상점', icon: 'shop', view: Shop },
  { id: 'social', label: '소셜', icon: 'users', view: Social },
] as const satisfies readonly { id: string; label: string; icon: IconName; view: () => JSX.Element | null }[];

type TabId = (typeof TABS)[number]['id'];

function Shell() {
  const [tab, setTab] = useState<TabId>('profile');
  const hash = useWikiPath();
  const { me, loadFailed, refresh, fail } = useGame();
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
        <button className="btn btn-ghost account-btn" onClick={openWiki}>위키</button>
        <a className="btn btn-ghost account-btn" href={ACCOUNT_ORIGIN} target="_blank" rel="noreferrer">
          계정
        </a>
      </div>
      {isWikiHash(hash) ? <div className="tab-content"><Wiki hash={hash} /></div> : <>
      <nav className="nav-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`nav-tab${t.id === tab ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} className="ico-nav" />
            {t.label}
          </button>
        ))}
      </nav>
      <div className="tab-content">
        {me ? (
          <View />
        ) : loadFailed ? (
          <div className="empty">
            <div>불러오지 못했어요.</div>
            <button className="btn btn-primary retry" onClick={() => refresh().catch(fail)}>다시 시도</button>
          </div>
        ) : (
          <div className="empty">불러오는 중...</div>
        )}
      </div>
      </>}
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
