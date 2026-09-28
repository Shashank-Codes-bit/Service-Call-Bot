import { describe, expect, it, vi } from 'vitest';
import {
  addDays,
  daysBetween,
  parseIsoDate,
  timestamp,
  toIsoDate,
  today,
  weekdayOf,
} from '../src/shared/dates.ts';
import { bookingWindow } from '../src/shared/availability.ts';

describe('local-time date arithmetic (I4-7)', () => {
  it('formats a date just after local midnight as that day, not the day before', () => {
    // The regression: toISOString() on 2026-09-06T00:30 in IST yields
    // 2026-09-05T19:00Z, so the date silently goes back one day for every run
    // between 00:00 and 05:30 IST.
    const justAfterMidnight = new Date(2026, 8, 6, 0, 30, 0);
    expect(toIsoDate(justAfterMidnight)).toBe('2026-09-06');
    expect(today(justAfterMidnight)).toBe('2026-09-06');
  });

  it('formats a date just before local midnight as that day, not the day after', () => {
    const justBeforeMidnight = new Date(2026, 8, 6, 23, 45, 0);
    expect(toIsoDate(justBeforeMidnight)).toBe('2026-09-06');
  });

  it('round-trips through parse without drifting', () => {
    for (const d of ['2026-01-01', '2026-02-28', '2026-09-06', '2026-12-31']) {
      expect(toIsoDate(parseIsoDate(d))).toBe(d);
    }
  });

  it('rejects a date that JS would silently roll over', () => {
    expect(() => parseIsoDate('2026-02-30')).toThrow();
    expect(() => parseIsoDate('2026-13-01')).toThrow();
    expect(() => parseIsoDate('not-a-date')).toThrow();
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-09-06', 1)).toBe('2026-09-07');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('walks the full 30-day booking window without skipping or repeating', () => {
    const start = '2026-09-06';
    const seen = new Set<string>();
    for (let i = 0; i <= 30; i++) seen.add(addDays(start, i));
    expect(seen.size).toBe(31);
    expect(daysBetween(start, addDays(start, 30))).toBe(30);
  });

  it('reports weekday 0 for Sunday, matching capacity_master.weekday', () => {
    // 2026-09-06 is a Sunday.
    expect(weekdayOf('2026-09-06')).toBe(0);
    const weekdays = Array.from({ length: 7 }, (_, i) => weekdayOf(addDays('2026-09-06', i)));
    expect(weekdays).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('stamps a timestamp with a local offset rather than Z', () => {
    const t = timestamp(new Date(2026, 8, 6, 0, 30, 0));
    expect(t.startsWith('2026-09-06T00:30:00')).toBe(true);
    expect(t.endsWith('Z')).toBe(false);
  });
});

describe('the centre clock, not the host clock (I4-7, D5)', () => {
  // A cloud machine runs UTC. At 00:30 in India it is still yesterday in UTC,
  // so the agent offered today as the earliest booking — the one day D5
  // forbids. Reproduced first, then fixed by importing config.
  it('keeps India dates on a UTC host', async () => {
    const saved = process.env.TZ;
    const instant = new Date('2026-09-20T19:00:00Z'); // 00:30 IST on the 21st
    try {
      process.env.TZ = 'UTC';
      expect(today(instant)).toBe('2026-09-20'); // the bug, as a UTC host sees it

      vi.resetModules();
      await import('../src/config.ts');
      expect(today(instant)).toBe('2026-09-21');
      expect(bookingWindow(instant).earliest).toBe('2026-09-22');
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});
