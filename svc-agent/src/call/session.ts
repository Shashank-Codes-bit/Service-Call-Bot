import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { timestamp } from '../shared/dates.ts';
import type { CallState, SessionData } from './types.ts';

export type Session = {
  id: string;
  state: CallState;
  data: SessionData;
};

/**
 * Conversation state lives server-side, keyed on a session id (F5). The voice
 * layer inherits it unchanged — a turn is a turn whether the words arrived as
 * audio or as text.
 *
 * Persisted rather than held in memory for three reasons: the pushback counter
 * and OTP attempts cannot survive a restart otherwise (D11, E1), the
 * state-derived summary is rendered *after* the call ends (F4), and the
 * transcript has a 45-day retention obligation.
 */
export function createSession(db: Database, data: SessionData, now: Date): Session {
  const id = randomUUID();
  const at = timestamp(now);
  db.prepare(
    `INSERT INTO sessions (id, state, data, started_at, updated_at) VALUES (?, 'greeting', ?, ?, ?)`,
  ).run(id, JSON.stringify(data), at, at);
  return { id, state: 'greeting', data };
}

export function loadSession(db: Database, id: string): Session | undefined {
  const row = db.prepare(`SELECT id, state, data FROM sessions WHERE id = ?`).get(id) as
    | { id: string; state: CallState; data: string }
    | undefined;
  return row ? { id: row.id, state: row.state, data: JSON.parse(row.data) as SessionData } : undefined;
}

export function saveSession(db: Database, session: Session, now: Date): void {
  db.prepare(`UPDATE sessions SET state = ?, data = ?, updated_at = ? WHERE id = ?`).run(
    session.state,
    JSON.stringify(session.data),
    timestamp(now),
    session.id,
  );
}

export function endSession(db: Database, session: Session, now: Date): void {
  const at = timestamp(now);
  db.prepare(`UPDATE sessions SET state = 'ended', data = ?, updated_at = ?, ended_at = ? WHERE id = ?`).run(
    JSON.stringify(session.data),
    at,
    at,
    session.id,
  );
}

/**
 * Append a turn to the transcript.
 *
 * Kept in its own table so the 45-day purge is one DELETE, and so the report
 * can carry the complete transcript alongside the state-derived summary (F4).
 * **No LLM ever reads this.**
 */
export function appendTranscript(
  db: Database,
  sessionId: string,
  speaker: 'agent' | 'caller',
  text: string,
  now: Date,
): void {
  // The index is drawn inside the INSERT, never by a separate SELECT. Two
  // turns arriving together — a provider retry, say — would both have read
  // the same MAX and collided on UNIQUE (session_id, turn_index).
  db.prepare(
    `INSERT INTO transcripts (session_id, turn_index, speaker, text, created_at)
     VALUES (
       ?,
       (SELECT COALESCE(MAX(turn_index), -1) + 1 FROM transcripts WHERE session_id = ?),
       ?, ?, ?
     )`,
  ).run(sessionId, sessionId, speaker, text, timestamp(now));
}

export function readTranscript(db: Database, sessionId: string) {
  return db
    .prepare(
      `SELECT turn_index, speaker, text, created_at FROM transcripts
       WHERE session_id = ? ORDER BY turn_index`,
    )
    .all(sessionId) as { turn_index: number; speaker: string; text: string; created_at: string }[];
}

/** 45-day retention (F4). One DELETE, which is why transcripts are separate. */
export function purgeOldTranscripts(db: Database, before: string): number {
  return db.prepare(`DELETE FROM transcripts WHERE created_at < ?`).run(before).changes;
}
