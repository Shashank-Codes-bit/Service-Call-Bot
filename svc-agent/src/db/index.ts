import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { migrate } from './migrate.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where the database lives. Comes from the environment so a deployment points
 * at a mounted volume; the default sits beside the source for local work. Were
 * it hardcoded, every deploy would ship a fresh image and lose the data.
 */
export const DB_PATH = config.dbPath;

export function open(path: string = DB_PATH): Database.Database {
  const db = new Database(path);
  // Off by default in SQLite; without it the REFERENCES clauses are decoration.
  db.pragma('foreign_keys = ON');
  // Both apps hold the same file open. WAL lets the dealer app read while the
  // call app writes, instead of the two blocking each other.
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * DESTRUCTIVE. schema.sql drops every table before recreating it, so this
 * wipes the database whatever state it was in. Only `seed.ts` calls it.
 */
export function resetSchema(db: Database.Database): void {
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  // The parts defined once, in migrate.ts: the knowledge search index and its
  // triggers, and the essentials form's table.
  migrate(db);
}
