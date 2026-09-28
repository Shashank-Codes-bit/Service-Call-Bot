import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { open } from '../src/db/index.ts';
import { seed } from '../src/db/seed.ts';
import { LEAD_REASONS } from '../src/shared/types.ts';
import {
  AUDIENCES,
  auditReasonCoverage,
  LEAD_REPORTS,
  runReport,
} from '../src/dealer/reports.ts';

const MONDAY = new Date(2026, 8, 14, 12, 0, 0);

let scratch: string;
let db: Database;
let TODAY: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'svc-reports-'));
  const path = join(scratch, 'test.db');
  TODAY = seed({ now: MONDAY, dbPath: path }).today;
  db = open(path);
});

afterAll(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('F3 — a lead type appears in exactly one report', () => {
  // "A lead in two reports is a lead nobody owns." Encoded as a map, so this
  // catches a second owner the moment someone adds one.
  it('gives every one of the nine reasons exactly one owner', () => {
    for (const { reason, owners } of auditReasonCoverage()) {
      expect(owners, `${reason} should have exactly one report`).toHaveLength(1);
    }
  });

  it('claims no reason that is not one of the nine', () => {
    const claimed = Object.values(LEAD_REPORTS).flatMap((r) => [...r.reasons]);
    for (const reason of claimed) expect(LEAD_REASONS).toContain(reason);
  });

  it('has seven reports in total — five lead lists plus arrivals and activity', () => {
    expect(AUDIENCES).toHaveLength(7);
  });
});

describe('report contents', () => {
  it('routes escalations to customer care', () => {
    const r = runReport(db, 'customer-care', TODAY);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!['reason']).toBe('another_problem');
    expect(String(r.rows[0]!['caller_words'])).toContain("won't start");
  });

  it('splits retention into its two call scripts (F2)', () => {
    const r = runReport(db, 'retention', TODAY);
    expect(r.rows).toHaveLength(2);
    expect(r.groups).toHaveLength(2);

    const [chase, recordFix] = r.groups!;
    // Overdue — has a due date on record, it just went past the cutoff.
    expect(chase!.rows).toHaveLength(1);
    expect(chase!.rows[0]!['vehicle_model']).toBe('Altroz');
    // No due date — we don't know when it's due, so the record needs fixing.
    expect(recordFix!.rows).toHaveLength(1);
    expect(recordFix!.rows[0]!['vehicle_model']).toBe('Venue');
    expect(recordFix!.rows[0]!['due_date']).toBeNull();
  });

  it('gives the service manager all three capacity outcomes', () => {
    const reasons = runReport(db, 'service-manager', TODAY).rows.map((r) => r['reason']);
    expect(reasons.sort()).toEqual([
      'forced_full_day',
      'nothing_available_30_days',
      'same_day_demanded',
    ]);
  });

  it('gives the CRM team the three data-quality failures', () => {
    const reasons = runReport(db, 'crm-data', TODAY).rows.map((r) => r['reason']);
    expect(reasons.sort()).toEqual([
      'missing_required_field',
      'model_not_recognised',
      'number_not_found',
    ]);
  });

  it('gives reception the stale open booking', () => {
    const r = runReport(db, 'reception', TODAY);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!['vehicle_registration']).toBe('GJ01TU2255');
  });

  it('shows every seeded lead exactly once across the five lead reports', () => {
    const total = (Object.keys(LEAD_REPORTS) as (keyof typeof LEAD_REPORTS)[])
      .map((a) => runReport(db, a, TODAY).rows.length)
      .reduce((a, b) => a + b, 0);
    const seeded = (db.prepare(`SELECT COUNT(*) n FROM leads`).get() as { n: number }).n;
    expect(total).toBe(seeded);
  });

  it('returns nothing for a day with no leads — reports are per-day, not cumulative', () => {
    expect(runReport(db, 'customer-care', '2026-01-01').rows).toEqual([]);
  });
});

describe('booking reports', () => {
  it('lists arrivals for the day the car turns up, not the day it was booked', () => {
    const bookingDate = (
      db.prepare(`SELECT booking_date AS d FROM bookings LIMIT 1`).get() as { d: string }
    ).d;
    expect(bookingDate).not.toBe(TODAY); // Meera's is five days out

    expect(runReport(db, 'bookings-arrivals', TODAY).rows).toHaveLength(0);
    expect(runReport(db, 'bookings-arrivals', bookingDate).rows).toHaveLength(1);
  });

  it('lists activity for the day the booking was taken', () => {
    const r = runReport(db, 'bookings-activity', TODAY);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!['source']).toBe('dealer');
  });
});
