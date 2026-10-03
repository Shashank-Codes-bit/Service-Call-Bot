import type { Database } from 'better-sqlite3';
import { CENTRE_ID } from '../shared/types.ts';
import { timestamp } from '../shared/dates.ts';
import { splitPhrases, type KbCategory } from './index.ts';

/**
 * The Knowledge page's writes. Everything lands in `knowledge_bank`, which the
 * agent reads on every turn — so a save here needs no publish step, no
 * re-index and no restart (kb/index.ts explains how).
 */

export class KnowledgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeError';
  }
}

export type KnowledgeRow = {
  id: number;
  key: string;
  category: KbCategory;
  title: string;
  answer: string;
  phrases: string[];
  valid_until: string | null;
  updated_at: string | null;
  expired: boolean;
};

export type KnowledgeInput = {
  category: unknown;
  title: unknown;
  answer: unknown;
  phrases?: unknown;
  validUntil?: unknown;
};

const EDITABLE: KbCategory[] = ['cars', 'services', 'offers'];

export function listKnowledge(db: Database, today: string, centreId = CENTRE_ID): KnowledgeRow[] {
  const rows = db
    .prepare(
      `SELECT id, question_key AS key, category, COALESCE(title, question_key) AS title,
              answer_text AS answer, phrases, valid_until, updated_at
       FROM knowledge_bank WHERE centre_id = ?
       ORDER BY category, COALESCE(updated_at, '') DESC, title`,
    )
    .all(centreId) as Array<Omit<KnowledgeRow, 'phrases' | 'expired'> & { phrases: string | null }>;
  return rows.map((r) => ({
    ...r,
    phrases: splitPhrases(r.phrases),
    valid_until: r.valid_until || null,
    expired: Boolean(r.valid_until && r.valid_until < today),
  }));
}

function clean(input: KnowledgeInput) {
  const category = String(input.category ?? '');
  if (!EDITABLE.includes(category as KbCategory)) {
    throw new KnowledgeError('Section must be cars, services or offers');
  }
  const title = String(input.title ?? '').trim().replace(/\s+/g, ' ');
  if (title.length < 2 || title.length > 80) throw new KnowledgeError('Name should be 2 to 80 characters');
  const answer = String(input.answer ?? '').trim();
  if (answer.length < 5 || answer.length > 600) {
    throw new KnowledgeError('What the agent should say should be 5 to 600 characters');
  }
  const raw = Array.isArray(input.phrases) ? input.phrases.map(String) : splitPhrases(String(input.phrases ?? ''));
  const phrases = [...new Set(raw.map((p) => p.trim().toLowerCase()).filter(Boolean))];
  if (phrases.length > 20) throw new KnowledgeError('At most 20 words or phrases');
  if (phrases.some((p) => p.length > 40 || p.includes(','))) {
    throw new KnowledgeError('Each phrase should be under 40 characters');
  }
  const until = input.validUntil == null || input.validUntil === '' ? null : String(input.validUntil);
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new KnowledgeError('Valid until must be a date');
  return { category: category as KbCategory, title, answer, phrases: phrases.join(', '), until };
}

/** A key from the title, unique in this centre: "Tata Curvv EV" → tata_curvv_ev. */
function keyFor(db: Database, title: string, centreId: number, except?: number): string {
  const base =
    title
      .toLowerCase()
      .replace(/₹/g, 'rs ')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 50) || 'entry';
  const taken = (k: string) =>
    Boolean(
      db
        .prepare(`SELECT 1 FROM knowledge_bank WHERE centre_id = ? AND question_key = ? AND id IS NOT ?`)
        .get(centreId, k, except ?? null),
    );
  let key = base;
  for (let n = 2; taken(key); n++) key = `${base}_${n}`;
  return key;
}

