import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { open } from '../src/db/index.ts';
import { seed } from '../src/db/seed.ts';
import { addDays } from '../src/shared/dates.ts';
import { DROP_SLOTS, POOLS } from '../src/shared/types.ts';
import { bookingWindow, isWithinWindow } from '../src/shared/availability.ts';
import {
  closeBooking,
  createBooking,
  DuplicateBookingError,
  expectedPickup,
  isSameDay,
  shouldOfferSameDayNudge,
  openBookingForRegistration,
  SlotFullError,
} from '../src/shared/bookings.ts';

const MONDAY = new Date(2026, 8, 14, 12, 0, 0);

let scratch: string;
let db: Database;
let TODAY: string;

const vehicleId = (registration: string) =>
  (db.prepare(`SELECT id FROM vehicles WHERE registration_number = ?`).get(registration) as {
    id: number;
  }).id;

const slot = (date: string, pool: string, dropSlot: string) =>
  db
    .prepare(
      `SELECT total_slots, booked_slots FROM slot_capacity
       WHERE centre_id = 1 AND date = ? AND service_type = ? AND drop_slot = ?`,
    )
    .get(date, pool, dropSlot) as { total_slots: number; booked_slots: number };

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'svc-bookings-'));
  const path = join(scratch, 'test.db');
  TODAY = seed({ now: MONDAY, dbPath: path }).today;
  db = open(path);
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('createBooking — the single write path', () => {
  it('takes the slot, draws a reference and computes the EDD', () => {
    const date = addDays(TODAY, 7);
    const before = slot(date, 'major', 'morning');

    const b = createBooking(db, {
      vehicleId: vehicleId('HR26AB4471'),
      centreId: 1,
      pool: 'major',
      bookingDate: date,
      dropSlot: 'morning',
      source: 'ai',
      now: MONDAY,
    });

    expect(b.reference).toMatch(/^\d{6}-\d{5}$/);
    expect(b.expectedPickup).toBe(date); // major + morning = same day (D7)
    expect(slot(date, 'major', 'morning').booked_slots).toBe(before.booked_slots + 1);
  });

  it('refuses when the slot is full, and leaves capacity untouched', () => {
    const date = addDays(TODAY, 7);
    db.prepare(
      `UPDATE slot_capacity SET total_slots = 1, booked_slots = 1
       WHERE centre_id = 1 AND date = ? AND service_type = 'minor' AND drop_slot = 'morning'`,
    ).run(date);

    expect(() =>
      createBooking(db, {
        vehicleId: vehicleId('HR26AB4471'),
        centreId: 1,
        pool: 'minor',
        bookingDate: date,
        dropSlot: 'morning',
        source: 'ai',
      }),
    ).toThrow(SlotFullError);

    expect(slot(date, 'minor', 'morning')).toEqual({ total_slots: 1, booked_slots: 1 });
  });

  it('refuses a second open booking on the same vehicle (E4 safety net, D13)', () => {
    // Meera already has one seeded.
    expect(() =>
      createBooking(db, {
        vehicleId: vehicleId('GJ01TU2255'),
        centreId: 1,
        pool: 'minor',
        bookingDate: addDays(TODAY, 8),
        dropSlot: 'morning',
        source: 'ai',
      }),
    ).toThrow(DuplicateBookingError);
  });

  it('releases the slot when the duplicate check fires after it was taken', () => {
    // The duplicate check runs first, so capacity must be completely untouched —
    // a leaked slot here would silently shrink the day for everyone else.
    const date = addDays(TODAY, 8);
    const before = slot(date, 'minor', 'morning');
    const count = () => (db.prepare(`SELECT COUNT(*) n FROM bookings`).get() as { n: number }).n;
    const countBefore = count();

    expect(() =>
      createBooking(db, {
        vehicleId: vehicleId('GJ01TU2255'),
        centreId: 1,
        pool: 'minor',
        bookingDate: date,
        dropSlot: 'morning',
        source: 'ai',
      }),
    ).toThrow(DuplicateBookingError);

    expect(slot(date, 'minor', 'morning')).toEqual(before);
    expect(count()).toBe(countBefore);
  });

  it('rolls back the whole transaction if the insert fails', () => {
    const date = addDays(TODAY, 9);
    const before = slot(date, 'minor', 'afternoon');
    const countBefore = (db.prepare(`SELECT COUNT(*) n FROM bookings`).get() as { n: number }).n;

    expect(() =>
      createBooking(db, {
        vehicleId: 99999, // violates the FK on vehicles
        centreId: 1,
        pool: 'minor',
        bookingDate: date,
        dropSlot: 'afternoon',
        source: 'ai',
      }),
    ).toThrow();

    expect(slot(date, 'minor', 'afternoon')).toEqual(before);
    expect((db.prepare(`SELECT COUNT(*) n FROM bookings`).get() as { n: number }).n).toBe(
      countBefore,
    );
  });

  it('lets exactly one of several bookings take the last slot', () => {
    const date = addDays(TODAY, 10);
    db.prepare(
      `UPDATE slot_capacity SET total_slots = 1, booked_slots = 0
       WHERE centre_id = 1 AND date = ? AND service_type = 'major' AND drop_slot = 'afternoon'`,
    ).run(date);

    const candidates = ['HR26AB4471', 'KA01AA5678', 'PB10RS7788', 'KL07BC4433'];
    const outcomes = candidates.map((reg) => {
      try {
        createBooking(db, {
          vehicleId: vehicleId(reg),
          centreId: 1,
          pool: 'major',
          bookingDate: date,
          dropSlot: 'afternoon',
          source: 'dealer',
        });
        return 'booked';
      } catch (e) {
        return e instanceof SlotFullError ? 'full' : 'other';
      }
    });

    expect(outcomes.filter((o) => o === 'booked')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'full')).toHaveLength(3);
    expect(slot(date, 'major', 'afternoon')).toEqual({ total_slots: 1, booked_slots: 1 });
  });

  it('records which channel booked it', () => {
    const date = addDays(TODAY, 11);
    const b = createBooking(db, {
      vehicleId: vehicleId('KA05MN0918'),
      centreId: 1,
      pool: 'minor',
      bookingDate: date,
      dropSlot: 'morning',
      source: 'dealer',
    });
    const row = db
      .prepare(`SELECT source FROM bookings WHERE booking_reference = ?`)
      .get(b.reference) as { source: string };
    expect(row.source).toBe('dealer');
  });

  it('does not enforce the D5 window — that governs what the agent offers, not the table', () => {
    // The dealer's own channel legitimately books same-day walk-ins.
    expect(() =>
      createBooking(db, {
        vehicleId: vehicleId('MH12PQ3344'),
        centreId: 1,
        pool: 'minor',
        bookingDate: TODAY,
        dropSlot: 'morning',
        source: 'dealer',
      }),
    ).not.toThrow();
  });
});

