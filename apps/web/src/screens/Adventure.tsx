import { useState } from 'react';
import { DUNGEONS, bossScriptFor, entryCost, spawnRates, getProfTier, itemById, mobById, type DungeonData, type MobData } from '@rtgm/data';
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

function DungeonCard({ dungeon, proficiency, gold, keysOf, onStart, onExplore }: {
  dungeon: DungeonData; proficiency: number; gold: number; keysOf: (id: string) => number; onStart: (mob: MobData) => void; onExplore: (d: DungeonData) => void;
}) {
  const locked = proficiency < dungeon.minProficiency;
  const boss = dungeon.mobs.map((id) => mobById(id)).find((m): m is MobData => !!m && m.kind === 'boss');
  const rates = spawnRates(dungeon);
  const poor = gold < dungeon.entry.normalGold;
  const weak = !locked && proficiency < dungeon.recommendedProficiency;
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
      {weak && <div className="lock-label" style={{ marginBottom: 8 }}><Icon name="lock" /> 권장 숙련도 {dungeon.recommendedProficiency} ({getProfTier(dungeon.recommendedProficiency).name}) · 아직 위험할 수 있어요</div>}
      <div className="note">{dungeon.description}</div>
      <div className="biome-spawns">
        <div className="muted" style={{ fontSize: '.76rem', marginBottom: 4 }}>이 지역에서 만나는 몬스터</div>
        {rates.map(({ mobId, rate }) => {
          const mob = mobById(mobId);
          if (!mob) return null;
          return (
            <div key={mobId} className="spawn-row">
              <span className="item-name rarity-normal">{mob.name}</span>
              <span className="muted gdesc">{Math.round(rate * 100)}% · HP {mob.hp} · ATK {mob.atk} · {mob.gold[0]}~{mob.gold[1]}D</span>
              {mob.note && <span className="muted gdesc">{mob.note}</span>}
            </div>
          );
        })}
      </div>
      <button className="btn btn-primary" style={{ width: '100%', marginTop: 10 }} disabled={locked || poor} onClick={() => onExplore(dungeon)}>
        <Icon name="map" /> 탐험하기{dungeon.entry.normalGold > 0 ? ` (${dungeon.entry.normalGold}D)` : ''}
      </button>
      {boss && (
        <div style={{ marginTop: 10 }}>
          <div className="muted" style={{ fontSize: '.76rem', marginBottom: 4 }}>지역의 보스</div>
          <MobRow mob={boss} locked={locked} gold={gold} keys={entryCost(boss).key ? keysOf(entryCost(boss).key!) : 0} onStart={() => onStart(boss)} />
        </div>
      )}
    </div>
  );
}

export function Adventure() {
  const { me, inv, refresh, fail, toast } = useGame();
  const [battle, setBattle] = useState<{ id: string; state: BattleState; mob: MobData }>();

  const start = async (mob: MobData) => {
    try {
      const res = await api.startBattle(mob.id);
      setBattle({ id: res.id, state: res.state, mob });
      if (res.paid.gold > 0 || res.paid.key) await refresh(); // 입장 비용이 나갔으니 골드·열쇠 표시를 갱신
    } catch (e) { fail(e); }
  };

  const explore = async (d: DungeonData) => {
    try {
      const res = await api.explore(d.id);
      const mob = mobById(res.mobId);
      if (!mob) return;
      setBattle({ id: res.id, state: res.state, mob });
      toast(`야생의 ${mob.name}이(가) 나타났다!`, 'warn');
      if (res.paid.gold > 0) await refresh();
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
        <DungeonCard key={d.id} dungeon={d} proficiency={me?.proficiency ?? 0} gold={inv?.gold ?? 0} keysOf={keysOf} onStart={start} onExplore={explore} />
      ))}
    </>
  );
}
