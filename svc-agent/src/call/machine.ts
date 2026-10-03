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
import type { Classifier } from './classifier.ts';
import { TableKnowledgeBank, type KnowledgeBank } from '../kb/index.ts';
import type { Crm } from './crm.ts';
import { appendTranscript, createSession, endSession, loadSession, saveSession, type Session } from './session.ts';
import { smsForBooking, smsForLead, type Centre } from './sms.ts';
import * as T from './templates.ts';
import type { CallState, SessionData, TurnResult } from './types.ts';

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
  const reply = T.fill(T.pick(T.GREETING, 0), {
    centre: centre.name,
    number: T.spokenNumber(callerNumber),
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
  const session = loadSession(db, sessionId);
  if (!session) throw new Error(`no session ${sessionId}`);
  if (session.state === 'ended') {
    return { sessionId, state: 'ended', reply: '', ended: true };
  }

  appendTranscript(db, sessionId, 'caller', utterance, now);
  const seed = seedOf(db, sessionId);
  const d = session.data;
  const callDate = today(new Date(d.startedAt));

  const ctx: Ctx = { db, deps, session, now, seed, callDate, centre: centreOf(db) };

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
  try {
    // "yes", "no", "morning", "4471" — roughly half a real call, and none of
    // it worth a second of network. The fast classifier answers those inline;
    // anything it is not certain about goes to the model (G7).
    const quick = deps.fast ? await deps.fast.classify(request) : undefined;
    cls = quick?.confident ? quick : await deps.classifier.classify(request);
  } catch {
    // The model timed out or errored. The caller must not hear a fault, and
    // the call must not drop — E0 says never "I didn't understand that", so we
    // ask the smaller question instead. Bounded by D11 like any other retry,
    // so a sustained outage routes out to a human rather than looping.
    const p = registerPushback(d.pushback);
    d.pushback = p.count;
    if (p.exhausted) {
      return routeOut(ctx, 'another_problem', T.pick(T.EXIT.another_problem, seed));
    }
    return answerAndResume(ctx, '');
  }
  d.lastCallerWords = cls.callerWords;

  // The always-on overlay (D9, D10) — answerable at ANY point, then we return
  // to exactly where the conversation was.
  if (cls.outOfBand === 'cost') {
    return answerAndResume(ctx, T.pick(T.COST_ANSWER, seed));
  }
  if (cls.outOfBand === 'general') {
    // The classifier chose from the dealer's own published topics, or said
    // none. D10: no match means no answer — never a near-enough row. The
    // question goes to the team and the call carries on with the booking.
    const answer = cls.kbKey ? kb.answerFor(cls.kbKey, callDate) : undefined;
    if (!answer) {
      passOn(ctx, cls.generalQuestion ?? utterance);
      return answerAndResume(ctx, T.pick(T.KB_PASSED, seed));
    }
    return answerAndResume(ctx, answer);
  }
  if (cls.intent === 'another_problem') {
    return routeOut(ctx, 'another_problem', T.pick(T.EXIT.another_problem, seed));
  }

  switch (session.state) {
    case 'greeting':
      return cls.yesNo === 'no'
        ? say(ctx, 'awaiting_number', T.pick(T.ASK_REGISTERED_NUMBER, seed), { digits: true })
        : identify(ctx, d.callerNumber);

    case 'awaiting_number': {
      const digits = utterance.replace(/\D/g, '');
      if (digits.length !== 10) {
        return say(ctx, 'awaiting_number', T.pick(T.ASK_REGISTERED_NUMBER, seed + 1), { digits: true });
      }
      d.otpCode = String(Math.floor(1000 + Math.random() * 9000));
      d.callerNumber = digits;
      // Logged rather than sent, same as every other message in the chat build.
      db.prepare(`INSERT INTO sms_log (mobile_number, body, created_at) VALUES (?, ?, ?)`).run(
        digits,
        `Your verification code is ${d.otpCode}`,
        timestamp(now),
      );
      return say(ctx, 'awaiting_otp', T.pick(T.ASK_OTP, seed), { digits: true });
    }

    case 'awaiting_otp': {
      if (utterance.replace(/\D/g, '') === d.otpCode) return identify(ctx, d.callerNumber);
      d.otpAttempts += 1;
      // Three failures ends the call, with the lead registered against the
      // caller ID we already hold (E1, F2 #1).
      if (d.otpAttempts >= 3) {
        return routeOut(ctx, 'number_not_found', T.pick(T.EXIT.number_not_found, seed));
      }
      return say(ctx, 'awaiting_number', T.pick(T.OTP_WRONG, seed), { digits: true });
    }

    case 'vehicle':
      return resolveVehicle(ctx, cls.vehicleModel, cls.vehicleLast4);

    case 'open_turn':
      if (cls.day) d.bookingDate = cls.day;
      if (cls.dropSlot) d.dropSlot = cls.dropSlot;
      // "Book it in as soon as you can" answers the day question before we
      // ask it, so don't then ask it (E7).
      if (cls.noPreference) d.noDayPreference = true;
      return afterIntent(ctx);

    case 'complaint':
      if (cls.complaint && !cls.nothing) {
        d.complaintNote = cls.complaint;
        // A complaint moves the job to the complaint pool (D8), and the
        // special-request question is skipped entirely.
        d.pool = poolFor(d.due!.service_type!, true);
        return askDay(ctx, T.pick(T.ACK_COMPLAINT, seed));
      }
      return say(ctx, 'special_request', T.pick(T.ASK_SPECIAL_REQUEST, seed));

    case 'special_request':
      if (cls.specialRequest && !cls.nothing) d.complaintNote = cls.specialRequest;
      return askDay(ctx);

    case 'day': {
      if (cls.dropSlot) d.dropSlot = cls.dropSlot;
      if (!cls.day) {
        // "Whenever suits you" is an answer, not a refusal — charging it a
        // pushback routed out a caller who was being easy to deal with.
        if (cls.noPreference) return offerFirstAvailable(ctx);
        const p = registerPushback(d.pushback);
        d.pushback = p.count;
        if (p.exhausted) return routeOut(ctx, 'forced_full_day', T.pick(T.EXIT.forced_full_day, seed));
        return say(ctx, 'day', T.pick(T.ASK_DAY.reask, seed));
      }
      return considerDay(ctx, cls.day);
    }

    case 'drop_slot': {
      // "Actually, make it Saturday." The schema now carries a date at this
      // turn, so a change of mind goes back through the same day checks
      // rather than being heard as silence.
      if (cls.day && cls.day !== d.bookingDate) return considerDay(ctx, cls.day);
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
        if (p.exhausted) return routeOut(ctx, 'forced_full_day', T.pick(T.EXIT.forced_full_day, seed));
        return say(ctx, 'drop_slot', reaskSlotLine(ctx));
      }
      // The caller can ask for a slot we have already said is gone — "only the
      // afternoon is free" followed by "morning's better". Check before
      // accepting, or the booking fails at the write and a caller who could
      // have been booked gets routed out instead.
      const { days } = windowAndDays(ctx);
      const day = days.find((x) => x.date === d.bookingDate);
      if (!day || !canTake(day, d.pool!, chosen)) {
        const p = registerPushback(d.pushback);
        d.pushback = p.count;
        if (p.exhausted) return routeOut(ctx, 'forced_full_day', T.pick(T.EXIT.forced_full_day, seed));
        const left = day ? dayOffer(day, d.pool!) : 'none';
        if (left === 'none') return considerDay(ctx, d.bookingDate!);
        return say(
          ctx,
          'drop_slot',
          T.fill(T.pick(T.SLOT_GONE, seed), {
            asked: chosen,
            left,
            day: T.spokenDay(d.bookingDate!),
          }),
        );
      }
      d.dropSlot = chosen;
      return maybeNudgeThenBook(ctx);
    }

    case 'confirm':
      // The same-day nudge, answered. Wanting it routes out — we cannot see
      // the workshop's real load, so we never invent a same-day slot (D7).
      if (cls.yesNo === 'yes') {
        return routeOut(ctx, 'same_day_demanded', T.pick(T.EXIT.same_day_demanded, seed));
      }
      d.sameDayNudgeDeclined = true; // never raise it again
      return book(ctx);

    default:
      return say(ctx, session.state, T.pick(T.OPEN_TURN, seed));
  }
}

