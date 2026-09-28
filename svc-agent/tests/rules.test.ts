import { describe, expect, it } from 'vitest';
import { addDays } from '../src/shared/dates.ts';
import {
  assessBookability,
  FREE_SERVICE_OVERDUE_DAYS,
  otherDueVehicles,
  poolFor,
  type ServiceDueRecord,
} from '../src/shared/service-due.ts';
import { isExhausted, PUSHBACK_LIMIT, registerPushback, remaining } from '../src/shared/service-due.ts';
import { buildLead } from '../src/shared/leads.ts';
import { LEAD_REASONS } from '../src/shared/types.ts';

const CALL_DATE = '2026-09-14';
const NOW = new Date(2026, 8, 14, 12, 0, 0);

const due = (o: Partial<ServiceDueRecord>): ServiceDueRecord => ({
  service_number: 3,
  service_type: 'minor',
  is_free: 1,
  due_date: addDays(CALL_DATE, -10),
  ...o,
});

describe('D2 / D3 — the full blocker matrix', () => {
  it.each([
    // type            free   due date                       bookable  reason
    ['null type',      null,  1, addDays(CALL_DATE, -10), false, 'missing_required_field'],
    ['free, no due',   'minor', 1, null,                  false, 'free_service_not_bookable'],
    ['free, 75 over',  'minor', 1, addDays(CALL_DATE, -75), false, 'free_service_not_bookable'],
    ['free, 30 over',  'minor', 1, addDays(CALL_DATE, -30), true,  null],
    ['free, future',   'minor', 1, addDays(CALL_DATE, 45),  true,  null],
    ['paid, no due',   'major', 0, null,                    true,  null],
    ['paid, 200 over', 'major', 0, addDays(CALL_DATE, -200), true, null],
  ] as const)('%s', (_label, service_type, is_free, due_date, bookable, reason) => {
    const result = assessBookability(
      due({ service_type: service_type as ServiceDueRecord['service_type'], is_free, due_date }),
      CALL_DATE,
    );
    expect(result.bookable).toBe(bookable);
    if (!result.bookable) expect(result.reason).toBe(reason);
  });

  it('names the missing field so the CRM team can fix that record (D3)', () => {
    const r = assessBookability(due({ service_type: null }), CALL_DATE);
    expect(r.bookable).toBe(false);
    if (!r.bookable) expect(r.missingField).toBe('service_type');
  });

  it('refuses a vehicle with no CRM record at all', () => {
    const r = assessBookability(null, CALL_DATE);
    expect(r.bookable).toBe(false);
    if (!r.bookable) expect(r.reason).toBe('missing_required_field');
  });

  it('treats a FUTURE due date as informational, never a blocker', () => {
    // The rule most likely to be implemented backwards: someone whose service
    // is due in six months can still book today.
    const r = assessBookability(due({ due_date: addDays(CALL_DATE, 180) }), CALL_DATE);
    expect(r.bookable).toBe(true);
  });

  it('applies the 60-day cutoff to FREE services only, never paid', () => {
    const veryOverdue = addDays(CALL_DATE, -365);
    expect(assessBookability(due({ is_free: 1, due_date: veryOverdue }), CALL_DATE).bookable).toBe(false);
    expect(assessBookability(due({ is_free: 0, due_date: veryOverdue }), CALL_DATE).bookable).toBe(true);
  });

  it('applies the null-due-date rule to FREE services only, never paid', () => {
    expect(assessBookability(due({ is_free: 1, due_date: null }), CALL_DATE).bookable).toBe(false);
    expect(assessBookability(due({ is_free: 0, due_date: null }), CALL_DATE).bookable).toBe(true);
  });

  it('sits the boundary at exactly 60 days — both sides asserted', () => {
    // CONTEXT says "more than 60 days overdue (due date 60+ days before the
    // call date)". The parenthetical is the precise one, so 60 blocks and 59
    // books. If that reading is ever corrected, this is the test that says so.
    const at = addDays(CALL_DATE, -FREE_SERVICE_OVERDUE_DAYS);
    const justInside = addDays(CALL_DATE, -(FREE_SERVICE_OVERDUE_DAYS - 1));
    expect(assessBookability(due({ due_date: at }), CALL_DATE).bookable).toBe(false);
    expect(assessBookability(due({ due_date: justInside }), CALL_DATE).bookable).toBe(true);
  });

  it('accepts SQLite booleans as 0/1 and as true/false', () => {
    expect(assessBookability(due({ is_free: true, due_date: null }), CALL_DATE).bookable).toBe(false);
    expect(assessBookability(due({ is_free: false, due_date: null }), CALL_DATE).bookable).toBe(true);
  });

  it('always refuses with one of the nine reasons', () => {
    const refusals = [
      assessBookability(null, CALL_DATE),
      assessBookability(due({ service_type: null }), CALL_DATE),
      assessBookability(due({ due_date: null }), CALL_DATE),
      assessBookability(due({ due_date: addDays(CALL_DATE, -90) }), CALL_DATE),
    ];
    for (const r of refusals) {
      expect(r.bookable).toBe(false);
      if (!r.bookable) expect(LEAD_REASONS).toContain(r.reason);
    }
  });
});