describe('the two channels have different windows — pinned', () => {
  // Decided 19 Sep: **the dealer screen books any day including today; the
  // voice bot books tomorrow onward.** Both halves asserted together so nobody
  // reads D5, assumes it is universal, and "fixes" the dealer desk.
  it('the dealer may book today', () => {
    expect(() =>
      createBooking(db, {
        vehicleId: vehicleId('HR26AB4471'),
        centreId: 1,
        pool: 'major',
        bookingDate: TODAY,
        dropSlot: 'morning',
        source: 'dealer',
      }),
    ).not.toThrow();
  });

  it('the agent may not — its window starts tomorrow', () => {
    const w = bookingWindow(MONDAY);
    expect(isWithinWindow(TODAY, w)).toBe(false);
    expect(isWithinWindow(addDays(TODAY, 1), w)).toBe(true);
    expect(isWithinWindow(addDays(TODAY, 30), w)).toBe(true);
    expect(isWithinWindow(addDays(TODAY, 31), w)).toBe(false);
  });
});

describe('closeBooking — reception closes a booking', () => {
  const book = (date: string) =>
    createBooking(db, {
      vehicleId: vehicleId('HR26AB4471'),
      centreId: 1,
      pool: 'major',
      bookingDate: date,
      dropSlot: 'morning',
      source: 'dealer',
      now: MONDAY,
    });

  it('gives the slot back when cancelled', () => {
    const date = addDays(TODAY, 7);
    const before = slot(date, 'major', 'morning').booked_slots;
    const b = book(date);
    expect(slot(date, 'major', 'morning').booked_slots).toBe(before + 1);

    expect(closeBooking(db, b.reference, 'cancelled')).toBe('closed');
    expect(slot(date, 'major', 'morning').booked_slots).toBe(before);
  });

  it('keeps the slot consumed when completed — the bay was used', () => {
    const date = addDays(TODAY, 7);
    const before = slot(date, 'major', 'morning').booked_slots;
    const b = book(date);
    expect(closeBooking(db, b.reference, 'completed')).toBe('closed');
    expect(slot(date, 'major', 'morning').booked_slots).toBe(before + 1);
  });

  it('lets the same vehicle book again once closed (D13)', () => {
    const b = book(addDays(TODAY, 7));
    expect(() => book(addDays(TODAY, 8))).toThrow(DuplicateBookingError);
    closeBooking(db, b.reference, 'completed');
    expect(() => book(addDays(TODAY, 8))).not.toThrow();
  });

  it('refuses to close twice, so a double click cannot release twice', () => {
    const date = addDays(TODAY, 7);
    const before = slot(date, 'major', 'morning').booked_slots;
    const b = book(date);
    expect(closeBooking(db, b.reference, 'cancelled')).toBe('closed');
    expect(closeBooking(db, b.reference, 'cancelled')).toBe('not_open');
    expect(slot(date, 'major', 'morning').booked_slots).toBe(before);
  });

  it('says so for a reference it does not hold', () => {
    expect(closeBooking(db, '000000-00000', 'completed')).toBe('not_found');
  });
});

