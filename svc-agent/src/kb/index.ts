import type { Database } from 'better-sqlite3';
import { CENTRE_ID } from '../shared/types.ts';

/**
 * The per-dealer knowledge bank (D10) — hours, location, what the centre does.
 * Org data, no customer data, so it sits outside the B3 argument entirely.
 *
 * Behind an interface like `Classifier` and `Crm`: today the match is made by
 * the classifier we already call each turn, and when dealer data grows into
 * real documents a vector implementation drops in here without the state
 * machine ever learning which one it is talking to.
 */

export type KbEntry = { key: string; answer: string; prompt?: string };

export interface KnowledgeBank {
  /** Every entry, so the classifier can be offered a closed set. */
  entries(): KbEntry[];
  /** The answer for a key the classifier chose, if it is still there. */
  answerFor(key: string): string | undefined;
}

/**
 * Reads the `knowledge_bank` table — every entry, which is what makes the
 * portal's editor meaningful. The previous version routed questions through a
 * regex list in the state machine, so adding a row did nothing at all.
 */
export class TableKnowledgeBank implements KnowledgeBank {
  constructor(
    private readonly db: Database,
    private readonly centreId: number = CENTRE_ID,
  ) {}

  entries(): KbEntry[] {
    return this.db
      .prepare(
        `SELECT question_key AS key, answer_text AS answer
         FROM knowledge_bank WHERE centre_id = ? ORDER BY question_key`,
      )
      .all(this.centreId) as KbEntry[];
  }

  answerFor(key: string): string | undefined {
    return (
      this.db
        .prepare(
          `SELECT answer_text FROM knowledge_bank WHERE centre_id = ? AND question_key = ?`,
        )
        .get(this.centreId, key) as { answer_text: string } | undefined
    )?.answer_text;
  }
}

// ---------------------------------------------------------------------------
// Portal editing. A dealer FAQ nobody can edit is not a product.
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

  db.prepare(
    `INSERT INTO knowledge_bank (centre_id, question_key, answer_text) VALUES (?, ?, ?)
     ON CONFLICT (centre_id, question_key) DO UPDATE SET answer_text = excluded.answer_text`,
  ).run(centreId, clean, answer.trim());
}

export function deleteEntry(db: Database, key: string, centreId: number = CENTRE_ID): boolean {
  return (
    db
      .prepare(`DELETE FROM knowledge_bank WHERE centre_id = ? AND question_key = ?`)
      .run(centreId, normaliseKey(key)).changes > 0
  );
}
