import { useState } from 'react';
import { Town } from './screens/Town';
import { Dungeon } from './screens/Dungeon';
import { Shop } from './screens/Shop';
import { Inventory } from './screens/Inventory';

const SCREENS = {
  town: { label: '마을', view: Town },
  dungeon: { label: '던전', view: Dungeon },
  shop: { label: '상점', view: Shop },
  inventory: { label: '인벤토리', view: Inventory },
} as const;

type ScreenId = keyof typeof SCREENS;

export function App() {
  const [screen, setScreen] = useState<ScreenId>('town');
  const View = SCREENS[screen].view;
  return (
    <div className="app">
      <header className="topbar">RTGM <span>The Road to Grand Master</span></header>
      <nav className="sidebar">
        {(Object.keys(SCREENS) as ScreenId[]).map((id) => (
          <button key={id} className={id === screen ? 'active' : ''} onClick={() => setScreen(id)}>
            {SCREENS[id].label}
          </button>
        ))}
      </nav>
      <main className="panel"><View /></main>
    </div>
  );
}