describe('openBookingForRegistration', () => {
  it('finds an open booking with no date condition (D13)', () => {
    const found = openBookingForRegistration(db, 'GJ01TU2255');
    expect(found?.booking_reference).toMatch(/^\d{6}-\d{5}$/);
  });

  it('returns nothing for a vehicle with no open booking', () => {
    expect(openBookingForRegistration(db, 'HR26AB4471')).toBeUndefined();
  });

  it('stops blocking once the booking is closed', () => {
    db.prepare(`UPDATE bookings SET status = 'completed'`).run();
    expect(openBookingForRegistration(db, 'GJ01TU2255')).toBeUndefined();
  });
});

const DAY = '2026-09-14';
const NEXT = '2026-09-15';

describe('EDD matrix (D7)', () => {
  // The whole table, asserted as a table — so a change to one cell is visible
  // as a change to one row here.
  it.each([
    ['minor', 'morning', DAY, 'same day, evening'],
    ['minor', 'afternoon', DAY, 'same day, evening'],
    ['major', 'morning', DAY, 'same day, evening'],
    ['major', 'afternoon', NEXT, 'next day'],
    ['complaint', 'morning', NEXT, 'next day'],
    ['complaint', 'afternoon', NEXT, 'next day'],
  ] as const)('%s dropped %s → %s (%s)', (pool, dropSlot, expected, _note) => {
    expect(expectedPickup(DAY, pool, dropSlot)).toBe(expected);
  });

  it('covers every pool and slot combination', () => {
    const seen = POOLS.flatMap((p) => DROP_SLOTS.map((s) => `${p}/${s}`));
    expect(seen).toHaveLength(6);
    for (const p of POOLS) for (const s of DROP_SLOTS) {
      expect(typeof isSameDay(p, s)).toBe('boolean');
    }
  });

  it('never sends a complaint back the same day — it is the longer job', () => {
    for (const s of DROP_SLOTS) expect(isSameDay('complaint', s)).toBe(false);
  });

  it('crosses a month end correctly', () => {
    expect(expectedPickup('2026-09-30', 'major', 'afternoon')).toBe('2026-10-01');
  });

  it('offers the same-day nudge exactly when delivery is next-day (D7)', () => {
    expect(shouldOfferSameDayNudge('major', 'afternoon')).toBe(true);
    expect(shouldOfferSameDayNudge('complaint', 'morning')).toBe(true);
    expect(shouldOfferSameDayNudge('minor', 'afternoon')).toBe(false);
    expect(shouldOfferSameDayNudge('major', 'morning')).toBe(false);
  });
});
