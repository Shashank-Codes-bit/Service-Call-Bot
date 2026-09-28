import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { open } from '../src/db/index.ts';
import { seed } from '../src/db/seed.ts';
import { addDays } from '../src/shared/dates.ts';
import {
  capacityWindow,
  readMaster,
  regenerateCapacity,
  writeMaster,
} from '../src/shared/capacity.ts';

const MONDAY = new Date(2026, 8, 14, 12, 0, 0);
/** Eight days on, exactly the drift that made the checked-in DB go stale. */
const EIGHT_DAYS_LATER = new Date(2026, 8, 22, 12, 0, 0);

let scratch: string;
let db: Database;
let TODAY: string;

const slot = (date: string, pool: string, dropSlot: string) =>
  db
    .prepare(
      `SELECT total_slots, booked_slots FROM slot_capacity
       WHERE centre_id = 1 AND date = ? AND service_type = ? AND drop_slot = ?`,
    )
    .get(date, pool, dropSlot) as { total_slots: number; booked_slots: number } | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'svc-capacity-'));
  const path = join(scratch, 'test.db');
  TODAY = seed({ now: MONDAY, dbPath: path }).today;
  db = open(path);
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('regeneration — rule 1: never touch the past', () => {
  it('leaves yesterday alone even when the master changes', () => {
    // Yesterday has no row (the seed starts at today), and regeneration must not
    // create one either — history is not ours to invent.
    const yesterday = addDays(TODAY, -1);
    expect(slot(yesterday, 'minor', 'morning')).toBeUndefined();

    regenerateCapacity(db, { now: MONDAY });
    expect(slot(yesterday, 'minor', 'morning')).toBeUndefined();
  });

  it('does not rewrite a past day that does exist', () => {
    const past = addDays(TODAY, -3);
    db.prepare(
      `INSERT INTO slot_capacity (centre_id, date, service_type, drop_slot, total_slots, booked_slots)
       VALUES (1, ?, 'minor', 'morning', 99, 4)`,
    ).run(past);

    regenerateCapacity(db, { now: MONDAY });
    expect(slot(past, 'minor', 'morning')).toEqual({ total_slots: 99, booked_slots: 4 });
  });
});

describe('regeneration — rule 2: never break the CHECK', () => {
  it('clamps a cut to what is already booked rather than failing', () => {
    const date = addDays(TODAY, 5);
    db.prepare(
      `UPDATE slot_capacity SET total_slots = 6, booked_slots = 5
       WHERE centre_id = 1 AND date = ? AND service_type = 'minor' AND drop_slot = 'morning'`,
    ).run(date);

    // The dealer cuts minor morning to 2 across the board.
    const master = readMaster(db);
    for (let w = 0; w <= 6; w++) master[w]!.minor.morning = 2;
    writeMaster(db, master);

    expect(() => regenerateCapacity(db, { now: MONDAY })).not.toThrow();
    // Held at 5 — it cannot go below what is sold, and the CHECK is intact.
    expect(slot(date, 'minor', 'morning')).toEqual({ total_slots: 5, booked_slots: 5 });
  });

  it('applies the cut fully where nothing is booked', () => {
    const date = addDays(TODAY, 6);
    const master = readMaster(db);
    for (let w = 0; w <= 6; w++) master[w]!.major.afternoon = 1;
    writeMaster(db, master);
    regenerateCapacity(db, { now: MONDAY });

    expect(slot(date, 'major', 'afternoon')?.total_slots).toBe(1);
  });

  it('raises capacity when the master grows', () => {
    const date = addDays(TODAY, 6);
    const master = readMaster(db);
    for (let w = 0; w <= 6; w++) master[w]!.complaint.morning = 12;
    writeMaster(db, master);
    regenerateCapacity(db, { now: MONDAY });

    expect(slot(date, 'complaint', 'morning')?.total_slots).toBe(12);
  });
});

