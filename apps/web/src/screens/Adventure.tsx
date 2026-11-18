import { useEffect, useRef, useState } from 'react';
import { MOBS, bossScriptFor, getProfTier, itemById, type MobData } from '@rtgm/data';
import type { BattleState, Combatant, LogEntry } from '@rtgm/engine';
import { api, type Rewards } from '../api';
import { useGame } from '../game';
import { Icon } from '../Icon';

/** 보스 권장 숙련도 (참고용 안내. 입장을 막지는 않는다) */
const RECOMMENDED: Record<string, number> = { rich: 450 };

/** 폰 진동(지원하는 기기만). 피격·승패 피드백 */
const haptic = (pattern: number | number[]) => { try { navigator.vibrate?.(pattern); } catch { /* 미지원 */ } };

const logClass = (l: LogEntry) =>
  l.type === 'attack' ? 'la'
    : l.type === 'guard' || l.type === 'status' ? 'ld'
      : l.type === 'heal' || l.type === 'phase' || l.type === 'interrupt' ? 'ls'
        : 'lf';

const ROLE_LABEL: Record<string, string> = { boss: '보스', minion: '하수인', vessel: '보호물' };

function HpBar({ hp, max }: { hp: number; max: number }) {
  const pct = Math.max(0, Math.min(100, Math.round((hp / max) * 100)));
  return (
    <>
      <div className="hp-bar-wrap"><div className={`hp-bar${pct < 30 ? ' low' : ''}`} style={{ width: `${pct}%` }} /></div>
      <div className="hp-label">HP {hp}/{max}</div>
    </>
  );
}

