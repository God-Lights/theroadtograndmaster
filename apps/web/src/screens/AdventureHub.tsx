import { useState } from 'react';
import { Adventure } from './Adventure';
import { Pvp } from './Pvp';

/** 모험 탭: 던전(PvE)과 대전(PvP). 둘 다 마운트해 두어 전투 중에 탭을 오가도 화면이 사라지지 않는다. */
export function AdventureHub() {
  const [mode, setMode] = useState<'dungeon' | 'pvp'>('dungeon');
  return (
    <>
      <div className="pill-tabs">
        <button className={`pill${mode === 'dungeon' ? ' active' : ''}`} onClick={() => setMode('dungeon')}>던전</button>
        <button className={`pill${mode === 'pvp' ? ' active' : ''}`} onClick={() => setMode('pvp')}>대전 (PvP)</button>
      </div>
      <div className={mode === 'dungeon' ? '' : 'hidden'}><Adventure /></div>
      <div className={mode === 'pvp' ? '' : 'hidden'}>{mode === 'pvp' && <Pvp />}</div>
    </>
  );
}
