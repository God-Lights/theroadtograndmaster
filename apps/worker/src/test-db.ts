import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * 테스트용 D1 어댑터: 실제 SQLite(node:sqlite)에 실제 마이그레이션을 적용한다.
 * batch 는 D1처럼 한 트랜잭션이고, changes() 같은 SQLite 동작도 그대로 검증된다.
 */
export function createTestDb() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(f, dir), 'utf8'));
  }

  type Param = string | number | null;
  const stmt = (sql: string, params: Param[] = []) => ({
    bind: (...p: Param[]) => stmt(sql, p),
    run: async () => {
      const r = sqlite.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(r.changes) }, results: [] };
    },
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    all: async () => ({ success: true, meta: {}, results: sqlite.prepare(sql).all(...params) }),
  });

  const db = {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: ReturnType<typeof stmt>[]) => {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return { db: db as unknown as D1Database, sqlite };
}
