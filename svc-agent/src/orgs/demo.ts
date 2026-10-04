import type { Database } from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seed } from '../db/seed.ts';
import { regenerateCapacity } from '../shared/capacity.ts';
import { today } from '../shared/dates.ts';

/**
 * A demo centre's nightly clean-up: its day's activity goes back to the sample
 * for the new day, so every visitor finds sample callers free to book and a
 * board that reads like a working morning.
 *
 * Only activity is replaced — customers and their cars (including demo
 * callers visitors added), bookings, calls, follow-ups, SMS and the capacity
 * window. What the centre set up is kept: its name and desk number, its
 * Knowledge entries and Centre essentials, and its weekly places.
 */

/** Replaced every night, in an order the foreign keys accept. */
const ACTIVITY = [
  'customers', 'vehicles', 'service_due', 'slot_capacity', 'booking_counter',
  'bookings', 'sessions', 'transcripts', 'leads', 'sms_log',
] as const;

/** The hour (centre time) after which the day's reset runs. */
export const RESET_HOUR = 3;

/** True once it's past the reset hour on a day this centre hasn't been reset yet. */
export function resetDue(now: Date, lastReset: string | undefined): boolean {
  return now.getHours() >= RESET_HOUR && lastReset !== today(now);
}

export function resetDemoActivity(db: Database, now = new Date()): { bookings: number; leads: number } {
  const dir = mkdtempSync(join(tmpdir(), 'svc-demo-reset-'));
  const fresh = join(dir, 'sample.db');
  try {
    // The same code-made sample a new centre gets, dated today. No model calls.
    seed({ now, dbPath: fresh });
    const name = (db.prepare(`SELECT name FROM centres WHERE id = 1`).get() as { name: string }).name;

    db.exec(`ATTACH DATABASE '${fresh.replace(/'/g, "''")}' AS fresh`);
    try {
      const sampleName = (db.prepare(`SELECT name FROM fresh.centres WHERE id = 1`).get() as { name: string }).name;
      db.transaction(() => {
        for (const t of [...ACTIVITY].reverse()) db.exec(`DELETE FROM main.${t}`);
        for (const t of ACTIVITY) {
          // By name, not position: a centre moved in from before a column
          // existed has it added at the end.
          const cols = (db.prepare(`PRAGMA main.table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
          const have = new Set((db.prepare(`PRAGMA fresh.table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
          const shared = cols.filter((c) => have.has(c)).join(', ');
          db.exec(`INSERT INTO main.${t} (${shared}) SELECT ${shared} FROM fresh.${t}`);
        }
        // The sample's calls and texts speak with the sample's name; these
        // should speak with this centre's.
        if (sampleName !== name) {
          db.prepare(`UPDATE main.transcripts SET text = replace(text, ?, ?)`).run(sampleName, name);
          db.prepare(`UPDATE main.sms_log SET body = replace(body, ?, ?)`).run(sampleName, name);
        }
      })();
    } finally {
      db.exec(`DETACH DATABASE fresh`);
    }
    // The centre's own weekly places, applied to the new window (never below
    // what the sample has booked).
    regenerateCapacity(db, { now });
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return { bookings: n(`SELECT COUNT(*) n FROM bookings`), leads: n(`SELECT COUNT(*) n FROM leads`) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The "done for today" mark, kept in accounts.db so a restart doesn't reset twice. */
export const resetKey = (slug: string) => `demo_reset:${slug}`;

/**
 * Run each demo centre's reset once a day, after the reset hour. Checked
 * often (server.ts), so a server that was down at 3:00 catches up when it
 * comes back. A centre seen for the first time is only marked — it was
 * either just created from the sample or is being met by this code for the
 * first time, and either way tonight is soon enough.
 */
export function nightlyResets(
  accounts: { list(): Array<{ slug: string }>; getMeta(k: string): string | undefined; setMeta(k: string, v: string): void },
  registry: { get(slug: string): { db: Database; demo: boolean } | undefined },
  now = new Date(),
  log: (line: string) => void = console.log,
): string[] {
  const done: string[] = [];
  for (const { slug } of accounts.list()) {
    const h = registry.get(slug);
    if (!h?.demo) continue;
    const last = accounts.getMeta(resetKey(slug));
    if (last === undefined) {
      accounts.setMeta(resetKey(slug), today(now));
      continue;
    }
    if (!resetDue(now, last)) continue;
    const r = resetDemoActivity(h.db, now);
    accounts.setMeta(resetKey(slug), today(now));
    log(`  demo reset ${slug}: back to the sample for ${today(now)} (${r.bookings} bookings, ${r.leads} follow-ups)`);
    done.push(slug);
  }
  return done;
}
