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
  {
    table: 'knowledge_bank',
    column: 'category',
    ddl: `category TEXT NOT NULL DEFAULT 'essentials'
      CHECK (category IN ('cars', 'services', 'offers', 'essentials'))`,
  },
  { table: 'knowledge_bank', column: 'title', ddl: 'title TEXT' },
  { table: 'knowledge_bank', column: 'phrases', ddl: 'phrases TEXT' },
  { table: 'knowledge_bank', column: 'valid_until', ddl: 'valid_until TEXT' },
  { table: 'knowledge_bank', column: 'updated_at', ddl: 'updated_at TEXT' },
];

/**
 * The knowledge search index. External-content FTS5 over knowledge_bank, kept
 * in step by triggers — so a save on the Knowledge page is searchable in the
 * same transaction that wrote it, and the agent finds it on its next turn.
 * There is no index job to run and nothing to go stale.
 */
const KNOWLEDGE_FTS = `
  CREATE VIRTUAL TABLE knowledge_fts USING fts5(
    title, phrases, answer_text,
    content = 'knowledge_bank', content_rowid = 'id',
    tokenize = 'porter unicode61'
  );
  CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge_bank BEGIN
    INSERT INTO knowledge_fts (rowid, title, phrases, answer_text)
    VALUES (new.id, new.title, new.phrases, new.answer_text);
  END;
  CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge_bank BEGIN
    INSERT INTO knowledge_fts (knowledge_fts, rowid, title, phrases, answer_text)
    VALUES ('delete', old.id, old.title, old.phrases, old.answer_text);
  END;
  CREATE TRIGGER knowledge_au AFTER UPDATE ON knowledge_bank BEGIN
    INSERT INTO knowledge_fts (knowledge_fts, rowid, title, phrases, answer_text)
    VALUES ('delete', old.id, old.title, old.phrases, old.answer_text);
    INSERT INTO knowledge_fts (rowid, title, phrases, answer_text)
    VALUES (new.id, new.title, new.phrases, new.answer_text);
  END;
`;

/** "opening_hours" → "Opening hours": a title for rows written before titles existed. */
const titleFromKey = (key: string) => {
  const t = key.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

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
    const hasTable = (name: string) =>
      Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(name));
    if (hasTable('knowledge_bank')) {
      // Rows from before titles existed get one from their key, so the
      // Knowledge page and the classifier both have something to read.
      const untitled = db
        .prepare(`SELECT id, question_key FROM knowledge_bank WHERE title IS NULL`)
        .all() as { id: number; question_key: string }[];
      const setTitle = db.prepare(`UPDATE knowledge_bank SET title = ? WHERE id = ?`);
      for (const r of untitled) setTitle.run(titleFromKey(r.question_key), r.id);
      if (!hasTable('knowledge_fts')) {
        db.exec(KNOWLEDGE_FTS);
        db.exec(`INSERT INTO knowledge_fts (knowledge_fts) VALUES ('rebuild')`);
        added++;
      }
    }
    if (hasTable('centres') && !hasTable('centre_profile')) {
      // The Centre essentials form, as the centre filled it in. The agent's
      // essentials answers are written from it (kb/knowledge.ts).
      db.exec(`CREATE TABLE centre_profile (
        centre_id  INTEGER PRIMARY KEY REFERENCES centres(id),
        data       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
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
