import { useState } from 'react';
import { MOBS, bossScriptFor, getProfTier, type MobData } from '@rtgm/data';
import type { BattleState } from '@rtgm/engine';
import { api } from '../api';
import { useGame } from '../game';
import { Icon } from '../Icon';
import { Battle } from './Battle';

/** 보스 권장 숙련도 (참고용 안내. 입장을 막지는 않는다) */
const RECOMMENDED: Record<string, number> = { rich: 450 };

function MobRow({ mob, profLevelName, onStart }: { mob: MobData; profLevelName?: string; onStart: () => void }) {
  const rec = RECOMMENDED[mob.id];
  return (
    <div className="shop-row">
      <div className="shop-info">
        <div className={`item-name ${mob.kind === 'boss' ? 'rarity-epic' : 'rarity-normal'}`}>
          {mob.name}{mob.kind === 'boss' && ' ⭐'}
        </div>
        {rec && (
          <div className="lock-label"><Icon name="lock" /> 권장 숙련도 {rec}{profLevelName ? ` (${profLevelName})` : ''}</div>
        )}
        <div className="item-stat"><Icon name="heart" /> HP {mob.hp} · <Icon name="sword" /> ATK {mob.atk} · <Icon name="shield" /> DEF {mob.def}</div>
        <div className="item-price"><Icon name="coin" /> {mob.gold[0]}~{mob.gold[1]}D</div>
        {bossScriptFor(mob.id) && <div className="note" style={{ margin: '4px 0 0' }}>보스 전용 패턴 · 행동 예고를 보고 대응하세요.</div>}
      </div>
      <button className="btn btn-primary" onClick={onStart}>도전</button>
    </div>
  );
}

export function Adventure() {
  const { fail } = useGame();
  const [battle, setBattle] = useState<{ id: string; state: BattleState; mob: MobData }>();

  const start = async (mob: MobData) => {
    try {
      const res = await api.startBattle(mob.id);
      setBattle({ id: res.id, state: res.state, mob });
    } catch (e) { fail(e); }
  };

  if (battle) {
    return <Battle battleId={battle.id} initial={battle.state} mobName={battle.mob.name} onEnd={() => setBattle(undefined)} />;
  }

  return (
    <>
      <div className="section-hd"><h2><Icon name="map" className="ico-hd" /> 모험</h2></div>
      <div className="card">
        <div className="card-title"><Icon name="map" /> 기본 던전</div>
        <div className="note">몬스터를 쓰러뜨려 달런트와 재료를 얻으세요. 마지막 보스 리치를 넘으면 더 깊은 던전이 열립니다.</div>
        {MOBS.map((mob) => (
          <MobRow key={mob.id} mob={mob} profLevelName={RECOMMENDED[mob.id] ? getProfTier(RECOMMENDED[mob.id]!).name : undefined} onStart={() => start(mob)} />
        ))}
      </div>
    </>
  );
}
