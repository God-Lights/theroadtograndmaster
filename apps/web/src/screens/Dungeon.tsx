import { useEffect, useState } from 'react';
import type { BattleState, LogEntry } from '@rtgm/engine';
import type { MobData } from '@rtgm/data';
import { api } from '../api';

export function Dungeon() {
  const [mobs, setMobs] = useState<MobData[]>([]);
  const [battleId, setBattleId] = useState<string>();
  const [state, setState] = useState<BattleState>();
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState('');

  useEffect(() => { api.mobs().then(setMobs).catch((e) => setError(String(e))); }, []);

  const start = async (mobId: string) => {
    try {
      const res = await api.startBattle(mobId);
      setBattleId(res.id); setState(res.state); setLog([]); setError('');
    } catch (e) { setError(String(e)); }
  };

  const act = async (action: 'attack' | 'guard' | 'item') => {
    if (!battleId) return;
    try {
      const res = await api.round(battleId, action, action === 'item' ? 'bread' : undefined);
      setState(res.state); setLog((l) => [...l, ...res.log]); setError('');
    } catch (e) { setError(String(e)); }
  };

  if (!state) {
    return (
      <section>
        <h2>던전</h2>
        {error && <p className="error">{error}</p>}
        <ul className="mobs">
          {mobs.map((m) => (
            <li key={m.id}>
              <span>{m.name}{m.kind === 'boss' ? ' ⭐' : ''} (HP {m.hp})</span>
              <button onClick={() => start(m.id)}>도전</button>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section>
      <h2>전투 - 라운드 {state.round}</h2>
      {state.combatants.map((c) => (
        <div key={c.id} className="hp">
          <span>{c.name}</span>
          <progress value={c.hp} max={c.stats.maxHp} />
          <span>{c.hp}/{c.stats.maxHp}</span>
        </div>
      ))}
      {state.status === 'ongoing' ? (
        <div className="actions">
          <button onClick={() => act('attack')}>공격</button>
          <button onClick={() => act('guard')}>방어</button>
          <button onClick={() => act('item')}>빵 먹기</button>
        </div>
      ) : (
        <p className="result">{state.status === 'victory' ? '승리!' : '패배...'} <button onClick={() => setState(undefined)}>던전으로</button></p>
      )}
      {error && <p className="error">{error}</p>}
      <ol className="log">{log.map((l, i) => <li key={i}>{l.text}</li>)}</ol>
    </section>
  );
}