describe('D8 — a complaint moves the job to the complaint pool', () => {
  it('overrides whatever the CRM said the service was', () => {
    expect(poolFor('minor', true)).toBe('complaint');
    expect(poolFor('major', true)).toBe('complaint');
  });

  it('leaves the pool alone when there is no complaint', () => {
    expect(poolFor('minor', false)).toBe('minor');
    expect(poolFor('major', false)).toBe('major');
  });
});

describe('D12 — mentioning a second due vehicle at the close', () => {
  const vehicles = [
    { id: 1, model: 'Swift', registration_number: 'DL8CAF2213', due: due({}) },
    { id: 2, model: 'Creta', registration_number: 'DL8CAG5567', due: due({}) },
  ];

  it('finds the other vehicle on the account', () => {
    const others = otherDueVehicles(vehicles, 1, CALL_DATE);
    expect(others.map((v) => v.model)).toEqual(['Creta']);
  });

  it('never returns the vehicle being booked', () => {
    for (const id of [1, 2]) {
      expect(otherDueVehicles(vehicles, id, CALL_DATE).some((v) => v.id === id)).toBe(false);
    }
  });

  it('stays quiet about a vehicle we would then refuse to book', () => {
    // Raising a car at the close and turning it away on the next call is worse
    // than saying nothing.
    const withBlocked = [
      vehicles[0]!,
      { id: 3, model: 'Venue', registration_number: 'TN09VW6600', due: due({ due_date: null }) },
      { id: 4, model: 'Kwid', registration_number: 'UP16ZA8899', due: due({ service_type: null }) },
    ];
    expect(otherDueVehicles(withBlocked, 1, CALL_DATE)).toEqual([]);
  });

  it('returns nothing for a single-vehicle account', () => {
    expect(otherDueVehicles([vehicles[0]!], 1, CALL_DATE)).toEqual([]);
  });
});

describe('D11 — the pushback limit', () => {
  it('routes out on the third push, not the fourth', () => {
    expect(registerPushback(0)).toEqual({ count: 1, exhausted: false });
    expect(registerPushback(1)).toEqual({ count: 2, exhausted: false });
    expect(registerPushback(2)).toEqual({ count: 3, exhausted: true });
  });

  it('is one shared counter, not one per question', () => {
    // A caller who pushes once on the day, once on the slot and once on
    // same-day delivery has pushed three times — the limit is reached even
    // though no single question was forced three times.
    let count = 0;
    for (const _ of ['day', 'slot', 'same-day']) count = registerPushback(count).count;
    expect(isExhausted(count)).toBe(true);
  });

  it('reports how many pushes are left', () => {
    expect(remaining(0)).toBe(PUSHBACK_LIMIT);
    expect(remaining(2)).toBe(1);
    expect(remaining(5)).toBe(0);
  });
});

describe('buildLead — one payload builder for all nine outcomes', () => {
  it('builds every reason without throwing', () => {
    for (const reason of LEAD_REASONS) {
      expect(() => buildLead(reason, { mobileNumber: '9899999999' }, NOW)).not.toThrow();
    }
  });

  it('rejects a reason that is not one of the nine', () => {
    // Fails here with a readable message rather than as a CHECK violation.
    expect(() =>
      buildLead('kb_miss' as never, { mobileNumber: '9899999999' }, NOW),
    ).toThrow(/unknown lead reason/);
  });

  it('refuses a lead with no number — an unreachable lead is not a lead', () => {
    expect(() => buildLead('another_problem', { mobileNumber: '' }, NOW)).toThrow(
      /no mobile number/,
    );
  });

  it('carries everything F2 asks for when the call got that far', () => {
    const row = buildLead(
      'forced_full_day',
      {
        mobileNumber: '9810044004',
        customerId: 5,
        vehicleRegistration: 'MH12PQ3344',
        vehicleModel: 'i20',
        requestedDate: addDays(CALL_DATE, 3),
        requestedSlot: 'morning',
        requestedPool: 'minor',
        crmSnapshot: { service_number: 2, is_free: true, due_date: null },
        callerWords: 'It has to be Wednesday.',
        sessionId: 'sess-1',
      },
      NOW,
    );

    expect(row).toMatchObject({
      mobile_number: '9810044004',
      reason: 'forced_full_day',
      vehicle_registration: 'MH12PQ3344',
      requested_slot: 'morning',
      session_id: 'sess-1',
    });
    expect(JSON.parse(row.crm_snapshot!)).toEqual({
      service_number: 2,
      is_free: true,
      due_date: null,
    });
    expect(row.created_at.startsWith(CALL_DATE)).toBe(true);
  });

  it('nulls the fields a shallow exit never learned', () => {
    // A failed OTP knows only the caller ID.
    const row = buildLead('number_not_found', { mobileNumber: '9899999999' }, NOW);
    expect(row.vehicle_registration).toBeNull();
    expect(row.requested_date).toBeNull();
    expect(row.crm_snapshot).toBeNull();
    expect(row.customer_id).toBeNull();
  });
});
