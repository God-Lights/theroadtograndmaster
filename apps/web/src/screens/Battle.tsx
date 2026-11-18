import { useEffect, useRef, useState } from 'react';
import { itemById, skillById, type MobData } from '@rtgm/data';
import { canUseSkill, skillCost, type BattleState, type Combatant, type LogEntry, type SkillDef } from '@rtgm/engine';
import { api, type Rewards } from '../api';
import { Resources, StatusBadges } from '../components/status';
import { useGame } from '../game';
import { Icon } from '../Icon';

/** 폰 진동(지원하는 기기만). 피격·승패 피드백 */
const haptic = (pattern: number | number[]) => { try { navigator.vibrate?.(pattern); } catch { /* 미지원 */ } };

const logClass = (l: LogEntry) =>
  l.type === 'attack' ? 'la'
    : l.type === 'guard' || l.type === 'status' ? 'ld'
      : l.type === 'heal' || l.type === 'phase' || l.type === 'interrupt' || l.type === 'skill' ? 'ls'
        : 'lf';

const ROLE_LABEL: Record<string, string> = { boss: '보스', minion: '하수인', vessel: '보호물' };
const PRIORITY_TAG: Record<string, string> = { first: '선행', last: '후행', delayed: '충전' };
const WHY: Record<string, string> = { ap: 'AP 부족', cooldown: '쿨다운 중', gauge: '게이지 부족', charging: '충전 중', unknown: '사용 불가' };

function HpBar({ hp, max }: { hp: number; max: number }) {
  const pct = Math.max(0, Math.min(100, Math.round((hp / max) * 100)));
  return (
    <>
      <div className="hp-bar-wrap"><div className={`hp-bar${pct < 30 ? ' low' : ''}`} style={{ width: `${pct}%` }} /></div>
      <div className="hp-label">HP {hp}/{max}</div>
    </>
  );
}

function EnemyCard({ enemy, label, selectable, selected, phase, round, isBoss, onSelect }: {
  enemy: Combatant; label: string; selectable: boolean; selected: boolean; phase?: number; round: number; isBoss?: boolean; onSelect: () => void;
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
        {enemy.role && enemy.role !== 'normal' && (enemy.role !== 'boss' || isBoss) && <span className="badge role">{ROLE_LABEL[enemy.role]}</span>}
        {phase && <span className="badge">{phase}페이즈</span>}
        {selected && <span className="badge target">대상</span>}
        <StatusBadges who={enemy} round={round} />
      </div>
      <HpBar hp={enemy.hp} max={enemy.stats.maxHp} />
    </div>
  );
}

/** 자세 규칙이 있는 보스(코에도스)의 이번 라운드 자세 안내 */
function StanceBanner({ state }: { state: BattleState }) {
  const cfg = state.boss?.script.stance;
  const rt = state.boss?.runtime;
  if (!cfg || !rt) return null;
  const boost = rt.stanceBoost;
  const pct = (n: number) => Math.round(n * 100);
  const title = rt.stance === 'counter' ? '반격의 자세' : rt.stance === 'offense' ? '공세의 자세' : '중립 자세';
  const detail =
    rt.stance === 'counter'
      ? `기본 공격은 피해가 ${pct(Math.min(0.95, cfg.counter.reduction * boost))}% 줄고 ${pct(cfg.counter.reflect * boost)}%가 되돌아와요. 스킬은 영향을 받지 않아요.`
      : rt.stance === 'offense'
        ? `보스 공격력 +${pct((cfg.offense.atkMult - 1) * boost)}%, 방어 효과를 ${pct(Math.min(1, cfg.offense.guardPierce * boost))}% 무시해요.`
        : '특별한 효과가 없어요.';
  // 지금 한 행동이 다음 라운드 자세를 정한다 (반전 라운드는 규칙이 뒤집힌다)
  const nextRound = state.round + 1;
  const flip = rt.phase >= cfg.reversalFromPhase && nextRound % cfg.reversalEvery === 0;
  const afterAttack = flip ? '공세' : '반격';
  const afterGuard = flip ? '반격' : '공세';
  return (
    <div className={`stance stance-${rt.stance}`}>
      <div className="stance-head">
        <Icon name={rt.stance === 'offense' ? 'sword' : rt.stance === 'counter' ? 'shield' : 'info'} /> <b>{title}</b>
        {boost > 1 && <span className="badge bad">강화 ×{boost}</span>}
        {rt.reversed && <span className="badge bad">⟲ 반전 라운드</span>}
      </div>
      <div>{detail}</div>
      <div className="stance-hint">
        이번에 <b>공격</b>하면 다음 라운드는 {afterAttack}, <b>방어</b>하면 {afterGuard}, <b>스킬·아이템</b>은 중립이에요.
        {flip && ' (다음 라운드는 규칙이 뒤집혀요)'}
      </div>
    </div>
  );
}