// ---------------------------------------------------------------------------

type Ctx = {
  db: Database;
  deps: CallDeps;
  session: Session;
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
      return { text: T.fill(T.RESUME_CALLER_ID, { number: T.spokenNumber(d.callerNumber) }) };
    case 'awaiting_number':
      return { text: T.pick(T.ASK_REGISTERED_NUMBER, seed), digits: true };
    // Re-prompt only; a fresh code would invalidate the one they are holding.
    case 'awaiting_otp':
      return { text: T.pick(T.ASK_OTP, seed), digits: true };
    case 'vehicle':
      return { text: T.pick(T.VEHICLE_ASK.reask, seed) };
    case 'complaint':
      return { text: T.pick(T.ASK_COMPLAINT.reask, seed) };
    case 'special_request':
      return { text: T.pick(T.ASK_SPECIAL_REQUEST, seed) };
    case 'day':
      return { text: T.pick(T.ASK_DAY.ask, seed) };
    case 'drop_slot':
      return { text: offerSlotLine(ctx) };
    case 'confirm':
      return { text: T.pick(T.SAME_DAY_NUDGE, seed) };
    default:
      return { text: T.pick(T.OPEN_TURN, seed) };
  }
}

/** Answer something out of band, then pick the conversation back up. */
function answerAndResume(ctx: Ctx, answer: string): TurnResult {
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

/** Every routed exit: lead, SMS, end. One path, so none can skip a step (F2). */
function routeOut(ctx: Ctx, reason: LeadReason, reply: string): TurnResult {
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

  d.leadReason = reason;
  ctx.session.state = 'ended';
  endSession(ctx.db, ctx.session, ctx.now);
  appendTranscript(ctx.db, ctx.session.id, 'agent', reply, ctx.now);
  return { sessionId: ctx.session.id, state: 'ended', reply, ended: true, leadReason: reason };
}

/** E5 — the CRM lookup is prefetched here, at identification, not later. */
async function identify(ctx: Ctx, mobile: string): Promise<TurnResult> {
  const d = ctx.session.data;
  const account = await ctx.deps.crm.findByMobile(mobile);
  if (!account) {
    return routeOut(ctx, 'number_not_found', T.pick(T.EXIT.number_not_found, ctx.seed));
  }

  d.customerId = account.customerId;
  d.customerName = account.name;
  d.vehicles = account.vehicles;

  // Nothing on the account. Asking "which one?" invites an answer that cannot
  // exist, and a model_not_recognised lead would blame the caller for a record
  // that is simply incomplete (D3).
  if (account.vehicles.length === 0) {
    return routeOut(ctx, 'missing_required_field', T.pick(T.EXIT.missing_required_field, ctx.seed));
  }

  // E2 — one vehicle: state it, don't ask.
  if (account.vehicles.length === 1) {
    const v = account.vehicles[0]!;
    setVehicle(ctx, v.id);
    const line = T.fill(T.pick(T.VEHICLE_SINGLE, ctx.seed), { model: v.model });
    return say(ctx, 'open_turn', `${line} ${T.pick(T.OPEN_TURN, ctx.seed)}`);
  }
  return say(ctx, 'vehicle', T.pick(T.VEHICLE_ASK.ask, ctx.seed));
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
function resolveVehicle(ctx: Ctx, model?: string, last4?: string): TurnResult {
  const d = ctx.session.data;
  const vehicles = d.vehicles ?? [];

  // Nothing to match on at all is a non-answer, not a failed match — narrow
  // the question once (E0) rather than ending the call on a mumble.
  if (!model && !last4) {
    const p = registerPushback(d.pushback);
    d.pushback = p.count;
    if (p.exhausted) {
      return routeOut(ctx, 'model_not_recognised', T.pick(T.EXIT.model_not_recognised, ctx.seed));
    }
    return say(ctx, 'vehicle', T.pick(T.VEHICLE_ASK.reask, ctx.seed));
  }

  const passes = [
    vehicles.filter((v) => model && last4 && v.model.toLowerCase() === model.toLowerCase() && v.registration.endsWith(last4)),
    vehicles.filter((v) => last4 && v.registration.endsWith(last4)),
    vehicles.filter((v) => model && v.model.toLowerCase() === model.toLowerCase()),
  ];
  const hit = passes.find((p) => p.length === 1)?.[0];

  if (!hit) {
    return routeOut(ctx, 'model_not_recognised', T.pick(T.EXIT.model_not_recognised, ctx.seed));
  }
  setVehicle(ctx, hit.id);
  return say(ctx, 'open_turn', T.pick(T.OPEN_TURN, ctx.seed));
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
    return routeOut(ctx, 'existing_open_booking', T.pick(T.EXIT.existing_open_booking, ctx.seed));
  }

  // E5 — the D2/D3 blockers fire here, on the prefetched CRM record.
  const assessment = assessBookability(d.due, ctx.callDate);
  if (!assessment.bookable) {
    return routeOut(ctx, assessment.reason, T.pick(T.EXIT[assessment.reason], ctx.seed));
  }
  d.pool = poolFor(assessment.serviceType, false);

  const due = d.due!;
  const stated = T.fill(
    T.pick(due.due_date ? T.SERVICE_DUE_WITH_DATE : T.SERVICE_DUE_NO_DATE, ctx.seed),
    {
      model: d.model!,
      ordinal: ordinalWord(due.service_number),
      pool: assessment.serviceType,
      dueDay: due.due_date ? T.spokenDate(due.due_date) : '',
    },
  );
  return say(ctx, 'complaint', `${stated} ${T.pick(T.ASK_COMPLAINT.ask, ctx.seed)}`);
}

function ordinalWord(n: number): string {
  return (
    ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'][n] ??
    `${n}th`
  );
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
function askDay(ctx: Ctx, ack?: string): TurnResult {
  const d = ctx.session.data;
  const lead = ack ? `${ack} ` : '';
  if (d.bookingDate) return considerDay(ctx, d.bookingDate, lead);
  if (d.noDayPreference) return offerFirstAvailable(ctx, lead);
  return say(ctx, 'day', `${lead}${T.pick(T.ASK_DAY.ask, ctx.seed)}`);
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
      T.pick(T.EXIT.nothing_available_30_days, ctx.seed),
    );
  }
  const named = T.fill(T.pick(T.FIRST_AVAILABLE, ctx.seed), { date: T.spokenDate(first.date) });
  return considerDay(ctx, first.date, `${lead}${named} `);
}

