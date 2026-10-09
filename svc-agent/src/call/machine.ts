import type { Database } from 'better-sqlite3';
import { timestamp, today, type IsoDate } from '../shared/dates.ts';
import { BOOKING_WINDOW_DAYS, CENTRE_ID, type LeadReason } from '../shared/types.ts';
import { capacityWindow } from '../shared/capacity.ts';
import {
  bookingWindow,
  canTake,
  dayOffer,
  type DayOffer,
  findBookable,
  firstAvailable,
  nextTwoAvailable,
  offerForDate,
} from '../shared/availability.ts';
import {
  assessBookability,
  otherDueVehicles,
  poolFor,
  registerPushback,
} from '../shared/service-due.ts';
import {
  createBooking,
  DuplicateBookingError,
  isSameDay,
  openBookingForRegistration,
  shouldOfferSameDayNudge,
  SlotFullError,
} from '../shared/bookings.ts';
import { buildLead, insertLead } from '../shared/leads.ts';
import { detectHinglish, type Classification, type Classifier } from './classifier.ts';
import { TableKnowledgeBank, type KnowledgeBank } from '../kb/index.ts';
import type { Crm } from './crm.ts';
import { appendTranscript, createSession, endSession, loadSession, saveSession, type Session } from './session.ts';
import { smsForBooking, smsForLead, type Centre } from './sms.ts';
import * as T from './templates.ts';
import type { CallState, ExplainTopic, SessionData, TurnResult } from './types.ts';
import type { DropSlot } from '../shared/types.ts';

export type CallDeps = {
  classifier: Classifier;
  crm: Crm;
  kb?: KnowledgeBank;
  /**
   * Answers the easy turns without a model round trip (G7). Consulted first,
   * and used only when it reports certainty; everything else falls through.
   */
  fast?: Classifier;
};

/**
 * The state machine. **Our code decides what happens next at every step** (B1);
 * the classifier only reports what the caller said (B2).
 *
 * Every business rule comes from `src/shared/` — nothing here restates one. If
 * a rule appears twice it will eventually disagree with itself.
 */

function centreOf(db: Database): Centre {
  return db.prepare(`SELECT name, landline FROM centres WHERE id = ?`).get(CENTRE_ID) as Centre;
}

/**
 * Template variation seed — the turn number, so phrasing moves through a call.
 *
 * Caller rows only. Counting every row counted two per turn, so the seed was
 * always even and `pick()` froze every two-phrasing pool on its first entry —
 * sixteen of the twenty-five in `templates.ts`. Two re-asks in a row came
 * back word for word, which is the one thing E0 forbids.
 */