export function Battle({ battleId, initial, mob, onEnd }: { battleId: string; initial: BattleState; mob: MobData; onEnd: () => void }) {
  const mobName = mob.name;
  const isBossMob = mob.kind === 'boss';
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
  const multiPhase = (state.boss?.script.phases.length ?? 0) > 1;
  const phase = multiPhase ? state.boss?.runtime.phase : undefined;
  const bossPhase = state.boss?.runtime.phase;
  const charge = intent && (intent.kind === 'charge' || intent.kind === 'release') ? state.boss?.script.patterns[intent.patternId] : undefined;
  const interruptNeed = charge?.kind === 'charge_attack' && bossPhase ? Math.ceil(charge.interruptPct[bossPhase - 1]! * mainEnemy.stats.maxHp) : undefined;
  // 중간계 몹처럼 끊을 수 없는 충전기는 힌트를 숨긴다 (필요 피해가 보스 최대 HP를 넘는 경우)
  const interruptible = interruptNeed !== undefined && interruptNeed <= mainEnemy.stats.maxHp;
  const potions = (inv?.items ?? [])
    .map((r) => ({ row: r, item: itemById(r.itemId) }))
    .filter((x) => x.item?.type === 'consumable' && x.item.heal > 0);
  const skillList = Object.values(state.skills ?? {}).sort((a, b) => Number(!!a.ultimate) - Number(!!b.ultimate));
  // 충전 중인 스킬이 이번 라운드에 발동하면 다른 행동은 고를 수 없다
  const charging = player.pending && player.pending.fireRound === state.round ? skillById(player.pending.skillId) : undefined;
  const ultReady = skillList.some((s) => s.ultimate && canUseSkill(state, player, s.id).ok);

  const act = async (body: { action: 'attack' | 'guard' | 'item' | 'skill'; itemId?: string; skillId?: string }) => {
    setBusy(true);
    try {
      const res = await api.round(battleId, { ...body, targetId: body.action === 'attack' || body.action === 'skill' ? targetId : undefined });
      setState(res.state);
      setLog((l) => [...l, ...res.log]);
      if (res.log.some((l) => l.type === 'attack' && l.targetId === 'player')) haptic(15);
      if (body.action === 'item') await refresh();
      if (res.state.status !== 'ongoing') await finish(res.state.status, res.rewards);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

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

  // ── 선택 시트: 아이템 / 스킬 ──────────────────────────────────────────────
  // 소모품 종류가 많아지면 전투 버튼이 화면을 밀어내므로, 보스전은 항상, 일반 전투는 3종 이상일 때 시트로 묶는다
  const COMPACT_AT = bossMode ? 1 : 3;
  const openItems = () =>
    modal({
      title: <><Icon name="bag" className="ico-hd" /> 아이템 사용</>,
      body: (
        <div className="item-pick">
          {potions.map(({ row, item }) => (
            <button key={row.itemId} className="btn btn-info" onClick={() => { modal(null); void act({ action: 'item', itemId: row.itemId }); }}>
              <span>{item!.name} x{row.quantity}</span>
              <span>HP {item!.heal >= 9999 ? '완전 회복' : `+${item!.heal}`}</span>
            </button>
          ))}
        </div>
      ),
      buttons: [{ text: '닫기', cls: 'btn-ghost', onClick: () => modal(null) }],
    });

  const skillRow = (s: SkillDef) => {
    const check = canUseSkill(state, player, s.id);
    const cd = Math.max(0, (player.cooldowns?.[s.id] ?? 0) - state.round);
    const data = skillById(s.id);
    return (
      <button
        key={s.id}
        className={`skill-opt${s.ultimate ? ' ult' : ''}`}
        disabled={!check.ok}
        onClick={() => { modal(null); void act({ action: 'skill', skillId: s.id }); }}
      >
        <span className="row">
          <span>
            {s.name}
            {s.ultimate && <span className="tag ult">궁극</span>}
            {PRIORITY_TAG[s.priority] && <span className="tag">{PRIORITY_TAG[s.priority]}</span>}
          </span>
          <span>{s.ultimate ? `게이지 ${player.gauge ?? 0}%` : `AP ${skillCost(player, s, state.round)}`}</span>
        </span>
        <span className="desc">{data?.description}</span>
        {!check.ok && <span className="why">{check.reason === 'cooldown' ? `쿨다운 ${cd}라운드 남음` : WHY[check.reason]}</span>}
      </button>
    );
  };
  const openSkills = () =>
    modal({
      title: <><Icon name="star" className="ico-hd" /> 스킬 <span className="muted" style={{ fontSize: '.78rem' }}>AP {player.ap}</span></>,
      body: <div className="skill-pick">{skillList.map(skillRow)}</div>,
      buttons: [{ text: '닫기', cls: 'btn-ghost', onClick: () => modal(null) }],
    });

  return (
    <div className="battle-arena">
      <div className="battle-title"><Icon name="swords" /> 전투! <span className="muted" style={{ fontSize: '.8rem' }}>라운드 {state.round}</span></div>
      {bossMode && state.status === 'ongoing' && intent && (
        <div className={`intent${intent.kind === 'charge' || intent.kind === 'release' ? ' danger' : ''}`}>
          <div className="intent-head"><Icon name="info" /> 다음 행동: <b>{intent.name}</b></div>
          <div>{intent.telegraph}</div>
          {interruptible && (
            <div className="intent-hint">
              {intent.kind === 'charge' ? '충전 중 ' : '발동 전 '}한 라운드에 {interruptNeed} 이상 피해를 주면 끊을 수 있어요.
            </div>
          )}
        </div>
      )}
      {bossMode && state.status === 'ongoing' && <StanceBanner state={state} />}
      {charging && state.status === 'ongoing' && (
        <div className="charge-note"><Icon name="bolt" /> 힘을 모으는 중: 이번 라운드에 <b>{charging.name}</b>이(가) 발동해요. 다른 행동은 할 수 없어요.</div>
      )}
      <div className={bossMode ? 'battle-stack' : 'battle-vs'}>
        <div className="fighter you">
          <div className="fighter-name">
            나
            <StatusBadges who={player} round={state.round} />
          </div>
          <HpBar hp={player.hp} max={player.stats.maxHp} />
          <Resources who={player} />
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
            isBoss={isBossMob}
            round={state.round}
            onSelect={() => setTarget(e.id)}
          />
        ))}
        {enemies.some((e) => e.role === 'minion') && (
          <div className="minion-row">
            {enemies.filter((e) => e.role === 'minion').map((e) => (
              <EnemyCard key={e.id} enemy={e} label={e.name} selectable selected={e.id === targetId} round={state.round} onSelect={() => setTarget(e.id)} />
            ))}
          </div>
        )}
      </div>
      <div className="blog" ref={logRef}>
        {log.length === 0 ? <div className="le ls">전투 시작!</div> : log.map((l, i) => <div key={i} className={`le ${logClass(l)}`}>{l.text}</div>)}
      </div>
      {state.status === 'ongoing' && (
        <div className={`bactions${bossMode ? ' sticky' : ''}`}>
          {charging ? (
            <button className="btn btn-primary" disabled={busy} onClick={() => act({ action: 'guard' })}><Icon name="bolt" /> {charging.name} 발동</button>
          ) : (
            <>
              <button className="btn btn-danger" disabled={busy} onClick={() => act({ action: 'attack' })}><Icon name="sword" /> 공격</button>
              <button className="btn btn-warn" disabled={busy} onClick={() => act({ action: 'guard' })}><Icon name="shield" /> 방어</button>
              {skillList.length > 0 && (
                <button className={`btn btn-skill${ultReady ? ' ready' : ''}`} disabled={busy} onClick={openSkills}><Icon name="star" /> 스킬</button>
              )}
              {potions.length >= COMPACT_AT ? (
                <button className="btn btn-info" disabled={busy} onClick={openItems}><Icon name="bag" /> 아이템</button>
              ) : (
                potions.map(({ row, item }) => (
                  <button key={row.itemId} className="btn btn-info" disabled={busy} onClick={() => act({ action: 'item', itemId: row.itemId })}>
                    {item!.name} x{row.quantity}
                  </button>
                ))
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
