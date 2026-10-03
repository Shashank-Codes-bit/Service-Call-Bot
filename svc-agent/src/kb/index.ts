import type { Database } from 'better-sqlite3';
import { CENTRE_ID } from '../shared/types.ts';
import { timestamp } from '../shared/dates.ts';

/**
 * The per-dealer knowledge bank (D10) — what the centre does, the cars it
 * services, its offers, and the essentials (hours, location, payment). Org
 * data, no customer data, so it sits outside the B3 argument entirely.
 *
 * How the agent stays current without anyone "updating" it: nothing is copied
 * or cached. Every turn reads the table — through the FTS5 index that triggers
 * keep in step with every write (db/migrate.ts) — so a save on the Knowledge
 * page is what the next caller hears. Expiry is applied at read time, so an
 * offer stops being mentioned on its last day with nobody touching it.
 */

export type KbCategory = 'cars' | 'services' | 'offers' | 'essentials';
export const KB_CATEGORIES: KbCategory[] = ['cars', 'services', 'offers', 'essentials'];

export type KbEntry = { key: string; answer: string; prompt?: string };

/** One topic offered to the classifier: enough to recognise, nothing to speak. */
export type KbTopic = { key: string; title: string; phrases: string[] };

export interface KnowledgeBank {
  /** Every live entry. */
  entries(today?: string): KbEntry[];
  /**
   * The handful of topics worth offering the classifier for this question:
   * the essentials, plus the best matches among everything else. Small and
   * relevant whether the centre has ten entries or five hundred.
   */
  shortlist(question: string, today: string): KbTopic[];
  /** The answer for a key the classifier chose, if it is still there and live. */
  answerFor(key: string, today?: string): string | undefined;
}

/** How many non-essential topics ride along with the essentials. */
export const SHORTLIST_SIZE = 6;

/** "Live" at read time: no end date, or an end date not yet passed. */
const LIVE = `(valid_until IS NULL OR valid_until = '' OR valid_until >= ?)`;

/** Words too common to search on. A search for "do you" must not rank anything. */
const NOT_SEARCHED = new Set([
  'the', 'and', 'you', 'are', 'can', 'for', 'was', 'our', 'out', 'who', 'how', 'why', 'did',
  'has', 'have', 'does', 'what', 'when', 'where', 'this', 'that', 'with', 'from', 'they',
  'been', 'will', 'your', 'there', 'about', 'would', 'could', 'please', 'get', 'got', 'any',
  'there', 'here', 'need', 'want', 'like', 'know', 'tell', 'mine', 'some', 'it', 'is', 'do',
  'my', 'me', 'we', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'or', 'if', 'be', 'i',
]);

/** The words of a question as an FTS5 query: each a prefix, any may match. */
export function searchTerms(question: string): string {
  const words = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !NOT_SEARCHED.has(w));
  return [...new Set(words)].map((w) => `"${w.replace(/"/g, '')}"*`).join(' OR ');
}

export const splitPhrases = (s: string | null | undefined): string[] =>
  (s ?? '')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

export class TableKnowledgeBank implements KnowledgeBank {
  constructor(
    private readonly db: Database,
    private readonly centreId: number = CENTRE_ID,
  ) {}

  entries(today = '0000-00-00'): KbEntry[] {
    return this.db
      .prepare(
        `SELECT question_key AS key, answer_text AS answer
         FROM knowledge_bank WHERE centre_id = ? AND ${LIVE} ORDER BY question_key`,
      )
      .all(this.centreId, today) as KbEntry[];
  }

  shortlist(question: string, today: string): KbTopic[] {
    type Row = { key: string; title: string | null; phrases: string | null };
    const essentials = this.db
      .prepare(
        `SELECT question_key AS key, title, phrases FROM knowledge_bank
         WHERE centre_id = ? AND category = 'essentials' AND ${LIVE} ORDER BY question_key`,
      )
      .all(this.centreId, today) as Row[];

    const terms = searchTerms(question);
    const matches = terms
      ? (this.db
          .prepare(
            // bm25 weights: the title counts most, then the customers' own
            // words, then the answer text.
            `SELECT k.question_key AS key, k.title, k.phrases
             FROM knowledge_fts f JOIN knowledge_bank k ON k.id = f.rowid
             WHERE knowledge_fts MATCH ? AND k.centre_id = ? AND k.category != 'essentials'
               AND ${LIVE.replace(/valid_until/g, 'k.valid_until')}
             ORDER BY bm25(knowledge_fts, 10.0, 6.0, 1.0) LIMIT ?`,
          )
          .all(terms, this.centreId, today, SHORTLIST_SIZE) as Row[])
      : [];

    return [...essentials, ...matches].map((r) => ({
      key: r.key,
      title: r.title ?? r.key,
      phrases: splitPhrases(r.phrases),
    }));
  }

  answerFor(key: string, today = '0000-00-00'): string | undefined {
    return (
      this.db
        .prepare(
          `SELECT answer_text FROM knowledge_bank
           WHERE centre_id = ? AND question_key = ? AND ${LIVE}`,
        )
        .get(this.centreId, key, today) as { answer_text: string } | undefined
    )?.answer_text;
  }
}

// ---------------------------------------------------------------------------
// Editing by key — the older, essentials-only route (`/api/kb/:key`). The
// Knowledge page uses kb/knowledge.ts, which writes the same table.
// ---------------------------------------------------------------------------

/**
 * One normalisation, used by both writes. Upsert normalised and delete did
 * not, so an entry saved as "Opening Hours" became `opening_hours` and then
 * could not be deleted by the name it was saved under.
 */
export function normaliseKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, '_');
}

export function upsertEntry(
  db: Database,
  key: string,
  answer: string,
  centreId: number = CENTRE_ID,
): void {
  const clean = normaliseKey(key);
  if (!/^[a-z0-9_]{2,60}$/.test(clean)) {
    throw new Error('key must be 2-60 characters, letters, digits and underscores');
  }
  if (!answer.trim()) throw new Error('answer cannot be empty');
  const title = clean.replace(/_/g, ' ');

  db.prepare(
    `INSERT INTO knowledge_bank (centre_id, question_key, answer_text, title, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (centre_id, question_key) DO UPDATE
       SET answer_text = excluded.answer_text, updated_at = excluded.updated_at`,
  ).run(centreId, clean, answer.trim(), title.charAt(0).toUpperCase() + title.slice(1), timestamp());
}

export function deleteEntry(db: Database, key: string, centreId: number = CENTRE_ID): boolean {
  return (
    db
      .prepare(`DELETE FROM knowledge_bank WHERE centre_id = ? AND question_key = ?`)
      .run(centreId, normaliseKey(key)).changes > 0
  );
}
