import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { seed } from '../db/seed.ts';
import { timestamp } from '../shared/dates.ts';

/**
 * Who can sign in, and where each centre's data lives.
 *
 * One SQLite file per centre (`<dataDir>/orgs/<slug>.db`), not an org column on
 * every table: a query can then never leak one centre's customers into
 * another's page, because the other centre's rows are not in the file. Every
 * existing query, and CENTRE_ID = 1 inside a file, stays exactly as it was.
 *
 * `accounts.db` beside them holds only the sign-in records and the cookie key.
 */

export type Org = {
  slug: string;
  name: string;
  user_id: string;
  pw_salt: string;
  pw_hash: string;
  daily_turn_cap: number | null;
  created_at: string;
};

export class AccountError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid' | 'taken',
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

const USER_ID = /^[a-z0-9][a-z0-9-]{2,29}$/;
export const MIN_PASSWORD = 8;

/** scrypt with a per-account salt. Slow on purpose; a sign-in is rare. */
export function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 32).toString('hex') };
}

export function passwordMatches(password: string, salt: string, hash: string): boolean {
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

/**
 * The avatar's letters. Two words or more: the first letter of the first two
 * ("Auto Vikas" → AV). One word: its first letter and the next consonant, so a
 * single name still gets two letters that read as that name ("Vikas" → VK).
 */
export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length > 1) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  const w = words[0]!;
  const next = [...w.slice(1)].find((ch) => /[^aeiou\d]/i.test(ch)) ?? w[1] ?? '';
  return (w[0]! + next).toUpperCase();
}

export class Accounts {
  readonly db: Database.Database;

  constructor(readonly dataDir: string) {
    mkdirSync(join(dataDir, 'orgs'), { recursive: true });
    this.db = new Database(join(dataDir, 'accounts.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orgs (
        slug           TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        user_id        TEXT NOT NULL UNIQUE COLLATE NOCASE,
        pw_salt        TEXT NOT NULL,
        pw_hash        TEXT NOT NULL,
        daily_turn_cap INTEGER,
        created_at     TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  orgPath(slug: string): string {
    return join(this.dataDir, 'orgs', `${slug}.db`);
  }

  list(): Org[] {
    return this.db.prepare(`SELECT * FROM orgs ORDER BY created_at`).all() as Org[];
  }

  get(slug: string): Org | undefined {
    return this.db.prepare(`SELECT * FROM orgs WHERE slug = ?`).get(slug) as Org | undefined;
  }

  /** The user ID is matched without case; the password exactly. */
  verify(userId: string, password: string): Org | undefined {
    const org = this.db
      .prepare(`SELECT * FROM orgs WHERE user_id = ?`)
      .get(userId.trim()) as Org | undefined;
    if (!org) {
      // Same cost as a real check, so a wrong user ID can't be told apart
      // from a wrong password by how long the refusal takes.
      passwordMatches(password, 'x', '0'.repeat(64));
      return undefined;
    }
    return passwordMatches(password, org.pw_salt, org.pw_hash) ? org : undefined;
  }

  /**
   * A new centre. Its data is the same sample every centre starts from, made
   * by the seed's code rather than by any model, with dates relative to the
   * day of sign-up so the board is never empty or stale.
   */
  create(input: { name: string; userId: string; password: string }, now = new Date()): Org {
    const name = input.name.trim();
    const userId = input.userId.trim().toLowerCase();
    if (name.length < 3 || name.length > 60) {
      throw new AccountError('Centre name should be 3 to 60 characters', 'invalid');
    }
    if (!USER_ID.test(userId)) {
      throw new AccountError(
        'User ID: 3 to 30 lowercase letters, numbers or hyphens, starting with a letter or number',
        'invalid',
      );
    }
    if (input.password.length < MIN_PASSWORD) {
      throw new AccountError(`Password should be at least ${MIN_PASSWORD} characters`, 'invalid');
    }
    if (this.get(userId) || this.db.prepare(`SELECT 1 FROM orgs WHERE user_id = ?`).get(userId)) {
      throw new AccountError('That user ID is taken', 'taken');
    }

    const path = this.orgPath(userId);
    seed({ now, dbPath: path });
    const db = new Database(path);
    try {
      // The sample calls greet with the centre's name; they should say this one.
      const was = (db.prepare(`SELECT name FROM centres WHERE id = 1`).get() as { name: string }).name;
      db.transaction(() => {
        db.prepare(`UPDATE centres SET name = ? WHERE id = 1`).run(name);
        db.prepare(`UPDATE transcripts SET text = replace(text, ?, ?)`).run(was, name);
      })();
    } finally {
      db.close();
    }
    return this.register(userId, name, input.password, now);
  }

  setPassword(slug: string, password: string): void {
    if (password.length < MIN_PASSWORD) {
      throw new AccountError(`Password should be at least ${MIN_PASSWORD} characters`, 'invalid');
    }
    const { salt, hash } = hashPassword(password);
    this.db.prepare(`UPDATE orgs SET pw_salt = ?, pw_hash = ? WHERE slug = ?`).run(salt, hash, slug);
  }

  /** The key cookies are signed with: the configured one, else one made once and kept. */
  secret(configured: string): string {
    if (configured) return configured;
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'cookie_secret'`).get() as
      | { value: string }
      | undefined;
    if (row) return row.value;
    const value = randomBytes(32).toString('hex');
    this.db.prepare(`INSERT INTO meta (key, value) VALUES ('cookie_secret', ?)`).run(value);
    return value;
  }

  /**
   * First boot after the move to separate centres. The single database the
   * server ran on until now becomes the first centre, signed in to with the
   * old admin password. It is copied, not moved: the original stays where it
   * was, untouched, as the backup.
   */
  adoptLegacy(
    legacyPath: string,
    { slug, password }: { slug: string; password: string },
    now = new Date(),
  ): 'adopted' | 'skipped' {
    if (this.list().length > 0 || !password || !existsSync(legacyPath)) return 'skipped';
    const legacy = new Database(legacyPath, { readonly: true });
    let name: string;
    try {
      const centre = legacy.prepare(`SELECT name FROM centres WHERE id = 1`).get() as
        | { name: string }
        | undefined;
      if (!centre) return 'skipped';
      name = centre.name;
    } catch {
      return 'skipped'; // not one of our databases
    } finally {
      legacy.close();
    }
    const target = this.orgPath(slug);
    if (!existsSync(target)) {
      const src = new Database(legacyPath);
      try {
        // VACUUM INTO writes a consistent copy even with WAL pages pending.
        src.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
      } finally {
        src.close();
      }
    }
    this.register(slug, name, password, now);
    return 'adopted';
  }

  private register(slug: string, name: string, password: string, now: Date): Org {
    const { salt, hash } = hashPassword(password);
    this.db
      .prepare(
        `INSERT INTO orgs (slug, name, user_id, pw_salt, pw_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(slug, name, slug, salt, hash, timestamp(now));
    return this.get(slug)!;
  }

  close(): void {
    this.db.close();
  }
}
