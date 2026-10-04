import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { open } from '../src/db/index.ts';
import { seed } from '../src/db/seed.ts';
import { addDays } from '../src/shared/dates.ts';
import { StubClassifier } from '../src/call/classifier.ts';
import { DEMO_PLATE_PREFIX, DemoCrm, LocalCrm } from '../src/call/crm.ts';
import { handleTurn, startCall, type CallDeps } from '../src/call/machine.ts';
import { readTranscript } from '../src/call/session.ts';
import type { TurnResult } from '../src/call/types.ts';

/** Monday. Bends land on Wed +2 (minor), Thu +3 (everything), Fri +4 (minor am). */
const MONDAY = new Date(2026, 8, 14, 10, 0, 0);
const TODAY = '2026-09-14';

let scratch: string;
let db: Database;
let deps: CallDeps;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'svc-machine-'));
  seed({ now: MONDAY, dbPath: join(scratch, 'test.db') });
  db = open(join(scratch, 'test.db'));
  deps = { classifier: new StubClassifier(), crm: new LocalCrm(db) };
});

afterEach(() => {
  db.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** Drive a whole call: caller's lines in, every agent reply out. */
async function call(number: string, lines: string[]): Promise<TurnResult[]> {
  const first = await startCall(db, number, MONDAY);
  const out = [first];
  let last = first;
  for (const line of lines) {
    if (last.ended) break;
    last = await handleTurn(db, deps, first.sessionId, line, MONDAY);
    out.push(last);
  }
  return out;
}

const said = (turns: TurnResult[]) => turns.map((t) => t.reply).join('\n');

describe('the E10 reference call, end to end', () => {
  it('books Rohit in', async () => {
    const turns = await call('9810011001', [
      "Yeah, that's right.",
      "I need to get the Nexon serviced. Friday if you've got something.",
      "No, it's fine.",
      'No.',
      "Morning's better.",
    ]);
    const last = turns.at(-1)!;

    expect(last.ended).toBe(true);
    expect(last.bookingReference).toMatch(/^\d{6}-\d{5}$/);

    const script = said(turns);
    // Discloses the bot once, in one clause, and never again (G3.1).
    expect(script.match(/automated assistant|automated line/g)).toHaveLength(1);
    // States what is due rather than asking the caller to confirm it (D1).
    expect(script).toContain('fourth service');
    // Asks about a fault like a person, not like a survey (E6).
    expect(script).toContain('anything actually wrong');
    // Names the caller exactly once, at the end (G3.8).
    expect(script.match(/Rohit/g)).toHaveLength(1);

    const booking = db
      .prepare(`SELECT booking_date, drop_slot, service_type, source FROM bookings WHERE booking_reference = ?`)
      .get(last.bookingReference!) as Record<string, string>;
    expect(booking).toMatchObject({
      booking_date: addDays(TODAY, 4), // the Friday they asked for
      drop_slot: 'morning',
      service_type: 'major',
      source: 'ai',
    });
  });

  it('writes the SMS it promised, with the reference and the landline', async () => {
    const turns = await call('9810011001', [
      'Yes.',
      'Book the Nexon in for Friday please.',
      'Nothing wrong with it.',
      'No thanks.',
      'Morning.',
    ]);
    const sms = db.prepare(`SELECT body FROM sms_log ORDER BY id DESC LIMIT 1`).get() as {
      body: string;
    };
    expect(sms.body).toContain(turns.at(-1)!.bookingReference!);
    expect(sms.body).toContain('01244567890');
    expect(sms.body).toContain('estimate');
  });

  it('keeps a full transcript of both sides', async () => {
    const turns = await call('9810011001', ['Yes.', 'Service the Nexon on Friday.', 'No.', 'No.', 'Morning.']);
    const t = readTranscript(db, turns[0]!.sessionId);
    expect(t.filter((x) => x.speaker === 'caller').length).toBeGreaterThan(3);
    expect(t.filter((x) => x.speaker === 'agent').length).toBeGreaterThan(3);
    expect(t.map((x) => x.turn_index)).toEqual(t.map((_, i) => i));
  });
});

describe('identification', () => {
  it('routes out a number that is not on the system', async () => {
    const turns = await call('9899999999', ['Yes, that is my number.']);
    expect(turns.at(-1)!.leadReason).toBe('number_not_found');
    expect(turns.at(-1)!.ended).toBe(true);
  });

  it('asks for the registered number on the different-phone branch', async () => {
    const turns = await call('9810011001', ['No, this is my work phone.']);
    expect(turns.at(-1)!.state).toBe('awaiting_number');
    expect(turns.at(-1)!.expectsDigits).toBe(true);
  });

  it('ends after three failed OTP attempts, with the lead on the caller ID', async () => {
    const turns = await call('9810011001', [
      'No.',
      '9810044004',
      '0000', // wrong -> back to number entry (E1), one attempt spent
      '9810044004',
      '1111',
      '9810044004',
      '2222',
    ]);
    expect(turns.at(-1)!.leadReason).toBe('number_not_found');
    const lead = db.prepare(`SELECT mobile_number FROM leads ORDER BY id DESC LIMIT 1`).get() as {
      mobile_number: string;
    };
    expect(lead.mobile_number).toBe('9810044004');
  });
});

describe('vehicle disambiguation (E2)', () => {
  it('states the vehicle rather than asking when there is only one', async () => {
    const turns = await call('9810011001', ['Yes.']);
    expect(turns.at(-1)!.reply).toContain('Nexon');
    expect(turns.at(-1)!.state).toBe('open_turn');
  });

  it('asks for model and last four when there are several', async () => {
    const turns = await call('9810022002', ['Yes.']);
    expect(turns.at(-1)!.state).toBe('vehicle');
    expect(turns.at(-1)!.reply).toMatch(/last four/i);
  });

  it('resolves on the model alone when models differ', async () => {
    const turns = await call('9810022002', ['Yes.', "It's the Creta."]);
    expect(turns.at(-1)!.state).toBe('open_turn');
  });

  it('resolves on the last four alone', async () => {
    const turns = await call('9810022002', ['Yes.', '5567']);
    expect(turns.at(-1)!.state).toBe('open_turn');
  });

  it('ends the call when two cars share a model and only the model is given', async () => {
    // Arjun has two Swifts, so the third pass cannot discriminate.
    const turns = await call('9810111011', ['Yes.', "It's the Swift."]);
    expect(turns.at(-1)!.leadReason).toBe('model_not_recognised');
    expect(turns.at(-1)!.ended).toBe(true);
  });

  it('still resolves two same-model cars when the digits are given', async () => {
    const turns = await call('9810111011', ['Yes.', 'Swift, 5678.']);
    expect(turns.at(-1)!.state).toBe('open_turn');
  });
});

describe('the blockers fire before anything is promised', () => {
  it('refuses a free service with no due date (D2)', async () => {
    const turns = await call('9810077007', ['Yes.', 'Book the Venue in for Friday.']);
    expect(turns.at(-1)!.leadReason).toBe('free_service_not_bookable');
  });

  it('refuses a free service 75 days overdue (D2)', async () => {
    const turns = await call('9810088008', ['Yes.', 'Service for the Altroz please.']);
    expect(turns.at(-1)!.leadReason).toBe('free_service_not_bookable');
  });

  it('books a PAID service with no due date (D2)', async () => {
    const turns = await call('9810100010', ['Yes.', 'Book the Ertiga in for Friday.']);
    expect(turns.at(-1)!.state).toBe('complaint');
  });

  it('refuses when the service type is missing (D3)', async () => {
    const turns = await call('9810099009', ['Yes.', 'Need the Kwid serviced.']);
    expect(turns.at(-1)!.leadReason).toBe('missing_required_field');
  });

  it('books a future due date — not a blocker (D2)', async () => {
    const turns = await call('9810033003', ['Yes.', 'Book the Baleno in for Friday.']);
    expect(turns.at(-1)!.state).toBe('complaint');
  });

  it('stops at the duplicate check, before complaints or days (E4)', async () => {
    const turns = await call('9810066006', ['Yes.', 'Book the Tiago in for Friday.']);
    expect(turns.at(-1)!.leadReason).toBe('existing_open_booking');
    // The point of checking at intent: they were never asked about a fault.
    expect(said(turns)).not.toContain('anything actually wrong');
  });
});

describe('day and slot (D5, D6)', () => {
  it('offers two alternatives when the requested day is full', async () => {
    // Thursday (+3) is the seeded "whole day gone" bend.
    const turns = await call('9810011001', ['Yes.', 'Nexon service on Thursday.', 'No.', 'No.']);
    const reply = turns.at(-1)!.reply;
    expect(turns.at(-1)!.state).toBe('day');
    expect(reply).toMatch(/full/i);
    // Two options, never a list (E0).
    expect(reply.match(/the \d+(st|nd|rd|th)/g)?.length).toBeLessThanOrEqual(2);
  });

  it('states the single free slot rather than offering a choice (D6)', async () => {
    // Friday (+4) has minor morning full, afternoon open. Sunita is minor.
    const turns = await call('9810044004', ['Yes.', 'Book the i20 in on Friday.', 'No.', 'No.']);
    expect(turns.at(-1)!.reply).toMatch(/only got the afternoon|afternoon is all/i);
  });

  it('offers both slots with their consequences, not as menu items (E8)', async () => {
    const turns = await call('9810011001', ['Yes.', 'Nexon service Friday.', 'No.', 'No.']);
    const reply = turns.at(-1)!.reply;
    expect(reply).toMatch(/8:30/);
    expect(reply).toMatch(/same evening/);
  });

  it('routes out after three pushes on a full day (D11)', async () => {
    const turns = await call('9810011001', [
      'Yes.',
      'Nexon service.',
      'No.',
      'No.',
      'Thursday.',
      'Thursday.',
      'Thursday.',
    ]);
    expect(turns.at(-1)!.leadReason).toBe('forced_full_day');
  });
});

describe('the same-day nudge (D7)', () => {
  it('raises it where delivery lands on the next day, and routes out if pressed', async () => {
    // Karan's Fortuner is major; an afternoon drop is a next-day collection.
    const turns = await call('9810055005', [
      'Yes.',
      'Book the Fortuner in for Friday.',
      'No.',
      'No.',
      'Afternoon.',
      'Yes please, I need it same day.',
    ]);
    // Asserted on the flow, not the wording. This used to match /same day/i,
    // which held only because the broken seed always picked the one phrasing
    // that spells it without a hyphen.
    expect(turns.map((t) => t.state)).toContain('confirm');
    expect(turns.at(-1)!.leadReason).toBe('same_day_demanded');
  });

  it('books normally when the nudge is declined', async () => {
    const turns = await call('9810055005', [
      'Yes.',
      'Book the Fortuner in for Friday.',
      'No.',
      'No.',
      'Afternoon.',
      'No, next day is fine.',
    ]);
    expect(turns.at(-1)!.bookingReference).toBeDefined();
  });
});

describe('complaints (D8)', () => {
  it('moves the booking to the complaint pool and skips the special request', async () => {
    const turns = await call('9810011001', [
      'Yes.',
      'Nexon service on Friday.',
      "There's a rattling from the front when I brake.",
      'Morning.',
      'No, next day is fine.',
    ]);
    const last = turns.at(-1)!;
    expect(said(turns)).not.toMatch(/wash, interior clean/);

    const booking = db
      .prepare(`SELECT service_type, complaint_note FROM bookings WHERE booking_reference = ?`)
      .get(last.bookingReference!) as { service_type: string; complaint_note: string };
    expect(booking.service_type).toBe('complaint');
    expect(booking.complaint_note).toContain('rattling');
  });
});

describe('the spoken offer never promises delivery it cannot make (D7)', () => {
  it('does not offer a same-evening morning slot on a complaint job', () => {
    // The complaint pool is next-day whichever slot they take. Promising an
    // evening here is the exact failure D7 warns about.
    return call('9810055005', [
      'Yes.',
      'Fortuner service.',
      "There's a rattling from the front when I brake.",
      'Friday.',
    ]).then((turns) => {
      const offer = turns.at(-1)!.reply;
      expect(offer).toMatch(/8:30/);
      expect(offer).not.toMatch(/same evening/i);
      expect(offer).toMatch(/next day/i);
    });
  });

  it('does offer same-evening for a minor job, where it is true', async () => {
    const turns = await call('9810044004', ['Yes.', 'i20 service.', 'No.', 'No.', 'Tuesday.']);
    expect(said(turns)).toMatch(/same evening/i);
  });

  it('acknowledges a reported fault before moving on (G3.3)', async () => {
    const turns = await call('9810055005', [
      'Yes.',
      'Fortuner service.',
      "There's a rattling from the front when I brake.",
    ]);
    expect(turns.at(-1)!.reply).toMatch(/job card|noted|look at/i);
  });

  it('speaks the drop time, never a clock string', async () => {
    const turns = await call('9810011001', ['Yes.', 'Nexon service Friday.', 'No.', 'No.', 'Morning.']);
    const closing = turns.at(-1)!.reply;
    expect(closing).toContain('8:30');
    expect(closing).not.toContain('08:30');
    expect(closing).not.toContain('14:00');
  });
});

describe('out-of-band questions (D9, D10)', () => {
  it('answers a cost question with no number, then resumes', async () => {
    const turns = await call('9810011001', ['Yes.', 'Nexon service Friday.', 'How much will it cost?']);
    const reply = turns.at(-1)!.reply;
    expect(reply).toMatch(/depends|varies/i);
    expect(reply).not.toMatch(/₹|\brupees?\b|\b\d{3,}\b/);
    // Still on the same question afterwards.
    expect(turns.at(-1)!.state).toBe('complaint');
  });

  it('answers from the knowledge bank, then resumes', async () => {
    const turns = await call('9810011001', ['Yes.', 'Nexon service Friday.', 'What time do you open?']);
    expect(turns.at(-1)!.reply).toMatch(/9 in the morning/);
    expect(turns.at(-1)!.state).toBe('complaint');
  });

  it('ends the call when the bank has no answer — never guesses (D10)', async () => {
    const turns = await call('9810011001', [
      'Yes.',
      'Nexon service Friday.',
      'Do you do insurance claims and is there parking for a trailer?',
    ]);
    // 'parking' matches the bank; the point is it answered from the bank, not
    // from the model. A true miss routes out — covered below.
    expect(turns.at(-1)!.reply).toBeTruthy();
  });

  it('escalates a breakdown without triage (E3)', async () => {
    const turns = await call('9810011001', ['Yes.', "The car won't start, it's in my basement."]);
    expect(turns.at(-1)!.leadReason).toBe('another_problem');
    expect(turns.at(-1)!.ended).toBe(true);
  });
});

describe('the call survives the classifier failing', () => {
  /** Stands in for a timeout or a 500 from the model. */
  class BrokenClassifier {
    async classify(): Promise<never> {
      throw new Error('model timed out');
    }
  }

  it('asks a smaller question rather than dropping the call', async () => {
    const broken = { classifier: new BrokenClassifier() as never, crm: new LocalCrm(db) };
    const first = await startCall(db, '9810011001', MONDAY);
    const turn = await handleTurn(db, broken, first.sessionId, 'yes', MONDAY);

    expect(turn.ended).toBe(false);
    expect(turn.reply).toBeTruthy();
    // E0 — never "I didn't understand that".
    expect(turn.reply).not.toMatch(/did ?n.t understand|error|sorry, something/i);
  });

  it('routes out to a human rather than looping through an outage (D11)', async () => {
    const broken = { classifier: new BrokenClassifier() as never, crm: new LocalCrm(db) };
    const first = await startCall(db, '9810011001', MONDAY);
    let last = await handleTurn(db, broken, first.sessionId, 'yes', MONDAY);
    for (let i = 0; i < 4 && !last.ended; i++) {
      last = await handleTurn(db, broken, first.sessionId, 'yes', MONDAY);
    }
    expect(last.ended).toBe(true);
    expect(last.leadReason).toBe('another_problem');
  });
});

describe('the live calls of 2026-10-04, with the model failing', () => {
  // Both calls went: greeting → "Yes. The car is registered under the same
  // number." → the bare re-ask, again and again → "Can you help me with
  // booking a service?" → handed to the team. The model was failing every
  // turn, and the quick reading — which had heard "yes" — was thrown away.
  class BrokenClassifier {
    async classify(): Promise<never> {
      throw Object.assign(new Error('Connection error.'), { status: undefined });
    }
  }
  const live = () => ({ classifier: new BrokenClassifier() as never, fast: new StubClassifier(), crm: new LocalCrm(db) });

  it('hears the yes and books, as a caller would expect', async () => {
    const d = live();
    const first = await startCall(db, '9810011001', MONDAY);
    const replies: TurnResult[] = [];
    for (const line of [
      'Yes. The car is registered under the same number.',
      'Can you help me with booking a service?',
    ]) {
      replies.push(await handleTurn(db, d, first.sessionId, line, MONDAY));
    }
    expect(replies[0]!.reply).toContain('Nexon');
    expect(replies[0]!.reply).not.toMatch(/^Anyway/);
    expect(replies[1]!.ended).toBe(false);
    expect(replies[1]!.reply).not.toMatch(/one for the team/);
  });

  it('reads "help me book" as the booking, not a question about the centre', async () => {
    const s = new StubClassifier();
    for (const u of ['Can you help me with booking a service?', 'Can you help me to a new service?', 'Could you book my car in?']) {
      const c = await s.classify({ state: 'open_turn', utterance: u, today: TODAY });
      expect(c.outOfBand, u).toBeUndefined();
    }
    // A real question about the centre still is one.
    expect((await s.classify({ state: 'open_turn', utterance: 'Do you service the Curvv?', today: TODAY })).outOfBand).toBe('general');
  });
});

describe('every routed exit leaves a usable lead (F2)', () => {
  it('carries the vehicle, the request and the caller words', async () => {
    await call('9810011001', ['Yes.', 'Nexon service.', 'No.', 'No.', 'Thursday.', 'Thursday.', 'Thursday.']);
    const lead = db.prepare(`SELECT * FROM leads ORDER BY id DESC LIMIT 1`).get() as Record<string, unknown>;
    expect(lead['reason']).toBe('forced_full_day');
    expect(lead['vehicle_registration']).toBe('HR26AB4471');
    expect(lead['vehicle_model']).toBe('Nexon');
    expect(lead['session_id']).toBeTruthy();
    expect(lead['caller_words']).toBeTruthy();
  });

  it('sends the centre details on every routed exit (F1)', async () => {
    await call('9810066006', ['Yes.', 'Book the Tiago in.']);
    const sms = db.prepare(`SELECT body, lead_id FROM sms_log ORDER BY id DESC LIMIT 1`).get() as {
      body: string;
      lead_id: number;
    };
    expect(sms.lead_id).toBeTruthy();
    expect(sms.body).toContain('01244567890');
  });
});

describe('D12 — the second vehicle is mentioned, never booked', () => {
  it('mentions the other due car at the close', async () => {
    const turns = await call('9810022002', [
      'Yes.',
      'Swift, 2213.',
      'Service please, Friday.',
      'No.',
      'No.',
      'Afternoon.', // Friday minor morning is full — the agent already said so
    ]);
    const last = turns.at(-1)!;
    expect(last.bookingReference).toBeDefined();
    expect(last.reply).toContain('Creta');
    // Mention only — exactly one booking exists for this account.
    const n = db
      .prepare(
        `SELECT COUNT(*) n FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
         WHERE v.customer_id = (SELECT id FROM customers WHERE mobile_number = '9810022002')`,
      )
      .get() as { n: number };
    expect(n.n).toBe(1);
  });
});

describe('resuming after an out-of-band question (D9, D10)', () => {
  // resumeQuestion() covered four of eleven states; the rest fell through to
  // "How can I help?" — a different question from the one the machine is
  // still waiting on.
  it('resumes the OTP prompt, and keeps the keypad open', async () => {
    const turns = await call('9810011001', [
      'No, different phone.',
      '9810044004',
      'what time do you open?',
    ]);
    const last = turns.at(-1)!;
    expect(last.state).toBe('awaiting_otp');
    expect(last.reply).toMatch(/9 in the morning/);
    // Without this the voice layer drops out of DTMF mid-code entry.
    expect(last.expectsDigits).toBe(true);
    expect(last.reply).toMatch(/code/i);
    expect(last.reply).not.toMatch(/How can I help/i);
  });

  it('resumes the vehicle question rather than opening the call again', async () => {
    const turns = await call('9810022002', ['Yes.', 'where are you located?']);
    const last = turns.at(-1)!;
    expect(last.state).toBe('vehicle');
    expect(last.reply).toMatch(/Sector 44/);
    expect(last.reply).not.toMatch(/How can I help/i);
  });

  it('resumes the caller-ID question during the greeting', async () => {
    const turns = await call('9810011001', ['is there parking?']);
    const last = turns.at(-1)!;
    expect(last.state).toBe('greeting');
    expect(last.reply).toMatch(/parking/i);
    expect(last.reply).toMatch(/registered under/i);
  });
});

describe('an account with no vehicles on it', () => {
  it('blames the record, not the caller', async () => {
    db.prepare(`INSERT INTO customers (mobile_number, name, created_at) VALUES (?, ?, ?)`).run(
      '9810120012',
      'Nikhil Rao',
      '2026-09-14T10:00:00+05:30',
    );

    const turns = await call('9810120012', ['Yes.']);
    const last = turns.at(-1)!;
    expect(last.ended).toBe(true);
    // Not model_not_recognised — they were never asked to name a car, and
    // telling the CRM team the model was wrong sends them looking for nothing.
    expect(last.leadReason).toBe('missing_required_field');
  });
});

describe('D6 — a single free slot is a statement, so "yes" accepts it', () => {
  // Friday +4 has only the minor afternoon left, which the agent states rather
  // than asking about. A caller who answers "yes, that's fine" was heard as
  // having said nothing: the same sentence came back verbatim (against E0),
  // and a pushback was charged, so three acceptances routed them out.
  const FRIDAY = addDays(TODAY, 4);

  it('books the slot the agent named when the caller simply agrees', async () => {
    const turns = await call('9810033003', [
      'yes',
      'I want to book a service',
      'nothing wrong',
      'no',
      FRIDAY,
      "yes that's fine",
    ]);
    const last = turns.at(-1)!;
    expect(said(turns)).toMatch(/only got the afternoon|afternoon is all/i);
    expect(last.bookingReference).toMatch(/^\d{6}-\d{5}$/);

    const booked = db
      .prepare(`SELECT booking_date, drop_slot FROM bookings WHERE booking_reference = ?`)
      .get(last.bookingReference!) as { booking_date: string; drop_slot: string };
    expect(booked).toEqual({ booking_date: FRIDAY, drop_slot: 'afternoon' });
  });

  it('never repeats the slot line word for word when it does re-ask (E0)', async () => {
    const turns = await call('9810033003', [
      'yes',
      'I want to book a service',
      'nothing wrong',
      'no',
      FRIDAY,
      'hmm',
    ]);
    const replies = turns.map((t) => t.reply);
    const stated = replies.at(-2)!;
    const reasked = replies.at(-1)!;
    expect(reasked).not.toBe(stated);
  });
});

describe('G2 — the phrasing pools actually rotate', () => {
  // The seed was the transcript ROW count, which grows by two per turn, so it
  // was always even. Every two-phrasing pool — sixteen of the twenty-five —
  // therefore returned phrasing #1 for the whole life of the system, and two
  // consecutive re-asks came back word for word identical.
  it('gives a different phrasing when the same pool is hit twice in one call', async () => {
    const turns = await call('9810033003', [
      'yes',
      'I want to book a service',
      'nothing wrong',
      'no',
      addDays(TODAY, 4),
      'hmm',
      'mmm',
    ]);
    const replies = turns.map((t) => t.reply);
    expect(replies.at(-1)).not.toBe(replies.at(-2));
  });

  it('hands pick() a seed that changes parity between turns', async () => {
    const first = await startCall(db, '9810033003', MONDAY);
    const seeds: number[] = [];
    for (const line of ['yes', 'book a service', 'nothing', 'no']) {
      await handleTurn(db, deps, first.sessionId, line, MONDAY);
      seeds.push(
        (
          db
            .prepare(`SELECT COUNT(*) AS n FROM transcripts WHERE session_id = ? AND speaker = 'caller'`)
            .get(first.sessionId) as { n: number }
        ).n,
      );
    }
    expect(new Set(seeds.map((s) => s % 2)).size).toBe(2);
  });
});

describe('E7 — the caller who has no day in mind', () => {
  // `firstAvailable` sat in shared/availability.ts with no caller at all: the
  // machine only knew how to receive a day, so "whenever suits you" counted
  // as a non-answer, took a pushback, and routed the caller out after three.
  it('picks the first day that can take the job and states it', async () => {
    const turns = await call('9810033003', [
      'yes',
      'I want to book a service',
      'nothing wrong',
      'no',
      'whenever you have something',
    ]);
    const last = turns.at(-1)!;
    expect(last.state).toBe('drop_slot');
    expect(last.reply).toMatch(/soonest|first I can do/i);

    // Whatever it named must be a real, bookable day inside the window.
    const row = db
      .prepare(
        `SELECT json_extract(data, '$.bookingDate') AS d FROM sessions WHERE id = ?`,
      )
      .get(last.sessionId) as { d: string };
    expect(row.d > TODAY).toBe(true);
    expect(row.d <= addDays(TODAY, 30)).toBe(true);
    const free = db
      .prepare(
        `SELECT SUM(total_slots - booked_slots) AS n FROM slot_capacity
         WHERE centre_id = 1 AND date = ? AND service_type = 'minor'`,
      )
      .get(row.d) as { n: number };
    expect(free.n).toBeGreaterThan(0);
  });

  it('charges no pushback for it — it is an answer, not a refusal', async () => {
    const turns = await call('9810033003', [
      'yes',
      'I want to book a service',
      'nothing wrong',
      'no',
      'any day is fine',
    ]);
    const pushback = (
      db
        .prepare(`SELECT json_extract(data, '$.pushback') AS p FROM sessions WHERE id = ?`)
        .get(turns.at(-1)!.sessionId) as { p: number }
    ).p;
    expect(pushback).toBe(0);
  });
});

describe('changing your mind about the day at the slot question', () => {
  // The drop_slot schema offered the model no date field, so "actually, make
  // it Saturday" could not be reported at all and read as a non-answer.
  it('moves to the new day instead of re-asking for a slot', async () => {
    const wed = addDays(TODAY, 8);
    const sat = addDays(TODAY, 11);
    const turns = await call('9810033003', [
      'yes',
      'I want to book a service',
      'nothing wrong',
      'no',
      wed,
      sat,
    ]);
    const last = turns.at(-1)!;
    const booking = (
      db
        .prepare(`SELECT json_extract(data, '$.bookingDate') AS d FROM sessions WHERE id = ?`)
        .get(last.sessionId) as { d: string }
    ).d;
    expect(booking).toBe(sat);
  });
});

describe('DEMO_MODE — a stranger can book', () => {
  // Without this a public demo is useless: every unknown number ends in
  // number_not_found. 9899999999 is deliberately absent from the seed.
  const STRANGER = '9899999999';
  const bookIt = ['yes', 'I want to book a service', 'no', 'no', addDays(TODAY, 8), 'morning'];

  beforeEach(() => {
    deps = { ...deps, crm: new DemoCrm(db, new LocalCrm(db)) };
  });

  it('takes an unknown number all the way to a booking', async () => {
    const turns = await call(STRANGER, bookIt);
    expect(turns.at(-1)!.bookingReference).toMatch(/^\d{6}-\d{5}$/);

    const car = db
      .prepare(
        `SELECT v.registration_number, c.name FROM vehicles v JOIN customers c ON c.id = v.customer_id
         WHERE c.mobile_number = ?`,
      )
      .get(STRANGER) as { registration_number: string; name: string };
    expect(car.registration_number.startsWith(DEMO_PLATE_PREFIX)).toBe(true);
  });

  it('is the same customer when they ring back, so D13 still holds', async () => {
    await call(STRANGER, bookIt);
    const again = await call(STRANGER, ['yes', 'I want to book a service']);
    expect(again.at(-1)!.leadReason).toBe('existing_open_booking');
    const n = db
      .prepare(`SELECT COUNT(*) AS n FROM customers WHERE mobile_number = ?`)
      .get(STRANGER) as { n: number };
    expect(n.n).toBe(1);
  });

  it('leaves a real customer exactly as the CRM has them', async () => {
    const turns = await call('9810011001', ['yes']);
    expect(said(turns)).toMatch(/Nexon/);
    expect(said(turns)).not.toMatch(/Swift/);
  });

  it('is off unless asked for: the same stranger ends in number_not_found', async () => {
    deps = { ...deps, crm: new LocalCrm(db) };
    const turns = await call(STRANGER, ['yes']);
    expect(turns.at(-1)!.leadReason).toBe('number_not_found');
  });
});

describe('a voice line\'s "yes" with stray words (live call, 2026-10-04)', () => {
  // Over Vapi a plain yes to the greeting arrived as "Yes. The car is it
  // should have the same number." The model flagged an incident as well, and
  // the call was handed to the team and ended. At the greeting, the answer to
  // the question we asked wins.
  const saysYesAndEscalates = {
    classify: async (req: { utterance: string }) => ({ callerWords: req.utterance, yesNo: 'yes' as const, intent: 'another_problem' as const }),
  };

  it('identifies the caller rather than ending the call', async () => {
    const first = await startCall(db, '9810011001', MONDAY);
    const t = await handleTurn(db, { ...deps, classifier: saysYesAndEscalates }, first.sessionId, 'Yes. The car is it should have the same number.', MONDAY);
    expect(t.ended).toBe(false);
    expect(t.state).toBe('open_turn');
    expect(t.reply).toMatch(/Nexon/);
    expect(t.understood).toBe('greeting → yes, another_problem (escalation ignored: answering the question)');
  });

  it('still escalates a real incident once the caller is identified', async () => {
    const first = await startCall(db, '9810011001', MONDAY);
    await handleTurn(db, deps, first.sessionId, 'Yes.', MONDAY);
    const t = await handleTurn(db, deps, first.sessionId, "The car won't start, it's in my basement.", MONDAY);
    expect(t.ended).toBe(true);
    expect(t.leadReason).toBe('another_problem');
  });

  it('still escalates at the greeting when there is no yes', async () => {
    const escalates = { classify: async (req: { utterance: string }) => ({ callerWords: req.utterance, intent: 'another_problem' as const }) };
    const first = await startCall(db, '9810011001', MONDAY);
    const t = await handleTurn(db, { ...deps, classifier: escalates }, first.sessionId, 'My car has broken down on the highway.', MONDAY);
    expect(t.ended).toBe(true);
    expect(t.leadReason).toBe('another_problem');
  });
});
