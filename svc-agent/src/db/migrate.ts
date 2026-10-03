import type { Database } from 'better-sqlite3';

/**
 * Columns added after a database may already hold real data. schema.sql has
 * them for fresh seeds; this brings an older file up to the same shape, in
 * place, without touching its rows. Safe to run on every open: each column is
 * added only when `PRAGMA table_info` says it is missing.
 */
const ADDED: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'bookings', column: 'arrived_at', ddl: 'arrived_at TEXT' },
  {
    table: 'leads',
    column: 'status',
    ddl: `status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done'))`,
  },
  {
    table: 'leads',
    column: 'outcome',
    ddl: `outcome TEXT CHECK (outcome IS NULL OR outcome IN (
      'booked', 'will_call_back', 'no_answer', 'not_interested', 'wrong_number'))`,
  },
  { table: 'leads', column: 'note', ddl: 'note TEXT' },
  { table: 'leads', column: 'team', ddl: 'team TEXT' },
  { table: 'leads', column: 'closed_by', ddl: 'closed_by TEXT' },
  { table: 'leads', column: 'closed_at', ddl: 'closed_at TEXT' },
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_leads_status_created ON leads(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at)`,
];

export function migrate(db: Database): number {
  let added = 0;
  db.transaction(() => {
    for (const { table, column, ddl } of ADDED) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (cols.length === 0) continue; // not one of our databases; leave it be
      if (cols.some((c) => c.name === column)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      added++;
    }
    for (const sql of INDEXES) {
      const table = /ON (\w+)\(/.exec(sql)![1]!;
      const exists = db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table);
      if (exists) db.exec(sql);
    }
  })();
  return added;
}
