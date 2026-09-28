import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_PATH } from './index.ts';
import { seed } from './seed.ts';

/**
 * A fresh server volume is an empty directory. Without this the first boot has
 * no tables: every portal read fails and the first call dies in the CRM lookup.
 *
 * `seed()` drops every table, so the guard is the feature, and it is lopsided
 * on purpose. It seeds only when the file is missing, or present with none of
 * our tables. A database with our tables and no rows is kept — far likelier a
 * half-restored backup than a blank, and guessing wrong that way cannot be
 * undone. A corrupt file throws, which beats seeding over it.
 */
export function seedIfEmpty(dbPath: string = DB_PATH): 'seeded' | 'kept' {
  mkdirSync(dirname(dbPath), { recursive: true });

  // Checked before any open, because opening creates the file.
  if (existsSync(dbPath)) {
    const db = new Database(dbPath);
    try {
      const { n } = db
        .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .get() as { n: number };
      if (n > 0) return 'kept';
    } finally {
      db.close();
    }
  }

  seed({ dbPath });
  return 'seeded';
}
