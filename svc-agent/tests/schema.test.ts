import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { open, resetSchema } from '../src/db/index.ts';
import { seedIfEmpty } from '../src/db/bootstrap.ts';
import { seed } from '../src/db/seed.ts';
import { addDays } from '../src/shared/dates.ts';
import { nextBookingReference } from '../src/shared/bookings.ts';

const scratch = mkdtempSync(join(tmpdir(), 'svc-agent-'));
const dbPath = join(scratch, 'test.db');

/** 2026-09-06 is a Sunday, so +0..+6 covers every weekday. */
const SUNDAY = new Date(2026, 8, 6, 12, 0, 0);

let db: Database;
let TODAY: string;

beforeAll(() => {
  TODAY = seed({ now: SUNDAY, dbPath }).today;
  db = open(dbPath);
});

afterAll(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

const slot = (date: string, pool: string, dropSlot: string) =>
  db
    .prepare(
      `SELECT total_slots, booked_slots FROM slot_capacity
       WHERE centre_id = 1 AND date = ? AND service_type = ? AND drop_slot = ?`,
    )
    .get(date, pool, dropSlot) as { total_slots: number; booked_slots: number };

describe('overbooking is impossible (I4-3, D4)', () => {
  it('lets the conditional UPDATE take the last slot exactly once', () => {
    const date = addDays(TODAY, 20);
    db.prepare(
      `UPDATE slot_capacity SET total_slots = 1, booked_slots = 0
       WHERE centre_id = 1 AND date = ? AND service_type = 'major' AND drop_slot = 'morning'`,
    ).run(date);

    const take = db.prepare(
      `UPDATE slot_capacity SET booked_slots = booked_slots + 1
       WHERE centre_id = 1 AND date = ? AND service_type = 'major' AND drop_slot = 'morning'
         AND booked_slots < total_slots`,
    );

    expect(take.run(date).changes).toBe(1); // first booking wins
    expect(take.run(date).changes).toBe(0); // second is refused, silently and safely
    expect(slot(date, 'major', 'morning')).toEqual({ total_slots: 1, booked_slots: 1 });
  });

  it('rejects an overflow even if code bypasses the conditional UPDATE', () => {
    const date = addDays(TODAY, 21);
    expect(() =>
      db
        .prepare(
          `UPDATE slot_capacity SET booked_slots = total_slots + 1
           WHERE centre_id = 1 AND date = ? AND service_type = 'minor' AND drop_slot = 'morning'`,
        )
        .run(date),
    ).toThrow(/CHECK constraint failed/);
  });

  it('rejects a negative booked_slots', () => {
    const date = addDays(TODAY, 22);
    expect(() =>
      db
        .prepare(
          `UPDATE slot_capacity SET booked_slots = -1
           WHERE centre_id = 1 AND date = ? AND service_type = 'minor' AND drop_slot = 'morning'`,
        )
        .run(date),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('capacity bends land on every weekday (I4-1, I4-2)', () => {
  // The old isSunday guard zeroed whichever day happened to be a Sunday, which
  // is how the "one slot left" case vanished. This asserts the bends fire
  // whatever weekday the seed runs on — the failure was only ever visible by
  // querying the database, never by reading the seed.
  for (let offset = 0; offset < 7; offset++) {
    const runDay = new Date(2026, 8, 6 + offset, 12, 0, 0);

    it(`holds when seeded on weekday ${runDay.getDay()}`, () => {
      const path = join(scratch, `weekday-${offset}.db`);
      const s = seed({ now: runDay, dbPath: path });
      const d = open(path);
      const at = (date: string, pool: string, dropSlot: string) =>
        d
          .prepare(
            `SELECT total_slots, booked_slots FROM slot_capacity
             WHERE centre_id = 1 AND date = ? AND service_type = ? AND drop_slot = ?`,
          )
          .get(date, pool, dropSlot) as { total_slots: number; booked_slots: number };

      const plus2 = addDays(s.today, 2);
      const plus3 = addDays(s.today, 3);
      const plus4 = addDays(s.today, 4);

      for (const dropSlot of ['morning', 'afternoon']) {
        const r = at(plus2, 'minor', dropSlot);
        expect(r.total_slots).toBeGreaterThan(0); // never zeroed away
        expect(r.booked_slots).toBe(r.total_slots); // minor is full
      }

      for (const pool of ['minor', 'major', 'complaint']) {
        for (const dropSlot of ['morning', 'afternoon']) {
          const r = at(plus3, pool, dropSlot);
          expect(r.booked_slots).toBe(r.total_slots); // whole day gone
        }
      }

      // The case that used to disappear: exactly one slot open on the day.
      const morning = at(plus4, 'minor', 'morning');
      const afternoon = at(plus4, 'minor', 'afternoon');
      expect(morning.booked_slots).toBe(morning.total_slots);
      expect(afternoon.total_slots).toBeGreaterThan(afternoon.booked_slots);

      d.close();
    });
  }
});

describe('booking reference', () => {
  it('starts at 00000 and increments per centre per day', () => {
    expect(nextBookingReference(db, 2, '2026-09-06')).toBe('260906-00000');
    expect(nextBookingReference(db, 2, '2026-09-06')).toBe('260906-00001');
    expect(nextBookingReference(db, 2, '2026-09-06')).toBe('260906-00002');
    // A different centre keeps its own sequence on the same day.
    expect(nextBookingReference(db, 3, '2026-09-06')).toBe('260906-00000');
    // And the same centre restarts on the next day.
    expect(nextBookingReference(db, 2, '2026-09-07')).toBe('260907-00000');
  });

  it('is digits only, so it survives being read down a phone line', () => {
    expect(nextBookingReference(db, 2, '2026-12-31')).toMatch(/^\d{6}-\d{5}$/);
  });

  it('never hands the same reference to two bookings', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(nextBookingReference(db, 3, '2026-10-01'));
    expect(seen.size).toBe(200);
  });

  it('is rejected as a duplicate at the bookings table', () => {
    const existing = db.prepare(`SELECT booking_reference FROM bookings LIMIT 1`).get() as {
      booking_reference: string;
    };
    expect(existing.booking_reference).toMatch(/^\d{6}-\d{5}$/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO bookings (booking_reference, vehicle_id, centre_id, service_type,
             booking_date, drop_slot, expected_pickup, status, source, created_at)
           VALUES (?, 1, 1, 'minor', ?, 'morning', ?, 'open', 'ai', ?)`,
        )
        .run(existing.booking_reference, TODAY, TODAY, TODAY),
    ).toThrow(/UNIQUE constraint failed/);
  });
});

describe('lead reasons — exactly nine (F2, as amended)', () => {
  const NINE = [
    'number_not_found',
    'model_not_recognised',
    'missing_required_field',
    'another_problem',
    'free_service_not_bookable',
    'existing_open_booking',
    'forced_full_day',
    'nothing_available_30_days',
    'same_day_demanded',
  ];

  const insertLead = () =>
    db.prepare(
      `INSERT INTO leads (mobile_number, reason, created_at) VALUES ('9899999999', ?, ?)`,
    );

  const leadCount = () =>
    (db.prepare(`SELECT COUNT(*) AS n FROM leads`).get() as { n: number }).n;

  it('accepts all nine', () => {
    // Delta, not an absolute — the seed writes its own leads so the report
    // screens have something to render.
    const before = leadCount();
    for (const reason of NINE) {
      expect(() => insertLead().run(reason, TODAY)).not.toThrow();
    }
    expect(leadCount() - before).toBe(9);
  });

  it('rejects a tenth value', () => {
    // The two that were merged must not reappear as separate reasons.
    for (const reason of ['free_service_overdue', 'free_service_no_due_date', 'kb_miss', '']) {
      expect(() => insertLead().run(reason, TODAY)).toThrow(/CHECK constraint failed/);
    }
  });
});

describe('seeded branches are actually reachable', () => {
  const dueFor = (registration: string) =>
    db
      .prepare(
        `SELECT s.service_type, s.is_free, s.due_date
         FROM service_due s JOIN vehicles v ON v.id = s.vehicle_id
         WHERE v.registration_number = ?`,
      )
      .get(registration) as { service_type: string | null; is_free: number; due_date: string | null };

  it('has a free service with no due date — blocks booking (D2)', () => {
    const r = dueFor('TN09VW6600');
    expect(r.is_free).toBe(1);
    expect(r.due_date).toBeNull();
  });

  it('has a paid service with no due date — books normally (D2)', () => {
    const r = dueFor('KL07BC4433');
    expect(r.is_free).toBe(0);
    expect(r.due_date).toBeNull();
  });

  it('has a free service more than 60 days overdue (D2)', () => {
    const r = dueFor('RJ14XY1177');
    expect(r.is_free).toBe(1);
    expect(r.due_date! < addDays(TODAY, -60)).toBe(true);
  });

  it('has a free service overdue but inside 60 days — still bookable (D2)', () => {
    const r = dueFor('MH12PQ3344');
    expect(r.due_date! < TODAY).toBe(true);
    expect(r.due_date! > addDays(TODAY, -60)).toBe(true);
  });

  it('has a due date in the future — not a blocker (D2)', () => {
    expect(dueFor('KA05MN0918').due_date! > TODAY).toBe(true);
  });

  it('has a null service type — cannot create a booking (D3)', () => {
    expect(dueFor('UP16ZA8899').service_type).toBeNull();
  });

  it('has an open booking blocking one vehicle (E4, D13)', () => {
    const open = db
      .prepare(
        `SELECT COUNT(*) AS n FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
         WHERE v.registration_number = 'GJ01TU2255' AND b.status = 'open'`,
      )
      .get() as { n: number };
    expect(open.n).toBe(1);
  });

  it('has two vehicles sharing a model, so model alone cannot disambiguate', () => {
    const swifts = db
      .prepare(
        `SELECT COUNT(*) AS n FROM vehicles v JOIN customers c ON c.id = v.customer_id
         WHERE c.mobile_number = '9810111011' AND v.model = 'Swift'`,
      )
      .get() as { n: number };
    expect(swifts.n).toBe(2);
  });

  it('has a mobile number deliberately absent, for the not-found lead', () => {
    const found = db
      .prepare(`SELECT COUNT(*) AS n FROM customers WHERE mobile_number = '9899999999'`)
      .get() as { n: number };
    expect(found.n).toBe(0);
  });
});

describe('capacity master covers every weekday', () => {
  it('has 42 rows and no weekday with zero capacity — the centre is open 7 days (D5)', () => {
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM capacity_master`).get() as { n: number };
    expect(rows.n).toBe(42);

    const empty = db
      .prepare(`SELECT COUNT(*) AS n FROM capacity_master WHERE total_slots = 0`)
      .get() as { n: number };
    expect(empty.n).toBe(0);
  });

  it('generates slot_capacity for all 31 days across 3 centres', () => {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM slot_capacity`).get() as { n: number };
    expect(n.n).toBe(31 * 3 * 2 * 3);
  });

  it('leaves centres 2 and 3 wide open — only centre 1 is bent (I3)', () => {
    const booked = db
      .prepare(`SELECT COUNT(*) AS n FROM slot_capacity WHERE centre_id IN (2, 3) AND booked_slots > 0`)
      .get() as { n: number };
    expect(booked.n).toBe(0);
  });
});

describe('seedIfEmpty — first boot on a fresh volume', () => {
  // seed() drops every table, so what matters most here is what it refuses to do.
  const at = (name: string) => join(scratch, 'boot', name, 'service.db');
  const rows = (path: string, table: string) => {
    const d = open(path);
    try {
      return (d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    } finally {
      d.close();
    }
  };

  it('seeds when there is no file, creating the directory too', () => {
    const path = at('absent');
    expect(seedIfEmpty(path)).toBe('seeded');
    expect(rows(path, 'customers')).toBeGreaterThan(0);
  });

  it('seeds an empty file — a boot that died before finishing', () => {
    const path = at('zero');
    seedIfEmpty(path);
    writeFileSync(path, '');
    expect(seedIfEmpty(path)).toBe('seeded');
  });

  it('never touches a database that has data', () => {
    const path = at('live');
    seedIfEmpty(path);
    const d = open(path);
    d.prepare(`UPDATE customers SET name = 'Marker' WHERE id = 1`).run();
    d.close();

    expect(seedIfEmpty(path)).toBe('kept');
    const d2 = open(path);
    expect((d2.prepare(`SELECT name FROM customers WHERE id = 1`).get() as { name: string }).name).toBe('Marker');
    d2.close();
  });

  it('keeps a schema with no rows — likelier a half-restore than a blank', () => {
    const path = at('schema-only');
    seedIfEmpty(path);
    const d = open(path);
    resetSchema(d);
    d.close();
    expect(seedIfEmpty(path)).toBe('kept');
    expect(rows(path, 'customers')).toBe(0);
  });
});
