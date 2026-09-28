import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { open } from '../src/db/index.ts';
import { seed } from '../src/db/seed.ts';
import { addDays } from '../src/shared/dates.ts';
import { capacityWindow, type CapacityDay } from '../src/shared/capacity.ts';
import {
  bookingWindow,
  canTake,
  dayOffer,
  findBookable,
  firstAvailable,
  isWithinWindow,
  nextTwoAvailable,
  offerForDate,
} from '../src/shared/availability.ts';
import { DROP_SLOTS, POOLS, type Pool } from '../src/shared/types.ts';

const MONDAY_NOON = new Date(2026, 8, 14, 12, 0, 0);
const TODAY = '2026-09-14';

let scratch: string;
let db: Database;
let days: CapacityDay[];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'svc-avail-'));
  const path = join(scratch, 'test.db');
  seed({ now: MONDAY_NOON, dbPath: path });
  db = open(path);
  days = capacityWindow(db, 1, { now: MONDAY_NOON, days: 30 });
});

afterAll(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** Hand-built day, for the cases the seed does not happen to contain. */
const fakeDay = (date: string, free: Partial<Record<Pool, [number, number]>>): CapacityDay => ({
  date,
  weekday: 1,
  pools: Object.fromEntries(
    POOLS.map((p) => {
      const [m, a] = free[p] ?? [0, 0];
      return [
        p,
        {
          morning: { total: 6, booked: 6 - m, free: m },
          afternoon: { total: 6, booked: 6 - a, free: a },
        },
      ];
    }),
  ) as CapacityDay['pools'],
});

describe('D5 — the booking window', () => {
  it('starts tomorrow and never today', () => {
    const w = bookingWindow(MONDAY_NOON);
    expect(w.earliest).toBe(addDays(TODAY, 1));
    expect(isWithinWindow(TODAY, w)).toBe(false);
  });

  it('ends exactly 30 days out', () => {
    const w = bookingWindow(MONDAY_NOON);
    expect(w.latest).toBe(addDays(TODAY, 30));
    expect(isWithinWindow(addDays(TODAY, 30), w)).toBe(true);
    expect(isWithinWindow(addDays(TODAY, 31), w)).toBe(false);
  });

  it('accepts every day in between — the centre opens 7 days, nothing to skip', () => {
    const w = bookingWindow(MONDAY_NOON);
    for (let i = 1; i <= 30; i++) expect(isWithinWindow(addDays(TODAY, i), w)).toBe(true);
  });

  it('is decided by the CALL START, so a call across midnight keeps its window', () => {
    // The rule the whole no-clock principle exists for: a call starting 23:59
    // on the 14th can book the 15th, and must still be offering the 15th when
    // the conversation runs past midnight into the 16th's calendar day.
    const callStart = new Date(2026, 8, 14, 23, 59, 0);
    const afterMidnight = new Date(2026, 8, 15, 0, 5, 0);

    const atStart = bookingWindow(callStart);
    expect(atStart.earliest).toBe('2026-09-15');

    // Same input, same answer — nothing inside reads the clock.
    expect(bookingWindow(callStart)).toEqual(atStart);

    // And this is what would have happened had it read the clock instead:
    // the day it just offered would silently become unbookable.
    expect(bookingWindow(afterMidnight).earliest).toBe('2026-09-16');
    expect(isWithinWindow('2026-09-15', bookingWindow(afterMidnight))).toBe(false);
    expect(isWithinWindow('2026-09-15', atStart)).toBe(true);
  });
});

describe('D6 — what a day can offer', () => {
  it('is available when either slot has room', () => {
    expect(dayOffer(fakeDay('2026-09-20', { minor: [3, 3] }), 'minor')).toBe('both');
    expect(dayOffer(fakeDay('2026-09-20', { minor: [1, 0] }), 'minor')).toBe('morning');
    expect(dayOffer(fakeDay('2026-09-20', { minor: [0, 1] }), 'minor')).toBe('afternoon');
    expect(dayOffer(fakeDay('2026-09-20', { minor: [0, 0] }), 'minor')).toBe('none');
  });

  it('judges each pool separately on the same day', () => {
    const day = fakeDay('2026-09-20', { minor: [0, 0], major: [2, 2], complaint: [0, 1] });
    expect(dayOffer(day, 'minor')).toBe('none');
    expect(dayOffer(day, 'major')).toBe('both');
    expect(dayOffer(day, 'complaint')).toBe('afternoon');
  });
});

describe('D6 — against the seeded bends', () => {
  const w = bookingWindow(MONDAY_NOON);

  it('skips the day where the pool is full both slots (+2)', () => {
    // Minor is full, but the day is still open for other work — availability is
    // per pool, not per day.
    expect(offerForDate(days, addDays(TODAY, 2), 'minor', w)).toBe('none');
    expect(offerForDate(days, addDays(TODAY, 2), 'major', w)).toBe('both');
  });

  it('skips the day where every pool is gone (+3)', () => {
    for (const pool of POOLS) {
      expect(offerForDate(days, addDays(TODAY, 3), pool, w)).toBe('none');
    }
  });

  it('names the one open slot rather than offering a choice (+4)', () => {
    // "Only the afternoon is free on Friday" — the agent states it.
    expect(offerForDate(days, addDays(TODAY, 4), 'minor', w)).toBe('afternoon');
  });

  it('offers the next two available days when the caller asks for a full one', () => {
    const full = addDays(TODAY, 3); // nothing at all on this day
    const next = nextTwoAvailable(days, 'minor', w, full);

    expect(next).toHaveLength(2);
    expect(next[0]!.date).toBe(addDays(TODAY, 4));
    expect(next[0]!.offer).toBe('afternoon'); // and it says which slot
    expect(next[1]!.date).toBe(addDays(TODAY, 5));
    expect(next.every((d) => d.date > full)).toBe(true);
  });

  it('never offers more than two — E0 allows at most two options a turn', () => {
    expect(nextTwoAvailable(days, 'major', w, TODAY).length).toBeLessThanOrEqual(2);
  });

  it('excludes today from the offers even though capacity exists for it', () => {
    expect(findBookable(days, 'minor', w).some((d) => d.date === TODAY)).toBe(false);
  });

  it('finds the first bookable day for a caller with no preference', () => {
    expect(firstAvailable(days, 'minor', w)?.date).toBe(addDays(TODAY, 1));
  });
});

describe('D6 — exhaustion is the loudest alarm in the system', () => {
  it('returns nothing when the whole window is full', () => {
    const w = bookingWindow(MONDAY_NOON);
    const allFull = Array.from({ length: 31 }, (_, i) => fakeDay(addDays(TODAY, i), {}));
    // Empty result -> nothing_available_30_days.
    expect(findBookable(allFull, 'minor', w)).toEqual([]);
    expect(firstAvailable(allFull, 'minor', w)).toBeUndefined();
    expect(nextTwoAvailable(allFull, 'minor', w, TODAY)).toEqual([]);
  });

  it('ignores availability that sits outside the window', () => {
    const w = bookingWindow(MONDAY_NOON);
    const outside = [
      fakeDay(TODAY, { minor: [6, 6] }), // today — too early
      fakeDay(addDays(TODAY, 31), { minor: [6, 6] }), // past 30 days
    ];
    expect(findBookable(outside, 'minor', w)).toEqual([]);
  });

  it('returns days in date order regardless of input order', () => {
    const w = bookingWindow(MONDAY_NOON);
    const shuffled = [
      fakeDay(addDays(TODAY, 9), { minor: [1, 1] }),
      fakeDay(addDays(TODAY, 2), { minor: [1, 1] }),
      fakeDay(addDays(TODAY, 5), { minor: [1, 1] }),
    ];
    expect(findBookable(shuffled, 'minor', w).map((d) => d.date)).toEqual([
      addDays(TODAY, 2),
      addDays(TODAY, 5),
      addDays(TODAY, 9),
    ]);
  });
});

describe('canTake — never confirm a slot we cannot take', () => {
  it('agrees with dayOffer on every combination', () => {
    const day = fakeDay('2026-09-20', { minor: [0, 2] });
    expect(canTake(day, 'minor', 'morning')).toBe(false);
    expect(canTake(day, 'minor', 'afternoon')).toBe(true);
    for (const s of DROP_SLOTS) {
      expect(canTake(day, 'major', s)).toBe(false);
    }
  });
});