describe('regeneration — rule 3: report what did not apply', () => {
  it('names the days where the cut was held back', () => {
    const date = addDays(TODAY, 5);
    db.prepare(
      `UPDATE slot_capacity SET total_slots = 6, booked_slots = 5
       WHERE centre_id = 1 AND date = ? AND service_type = 'minor' AND drop_slot = 'morning'`,
    ).run(date);

    const master = readMaster(db);
    for (let w = 0; w <= 6; w++) master[w]!.minor.morning = 2;
    writeMaster(db, master);

    const result = regenerateCapacity(db, { now: MONDAY });
    const conflict = result.conflicts.find(
      (c) => c.date === date && c.pool === 'minor' && c.dropSlot === 'morning',
    );
    expect(conflict).toMatchObject({ requested: 2, heldAt: 5 });
  });

  it('reports no conflicts when every cut lands', () => {
    expect(regenerateCapacity(db, { now: MONDAY }).conflicts).toEqual([]);
  });
});

describe('regeneration walks the window forward — the staleness fix', () => {
  it('restores a full 30 days on a database that has sat for eight days', () => {
    const laterToday = addDays(TODAY, 8);

    // Before: the window still ends where the original seed left it.
    const endBefore = (
      db.prepare(`SELECT MAX(date) AS d FROM slot_capacity WHERE centre_id = 1`).get() as {
        d: string;
      }
    ).d;
    expect(endBefore).toBe(addDays(TODAY, 30));

    const result = regenerateCapacity(db, { now: EIGHT_DAYS_LATER });

    expect(result.from).toBe(laterToday);
    expect(result.to).toBe(addDays(laterToday, 30));
    expect(result.created).toBeGreaterThan(0);

    const endAfter = (
      db.prepare(`SELECT MAX(date) AS d FROM slot_capacity WHERE centre_id = 1`).get() as {
        d: string;
      }
    ).d;
    expect(endAfter).toBe(addDays(laterToday, 30));

    // And the whole forward window is contiguous — no gaps to fall into.
    const days = (
      db
        .prepare(
          `SELECT COUNT(DISTINCT date) AS n FROM slot_capacity
           WHERE centre_id = 1 AND date >= ? AND date <= ?`,
        )
        .get(laterToday, addDays(laterToday, 30)) as { n: number }
    ).n;
    expect(days).toBe(31);
  });

  it('is idempotent — running it twice changes nothing the second time', () => {
    regenerateCapacity(db, { now: MONDAY });
    const second = regenerateCapacity(db, { now: MONDAY });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
  });
});

describe('master read/write', () => {
  it('round-trips the 7x6 grid', () => {
    const master = readMaster(db);
    expect(Object.keys(master)).toHaveLength(7);
    master[3]!.major.afternoon = 9;
    writeMaster(db, master);
    expect(readMaster(db)[3]!.major.afternoon).toBe(9);
  });

  it('rejects a negative or non-integer value rather than writing it', () => {
    const master = readMaster(db);
    master[0]!.minor.morning = -1;
    expect(() => writeMaster(db, master)).toThrow(/bad master value/);
    // Rejected as a whole — the transaction rolled back.
    expect(readMaster(db)[0]!.minor.morning).toBeGreaterThanOrEqual(0);
  });
});

describe('capacityWindow', () => {
  it('shapes the grid the dealer screen renders, with the bends visible', () => {
    const w = capacityWindow(db, 1, { now: MONDAY, days: 6 });
    expect(w).toHaveLength(7);

    const plus3 = w.find((d) => d.date === addDays(TODAY, 3))!;
    for (const pool of ['minor', 'major', 'complaint'] as const) {
      for (const s of ['morning', 'afternoon'] as const) {
        expect(plus3.pools[pool][s].free).toBe(0); // the whole day is gone
      }
    }

    const plus4 = w.find((d) => d.date === addDays(TODAY, 4))!;
    expect(plus4.pools.minor.morning.free).toBe(0);
    expect(plus4.pools.minor.afternoon.free).toBeGreaterThan(0);
  });
});
