import { useEffect, useState } from 'react';
import type { ItemData } from '@rtgm/data';
import { api } from '../api';

export function Shop() {
  const [items, setItems] = useState<ItemData[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { api.items().then(setItems).catch((e) => setError(String(e))); }, []);
  return (
    <section>
      <h2>상점</h2>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>이름</th><th>종류</th><th>ATK</th><th>DEF</th><th>HP</th><th>구매가</th></tr></thead>
        <tbody>
          {items.filter((i) => i.buy !== null).map((i) => (
            <tr key={i.id}><td>{i.name}</td><td>{i.type}</td><td>{i.atk}</td><td>{i.def}</td><td>{i.hp || i.heal}</td><td>{i.buy}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="muted">구매 기능은 계정·인벤토리 연결 후 활성화됩니다.</p>
    </section>
  );
}
