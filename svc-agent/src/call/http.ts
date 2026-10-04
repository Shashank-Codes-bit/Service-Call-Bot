import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { config, hasApiKey } from '../config.ts';
import { StubClassifier, type Classifier } from './classifier.ts';
import { HaikuClassifier } from './haiku-classifier.ts';
import { DemoCrm, LocalCrm } from './crm.ts';
import { TableKnowledgeBank } from '../kb/index.ts';
import { handleTurn, startCall, type CallDeps } from './machine.ts';
import { loadSession } from './session.ts';
import { lastSmsId, smsSince } from './sms.ts';

/**
 * The call, over HTTP — our own contract, deliberately not shaped like any
 * provider's. The portal's chat panel speaks it directly; the Vapi adapter
 * sits beside it and translates. Adding voice therefore changes neither this
 * file nor the state machine behind it.
 */

/**
 * Haiku when a key is present, the stub otherwise. The server must boot and
 * complete a booking with no credentials at all: a missing key degrades
 * comprehension, it does not take the service down.
 */
export function buildDeps(db: Database, { demo = config.demoMode }: { demo?: boolean } = {}): CallDeps {
  const classifier: Classifier = hasApiKey() ? new HaikuClassifier() : new StubClassifier();
  return {
    classifier,
    crm: demo ? new DemoCrm(db, new LocalCrm(db)) : new LocalCrm(db),
    kb: new TableKnowledgeBank(db),
    // The same stub, used ahead of the model to answer the unmistakable turns
    // without a round trip. Pointless when the stub *is* the classifier.
    ...(hasApiKey() ? { fast: new StubClassifier() } : {}),
  };
}

/**
 * `demo` is per centre now (orgs.demo, and DEMO_MODE as the server-wide
 * master switch): a demo centre shows the SMS in the chat; a real one never does.
 */
export function callApi(
  db: Database,
  deps: CallDeps = buildDeps(db),
  { demo = config.demoMode }: { demo?: boolean } = {},
): Router {
  const r = Router();

  /** Begin a call. The caller's number is all we know at this point. */
  r.post('/start', async (req, res) => {
    const callerNumber = String(req.body?.callerNumber ?? '').replace(/\D/g, '');
    if (callerNumber.length < 10) {
      return res.status(400).json({ error: 'callerNumber must be a 10-digit number' });
    }
    res.json(await startCall(db, callerNumber));
  });

  /** One turn. Everything the caller said, one reply back. */
  r.post('/turn', async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? '');
    const utterance = String(req.body?.utterance ?? '');
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    if (!utterance.trim()) return res.status(400).json({ error: 'utterance required' });
    const before = loadSession(db, sessionId);
    if (!before) return res.status(404).json({ error: 'no such session' });

    const smsFrom = lastSmsId(db);
    const result = await handleTurn(db, deps, sessionId, utterance);
    if (!demo) return res.json(result);

    // DEMO_MODE: a chat has no phone, so the reply carries what the phone
    // would have received — the OTP, the booking confirmation. Never outside
    // demo: it would hand a one-time code to whoever typed the number. The
    // caller's number can change mid-call (E1's "different number"), so both.
    const after = loadSession(db, sessionId)!;
    res.json({
      ...result,
      sms: smsSince(db, smsFrom, [before.data.callerNumber, after.data.callerNumber]),
    });
  });

  return r;
}

/**
 * Find the session belonging to a provider's call id. Stored inside
 * `sessions.data`, not as a column: a JSON lookup costs nothing at this scale
 * and keeps provider identifiers out of a schema that knows nothing of Vapi.
 */
export function sessionIdForExternal(db: Database, externalId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT id FROM sessions
       WHERE json_extract(data, '$.externalId') = ?
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(externalId) as { id: string } | undefined;
  return row?.id;
}