/** D5 and D6 together: is this day in the window, and can it take the job? */
function considerDay(ctx: Ctx, requested: IsoDate, lead = ''): TurnResult {
  const d = ctx.session.data;
  const { w, days } = windowAndDays(ctx);
  const offer = offerForDate(days, requested, d.pool!, w);

  if (offer && offer !== 'none') {
    d.bookingDate = requested;
    return say(ctx, 'drop_slot', `${lead}${offerSlotLine(ctx, offer)}`);
  }

  // Nothing at all in the whole window is the loudest alarm in the system (F3).
  const bookable = findBookable(days, d.pool!, w);
  if (bookable.length === 0) {
    return routeOut(ctx, 'nothing_available_30_days', T.pick(T.EXIT.nothing_available_30_days, ctx.seed));
  }

  // D11 — forcing a full day more than three times routes out.
  const p = registerPushback(d.pushback);
  d.pushback = p.count;
  if (p.exhausted) {
    d.bookingDate = requested;
    return routeOut(ctx, 'forced_full_day', T.pick(T.EXIT.forced_full_day, ctx.seed));
  }

  // D6 — offer the next two available days, naming the slot where only one is
  // open. Two, never a list: E0 allows at most two options a turn.
  const alts = nextTwoAvailable(days, d.pool!, w, requested);
  const label = (a: { date: IsoDate; offer: string }) =>
    a.offer === 'both' ? T.spokenDate(a.date) : `${T.spokenDate(a.date)} ${a.offer}`;

  const reply =
    alts.length >= 2
      ? T.fill(T.pick(T.DAY_FULL_OFFER_TWO, ctx.seed), {
          day: T.spokenDay(requested),
          alt1: label(alts[0]!),
          alt2: label(alts[1]!),
        })
      : T.fill(T.pick(T.DAY_FULL_OFFER_ONE, ctx.seed), {
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
    return T.fill(T.pick(T.DAY_ONE_SLOT, ctx.seed), { day, slot: offer });
  }
  const am = isSameDay(d.pool!, 'morning');
  const pm = isSameDay(d.pool!, 'afternoon');
  const pool = am && pm ? T.SLOT_BOTH_SAME_DAY : !am && !pm ? T.SLOT_BOTH_NEXT_DAY : T.SLOT_BOTH;
  return T.fill(T.pick(pool, ctx.seed), { day });
}

/** The narrowed second ask, so the same sentence never comes back twice (E0). */
function reaskSlotLine(ctx: Ctx): string {
  const offer = slotOffer(ctx);
  const day = T.spokenDay(ctx.session.data.bookingDate!);
  return offer === 'morning' || offer === 'afternoon'
    ? T.fill(T.pick(T.SLOT_REASK_ONE, ctx.seed), { day, slot: offer })
    : T.fill(T.pick(T.SLOT_REASK_BOTH, ctx.seed), { day });
}

/** D7 — offer the same-day nudge once, where delivery lands on the next day. */
function maybeNudgeThenBook(ctx: Ctx): TurnResult {
  const d = ctx.session.data;
  if (!d.sameDayNudgeDeclined && shouldOfferSameDayNudge(d.pool!, d.dropSlot!)) {
    return say(ctx, 'confirm', T.pick(T.SAME_DAY_NUDGE, ctx.seed));
  }
  return book(ctx);
}

/** E9 — write, decrement, SMS, one recap sentence. Name used once, here. */
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
      complaintNote: d.complaintNote ?? null,
      source: 'ai',
      now: ctx.now,
    });
  } catch (e) {
    // The cheap safety net: another channel took the slot, or the vehicle, mid
    // conversation. Both are real outcomes, not faults.
    if (e instanceof SlotFullError) {
      return routeOut(ctx, 'forced_full_day', T.pick(T.EXIT.forced_full_day, ctx.seed));
    }
    if (e instanceof DuplicateBookingError) {
      return routeOut(ctx, 'existing_open_booking', T.pick(T.EXIT.existing_open_booking, ctx.seed));
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

  const sameDay = isSameDay(d.pool!, d.dropSlot!);
  let reply = T.fill(T.pick(sameDay ? T.CONFIRM_SAME_DAY : T.CONFIRM_NEXT_DAY, ctx.seed), {
    date: T.spokenDate(created.bookingDate),
    time: T.spokenDropTime(created.dropSlot),
  });

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
    reply += ` ${T.fill(T.pick(T.SECOND_VEHICLE, ctx.seed), { model: others[0]!.model })}`;
  }

  // G3.8 — the caller's name, once, at the end.
  reply += ` ${T.fill(T.pick(T.SIGN_OFF, ctx.seed), {
    name: (d.customerName ?? '').split(' ')[0] ?? '',
    day: T.spokenDay(created.bookingDate),
  })}`;

  ctx.session.state = 'ended';
  endSession(ctx.db, ctx.session, ctx.now);
  appendTranscript(ctx.db, ctx.session.id, 'agent', reply, ctx.now);
  return {
    sessionId: ctx.session.id,
    state: 'ended',
    reply,
    ended: true,
    bookingReference: created.reference,
  };
}