function Battle({ battleId, initial, mobName, onEnd }: { battleId: string; initial: BattleState; mobName: string; onEnd: () => void }) {
  const { inv, refresh, modal, fail } = useGame();
  const [state, setState] = useState(initial);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState('enemy');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [log]);

  const player = state.combatants.find((c) => c.side === 'player')!;
  const enemies = state.combatants.filter((c) => c.side === 'enemy' && c.hp > 0);
  const mainEnemy = state.combatants.find((c) => c.id === 'enemy')!;
  const bossMode = !!state.boss;
  // 선택한 대상이 쓰러졌으면(영혼함 파괴 등) 주 적으로 돌아간다
  const targetId = enemies.some((e) => e.id === target) ? target : (enemies.find((e) => e.id === 'enemy') ?? enemies[0])?.id ?? 'enemy';
  const intent = state.intents?.enemy;
  const phase = state.boss?.runtime.phase;
  const charge = intent && (intent.kind === 'charge' || intent.kind === 'release') ? state.boss?.script.patterns[intent.patternId] : undefined;
  const interruptNeed = charge?.kind === 'charge_attack' && phase ? Math.ceil(charge.interruptPct[phase - 1]! * mainEnemy.stats.maxHp) : undefined;
  const potions = (inv?.items ?? [])
    .map((r) => ({ row: r, item: itemById(r.itemId) }))
    .filter((x) => x.item?.type === 'consumable' && x.item.heal > 0);

  // 소모품 종류가 많아지면 전투 버튼이 화면을 밀어내므로, 3종 이상이면 '아이템' 시트 하나로 묶는다
  const COMPACT_AT = bossMode ? 1 : 3; // 보스전은 하단 고정 바를 한 줄로 유지하려고 항상 묶는다
  const useItem = (itemId: string) => { modal(null); void act('item', itemId); };
  const openItems = () =>
    modal({
      title: <><Icon name="bag" className="ico-hd" /> 아이템 사용</>,
      body: (
        <div className="item-pick">
          {potions.map(({ row, item }) => (
            <button key={row.itemId} className="btn btn-info" onClick={() => useItem(row.itemId)}>
              <span>{item!.name} x{row.quantity}</span>
              <span>HP {item!.heal >= 9999 ? '완전 회복' : `+${item!.heal}`}</span>
            </button>
          ))}
        </div>
      ),
      buttons: [{ text: '닫기', cls: 'btn-ghost', onClick: () => modal(null) }],
    });

  const finish = async (status: 'victory' | 'defeat', rewards?: Rewards) => {
    await refresh();
    const close = () => { modal(null); onEnd(); };
    haptic(status === 'victory' ? [30, 40, 30] : 120);
    if (status === 'victory') {
      modal({
        title: <><Icon name="trophy" className="ico-hd" /> 승리!</>,
        body: (
          <>
            <p>달런트 +{rewards?.gold ?? 0}D</p>
            {!!rewards?.proficiency && <p style={{ color: 'var(--epic)' }}>숙련도 +{rewards.proficiency}</p>}
            {rewards?.items.map((it) => <p key={it.itemId}>아이템: {it.name}{it.quantity > 1 ? ` x${it.quantity}` : ''}</p>)}
          </>
        ),
        buttons: [{ text: '확인', cls: 'btn-primary', onClick: close }],
      });
    } else {
      modal({
        title: <><Icon name="skull" className="ico-hd" /> 패배...</>,
        body: (
          <>
            <p>쓰러졌습니다. 장비를 점검하고 다시 도전해 보세요.</p>
            {!!rewards?.proficiency && <p style={{ color: 'var(--epic)' }}>숙련도 +{rewards.proficiency}</p>}
          </>
        ),
        buttons: [{ text: '확인', cls: 'btn-ghost', onClick: close }],
      });
    }
  };

  const act = async (action: 'attack' | 'guard' | 'item', itemId?: string) => {
    setBusy(true);
    try {
      const res = await api.round(battleId, action, itemId, action === 'attack' ? targetId : undefined);
      setState(res.state);
      setLog((l) => [...l, ...res.log]);
      if (res.log.some((l) => l.type === 'attack' && l.targetId === 'player')) haptic(15);
      if (action === 'item') await refresh();
      if (res.state.status !== 'ongoing') await finish(res.state.status, res.rewards);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="battle-arena">
      <div className="battle-title"><Icon name="swords" /> 전투! <span className="muted" style={{ fontSize: '.8rem' }}>라운드 {state.round}</span></div>
      {bossMode && state.status === 'ongoing' && intent && (
        <div className={`intent${intent.kind === 'charge' || intent.kind === 'release' ? ' danger' : ''}`}>
          <div className="intent-head"><Icon name="info" /> 다음 행동: <b>{intent.name}</b></div>
          <div>{intent.telegraph}</div>
          {interruptNeed !== undefined && (
            <div className="intent-hint">
              {intent.kind === 'charge' ? '충전 중 ' : '발동 전 '}한 라운드에 {interruptNeed} 이상 피해를 주면 끊을 수 있어요.
            </div>
          )}
        </div>
      )}
      <div className={bossMode ? 'battle-stack' : 'battle-vs'}>
        <div className="fighter you">
          <div className="fighter-name">
            나
            {(player.statuses ?? []).map((st) => (
              <span key={st.id} className="badge" title="공격력 감소">약화 -{Math.round((1 - (st.atkMult ?? 1)) * 100)}% · {st.until - state.round + 1}R</span>
            ))}
          </div>
          <HpBar hp={player.hp} max={player.stats.maxHp} />
        </div>
        {!bossMode && <div className="vs-txt"><Icon name="skull" /></div>}
        {enemies.filter((e) => e.role !== 'minion').map((e) => (
          <EnemyCard
            key={e.id}
            enemy={e}
            label={e.id === 'enemy' ? mobName : e.name}
            selectable={bossMode && enemies.length > 1}
            selected={bossMode && enemies.length > 1 && e.id === targetId}
            phase={e.role === 'boss' ? phase : undefined}
            onSelect={() => setTarget(e.id)}
          />
        ))}
        {enemies.some((e) => e.role === 'minion') && (
          <div className="minion-row">
            {enemies.filter((e) => e.role === 'minion').map((e) => (
              <EnemyCard key={e.id} enemy={e} label={e.name} selectable selected={e.id === targetId} onSelect={() => setTarget(e.id)} />
            ))}
          </div>
        )}
      </div>
      <div className="blog" ref={logRef}>
        {log.length === 0 ? <div className="le ls">전투 시작!</div> : log.map((l, i) => <div key={i} className={`le ${logClass(l)}`}>{l.text}</div>)}
      </div>
      {state.status === 'ongoing' && (
        <div className={`bactions${bossMode ? ' sticky' : ''}`}>
          <button className="btn btn-danger" disabled={busy} onClick={() => act('attack')}><Icon name="sword" /> 공격</button>
          <button className="btn btn-warn" disabled={busy} onClick={() => act('guard')}><Icon name="shield" /> 방어</button>
          {potions.length >= COMPACT_AT ? (
            <button className="btn btn-info" disabled={busy} onClick={openItems}><Icon name="bag" /> 아이템</button>
          ) : (
            potions.map(({ row, item }) => (
              <button key={row.itemId} className="btn btn-info" disabled={busy} onClick={() => act('item', row.itemId)}>
                {item!.name} x{row.quantity}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function EnemyCard({ enemy, label, selectable, selected, phase, onSelect }: {
  enemy: Combatant; label: string; selectable: boolean; selected: boolean; phase?: number; onSelect: () => void;
}) {
  return (
    <div
      className={`fighter opp${selectable ? ' selectable' : ''}${selected ? ' selected' : ''}`}
      onClick={selectable ? onSelect : undefined}
      role={selectable ? 'button' : undefined}
      aria-pressed={selectable ? selected : undefined}
    >
      <div className="fighter-name">
        {label}
        {enemy.role && enemy.role !== 'normal' && <span className="badge role">{ROLE_LABEL[enemy.role]}</span>}
        {phase && <span className="badge">{phase}페이즈</span>}
        {selected && <span className="badge target">대상</span>}
      </div>
      <HpBar hp={enemy.hp} max={enemy.stats.maxHp} />
    </div>
  );
}

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
