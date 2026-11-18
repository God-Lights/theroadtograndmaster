import { useCallback, useEffect, useState } from 'react';
import { itemById, mobById } from '@rtgm/data';
import { api, fmtWait, type Loot, type RogueInfo, type RunView } from '../api';
import { useGame } from '../game';
import { Icon } from '../Icon';
import { Battle } from './Battle';

const ROOM_ICON: Record<string, string> = { monster: '⚔️', treasure: '💰', trap: '🪤', nothing: '🌫️', clear: '🏆' };

function LootLine({ loot }: { loot: Loot }) {
  return (
    <div className="item-stat">
      <Icon name="coin" /> {loot.gold.toLocaleString()}D · 숙련도 +{loot.proficiency}
      {loot.items.map((i) => ` · ${itemById(i.itemId)?.name ?? i.itemId} ×${i.quantity}`)}
    </div>
  );
}

export function Rogue() {
  const { toast, fail, refresh } = useGame();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.runInfo>>>();
  const [result, setResult] = useState<RunView>();
  const [lastRoom, setLastRoom] = useState<{ kind: string; text: string }>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => { try { setInfo(await api.runInfo()); } catch (e) { fail(e); } }, [fail]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);

  const act = async (fn: () => Promise<RunView>, after?: (r: RunView) => void) => {
    setBusy(true);
    try { const r = await fn(); after?.(r); await Promise.all([load(), refresh()]); } catch (e) { fail(e); await load(); } finally { setBusy(false); }
  };

  if (!info) return <div className="empty">불러오는 중...</div>;
  const run = info.run;

  // 끝난 런의 결과
  if (result && result.status === 'done') {
    const text = result.result === 'clear' ? '🏆 던전을 완주했어요!' : result.result === 'retreat' ? '전리품을 챙겨 빠져나왔어요.' : '💀 쓰러졌어요… 전리품을 잃었어요.';
    return (
      <div className="card">
        <div className="card-title">{result.name} · 결과</div>
        <div className={`turn-note pvp-result ${result.result === 'dead' ? 'opponent' : 'me'}`}>{text}</div>
        <div className="note">{result.result === 'dead' ? '받은 것 (숙련도만 조금)' : '받은 전리품'}</div>
        <LootLine loot={result.loot} />
        <div className="wiki-def">{result.events.slice(-6).map((e, i) => <div key={i} className="wiki-line">{ROOM_ICON[e.kind]} {e.floor}층 · {e.text}</div>)}</div>
        <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => setResult(undefined)}>확인</button>
      </div>
    );
  }

  // 전투 중
  if (run?.status === 'battle' && run.battle) {
    const mob = mobById(run.battle.mobId);
    if (mob) {
      return (
        <>
          <div className="card">
            <div className="card-title">{run.name} · {run.floor}/{run.floors}층</div>
            <div className="note">전투에서 이기면 HP가 이어지고 보상은 전리품이 돼요. 쓰러지면 전리품을 잃어요.</div>
          </div>
          <Battle key={run.battle.id} battleId={run.battle.id} initial={run.battle.state} mob={mob}
            onEnd={async () => { await load(); try { const l = await api.runLast(); if (l.run && l.run.status === 'done' && !(await api.runInfo()).run) setResult(l.run); } catch { /* 무시 */ } }} />
        </>
      );
    }
  }

  // 진행 중
  if (run) {
    const pct = Math.max(0, Math.round((run.hp / run.maxHp) * 100));
    const last = run.floor + 1 >= run.floors;
    return (
      <>
        <div className="card">
          <div className="card-title"><Icon name="map" /> {run.name} · {run.floor}/{run.floors}층</div>
          <div className="hp-bar-wrap"><div className="hp-bar" style={{ width: `${pct}%` }} /></div>
          <div className="hp-label">HP {run.hp}/{run.maxHp} · 층을 내려가도 HP가 이어져요</div>
          <div className="note" style={{ marginTop: 8 }}>지금까지의 전리품 (탈출해야 받아요)</div>
          <LootLine loot={run.loot} />
        </div>
        {lastRoom && (
          <div className={`turn-note${lastRoom.kind === 'trap' ? ' pvp-result opponent' : lastRoom.kind === 'treasure' ? ' pvp-result me' : ''}`}>{ROOM_ICON[lastRoom.kind]} {lastRoom.text}</div>
        )}
        <div className="form-col">
          <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api.runAdvance(), (r) => setLastRoom(r.room))}>
            {last ? '⚠ 최종 보스가 기다리는 마지막 층으로' : `${run.floor + 1}층으로 내려가기`}
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => { if (confirm('후퇴할까요? 전리품을 받고 나가지만 대기시간이 걸려요.')) void act(() => api.runRetreat(), (r) => { setResult(r); toast('전리품을 챙겼어요.'); }); }}>후퇴하고 전리품 받기</button>
        </div>
        <div className="card">
          <div className="card-title">기록</div>
          {run.events.length === 0 && <div className="muted">아직 아무 방에도 들어가지 않았어요.</div>}
          {[...run.events].reverse().slice(0, 8).map((e, i) => <div key={i} className="wiki-line">{ROOM_ICON[e.kind]} {e.floor}층 · {e.text}</div>)}
        </div>
      </>
    );
  }

  // 던전 목록
  return (
    <>
      <div className="note">층마다 방이 하나씩 열려요: ⚔️ 몬스터 · 💰 보물 · 🪤 함정 · 🌫️ 빈 방. 마지막 층에는 최종 보스가 있어요. 모은 전리품은 완주하거나 후퇴해야 받고, 쓰러지면 잃어요.</div>
      {info.dungeons.map((d: RogueInfo) => {
        const locked = info.proficiency < d.minProficiency;
        const wait = Math.max(0, d.until - now);
        const boss = mobById(d.finalBoss.mobId);
        return (
          <div key={d.id} className="card">
            <div className="card-title"><Icon name={locked ? 'lock' : 'skull'} /> {d.name}</div>
            <div className="note">{d.description}</div>
            {locked && <div className="lock-label"><Icon name="lock" /> 숙련도 {d.minProficiency} 필요 · 현재 {info.proficiency}</div>}
            {!locked && info.proficiency < d.recommendedProficiency && <div className="lock-label"><Icon name="lock" /> 권장 숙련도 {d.recommendedProficiency}</div>}
            <div className="stat-row"><span className="stat-label">층 수</span><span>{d.floors}층</span></div>
            <div className="stat-row"><span className="stat-label">만나는 몬스터</span><span>{d.monsters.map((m) => mobById(m)?.name.split(' ')[0]).join(', ')}</span></div>
            <div className="stat-row"><span className="stat-label">최종 보스</span><span>{d.finalBoss.title} {boss?.name.split(' ')[0]} (×{d.finalBoss.mult})</span></div>
            <div className="stat-row"><span className="stat-label">완주 보너스</span><span>{d.clearBonus.gold[0].toLocaleString()}~{d.clearBonus.gold[1].toLocaleString()}D · 숙련도 +{d.clearBonus.proficiency}</span></div>
            <div className="stat-row"><span className="stat-label">입장</span><span>{d.entryGold > 0 ? `${d.entryGold}D` : '무료'} · 재입장 대기 {d.cooldownMinutes}분 (후퇴·사망 시 절반)</span></div>
            {wait > 0 && <div className="lock-label"><Icon name="lock" /> 대기 중 · {fmtWait(wait)} 남음</div>}
            <button className="btn btn-primary" style={{ width: '100%', marginTop: 8 }} disabled={busy || locked || wait > 0 || info.gold < d.entryGold}
              onClick={() => act(() => api.runStart(d.id), () => { setLastRoom(undefined); setResult(undefined); })}>
              {locked ? `숙련도 ${d.minProficiency} 필요` : wait > 0 ? `대기 중 (${fmtWait(wait)})` : info.gold < d.entryGold ? '달런트가 부족해요' : '입장하기'}
            </button>
          </div>
        );
      })}
    </>
  );
}
