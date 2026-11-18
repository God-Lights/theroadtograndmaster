import { useState } from 'react';
import { DUNGEONS, bossScriptFor, entryCost, getProfTier, itemById, mobById, type DungeonData, type MobData } from '@rtgm/data';
import type { BattleState } from '@rtgm/engine';
import { api } from '../api';
import { useGame } from '../game';
import { Icon } from '../Icon';
import { Battle } from './Battle';

/** 보스 권장 숙련도 (참고용 안내. 입장을 막지는 않는다) */
const RECOMMENDED: Record<string, number> = { rich: 450, oppoko: 900, fodermore: 1500 };

function MobRow({ mob, locked, gold, keys, onStart }: { mob: MobData; locked: boolean; gold: number; keys: number; onStart: () => void }) {
  const rec = RECOMMENDED[mob.id];
  const cost = entryCost(mob);
  const keyItem = cost.key ? itemById(cost.key) : undefined;
  const missingKey = !!cost.key && keys < 1;
  const poor = gold < cost.gold;
  return (
    <div className={`shop-row${locked ? ' dungeon-lock' : ''}`}>
      <div className="shop-info">
        <div className={`item-name ${mob.kind === 'boss' ? 'rarity-epic' : 'rarity-normal'}`}>
          {mob.name}{mob.kind === 'boss' && ' ⭐'}
        </div>
        {rec && (
          <div className="lock-label"><Icon name="lock" /> 권장 숙련도 {rec} ({getProfTier(rec).name})</div>
        )}
        <div className="item-stat"><Icon name="heart" /> HP {mob.hp} · <Icon name="sword" /> ATK {mob.atk} · <Icon name="shield" /> DEF {mob.def}</div>
        <div className="item-price"><Icon name="coin" /> 보상 {mob.gold[0]}~{mob.gold[1]}D</div>
        {(cost.gold > 0 || cost.key) && (
          <div className="cost-line">
            {cost.gold > 0 && <span style={{ color: poor ? 'var(--danger)' : 'var(--gold2)' }}>입장 {cost.gold}D</span>}
            {keyItem && <span style={{ color: missingKey ? 'var(--danger)' : 'var(--rare)' }}>{keyItem.name} 1개 ({keys}개 보유)</span>}
          </div>
        )}
        {mob.note && <div className="note" style={{ margin: '4px 0 0' }}>{mob.note}</div>}
        {!mob.note && bossScriptFor(mob.id) && <div className="note" style={{ margin: '4px 0 0' }}>보스 전용 패턴 · 행동 예고를 보고 대응하세요.</div>}
      </div>
      <button className="btn btn-primary" disabled={locked || missingKey || poor} onClick={onStart}>도전</button>
    </div>
  );
}

function DungeonCard({ dungeon, proficiency, gold, keysOf, onStart }: {
  dungeon: DungeonData; proficiency: number; gold: number; keysOf: (id: string) => number; onStart: (mob: MobData) => void;
}) {
  const locked = proficiency < dungeon.minProficiency;
  const mobs = dungeon.mobs.map((id) => mobById(id)).filter((m): m is MobData => !!m);
  return (
    <div className="card">
      <div className="card-title">
        <Icon name={locked ? 'lock' : 'map'} /> {dungeon.name}
      </div>
      {locked && (
        <div className="lock-label" style={{ marginBottom: 8 }}>
          <Icon name="lock" /> 숙련도 {dungeon.minProficiency} ({getProfTier(dungeon.minProficiency).name}) 필요 · 현재 {proficiency}
        </div>
      )}
      <div className="note">{dungeon.description}</div>
      {mobs.map((mob) => (
        <MobRow
          key={mob.id}
          mob={mob}
          locked={locked}
          gold={gold}
          keys={entryCost(mob).key ? keysOf(entryCost(mob).key!) : 0}
          onStart={() => onStart(mob)}
        />
      ))}
    </div>
  );
}

export function Adventure() {
  const { me, inv, refresh, fail } = useGame();
  const [battle, setBattle] = useState<{ id: string; state: BattleState; mob: MobData }>();

  const start = async (mob: MobData) => {
    try {
      const res = await api.startBattle(mob.id);
      setBattle({ id: res.id, state: res.state, mob });
      if (res.paid.gold > 0 || res.paid.key) await refresh(); // 입장 비용이 나갔으니 골드·열쇠 표시를 갱신
    } catch (e) { fail(e); }
  };

  if (battle) {
    return <Battle battleId={battle.id} initial={battle.state} mob={battle.mob} onEnd={() => setBattle(undefined)} />;
  }

  const keysOf = (id: string) => inv?.items.find((i) => i.itemId === id)?.quantity ?? 0;

  return (
    <>
      <div className="section-hd">
        <h2><Icon name="map" className="ico-hd" /> 모험</h2>
        <span style={{ color: 'var(--gold2)' }}><Icon name="coin" /> {(inv?.gold ?? 0).toLocaleString()} D</span>
      </div>
      {DUNGEONS.map((d) => (
        <DungeonCard key={d.id} dungeon={d} proficiency={me?.proficiency ?? 0} gold={inv?.gold ?? 0} keysOf={keysOf} onStart={start} />
      ))}
    </>
  );
}
