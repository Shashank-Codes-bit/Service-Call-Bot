import type { Database } from 'better-sqlite3';
import { timestamp, type IsoDate } from '../shared/dates.ts';
import { DROP_TIMES, type DropSlot } from '../shared/types.ts';

/**
 * F1 — for the chat build we **log what the SMS would say** rather than
 * integrating a provider. The voice build swaps the sink, not the text.
 *
 * Every booking gets one, and **every "call the service centre" outcome gets
 * one too** — carrying the centre details, so a routed caller always has a
 * human to reach. The landline is the point: it sends follow-up questions to a
 * person rather than back to the AI.
 */
export type Centre = { name: string; landline: string };

export function smsForBooking(
  db: Database,
  opts: {
    bookingId: number;
    mobile: string;
    centre: Centre;
    reference: string;
    model: string;
    date: IsoDate;
    dropSlot: DropSlot;
    expectedPickup: IsoDate;
    now: Date;
  },
): string {
  const body =
    `${opts.centre.name}\n` +
    `Booking ${opts.reference}\n` +
    `${opts.model} — ${opts.date}, drop ${DROP_TIMES[opts.dropSlot]}\n` +
    `Expected back ${opts.expectedPickup} (estimate)\n` +
    `Workshop: ${opts.centre.landline}`;

  db.prepare(
    `INSERT INTO sms_log (booking_id, mobile_number, body, created_at) VALUES (?, ?, ?, ?)`,
  ).run(opts.bookingId, opts.mobile, body, timestamp(opts.now));
  return body;
}

export function smsForLead(
  db: Database,
  opts: { leadId: number; mobile: string; centre: Centre; now: Date },
): string {
  const body = `${opts.centre.name}\nGive the workshop a call on ${opts.centre.landline} and they'll sort this out.`;
  db.prepare(
    `INSERT INTO sms_log (lead_id, mobile_number, body, created_at) VALUES (?, ?, ?, ?)`,
  ).run(opts.leadId, opts.mobile, body, timestamp(opts.now));
  return body;
}

/** The newest message so far — taken before a turn, so `smsSince` can say what the turn sent. */
export function lastSmsId(db: Database): number {
  return (db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM sms_log`).get() as { n: number }).n;
}

/** What these numbers were sent after `afterId`, oldest first — the caller's inbox. */
export function smsSince(db: Database, afterId: number, mobiles: string[]): string[] {
  const numbers = [...new Set(mobiles)];
  return (
    db
      .prepare(
        `SELECT body FROM sms_log
         WHERE id > ? AND mobile_number IN (${numbers.map(() => '?').join(', ')})
         ORDER BY id`,
      )
      .all(afterId, ...numbers) as { body: string }[]
  ).map((r) => r.body);
}