export function createKnowledge(db: Database, input: KnowledgeInput, now = new Date(), centreId = CENTRE_ID): number {
  const c = clean(input);
  return Number(
    db
      .prepare(
        `INSERT INTO knowledge_bank
           (centre_id, question_key, answer_text, category, title, phrases, valid_until, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(centreId, keyFor(db, c.title, centreId), c.answer, c.category, c.title, c.phrases, c.until, timestamp(now))
      .lastInsertRowid,
  );
}

/** Edit an entry. Its key follows a renamed title, so the classifier sees what it is. */
export function updateKnowledge(
  db: Database,
  id: number,
  input: KnowledgeInput,
  now = new Date(),
  centreId = CENTRE_ID,
): boolean {
  const row = db
    .prepare(`SELECT category FROM knowledge_bank WHERE id = ? AND centre_id = ?`)
    .get(id, centreId) as { category: string } | undefined;
  if (!row) return false;
  if (row.category === 'essentials') throw new KnowledgeError('Centre essentials are edited in their own form');
  const c = clean(input);
  db.prepare(
    `UPDATE knowledge_bank
     SET question_key = ?, answer_text = ?, category = ?, title = ?, phrases = ?, valid_until = ?, updated_at = ?
     WHERE id = ?`,
  ).run(keyFor(db, c.title, centreId, id), c.answer, c.category, c.title, c.phrases, c.until, timestamp(now), id);
  return true;
}

export function removeKnowledge(db: Database, id: number, centreId = CENTRE_ID): 'removed' | 'not_found' | 'essential' {
  const row = db
    .prepare(`SELECT category FROM knowledge_bank WHERE id = ? AND centre_id = ?`)
    .get(id, centreId) as { category: string } | undefined;
  if (!row) return 'not_found';
  if (row.category === 'essentials') return 'essential';
  db.prepare(`DELETE FROM knowledge_bank WHERE id = ?`).run(id);
  return 'removed';
}

// ---------------------------------------------------------------------------
// Centre essentials: one form, and the agent's essentials answers written
// from it. One save changes what the agent says and what the SMS carries.
// ---------------------------------------------------------------------------

export type Essentials = {
  name: string;
  address: string;
  landmark: string;
  days: string;
  opens: string;
  closes: string;
  /** The workshop desk number — sent in every SMS. */
  desk: string;
  parking: string;
  waiting: string;
  payment: string[];
  pickup: boolean;
  pickupTerms: string;
  services: string[];
  languages: string[];
};

export const PAYMENT_OPTIONS = ['Cards', 'UPI', 'Cash', 'Cheque'];
export const SERVICE_OPTIONS = [
  'Periodic service', 'Running repairs', 'AC service', 'Wheel alignment', 'Body and paint', 'Insurance claims', 'Car wash',
];
export const LANGUAGE_OPTIONS = ['English', 'Hindi'];

/** "09:00" → "9 in the morning"; "13:30" → "1:30 in the afternoon"; "19:00" → "7 in the evening". */
export function spokenTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const part = h < 12 ? 'in the morning' : h < 17 ? 'in the afternoon' : 'in the evening';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  if (h === 12 && m === 0) return 'noon';
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${part}`;
}

/** "Cards, UPI and cash". Acronyms keep their capitals. */
function spokenList(items: string[], capitaliseFirst = false): string {
  const words = items.map((w, i) => (i === 0 && capitaliseFirst) || w === w.toUpperCase() ? w : w.toLowerCase());
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

const sentence = (s: string) => {
  const t = s.trim();
  return t && !/[.!?]$/.test(t) ? `${t}.` : t;
};

/** The answers the form writes. */
export const ESSENTIAL_KEYS = [
  'opening_hours', 'location', 'parking', 'waiting_area', 'pickup_drop', 'payment_methods', 'services_offered',
];

/** The essentials answers, worded for the phone, from the form. */
export function essentialsAnswers(e: Essentials): Array<{ key: string; title: string; phrases: string; answer: string }> {
  const out = [
    {
      key: 'opening_hours',
      title: 'Opening hours',
      phrases: 'open, opening, close, closing, timings, hours, sunday',
      answer: `The workshop is open ${e.days.trim().toLowerCase()}, ${spokenTime(e.opens)} to ${spokenTime(e.closes)}.`,
    },
    {
      key: 'location',
      title: 'Location',
      phrases: 'where, address, located, location, directions, reach',
      answer: sentence(`We're at ${e.address.trim()}${e.landmark.trim() ? `, ${e.landmark.trim()}` : ''}`),
    },
    { key: 'parking', title: 'Parking', phrases: 'parking, park', answer: sentence(e.parking) },
    { key: 'waiting_area', title: 'Waiting area', phrases: 'wait, waiting, lounge, sit, wifi', answer: sentence(e.waiting) },
    {
      key: 'pickup_drop',
      title: 'Pickup and drop',
      phrases: 'pickup, pick up, drop, collect, home',
      answer: e.pickup
        ? sentence(`Pickup and drop is available${e.pickupTerms.trim() ? ` ${e.pickupTerms.trim()}` : ''}`)
        : "We don't offer pickup and drop at the moment.",
    },
    {
      key: 'payment_methods',
      title: 'Payment',
      phrases: 'pay, payment, upi, card, cash, cheque',
      answer: `${spokenList(e.payment, true)} ${e.payment.length > 1 ? 'are all' : 'is'} accepted at the counter.`,
    },
    {
      key: 'services_offered',
      title: 'Services offered',
      phrases: e.services.map((s) => s.toLowerCase()).join(', '),
      answer: `We do ${spokenList(e.services)}.`,
    },
  ];
  // An empty field is an answer nobody wrote: leave it out rather than speak a blank.
  return out.filter((a) => a.answer.replace(/[.\s]/g, '').length > 3 && !(a.key === 'payment_methods' && !e.payment.length) && !(a.key === 'services_offered' && !e.services.length));
}

function validEssentials(raw: unknown): Essentials {
  const r = (raw ?? {}) as Record<string, unknown>;
  const s = (k: string, max = 200) => String(r[k] ?? '').trim().slice(0, max);
  const list = (k: string, allowed: string[]) =>
    (Array.isArray(r[k]) ? (r[k] as unknown[]).map(String) : []).filter((x) => allowed.includes(x));
  const e: Essentials = {
    name: s('name', 60),
    address: s('address'),
    landmark: s('landmark'),
    days: s('days', 60) || 'Every day',
    opens: s('opens', 5),
    closes: s('closes', 5),
    desk: s('desk', 20),
    parking: s('parking'),
    waiting: s('waiting'),
    payment: list('payment', PAYMENT_OPTIONS),
    pickup: r['pickup'] === true,
    pickupTerms: s('pickupTerms'),
    services: list('services', SERVICE_OPTIONS),
    languages: list('languages', LANGUAGE_OPTIONS),
  };
  if (e.name.length < 3) throw new KnowledgeError('Centre name should be at least 3 characters');
  if (!/^\d{2}:\d{2}$/.test(e.opens) || !/^\d{2}:\d{2}$/.test(e.closes)) throw new KnowledgeError('Opening and closing times are needed');
  if (e.opens >= e.closes) throw new KnowledgeError('Closing time should be after opening time');
  if (e.desk.replace(/\D/g, '').length < 8) throw new KnowledgeError('Workshop desk number looks too short');
  if (!e.address) throw new KnowledgeError('Address is needed');
  return e;
}

/**
 * The form as last saved. A centre that has never saved it (one moved in from
 * before the form existed) gets a draft from its centre row, and `saved:
 * false` — its agent keeps answering from the rows it already has.
 */
export function readEssentials(db: Database, centreId = CENTRE_ID): { essentials: Essentials; saved: boolean; updated_at: string | null } {
  const row = db.prepare(`SELECT data, updated_at FROM centre_profile WHERE centre_id = ?`).get(centreId) as
    | { data: string; updated_at: string }
    | undefined;
  if (row) return { essentials: JSON.parse(row.data) as Essentials, saved: true, updated_at: row.updated_at };
  const c = db.prepare(`SELECT name, landline, opens_at, closes_at FROM centres WHERE id = ?`).get(centreId) as
    | { name: string; landline: string; opens_at: string; closes_at: string }
    | undefined;
  return {
    saved: false,
    updated_at: null,
    essentials: {
      name: c?.name ?? '',
      address: '',
      landmark: '',
      days: 'Every day',
      opens: c?.opens_at ?? '09:00',
      closes: c?.closes_at ?? '19:00',
      desk: c?.landline ?? '',
      parking: '',
      waiting: '',
      payment: [],
      pickup: false,
      pickupTerms: '',
      services: [],
      languages: ['English'],
    },
  };
}

/**
 * Save the form and apply it, in one transaction: the profile, the centre row
 * (its name, the desk number every SMS carries, the hours) and the agent's
 * essentials answers.
 */
export function saveEssentials(db: Database, raw: unknown, now = new Date(), centreId = CENTRE_ID): Essentials {
  const e = validEssentials(raw);
  const at = timestamp(now);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO centre_profile (centre_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (centre_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    ).run(centreId, JSON.stringify(e), at);
    db.prepare(`UPDATE centres SET name = ?, landline = ?, opens_at = ?, closes_at = ? WHERE id = ?`).run(
      e.name,
      e.desk.replace(/\D/g, ''),
      e.opens,
      e.closes,
      centreId,
    );
    const answers = essentialsAnswers(e);
    // A field emptied on the form takes its answer away. Only the form's own
    // keys: an essentials row someone added another way is left alone.
    const dropped = ESSENTIAL_KEYS.filter((k) => !answers.some((a) => a.key === k));
    const drop = db.prepare(`DELETE FROM knowledge_bank WHERE centre_id = ? AND question_key = ?`);
    for (const k of dropped) drop.run(centreId, k);
    const upsert = db.prepare(
      `INSERT INTO knowledge_bank (centre_id, question_key, answer_text, category, title, phrases, updated_at)
       VALUES (?, ?, ?, 'essentials', ?, ?, ?)
       ON CONFLICT (centre_id, question_key) DO UPDATE SET
         answer_text = excluded.answer_text, category = 'essentials', title = excluded.title,
         phrases = excluded.phrases, valid_until = NULL, updated_at = excluded.updated_at`,
    );
    for (const a of answers) upsert.run(centreId, a.key, a.answer, a.title, a.phrases, at);
  })();
  return e;
}