function seedOf(db: Database, sessionId: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM transcripts WHERE session_id = ? AND speaker = 'caller'`)
      .get(sessionId) as { n: number }
  ).n;
}

export async function startCall(
  db: Database,
  callerNumber: string,
  now: Date = new Date(),
  /** A telephony provider's own call id, so its turns can find this session. */
  externalId?: string,
): Promise<TurnResult> {
  const centre = centreOf(db);
  const data: SessionData = {
    centreId: CENTRE_ID,
    callerNumber,
    // The call's start decides what "tomorrow" means for its whole length (D5).
    startedAt: timestamp(now),
    pushback: 0,
    otpAttempts: 0,
    ...(externalId ? { externalId } : {}),
  };
  const session = createSession(db, data, now);
  // Always English: we don't know how the caller speaks yet.
  const reply = T.fill(T.pick(T.EN.GREETING, 0), {
    centre: centre.name,
    last4: T.spokenDigits(callerNumber.slice(-4)),
  });
  appendTranscript(db, session.id, 'agent', reply, now);
  return { sessionId: session.id, state: 'greeting', reply, ended: false };
}

export async function handleTurn(
  db: Database,
  deps: CallDeps,
  sessionId: string,
  utterance: string,
  now: Date = new Date(),
): Promise<TurnResult> {
  const note: { understood?: string } = {};
  const result = await turn(db, deps, sessionId, utterance, now, note);
  return note.understood ? { ...result, understood: note.understood } : result;
}

/** The labels a turn was acted on: no words, so it is safe to log. */
function labels(state: CallState, cls: import('./classifier.ts').Classification, overridden: boolean): string {
  const parts = [
    cls.yesNo,
    cls.intent,
    cls.outOfBand && `question:${cls.outOfBand}${cls.kbKey ? '+answer' : ''}`,
    cls.vehicleModel && 'car',
    cls.vehicleLast4 && 'last4',
    cls.vehicleChoice && `choice:${cls.vehicleChoice}`,
    cls.day && 'day',
    cls.noPreference && 'any-day',
    cls.dropSlot,
    cls.complaint && 'complaint',
    cls.specialRequest && 'request',
    cls.nothing && 'nothing-wrong',
  ].filter(Boolean);
  return `${state} → ${parts.join(', ') || 'nothing clear'}${overridden ? ' (escalation ignored: answering the question)' : ''}`;
}

async function turn(
  db: Database,
  deps: CallDeps,
  sessionId: string,
  utterance: string,
  now: Date,
  note: { understood?: string },
): Promise<TurnResult> {
  const session = loadSession(db, sessionId);
  if (!session) throw new Error(`no session ${sessionId}`);
  if (session.state === 'ended') {
    return { sessionId, state: 'ended', reply: '', ended: true };
  }

  appendTranscript(db, sessionId, 'caller', utterance, now);
  const seed = seedOf(db, sessionId);
  const d = session.data;
  if (session.state === 'wrap_up') d.wrapTurns = (d.wrapTurns ?? 0) + 1;
  const callDate = today(new Date(d.startedAt));

  const ctx: Ctx = { db, deps, session, now, seed, callDate, centre: centreOf(db), L: T.poolsFor(d.language) };

  const kb = deps.kb ?? new TableKnowledgeBank(db);
  const request = {
    state: session.state,
    utterance,
    today: callDate,
    vehicles: d.vehicles?.map((v) => ({ model: v.model, last4: v.registration.slice(-4) })),
    // A shortlist read from the table this turn — so whatever the centre
    // saved on the Knowledge page a moment ago is already in it.
    kbTopics: kb.shortlist(utterance, callDate),
    // B3: strip what we already hold before the words leave the process.
    redact: [d.customerName, d.registration, d.model, d.callerNumber].filter(Boolean) as string[],
  };

  let cls;
  let quick: Classification | undefined;
  try {
    // "yes", "no", "morning", "4471" — roughly half a real call, and none of
    // it worth a second of network. The fast classifier answers those inline;
    // anything it is not certain about goes to the model (G7).
    quick = deps.fast ? await deps.fast.classify(request) : undefined;
    cls = quick?.confident ? quick : await deps.classifier.classify(request);
  } catch (err) {
    // The model timed out or errored. Said in the log — silent, this cost a
    // live call (2026-10-04) before anyone could see why. The error only:
    // never what the caller said.
    console.error(`  classifier failed at ${session.state}: ${failureLabel(err)}${quick && readsSomething(quick) ? ' · used the quick reading' : ''}`);
    if (quick && readsSomething(quick)) {
      // The quick reading is weaker than the model's but it is an answer:
      // it hears "Yes. The car is registered under the same number." as yes.
      // Re-asking instead made the caller repeat a right answer, and three
      // of those handed a booking call to the team.
      cls = quick;
    } else if (session.state === 'wrap_up') {
      // Closing, and nothing to go on: close rather than ask again.
      return signOff(ctx);
    } else {
      // Nothing to go on. The caller must not hear a fault, and the call must
      // not drop — E0 says never "I didn't understand that", so we ask the
      // smaller question instead. Bounded by D11 like any other retry, so a
      // sustained outage routes out to a human rather than looping.
      const p = registerPushback(d.pushback);
      d.pushback = p.count;
      if (p.exhausted) {
        // An outage, not a conversation: no "Anything else?" — it would fail too.
        return routeOut(ctx, 'another_problem', T.pick(ctx.L.EXIT.another_problem, seed), { end: true });
      }
      return answerAndResume(ctx, '');
    }
  }
  d.lastCallerWords = cls.callerWords;

  // Reply in the language the caller is speaking. Hinglish once they use
  // Hindi words; back to English after two plain-English turns, so it
  // follows them. "Yes" and "okay" are both, so short turns don't count.
  if (cls.language === 'hinglish' || detectHinglish(utterance)) {
    d.language = 'hinglish';
    d.englishTurns = 0;
  } else if (d.language === 'hinglish' && utterance.trim().split(/\s+/).length >= 3) {
    d.englishTurns = (d.englishTurns ?? 0) + 1;
    if (d.englishTurns >= 2) d.language = 'english';
  }
  ctx.L = T.poolsFor(d.language);

  // The always-on overlay (D9, D10) — answerable at ANY point, then we return
  // to exactly where the conversation was.
  if (cls.outOfBand === 'callback') return callBack(ctx, utterance);
  if (cls.outOfBand === 'explain' && cls.explain) return answerAndResume(ctx, explain(ctx, cls.explain));
  if (cls.outOfBand === 'cost') {
    return answerAndResume(ctx, T.pick(ctx.L.COST_ANSWER, seed));
  }
  if (cls.outOfBand === 'general') {
    // The classifier chose from the dealer's own published topics, or said
    // none. D10: no match means no answer — never a near-enough row. The
    // question goes to the team and the call carries on with the booking.
    const answer = cls.kbKey ? kb.answerFor(cls.kbKey, callDate) : undefined;
    if (!answer) {
      passOn(ctx, cls.generalQuestion ?? utterance);
      return answerAndResume(ctx, T.pick(ctx.L.KB_PASSED, seed));
    }
    // "Can you do pickup?" asked while booking is a wish the workshop should
    // see: it goes on the job card with the booking.
    const topic = request.kbTopics.find((t) => t.key === cls.kbKey)?.title ?? cls.kbKey!;
    if (d.bookingReference) addToBooking(ctx, `Asked about: ${topic}`);
    else if (d.vehicleId) d.askedAbout = [...new Set([...(d.askedAbout ?? []), topic])];
    return answerAndResume(ctx, answer);
  }
  // A caller answering the question we asked is answering it. Over a voice
  // line a plain "yes" can arrive with stray words, and the model once read
  // "Yes. The car is it should have the same number." as an incident and
  // ended a good call. At these steps the expected answer wins; a real
  // breakdown is still caught on the very next turn, "What can I do for you?".
  const answering =
    (session.state === 'greeting' && cls.yesNo === 'yes') ||
    ((session.state === 'awaiting_number' || session.state === 'awaiting_otp') && /\d{4,}/.test(utterance.replace(/\s/g, '')));
  note.understood = labels(session.state, cls, cls.intent === 'another_problem' && answering);
  if (cls.intent === 'another_problem' && !answering) {
    return routeOut(ctx, 'another_problem', T.pick(ctx.L.EXIT.another_problem, seed));
  }

  switch (session.state) {
    case 'greeting':
      return cls.yesNo === 'no'
        ? say(ctx, 'awaiting_number', T.pick(ctx.L.ASK_REGISTERED_NUMBER, seed), { digits: true })
        : identify(ctx, d.callerNumber);

    case 'awaiting_number': {
      const digits = utterance.replace(/\D/g, '');
      if (digits.length !== 10) {
        return say(ctx, 'awaiting_number', T.pick(ctx.L.ASK_REGISTERED_NUMBER, seed + 1), { digits: true });
      }
      d.otpCode = String(Math.floor(1000 + Math.random() * 9000));
      d.callerNumber = digits;
      // Logged rather than sent, same as every other message in the chat build.
      db.prepare(`INSERT INTO sms_log (mobile_number, body, created_at) VALUES (?, ?, ?)`).run(
        digits,
        `Your verification code is ${d.otpCode}`,
        timestamp(now),
      );
      return say(ctx, 'awaiting_otp', T.pick(ctx.L.ASK_OTP, seed), { digits: true });
    }

    case 'awaiting_otp': {
      if (utterance.replace(/\D/g, '') === d.otpCode) return identify(ctx, d.callerNumber);
      d.otpAttempts += 1;
      // Three failures ends the call, with the lead registered against the
      // caller ID we already hold (E1, F2 #1).
      if (d.otpAttempts >= 3) {
        return routeOut(ctx, 'number_not_found', T.pick(ctx.L.EXIT.number_not_found, seed));
      }
      return say(ctx, 'awaiting_number', T.pick(ctx.L.OTP_WRONG, seed), { digits: true });
    }

    case 'vehicle':
      return resolveVehicle(ctx, cls.vehicleModel, cls.vehicleLast4, cls.vehicleChoice);

    case 'open_turn':
      if (cls.day) d.bookingDate = cls.day;
      if (cls.dropSlot) d.dropSlot = cls.dropSlot;
      // "Book it in as soon as you can" answers the day question before we
      // ask it, so don't then ask it (E7).
      if (cls.noPreference) d.noDayPreference = true;
      // "I can't shift the gears properly" — the fault, said up front.
      if (cls.complaint && !cls.nothing) noteFault(ctx, cls);
      return afterIntent(ctx);

    case 'complaint':
      if (cls.complaint && !cls.nothing) {
        noteFault(ctx, cls);
        // A complaint moves the job to the complaint pool (D8), and the
        // special-request question is skipped entirely.
        d.pool = poolFor(d.due!.service_type!, true);
        return askDay(ctx, faultAck(ctx), T.pick(ctx.L.FAULT_NEXT_DAY, seed));
      }
      return say(ctx, 'special_request', T.pick(ctx.L.ASK_SPECIAL_REQUEST, seed));

    case 'special_request':
      if (cls.specialRequest && !cls.nothing) d.complaintNote = cls.specialRequest;
      return askDay(ctx);

    case 'day': {
      // "Same day, but the afternoon" — after a readback, a change of time alone.
      if (!cls.day && cls.dropSlot && d.bookingDate) return chooseSlot(ctx, cls.dropSlot);
      if (cls.dropSlot) d.dropSlot = cls.dropSlot;
      if (!cls.day) {
        // "Whenever suits you" is an answer, not a refusal — charging it a
        // pushback routed out a caller who was being easy to deal with.
        if (cls.noPreference) return offerFirstAvailable(ctx);
        // No day named twice: offer the soonest rather than ask a third time.
        // Counting it as "forcing a full day" handed a caller who only wanted
        // their car fixed to the team with "I can't fit that in" (live call).
        if (d.dayReasked) return offerFirstAvailable(ctx);
        d.dayReasked = true;
        return say(ctx, 'day', T.pick(ctx.L.ASK_DAY.reask, seed));
      }
      // "Kal subah", "Friday morning": the slot came with the day.
      return considerDay(ctx, cls.day, undefined, cls.dropSlot);
    }

    case 'drop_slot': {
      // "Actually, make it Saturday." The schema now carries a date at this
      // turn, so a change of mind goes back through the same day checks
      // rather than being heard as silence.
      if (cls.day && cls.day !== d.bookingDate) return considerDay(ctx, cls.day, undefined, cls.dropSlot);
      if (cls.noPreference && !d.dropSlot) return offerFirstAvailable(ctx);
      // Where only one slot is free, D6 has us state it rather than ask — so
      // "yes, that's fine" is the caller choosing the slot we just named, not
      // a non-answer. `offerSlotLine` parked it on the session for exactly
      // this. Read as nothing, it re-asked verbatim and charged a pushback,
      // so three acceptances routed the caller out.
      const chosen = cls.dropSlot ?? (cls.yesNo === 'yes' ? d.dropSlot : undefined);
      if (!chosen) {
        const p = registerPushback(d.pushback);
        d.pushback = p.count;
        if (p.exhausted) return routeOut(ctx, 'forced_full_day', T.pick(ctx.L.EXIT.forced_full_day, seed));
        return say(ctx, 'drop_slot', reaskSlotLine(ctx));
      }
      return chooseSlot(ctx, chosen);
    }

    case 'confirm':
      // The same-day nudge, answered. Wanting it routes out — we cannot see
      // the workshop's real load, so we never invent a same-day slot (D7).
      if (cls.yesNo === 'yes') {
        // They want it back the same day. We can't promise that (D7) — but
        // they still want the visit, so book it as offered, and the service
        // manager calls about same-day. Routing out instead left a caller who
        // asked for more with nothing booked at all.
        fileLead(ctx, 'same_day_demanded');
        d.sameDayNudgeDeclined = true;
        d.complaintNote = [d.complaintNote, 'Wants it back the same day if possible.'].filter(Boolean).join('\n');
        return { ...readBack(ctx, T.pick(ctx.L.SAME_DAY_NOTED, seed)), leadReason: 'same_day_demanded' };
      }
      // Not a clear answer: ask once, plainly. Reading anything but "yes" as
      // a no booked next-day for a caller asking for same-day (live call).
      if (cls.yesNo !== 'no' && !d.nudgeReasked) {
        d.nudgeReasked = true;
        return say(ctx, 'confirm', T.pick(ctx.L.NUDGE_REASK, seed));
      }
      d.sameDayNudgeDeclined = true; // never raise it again
      return readBack(ctx);

    case 'confirm_booking': {
      // A change in the same breath — "no, make it Saturday" — goes straight
      // through the same checks as the first time.
      if (cls.day && cls.day !== d.bookingDate) return considerDay(ctx, cls.day, undefined, cls.dropSlot);
      if (cls.dropSlot && cls.dropSlot !== d.dropSlot) return chooseSlot(ctx, cls.dropSlot);
      if (cls.yesNo === 'yes') return book(ctx);
      if (cls.yesNo === 'no') return say(ctx, 'day', T.pick(ctx.L.READBACK_CHANGE, seed));
      const p = registerPushback(d.pushback);
      d.pushback = p.count;
      if (p.exhausted) return routeOut(ctx, 'another_problem', T.pick(ctx.L.EXIT.another_problem, seed));
      return say(ctx, 'confirm_booking', T.pick(ctx.L.READBACK_REASK, seed));
    }

    case 'wrap_up': {
      if ((d.wrapTurns ?? 0) >= WRAP_TURNS) return signOff(ctx);
      const booked = Boolean(d.bookingReference);
      const words = utterance.trim().split(/\s+/).filter(Boolean).length;
      // Another car is its own call (D12): the team has it.
      if (cls.otherVehicle) return say(ctx, 'wrap_up', T.pick(ctx.L.WRAP_FOR_THE_TEAM, seed));
      const restates = cls.intent === 'book' || Boolean(cls.day) || Boolean(cls.dropSlot);
      // Said again, or something to add: the booking is done, so say so, and
      // the extra goes on the job card ("…with pickup at my home").
      if (booked && (restates || cls.specialRequest)) {
        const parts: string[] = [];
        if (restates) {
          parts.push(
            T.fill(T.pick(ctx.L.ALL_SET, seed), { day: T.spokenDay(d.bookingDate!), time: ctx.L.time(d.dropSlot!) }),
          );
        }
        if (cls.specialRequest) {
          addToBooking(ctx, `Caller added: ${cls.specialRequest}`);
          parts.push(T.pick(ctx.L.ADDED_TO_BOOKING, seed));
        }
        parts.push(T.pick(ctx.L.ANYTHING_ELSE_AGAIN, seed));
        return say(ctx, 'wrap_up', parts.join(' '));
      }
      if (cls.yesNo === 'no') return signOff(ctx);
      if (cls.yesNo === 'yes' && words <= 3) return say(ctx, 'wrap_up', T.pick(ctx.L.GO_AHEAD, seed));
      // Something more than a question: another car, a booking we couldn't
      // make. Not for this call (D12); the team has it, and their number.
      if (cls.yesNo === 'yes' || restates || cls.specialRequest || cls.vehicleModel || cls.complaint) {
        return say(ctx, 'wrap_up', T.pick(ctx.L.WRAP_FOR_THE_TEAM, seed));
      }
      // Not clear: ask once more rather than hang up on a question.
      if (!d.wrapReasked) {
        d.wrapReasked = true;
        return say(ctx, 'wrap_up', T.pick(ctx.L.WRAP_REASK, seed));
      }
      return signOff(ctx);
    }

    default:
      return say(ctx, session.state, T.pick(ctx.L.OPEN_TURN, seed));
  }
}

// ---------------------------------------------------------------------------

type Ctx = {
  db: Database;
  deps: CallDeps;
  session: Session;
  /** The lines in the caller's language (templates.ts EN / HI). */
  L: T.Pools;
  now: Date;
  seed: number;
  callDate: IsoDate;
  centre: Centre;
};

function say(
  ctx: Ctx,
  state: CallState,
  reply: string,
  opts: { digits?: boolean } = {},
): TurnResult {
  ctx.session.state = state;
  saveSession(ctx.db, ctx.session, ctx.now);
  appendTranscript(ctx.db, ctx.session.id, 'agent', reply, ctx.now);
  return {
    sessionId: ctx.session.id,
    state,
    reply,
    ended: false,
    ...(opts.digits ? { expectsDigits: true } : {}),
  };
}

/**
 * Re-ask whatever we were waiting on, so an out-of-band answer resumes
 * cleanly (D9, D10). Every state, not most: a caller who asks about parking
 * mid-OTP must hear the OTP prompt again with the keypad still open. Falling
 * through to "How can I help?" asks a different question and drops
 * `expectsDigits`.
 */
function resumeQuestion(ctx: Ctx): { text: string; digits?: boolean } {
  const { seed } = ctx;
  const d = ctx.session.data;
  switch (ctx.session.state) {
    // Not the full greeting — the bot is disclosed once and never again (G3.1).
    case 'greeting':
      return { text: T.fill(T.pick(ctx.L.RESUME_CALLER_ID, seed), { last4: T.spokenDigits(d.callerNumber.slice(-4)) }) };
    case 'awaiting_number':
      return { text: T.pick(ctx.L.ASK_REGISTERED_NUMBER, seed), digits: true };
    // Re-prompt only; a fresh code would invalidate the one they are holding.
    case 'awaiting_otp':
      return { text: T.pick(ctx.L.ASK_OTP, seed), digits: true };
    case 'vehicle':
      return { text: T.pick(d.vehicleListed ? ctx.L.VEHICLE_LIST.reask : ctx.L.VEHICLE_ASK.reask, seed) };
    case 'complaint':
      return { text: T.pick(ctx.L.ASK_COMPLAINT.reask, seed) };
    case 'special_request':
      return { text: T.pick(ctx.L.ASK_SPECIAL_REQUEST, seed) };
    case 'day':
      return { text: T.pick(ctx.L.ASK_DAY.ask, seed) };
    case 'drop_slot':
      return { text: offerSlotLine(ctx) };
    case 'confirm':
      return { text: T.pick(ctx.L.SAME_DAY_NUDGE, seed) };
    case 'confirm_booking':
      return { text: T.pick(ctx.L.READBACK_REASK, seed) };
    case 'wrap_up':
      return { text: T.pick(ctx.L.ANYTHING_ELSE_AGAIN, seed) };
    default:
      return { text: T.pick(ctx.L.OPEN_TURN, seed) };
  }
}

/** Answer something out of band, then pick the conversation back up. */
/** Whether a classification says anything a step can act on. */
function readsSomething(c: Classification): boolean {
  return Boolean(
    c.yesNo || c.day || c.dropSlot || c.noPreference || c.vehicleModel || c.vehicleLast4 || c.vehicleChoice || c.otherVehicle ||
      c.outOfBand || c.intent || c.complaint || c.specialRequest || c.nothing,
  );
}

/** "429 rate_limit_error: …" — the kind of failure, for the log. */
function failureLabel(err: unknown): string {
  const e = err as { status?: number; name?: string; message?: string; error?: { error?: { type?: string } } };
  return [e?.status, e?.error?.error?.type ?? e?.name, String(e?.message ?? err).slice(0, 160)].filter(Boolean).join(' ');
}

function answerAndResume(ctx: Ctx, answer: string): TurnResult {
  // The closing has had its turns: answer, and say goodbye.
  if (ctx.session.state === 'wrap_up' && (ctx.session.data.wrapTurns ?? 0) >= WRAP_TURNS) return signOff(ctx, answer);
  const resume = resumeQuestion(ctx);
  // The classifier-failure path passes no answer, which would otherwise leave
  // a leading space for the voice layer to read.
  return say(ctx, ctx.session.state, `${answer} ${resume.text}`.trim(), { digits: resume.digits });
}

/**
 * A question the bank could not answer: a customer-care follow-up with the
 * caller's own words, and the team's number by SMS — without ending the call.
 * One follow-up per call; a second unanswered question is added to it.
 */
function passOn(ctx: Ctx, question: string): void {
  const d = ctx.session.data;
  if (d.passedLeadId) {
    ctx.db
      .prepare(
        `UPDATE leads SET caller_words = COALESCE(caller_words || ' / ', '') || ? WHERE id = ? AND status = 'open'`,
      )
      .run(question, d.passedLeadId);
    return;
  }
  d.passedLeadId = insertLead(
    ctx.db,
    buildLead(
      'another_problem',
      {
        mobileNumber: d.callerNumber,
        customerId: d.customerId ?? null,
        vehicleRegistration: d.registration ?? null,
        vehicleModel: d.model ?? null,
        callerWords: question,
        sessionId: ctx.session.id,
      },
      ctx.now,
    ),
  );
  smsForLead(ctx.db, { leadId: d.passedLeadId, mobile: d.callerNumber, centre: ctx.centre, now: ctx.now });
}

export type KbAnswer =
  | { kind: 'answer'; key: string; title: string; answer: string; shortlisted: string[] }
  | { kind: 'passed'; shortlisted: string[] }
  | { kind: 'cost' | 'not_a_question'; shortlisted: string[] };

/**
 * What the agent would say to a question about the centre — the same
 * shortlist, the same classifiers and the same lookup a call uses, so the
 * Knowledge page's test panel shows the truth rather than an imitation.
 */
export async function answerQuestion(
  db: Database,
  deps: CallDeps,
  question: string,
  day: string,
): Promise<KbAnswer> {
  const kb = deps.kb ?? new TableKnowledgeBank(db);
  const topics = kb.shortlist(question, day);
  const shortlisted = topics.map((t) => t.title);
  const request = { state: 'open_turn' as const, utterance: question, today: day, kbTopics: topics };
  const quick = deps.fast ? await deps.fast.classify(request) : undefined;
  const cls = quick?.confident ? quick : await deps.classifier.classify(request);
  if (cls.outOfBand === 'cost') return { kind: 'cost', shortlisted };
  if (cls.outOfBand !== 'general') return { kind: 'not_a_question', shortlisted };
  const answer = cls.kbKey ? kb.answerFor(cls.kbKey, day) : undefined;
  if (!answer || !cls.kbKey) return { kind: 'passed', shortlisted };
  const title = topics.find((t) => t.key === cls.kbKey)?.title ?? cls.kbKey;
  return { kind: 'answer', key: cls.kbKey, title, answer, shortlisted };
}

/** A line on the booking's job card, added after it was made. */
function addToBooking(ctx: Ctx, line: string): void {
  ctx.db
    .prepare(
      `UPDATE bookings SET complaint_note = COALESCE(complaint_note || char(10), '') || ? WHERE booking_reference = ?`,
    )
    .run(line, ctx.session.data.bookingReference);
}

/** Caller turns the closing "Anything else?" may take before we say goodbye. */
const WRAP_TURNS = 3;

/**
 * Every routed exit: lead, SMS, then "Anything else?" — the caller, not the
 * agent, ends the call. One path, so none can skip a step (F2). `end` is for
 * an outage, where another question would only fail again; an exit from the
 * closing itself also ends, so the closing can't loop.
 */
function routeOut(ctx: Ctx, reason: LeadReason, reply: string, opts: { end?: boolean } = {}): TurnResult {
  const d = ctx.session.data;
  fileLead(ctx, reason);
  d.leadReason = reason;
  if (opts.end) return endCall(ctx, reply);
  if (ctx.session.state === 'wrap_up') return signOff(ctx, reply);
  return { ...say(ctx, 'wrap_up', `${reply} ${T.pick(ctx.L.ANYTHING_ELSE_AFTER_EXIT, ctx.seed)}`), leadReason: reason };
}

/** A follow-up for the right team, with everything the call knows, and the workshop's number by SMS (F1, F2). */
function fileLead(ctx: Ctx, reason: LeadReason): number {
  const d = ctx.session.data;
  const leadId = insertLead(
    ctx.db,
    buildLead(
      reason,
      {
        mobileNumber: d.callerNumber,
        customerId: d.customerId ?? null,
        vehicleRegistration: d.registration ?? null,
        vehicleModel: d.model ?? null,
        requestedDate: d.bookingDate ?? null,
        requestedSlot: d.dropSlot ?? null,
        requestedPool: d.pool ?? null,
        crmSnapshot: d.due ?? null,
        callerWords: d.lastCallerWords ?? null,
        sessionId: ctx.session.id,
      },
      ctx.now,
    ),
  );
  smsForLead(ctx.db, { leadId, mobile: d.callerNumber, centre: ctx.centre, now: ctx.now });
  return leadId;
}

/** The last words, then the call is over. The voice layer adds "Goodbye." and hangs up. */
function endCall(ctx: Ctx, reply: string): TurnResult {
  const d = ctx.session.data;
  ctx.session.state = 'ended';
  endSession(ctx.db, ctx.session, ctx.now);
  appendTranscript(ctx.db, ctx.session.id, 'agent', reply, ctx.now);
  return {
    sessionId: ctx.session.id,
    state: 'ended',
    reply,
    ended: true,
    ...(d.bookingReference ? { bookingReference: d.bookingReference } : {}),
    ...(d.leadReason ? { leadReason: d.leadReason } : {}),
  };
}

/** G3.8 — thanks, by first name once, and see you on the day if they booked. */
function signOff(ctx: Ctx, lead = ''): TurnResult {
  const d = ctx.session.data;
  const name = (d.customerName ?? '').split(' ')[0] ?? '';
  const known = name && name !== 'Guest';
  const line =
    d.bookingReference && d.bookingDate && known
      ? T.fill(T.pick(ctx.L.SIGN_OFF.booked, ctx.seed), { name, day: T.spokenDay(d.bookingDate) })
      : known
        ? T.fill(T.pick(ctx.L.SIGN_OFF.other, ctx.seed), { name })
        : T.pick(ctx.L.SIGN_OFF.anonymous, ctx.seed);
  return endCall(ctx, `${lead} ${line}`.trim());
}

/** E5 — the CRM lookup is prefetched here, at identification, not later. */
async function identify(ctx: Ctx, mobile: string): Promise<TurnResult> {
  const d = ctx.session.data;
  const account = await ctx.deps.crm.findByMobile(mobile);
  if (!account) {
    return routeOut(ctx, 'number_not_found', T.pick(ctx.L.EXIT.number_not_found, ctx.seed));
  }

  d.customerId = account.customerId;
  d.customerName = account.name;
  d.vehicles = account.vehicles;

  // Nothing on the account. Asking "which one?" invites an answer that cannot
  // exist, and a model_not_recognised lead would blame the caller for a record
  // that is simply incomplete (D3).
  if (account.vehicles.length === 0) {
    return routeOut(ctx, 'missing_required_field', T.pick(ctx.L.EXIT.missing_required_field, ctx.seed));
  }

  // E2 — one vehicle: state it, don't ask.
  if (account.vehicles.length === 1) {
    const v = account.vehicles[0]!;
    setVehicle(ctx, v.id);
    const line = T.fill(T.pick(ctx.L.VEHICLE_SINGLE, ctx.seed), { model: v.model });
    return say(ctx, 'open_turn', `${T.pick(ctx.L.LOOKUP_ACCOUNT, ctx.seed)} ${line} ${T.pick(ctx.L.OPEN_TURN, ctx.seed)}`);
  }
  // Two to five: read them out, numbered, so "two" is an answer.
  if (account.vehicles.length <= ctx.L.listNumber.length) {
    d.vehicleListed = true;
    const L = ctx.L.VEHICLE_LIST;
    const items = account.vehicles.map((v, i) =>
      T.fill(L.item, {
        number: ctx.L.listNumber[i]!,
        model: v.model,
        last4: T.spokenDigits(v.registration.slice(-4)),
      }),
    );
    const intro = T.fill(T.pick(L.intro, ctx.seed), { count: account.vehicles.length });
    const pickLine = T.pick(account.vehicles.length === 2 ? L.pickTwo : L.pickMany, ctx.seed);
    return say(ctx, 'vehicle', [intro, ...items, pickLine].join(' '));
  }
  return say(ctx, 'vehicle', T.pick(ctx.L.VEHICLE_ASK.ask, ctx.seed));
}

function setVehicle(ctx: Ctx, vehicleId: number): void {
  const d = ctx.session.data;
  const v = d.vehicles!.find((x) => x.id === vehicleId)!;
  d.vehicleId = v.id;
  d.registration = v.registration;
  d.model = v.model;
  d.due = v.due;
}

/**
 * E2 — three passes over the one answer: model + last four, then last four,
 * then model. Registration outranks model because four digits discriminate
 * better than "Swift". If all three fail the call ends; we do not loop.
 */
function resolveVehicle(ctx: Ctx, model?: string, last4?: string, choice?: number): TurnResult {
  const d = ctx.session.data;
  const vehicles = d.vehicles ?? [];

  // "Two" — the second car of the list we just read out.
  const picked = d.vehicleListed && choice && choice >= 1 && choice <= vehicles.length ? vehicles[choice - 1] : undefined;
  if (picked) {
    setVehicle(ctx, picked.id);
    const line = T.fill(T.pick(ctx.L.VEHICLE_SINGLE, ctx.seed), { model: picked.model });
    return say(ctx, 'open_turn', `${line} ${T.pick(ctx.L.OPEN_TURN, ctx.seed)}`);
  }

  // Nothing to match on at all is a non-answer, not a failed match — narrow
  // the question once (E0) rather than ending the call on a mumble.
  if (!model && !last4) {
    const p = registerPushback(d.pushback);
    d.pushback = p.count;
    if (p.exhausted) {
      return routeOut(ctx, 'model_not_recognised', T.pick(ctx.L.EXIT.model_not_recognised, ctx.seed));
    }
    return say(ctx, 'vehicle', T.pick(d.vehicleListed ? ctx.L.VEHICLE_LIST.reask : ctx.L.VEHICLE_ASK.reask, ctx.seed));
  }

  const passes = [
    vehicles.filter((v) => model && last4 && v.model.toLowerCase() === model.toLowerCase() && v.registration.endsWith(last4)),
    vehicles.filter((v) => last4 && v.registration.endsWith(last4)),
    vehicles.filter((v) => model && v.model.toLowerCase() === model.toLowerCase()),
  ];
  const hit = passes.find((p) => p.length === 1)?.[0];

  // "The Swift", with two Swifts on a list we read out: ask for the number
  // rather than ending the call — the list is right there.
  if (!hit && d.vehicleListed && passes[2]!.length > 1) {
    const p = registerPushback(d.pushback);
    d.pushback = p.count;
    if (!p.exhausted) return say(ctx, 'vehicle', T.pick(ctx.L.VEHICLE_LIST.reask, ctx.seed));
  }
  if (!hit) {
    return routeOut(ctx, 'model_not_recognised', T.pick(ctx.L.EXIT.model_not_recognised, ctx.seed));
  }
  setVehicle(ctx, hit.id);
  const line = T.fill(T.pick(ctx.L.VEHICLE_SINGLE, ctx.seed), { model: hit.model });
  return say(ctx, 'open_turn', `${line} ${T.pick(ctx.L.OPEN_TURN, ctx.seed)}`);
}

/**
 * E4 — the duplicate check fires here, at intent, **before** complaints or
 * days. Taking the caller through all of that and rejecting them at the write
 * would be a worse call than an IVR gives.
 */
function afterIntent(ctx: Ctx): TurnResult {
  const d = ctx.session.data;

  const existing = openBookingForRegistration(ctx.db, d.registration!);
  if (existing) {
    return routeOut(ctx, 'existing_open_booking', T.pick(ctx.L.EXIT.existing_open_booking, ctx.seed));
  }

  // E5 — the D2/D3 blockers fire here, on the prefetched CRM record.
  const assessment = assessBookability(d.due, ctx.callDate);
  if (!assessment.bookable) {
    return routeOut(ctx, assessment.reason, T.pick(ctx.L.EXIT[assessment.reason], ctx.seed));
  }
  // The fault was said up front: it goes on the job card, and we don't ask
  // "is anything wrong?" about the thing they just told us (D8).
  if (d.complaintNote) {
    d.pool = poolFor(assessment.serviceType, true);
    return askDay(ctx, faultAck(ctx), T.pick(ctx.L.FAULT_NEXT_DAY, ctx.seed));
  }
  d.pool = poolFor(assessment.serviceType, false);

  const due = d.due!;
  const stated = T.fill(T.pick(ctx.L.SERVICE_DUE, ctx.seed), {
    model: d.model!,
    ordinal: ctx.L.ordinal(due.service_number),
    pool: assessment.serviceType,
  });
  return say(ctx, 'complaint', `${stated} ${T.pick(ctx.L.ASK_COMPLAINT.ask, ctx.seed)}`);
}

function windowAndDays(ctx: Ctx) {
  const d = ctx.session.data;
  const w = bookingWindow(new Date(d.startedAt));
  const days = capacityWindow(ctx.db, d.centreId, {
    now: new Date(d.startedAt),
    days: BOOKING_WINDOW_DAYS,
  });
  return { w, days };
}

/** E7 — if the open turn already settled the day, use it rather than re-asking. */
function askDay(ctx: Ctx, ack?: string, consequence?: string): TurnResult {
  const d = ctx.session.data;
  const lead = ack ? `${ack} ` : '';
  // The slot line says when it's back, so the consequence is only said here,
  // where the next question is the day.
  if (d.bookingDate) return considerDay(ctx, d.bookingDate, lead, d.dropSlot);
  if (d.noDayPreference) return offerFirstAvailable(ctx, lead);
  return say(ctx, 'day', `${lead}${consequence ? `${consequence} ` : ''}${T.pick(ctx.L.ASK_DAY.ask, ctx.seed)}`);
}

/** The fault on the session: its area (a closed list), and the caller's words for the job card. */
function noteFault(ctx: Ctx, cls: Classification): void {
  const d = ctx.session.data;
  d.faultArea = cls.faultArea ?? 'other';
  d.complaintNote = d.faultArea !== 'other' ? `[${d.faultArea}] ${cls.complaint}` : cls.complaint;
}

/** "Got it, a problem with the gears, noted for the workshop." — the area in our words (B3). */
function faultAck(ctx: Ctx): string {
  const area = ctx.session.data.faultArea;
  return area && area !== 'other'
    ? T.fill(T.pick(ctx.L.ACK_FAULT, ctx.seed), { fault: ctx.L.fault[area] })
    : T.pick(ctx.L.ACK_COMPLAINT, ctx.seed);
}

/**
 * "Why is it next day?", "When do I get it back?" — answered from this call's
 * own booking state, in the caller's language. A question asked before it
 * applies (no day yet) gets the general answer.
 */
function explain(ctx: Ctx, topic: ExplainTopic): string {
  const d = ctx.session.data;
  const E = ctx.L.EXPLAIN;
  const say = (pool: string[], vars: Record<string, string> = {}) => T.fill(T.pick(pool, ctx.seed), vars);
  const pool = d.pool;
  const slot = d.dropSlot;
  const day = d.bookingDate ? T.spokenDay(d.bookingDate) : undefined;
  const back = pool && slot ? (isSameDay(pool, slot) ? ctx.L.back.same : ctx.L.back.next) : undefined;
  switch (topic) {
    case 'next_day':
      if (pool === 'complaint') {
        return say(E.next_day_fault, {
          pool: d.due?.service_type ?? 'regular',
          problem: ctx.L.problem[d.faultArea ?? 'other'],
        });
      }
      if (pool === 'major' && slot === 'afternoon') return say(E.next_day_major);
      if (pool && slot && isSameDay(pool, slot)) return say(E.not_next_day);
      return say(E.next_day_general);
    case 'same_day_how':
      if (pool === 'complaint') return say(E.same_day_fault);
      if (pool === 'minor') return say(E.same_day_minor);
      if (pool === 'major') return say(E.same_day_major);
      return say(E.same_day_general);
    case 'not_today':
      return say(E.not_today);
    case 'day_full':
      return d.lastFullDay ? say(E.day_full, { day: T.spokenDay(d.lastFullDay) }) : say(E.day_full_general);
    case 'one_slot': {
      const offer = d.bookingDate && pool ? slotOffer(ctx) : undefined;
      if (day && (offer === 'morning' || offer === 'afternoon')) {
        return say(E.one_slot, { day, other: ctx.L.slot[offer === 'morning' ? 'afternoon' : 'morning'] });
      }
      return say(E.one_slot_general);
    }
    case 'ready_when':
      return day && slot && back ? say(E.ready_when, { day, time: ctx.L.time(slot), back }) : say(E.ready_when_general);
    case 'drop_off':
      return slot ? say(E.drop_off, { time: ctx.L.time(slot) }) : say(E.drop_off_general);
    default:
      return say(E[topic]);
  }
}

/**
 * "Can someone call me back?" — a plain yes. One customer-care follow-up for
 * the call (a second ask joins it), the workshop's number by SMS. Mid-booking
 * the booking carries on; otherwise the call moves to "Anything else?".
 */
function callBack(ctx: Ctx, words: string): TurnResult {
  passOn(ctx, `Asked for a call back: ${words.trim()}`);
  const yes = T.pick(ctx.L.CALLBACK_YES, ctx.seed);
  const booking = ['vehicle', 'complaint', 'special_request', 'day', 'drop_slot', 'confirm', 'confirm_booking'];
  if (booking.includes(ctx.session.state) || ctx.session.state === 'wrap_up') return answerAndResume(ctx, yes);
  return say(ctx, 'wrap_up', `${yes} ${T.pick(ctx.L.ANYTHING_ELSE_AFTER_EXIT, ctx.seed)}`);
}

/**
 * E7 — the caller left it to us, so we pick: the first day in the window that
 * can take the job. Stated, then straight into the ordinary slot offer, so
 * they still choose between the two outcomes and their consequences (E8).
 */
function offerFirstAvailable(ctx: Ctx, lead = ''): TurnResult {
  const d = ctx.session.data;
  const { w, days } = windowAndDays(ctx);
  const first = firstAvailable(days, d.pool!, w);
  if (!first) {
    return routeOut(
      ctx,
      'nothing_available_30_days',
      T.pick(ctx.L.EXIT.nothing_available_30_days, ctx.seed),
    );
  }
  const named = T.fill(T.pick(ctx.L.FIRST_AVAILABLE, ctx.seed), { date: ctx.L.date(first.date) });
  return considerDay(ctx, first.date, `${lead}${named} `);
}

/** D5 and D6 together: is this day in the window, and can it take the job? */
function considerDay(ctx: Ctx, requested: IsoDate, given?: string, wanted?: DropSlot): TurnResult {
  const d = ctx.session.data;
  // A lead-in while the day is checked — unless the turn already has one
  // (an acknowledgement, or "the soonest is…"). Never two.
  const lead = given ?? `${T.pick(ctx.L.LOOKUP_DAY, ctx.seed)} `;
  const { w, days } = windowAndDays(ctx);
  const offer = offerForDate(days, requested, d.pool!, w);

  if (offer && offer !== 'none') {
    d.bookingDate = requested;
    // The caller already said which slot, and it's free: don't offer both
    // again — go to the readback ("kal subah" was answered with a choice).
    if (wanted && (offer === 'both' || offer === wanted)) return chooseSlot(ctx, wanted, lead);
    d.dropSlot = undefined;
    return say(ctx, 'drop_slot', `${lead}${offerSlotLine(ctx, offer)}`);
  }

  // Nothing at all in the whole window is the loudest alarm in the system (F3).
  const bookable = findBookable(days, d.pool!, w);
  if (bookable.length === 0) {
    return routeOut(ctx, 'nothing_available_30_days', T.pick(ctx.L.EXIT.nothing_available_30_days, ctx.seed));
  }

  // D11 — forcing a full day more than three times routes out.
  const p = registerPushback(d.pushback);
  d.pushback = p.count;
  if (p.exhausted) {
    d.bookingDate = requested;
    return routeOut(ctx, 'forced_full_day', T.pick(ctx.L.EXIT.forced_full_day, ctx.seed));
  }

  // D6 — offer the next two available days, naming the slot where only one is
  // open. Two, never a list: E0 allows at most two options a turn.
  d.lastFullDay = requested;
  const alts = nextTwoAvailable(days, d.pool!, w, requested);
  const label = (a: { date: IsoDate; offer: string }) =>
    a.offer === 'both' ? ctx.L.date(a.date) : `${ctx.L.date(a.date)} ${ctx.L.slot[a.offer as DropSlot]}`;

  const reply =
    alts.length >= 2
      ? T.fill(T.pick(ctx.L.DAY_FULL_OFFER_TWO, ctx.seed), {
          day: T.spokenDay(requested),
          alt1: label(alts[0]!),
          alt2: label(alts[1]!),
        })
      : T.fill(T.pick(ctx.L.DAY_FULL_OFFER_ONE, ctx.seed), {
          day: T.spokenDay(requested),
          alt1: label(alts[0]!),
        });
  return say(ctx, 'day', reply);
}

/** What this day can still take. `known` saves a second lookup when the
 *  caller has just been through `considerDay`. */
function slotOffer(ctx: Ctx, known?: DayOffer): DayOffer {
  const d = ctx.session.data;
  const { w, days } = windowAndDays(ctx);
  return known ?? offerForDate(days, d.bookingDate!, d.pool!, w) ?? 'none';
}

/** E8 — two outcomes with consequences, not two menu items. */
function offerSlotLine(ctx: Ctx, known?: DayOffer): string {
  const d = ctx.session.data;
  const offer = slotOffer(ctx, known);
  const day = T.spokenDay(d.bookingDate!);

  if (offer === 'morning' || offer === 'afternoon') {
    // Only one slot free: state it (D6), don't ask a question with one answer.
    // Parked on the session so a bare "yes" in `drop_slot` can accept it.
    d.dropSlot = offer;
    return T.fill(T.pick(ctx.L.DAY_ONE_SLOT, ctx.seed), { day, slot: ctx.L.slot[offer] });
  }
  const am = isSameDay(d.pool!, 'morning');
  const pm = isSameDay(d.pool!, 'afternoon');
  const pool = am && pm ? ctx.L.SLOT_BOTH_SAME_DAY : !am && !pm ? ctx.L.SLOT_BOTH_NEXT_DAY : ctx.L.SLOT_BOTH;
  return T.fill(T.pick(pool, ctx.seed), { day });
}

/** The narrowed second ask, so the same sentence never comes back twice (E0). */
function reaskSlotLine(ctx: Ctx): string {
  const offer = slotOffer(ctx);
  const day = T.spokenDay(ctx.session.data.bookingDate!);
  return offer === 'morning' || offer === 'afternoon'
    ? T.fill(T.pick(ctx.L.SLOT_REASK_ONE, ctx.seed), { day, slot: ctx.L.slot[offer] })
    : T.fill(T.pick(ctx.L.SLOT_REASK_BOTH, ctx.seed), { day });
}

/**
 * The caller chose a slot. They can ask for one we have already said is gone
 * — "only the afternoon is free" followed by "morning's better". Check before
 * accepting, or the booking fails at the write and a caller who could have
 * been booked gets routed out instead.
 */
function chooseSlot(ctx: Ctx, chosen: DropSlot, lead = ''): TurnResult {
  const d = ctx.session.data;
  const { days } = windowAndDays(ctx);
  const day = days.find((x) => x.date === d.bookingDate);
  if (!day || !canTake(day, d.pool!, chosen)) {
    const p = registerPushback(d.pushback);
    d.pushback = p.count;
    if (p.exhausted) return routeOut(ctx, 'forced_full_day', T.pick(ctx.L.EXIT.forced_full_day, ctx.seed));
    const left = day ? dayOffer(day, d.pool!) : 'none';
    if (left === 'none') return considerDay(ctx, d.bookingDate!);
    return say(
      ctx,
      'drop_slot',
      T.fill(T.pick(ctx.L.SLOT_GONE, ctx.seed), {
        asked: ctx.L.slot[chosen],
        left: ctx.L.slot[left as DropSlot],
        day: T.spokenDay(d.bookingDate!),
      }),
    );
  }
  d.dropSlot = chosen;
  return maybeNudgeThenReadBack(ctx, lead);
}

/** D7 — offer the same-day nudge once, where delivery lands on the next day. */
function maybeNudgeThenReadBack(ctx: Ctx, lead = ''): TurnResult {
  const d = ctx.session.data;
  if (!d.sameDayNudgeDeclined && shouldOfferSameDayNudge(d.pool!, d.dropSlot!)) {
    return say(ctx, 'confirm', `${lead}${T.pick(ctx.L.SAME_DAY_NUDGE, ctx.seed)}`);
  }
  return readBack(ctx, lead.trim());
}

/** Say what will be booked, and wait for a yes. Nothing is written yet. */
function readBack(ctx: Ctx, lead = ''): TurnResult {
  const d = ctx.session.data;
  return say(
    ctx,
    'confirm_booking',
    (lead ? `${lead} ` : '') +
    T.fill(T.pick(ctx.L.READBACK, ctx.seed), {
      date: ctx.L.date(d.bookingDate!),
      time: ctx.L.time(d.dropSlot!),
      back: isSameDay(d.pool!, d.dropSlot!) ? ctx.L.back.same : ctx.L.back.next,
    }),
  );
}

/** E9 — write, decrement, SMS, a short "booked", then "Anything else?". */
function book(ctx: Ctx): TurnResult {
  const d = ctx.session.data;
  let created;
  try {
    created = createBooking(ctx.db, {
      vehicleId: d.vehicleId!,
      centreId: d.centreId,
      pool: d.pool!,
      bookingDate: d.bookingDate!,
      dropSlot: d.dropSlot!,
      complaintNote: [d.complaintNote, d.askedAbout?.length ? `Asked about: ${d.askedAbout.join(', ')}` : '']
        .filter(Boolean)
        .join('\n') || null,
      source: 'ai',
      now: ctx.now,
    });
  } catch (e) {
    // The cheap safety net: another channel took the slot, or the vehicle, mid
    // conversation. Both are real outcomes, not faults.
    if (e instanceof SlotFullError) {
      return routeOut(ctx, 'forced_full_day', T.pick(ctx.L.EXIT.forced_full_day, ctx.seed));
    }
    if (e instanceof DuplicateBookingError) {
      return routeOut(ctx, 'existing_open_booking', T.pick(ctx.L.EXIT.existing_open_booking, ctx.seed));
    }
    throw e;
  }

  smsForBooking(ctx.db, {
    bookingId: created.id,
    mobile: d.callerNumber,
    centre: ctx.centre,
    reference: created.reference,
    model: d.model!,
    date: created.bookingDate,
    dropSlot: created.dropSlot,
    expectedPickup: created.expectedPickup,
    now: ctx.now,
  });
  d.bookingReference = created.reference;

  let reply = T.pick(ctx.L.BOOKED, ctx.seed);

  // D12 — mention a second due vehicle. Mention only; it needs its own call.
  const others = otherDueVehicles(
    (d.vehicles ?? []).map((v) => ({
      id: v.id,
      model: v.model,
      registration_number: v.registration,
      due: v.due,
    })),
    d.vehicleId!,
    ctx.callDate,
  );
  if (others.length > 0) {
    reply += ` ${T.fill(T.pick(ctx.L.SECOND_VEHICLE, ctx.seed), { model: others[0]!.model })}`;
  }

  // Not goodbye yet: the caller may have something else (wrap_up).
  reply += ` ${T.pick(ctx.L.ANYTHING_ELSE, ctx.seed)}`;
  return { ...say(ctx, 'wrap_up', reply), bookingReference: created.reference };
}

