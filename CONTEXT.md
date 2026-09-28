# AI Service Booking Agent — Full Project Context (v3)

> Complete handover. Supersedes v2 (2026-08-26) and `Prev Chat Context.md`.
>
> **Updated 2026-09-06.** The 5–6 September session closed **every** open
> question in the old PART J and made three decisions that changed the shape of
> the build:
>
> 1. **The dealer has no bay or capacity management system**, so we build it and
>    both apps share one table. No sync, no batch, no second ledger. This
>    replaced the whole walk-in contention argument in D4.
> 2. **A minimal dealer backend + frontend ships first** — it owns the data the
>    call app consumes, and it is the demo's persuasive moment.
> 3. **B3 is amended** — see below. It is no longer an absolute.
>
> **Step 1 is built and verified in this repo** (`svc-agent/`) — schema, seed,
> date arithmetic, booking references, 36 passing tests. See PART I, which has
> been rewritten; the old PART I described code that no longer exists.
>
> Sections carrying decisions from that session are marked **[Sep-06]**.

---

# PART A — The product

## A1. What this is

An AI phone agent for a **car dealer service centre**. It answers incoming
customer calls, identifies the caller, confirms their vehicle, tells them what
service is due (from the dealer's CRM), books a slot, and confirms by SMS.
Anything it cannot handle becomes a routed lead for a human.

**Version 1 is chat-only.** The whole flow runs as text. **Voice is the USP**
and the main focus — every turn must be designed as if spoken, even in v1.

## A2. Commercial context

Target buyers are multi-location dealer service centres, service franchises and
dealer groups — high call volume, standard queries, a countable cost per missed
call.

Indicative pricing: ₹40,000–1,20,000 setup, ₹8,000–25,000/month retainer.
First two clients at ₹15,000–20,000 to buy case studies.

---

# PART B — Non-negotiable design principles

## B1. The code drives the flow, not the LLM
A deterministic state machine. Our code decides what happens next at every step.

## B2. The LLM only interprets what the caller said
Narrow classification questions with a known candidate set, returning small
structured JSON. Never open-ended understanding, never business rules, never
prose.

## B3. Minimise customer data reaching the LLM  **[Sep-06 — amended]**

The rule was *"no customer data leaves our system."* That was not literally
true, so it has been amended to something we can actually hold to:

1. **Never send database records to the LLM.** No names, mobile numbers,
   registration numbers, service history or booking references are ever passed
   from our tables into a prompt.
2. **Redact known identifiers from free text before sending.** By the time we
   classify a complaint we already hold this caller's name, mobile,
   registration and model — strip those exact strings from the utterance first.
   Asserted by test.
3. **Accept residual identifiers in a caller's own words.** Redaction cannot
   catch a caller naming their spouse or their street. That's the honest limit.

Everything the agent *says* is still templated in our code with values
interpolated from the database. The LLM never writes prose.

**Why the wording matters commercially.** The pitch changes from *"nothing about
your customers ever leaves"* — which fails a dealer's IT audit — to **"we never
send your customer records to a third party"**, which is still a strong wedge
(H4) and is true.

**The transcript is never sent to an LLM.** A proposal to generate report
summaries that way was rejected: the summary is rendered from the **session
state we already maintain** (F4). The report carries that summary, the
structured fields, and the raw transcript — the dealer reading their own
customer's call is not egress.

---

# PART C — Data model

**[Sep-06 — built.]** 13 tables, one SQLite file shared by both apps. The v2
schema and its C1 change-list are superseded: the changes were built in rather
than migrated onto, so none of the old defects (PART I) exist. Source of truth
is `svc-agent/src/db/schema.sql`.

### Dealer-owned — the call app reads these over HTTP

**`centres`** — id, name, landline, opens_at, closes_at *(hours are knowledge-bank data only; they never gate a booking)*
**`customers`** — id, mobile_number UNIQUE, name, created_at
**`vehicles`** — id, customer_id FK, registration_number UNIQUE, model, purchase_date
**`service_due`** — vehicle_id PK/FK, service_number, service_type *(nullable)*, is_free, due_date *(nullable)*
**`knowledge_bank`** — id, centre_id FK, question_key, answer_text. Unique on (centre_id, question_key)

`service_due` **replaces `service_history` entirely.** Service-due comes from the
CRM (D1); we never derive it. One row per vehicle = the next due service.

### Capacity — ours, central, shared by both apps

**`capacity_master`** — weekday 0–6 × service_type × drop_slot, total_slots. Unique on all three. **42 rows**, rendering as the 7×6 grid in the dealer UI.
**`slot_capacity`** — id, centre_id, date, service_type, drop_slot, total_slots, booked_slots. Unique on (centre_id, date, service_type, **drop_slot**). Generated 30 days forward from the master. Carries `CHECK (booked_slots >= 0 AND booked_slots <= total_slots)`.

### Call-app owned

**`bookings`** — id, booking_reference UNIQUE, vehicle_id, centre_id, service_type, booking_date, drop_slot, expected_pickup, complaint_note, status, **source** (`ai`|`dealer`), created_at
**`booking_counter`** — centre_id, date, last_seq. PK (centre_id, date)
**`leads`** — id, mobile_number, reason *(CHECK, nine values)*, customer_id, vehicle_registration, vehicle_model, requested_date, requested_slot, requested_pool, crm_snapshot, caller_words, session_id, created_at
**`sessions`** — id, state, data, started_at, updated_at, ended_at
**`transcripts`** — id, session_id FK, turn_index, speaker, text, created_at. Unique on (session_id, turn_index)
**`sms_log`** — id, booking_id, lead_id, mobile_number, body, created_at

`source` on `bookings` lets the demo show the AI and dealer channels on one
table. The old `pickup_when` is gone — `expected_pickup` is the EDD.
`transcripts` is separate from `sessions` so the 45-day purge is one `DELETE`.

## C1. One database, two boundaries  **[Sep-06]**

Capacity is **permanently ours** — the dealer has no bay management system, so
there is nothing to integrate with and nothing to reconcile. The call app writes
it directly with the conditional `UPDATE`.

Vehicle and service-due data is **the dealer's**, and one day will be a real
integration. So the call app reads it **over HTTP from the dealer app** even
though the two share a database file. That keeps the CRM boundary real and
swappable rather than a fiction we'd have to unpick.

## C2. Why capacity is per day per type, not per clock slot

Real dealer centres work this way — you're told to come Tuesday morning, not at
10:40. Clock slots would mean bay constraints, technician skills and parts
availability: months of work, no more convincing as a demo.

---

# PART D — Business rules

## D1. Service due — NOT our calculation
The account/CRM lookup returns the vehicle **and** the next due service:
service number, free/paid, minor/major, and the due date. We never derive it
from service history. The customer is **never** asked to confirm the type — the
advisor corrects details later.

## D2. Due date rules
- The due date **can be NULL** (e.g. vehicle serviced outside the network).
  If null, do not state it.
- **Null + free service** → no booking. Route to call centre to make contact and
  update records.
- **Null + paid service** → book normally.
- **Free service more than 60 days overdue** (due date 60+ days before the call
  date) → no booking, route to call centre. Free services only, not paid.
- **A due date in the future is not a blocker.** A caller whose service is due in
  six months can still book now. The due date is informational.

## D3. Required fields for booking creation
If the service **type** (minor/major) is null, **do not create a booking.**

Required: account, registration, model, service type, free/paid flag, booking
date, drop slot, centre.
Not required: next due date.

Missing any → tell the caller to ring the centre, send the SMS, end the call,
and raise a CRM/data lead **naming the field that was missing**.

## D4. Capacity  **[Sep-06 — rewritten]**
- A **weekday master**: weekday × {minor, major, complaint} × {morning,
  afternoon} = 42 rows, rendered as a 7×6 grid in the dealer UI.
- The master is set **net of expected walk-in load**. If a day has 6 major bays
  and ~2 go to walk-ins, the master says 4.
- **One central table, shared by both channels.** The dealer has no bay or
  capacity management system today, so we build it and their staff use our
  screen. There is no second ledger, no sync, and **no batch job** — an earlier
  design that polled the dealer's system every 10 minutes was dropped once it
  became clear there was nothing to poll.
- This also **retires the old walk-in contention argument.** v2 reasoned that
  we book in advance while their call centre books same-day, so we never compete
  for the same rows. That assumption is no longer load-bearing: both channels
  now decrement the same row, so contention is impossible by construction rather
  than by agreement.
- **Overbooking is blocked at the write.** Conditional update:
  `UPDATE ... WHERE booked_slots < total_slots`, assert `changes === 1`. Never
  read-then-increment. A `CHECK (booked_slots <= total_slots)` backs it up at
  the table, so code that bypasses the conditional update still cannot oversell.
- Because the table is shared, that single guard now protects against the
  dealer's own bookings too.

## D5. Booking window
- Earliest bookable day is **tomorrow**. Never today.
- Latest is **30 days** ahead.
- The **call start time** decides what "tomorrow" means (a call started before
  23:59 on 26 Aug can book 27 Aug, even if it finishes after midnight).
- The centre is **open 7 days**, no leaves, **no holidays at all**. Finding the
  next available day is a plain walk forward — no calendar skipping.
- **Nothing free in the whole 30-day window** → route to call centre.

## D6. Day and slot selection
- A day counts as available if **either** slot has room.
- If only one slot is free, the agent **states it** rather than asking
  ("only the afternoon is free on Thursday").
- If a day is full, offer the **next two available days**, naming the slot where
  only one is open.
- If the caller insists on a full day, do not book — give the landline.

## D7. Drop-off and delivery (EDD)
Drop-off: **morning 8:30**, **afternoon 2:00**.

**EDD** = Expected Date of Delivery = the date the **customer picks the vehicle
up after service**. It is **our computed output**, not a CRM field.

| service type | drop slot | delivery |
|---|---|---|
| minor | morning | same day, evening |
| minor | afternoon | same day, evening |
| major | morning | **same day, evening** |
| major | afternoon | next day |
| complaint | morning | next day |
| complaint | afternoon | next day |

Delivery is **always an estimate**, phrased as one:
*"they'll confirm once they've had a proper look at it."*
A missed promise gets blamed on the AI; no dealer will underwrite a hard
commitment made by a machine.

**Same-day nudge:** where the booking lands on next-day delivery, the agent
proactively mentions that same-day is worth asking the centre about. If the
caller wants it → route to the call centre (we cannot see the workshop's real
workload, so we never invent a same-day slot). If the caller declines → never
raise it again.

## D8. Complaints and special requests
- **Two separate explicit questions.** Complaint first. If a complaint is given,
  **skip** the special-request question. If not, ask it.
- A **complaint** moves the booking into the **complaint pool** — longer job,
  next-day delivery either way.
- A **special request** does **not** change the pool. Note only.
- **The LLM classifies** which of the two the caller's answer actually is.
- **One note field.** If both somehow arrive, write them on consecutive lines.

## D9. Cost questions
Answerable at **any point** in the flow, not just where "paid" is stated.
Templated answer: cost depends on the vehicle, and the service advisor provides
an estimate after examination. **No number is ever given on the call.**

## D10. General questions
Opening hours, location and similar are answered from a **per-dealer knowledge
bank** — org-specific data, no customer data, so B3-safe. Answer, then **return
to exactly where the conversation was** (same pattern as the cost answer).

**[Sep-06] If the bank has no answer, end the call.** Never guess, never give a
wrong answer. The exit writes an `another_problem` lead to customer care and
sends the SMS, so a human calls back with the real answer.

*Recorded consequence:* this can end a call that was one turn from a confirmed
booking — someone mid-flow asking about the waiting area gets hung up on. That
cost lands on **booking completion rate**, the metric H5 says settles the whole
IVR argument. Worth watching once there's live traffic: if the reports show
bookings dying on trivia, narrow the rule to "end only when the caller refuses
to proceed without the answer."

**The LLM never answers from its own knowledge.** It only matches the question
to a bank entry or reports no match — B2. An agent confidently inventing a
courtesy car is worse than any routing exit in the system.

## D11. Pushback limit
Anything the caller forces **more than three times** → route to the service
centre. Applies to all forcing, not just day choice.

## D12. One call = one booking = one vehicle
Once model + last-4 confirm a single vehicle, that is the vehicle for this call.
**Other vehicles on the same account require a separate call.**

**[Sep-06] Decided: mention a second due vehicle at the close.** *"Your Creta's
also due, give us a call for that one."* Mention only — never book it. Respects
the one-vehicle rule, costs one sentence, and is a genuine upsell the dealer
wants rather than a booking we walk past.

## D13. Open bookings
An open booking is an open booking — **no date condition**. A stale/no-show
booking keeps blocking that vehicle. Dealers maintain sanity on their side.

## D14. Out-of-hours
**No special handling.** The drop time is stated anyway. The old rule about the
SMS stating opening time is dropped.

## D15. Dropped rules
- **Duration is never returned or stated.** The old *"that's about two hours"*
  line is cut — it contradicted the delivery estimate and had no data source.
- **Sundays closed** — dead. The centre is open 7 days.

---

# PART E — The conversation flow

## E0. Standing rules at every turn
- One question per turn, never more than two options, **question last** in the
  sentence.
- **Acknowledge before answering** — "Right", "Got it", "Okay".
- Templates are **pools of 3–5 phrasings**, selected by code (see F3).
- **Never repeat a prompt verbatim** on a re-prompt — rephrase *and* narrow it.
- **Never say "I didn't understand that."** Ask the smaller question instead.
- **Barge-in supported throughout** — an answer can arrive before the question
  finishes playing.
- Max ~2 sentences per turn.

## E1. Greeting and identification
Centre name, **AI disclosure in one clause**, then the caller-ID shortcut:

> *"Voltas Motors service, Sector 44. I'm an automated assistant — I can book you
> in or take a message for the team. You're calling from 98100 11001 — is that the
> number the car's registered under?"*

- **Yes** → proceed, **no OTP**. Calling from that SIM already proves possession.
  Most callers land here and never touch a keypad.
- **No** (different phone) → they enter their registered mobile number → OTP.

**OTP mechanics:**
- **Keypad (DTMF) only** for the registered mobile number and the OTP. Chosen
  for accuracy. Framing matters: *"tap in the number the car's registered under
  and I'll send a quick code to check it's you"* — not *"please enter your
  ten-digit mobile number"*.
- **4 digits**, auto-continues on the fourth digit (no submit key).
- **Reminder at 15 s**, **resend offered at 45 s**. One resend per attempt, max
  3 per call. **A resend kills the previous code.** Validity **5 minutes**.
- **Wrong code** → say so, return to number entry, **consumes one of 3 attempts**.
- **3 failed attempts** → end the call, and **register a lead against the caller
  ID we already hold**.
- **Rate limit:** after a failed OTP verification, max **3 calls per hour** from
  that number, then blocked.

*(Timings were reasoned for chat. On a live call, 15 s of silence reads as a
dropped line — expect to want ~10 s and ~30 s. Measure, don't change on paper.)*

## E2. Vehicle confirmation
- **One vehicle** → state it, don't ask: *"so this is about the Nexon?"*
- **More than one** → ask for **both the model name and the last 4 digits of the
  registration** in one turn.
- **[Sep-06] Both are spoken, never keypad.** DTMF now exists in exactly one
  place in the whole call — the registered mobile number and the OTP, on the
  "different phone" branch only. The keypad never interrupts mid-conversation.
- **Matching cascade — three passes over the one answer**, not three re-asks:
  model + last-4 together → last-4 alone → model alone. Registration outranks
  model (four digits discriminate better than "Swift").
- **[Sep-06] If all three passes fail, end the call** — "cannot identify the
  vehicle". Writes the `model_not_recognised` lead and sends the centre-details
  SMS, like every other exit. **Do not loop.**

*Indian plates end in four digits, so the last four are speech-friendly.*

## E3. The open turn
> *"How can I help?"*

This replaces the old closed fork ("book a service, or another problem?"). It is
the turn that separates this from a phone tree.

Whatever comes back is classified for **intent** (booking / another problem) and
**mined for slots**: day, drop slot.

*"I need to get the Nexon serviced, Thursday if you've got something"* fills
several fields at once, and none of them get asked again.

**Never silently accept an extracted slot.** Confirm all captured slots in **one
line**; if wrong, re-ask only that slot. Nothing is lost versus asking.

**"Another problem"** is the escalation hatch — angry caller, car won't start,
roadside assistance. Captured in their own words, lead to customer care, human
calls back. No triage, no attempt to solve it.

## E4. Duplicate booking check
As soon as **booking intent is established** — right after the open turn, before
asking about complaints or days — check for an open booking on that registration
+ account.

**This must not be deferred to the write.** Taking the caller through the
complaint question, the day and the slot, quoting a delivery date, and *then*
rejecting them would be a worse call than an IVR gives.

**[Sep-06] Confirmed: at intent, not at the write.** If one exists → tell the
caller it's open, give the centre's number, write the `existing_open_booking`
lead to reception, send the SMS, and **end the call**. Never create a second.

*Cheap safety net: re-check at write time, to close the race where another
channel books that vehicle during the conversation.*

## E5. State what's due
One CRM call returns service number, free/paid, minor/major, due date. The agent
states it.

**Prefetch this at identification**, not here — if the CRM takes 2–3 seconds the
caller otherwise hears dead air at the exact moment they've just spoken.

The three blockers in D2 and D3 fire here.

## E6. Complaint, then special request
Phrased as a person asks it:

> *"Before I book it — is there anything actually wrong with the car? Any noise,
> a warning light, something not working properly?"*

*"Do you have any complaints?"* is a survey question; nobody answers it
accurately.

## E7. Day
Per D5 and D6.

## E8. Drop slot and delivery
Offered as two **outcomes**, not two menu options:

> *"Thursday I can do morning or afternoon. Morning, you drop at 8:30 and have it
> back the same evening. Afternoon's a 2 o'clock drop and you'd get it the next
> day."*

## E9. Confirm and close
Write the booking, decrement capacity under the conditional update, generate the
reference, send the SMS. **One recap sentence, not a field-by-field readback.**
Use the caller's name **once**, here at the end.

## E10. Reference call script (the agreed shape)

> **Agent:** Voltas Motors service, Sector 44. I'm an automated assistant — I can
> book you in or take a message for the team. You're calling from 98100 11001 — is
> that the number the car's registered under?
> **Caller:** Yeah, that's right.
> **Agent:** Great. How can I help?
> **Caller:** I need to get the Nexon serviced. Thursday if you've got something.
> **Agent:** Right, let me pull that up… Your Nexon's due its fourth service —
> that's a major one, it was due on the 28th. Let me check Thursday for you.
> **Agent:** Thursday's open. Before I book it — is there anything actually wrong
> with the car? Any noise, a warning light, something not working properly?
> **Caller:** No, it's fine.
> **Agent:** Good. Anything you'd like them to do while it's in — a wash, interior
> clean, that sort of thing?
> **Caller:** No.
> **Agent:** Okay. Thursday I can do morning or afternoon. Morning, you drop at
> 8:30 and have it back the same evening. Afternoon's a 2 o'clock drop and you'd
> get it the next day.
> **Caller:** Morning's better.
> **Agent:** Done. Thursday the 27th, drop at 8:30, back the same evening — they'll
> confirm that once they've had a proper look at it. I'm texting you the booking
> reference and the workshop's direct number now. Anything else, Rohit?
> **Caller:** No, that's it.
> **Agent:** Thanks for calling. See you Thursday.

---

# PART F — Supporting pieces

## F1. The SMS
Sent on every booking, re-sendable on request. Contains: booking reference,
vehicle model, date, drop-off time, **expected** delivery, and **the centre's
landline**. The landline routes follow-up questions to a human rather than back
to the AI.

**Every "call the service centre" outcome also sends an SMS** carrying the centre
details.

For the chat build, **log what the SMS would say** rather than integrating a
provider.

### The booking reference  **[Sep-06]**

**`YYMMDD-NNNNN`** — the date of the *call*, then a sequence per centre per day
starting at `00000`. So the first booking taken on 6 September is `260906-00000`.

- **Digits only**, so it survives being read down a workshop phone line. An
  alphanumeric code carries the `0`/`O` and `1`/`I` confusions; this doesn't.
- The sequence is drawn with a conditional `UPDATE ... RETURNING` against
  `booking_counter`, **never `COUNT(*)`**, which would hand the same reference
  to two simultaneous bookings.
- It is **enumerable by design** — `260906-00001` implies `260906-00000` exists.
  That is safe only because **a reference alone never retrieves a booking**: any
  lookup requires reference **plus** the registered mobile. Keep that rule
  whenever a lookup endpoint is added.
- **The agent never reads it aloud.** It goes in the SMS only — spelling a code
  down the phone is exactly the texture G5 warns will leak the IVR feel. E10 has
  this right: *"I'm texting you the booking reference."*

## F2. The nine routing outcomes → leads  **[Sep-06 — resolved]**

*v2's heading said nine over a list of ten. Resolved by **merging** the two
free-service cases, so it is now genuinely nine.* These are the exact values of
the `leads.reason` CHECK constraint:

| # | `reason` | fires when |
|---|---|---|
| 1 | `number_not_found` | 3 failed OTP attempts — registered against the caller ID |
| 2 | `model_not_recognised` | vehicle cascade exhausted (E2) |
| 3 | `missing_required_field` | a required booking field is null (D3) |
| 4 | `another_problem` | the open-turn escalation — **and a knowledge-bank miss** |
| 5 | `free_service_not_bookable` | free service 60+ days overdue **or** with a null due date |
| 6 | `existing_open_booking` | duplicate check hit (E4) |
| 7 | `forced_full_day` | 3× pushback on a full day (D11) |
| 8 | `nothing_available_30_days` | window exhausted |
| 9 | `same_day_demanded` | caller insisted on same-day delivery (D7) |

**On the merge:** the two free-service cases share a trigger and a report, so
they became one reason. Nothing is lost — the retention report splits them on
`due_date IS NULL`, which still gives the team two lists with two different
scripts: a **chase call** for the overdue customer, and a **record-fix and
win-back** for the one whose car was serviced outside the network.

**The OTP rate-limit block folds into #1.** A caller capped at 3 calls/hour has
already produced that lead on their first failure; the CRM team has the number.

**Each lead carries:** caller number; customer name/account; vehicle registration
and model; what they were trying to do (requested date, slot, pool); CRM facts
frozen at call time; the caller's own words; call date and time; link to the
transcript.

## F3. Seven reports
**Rule: a lead type appears in exactly one report.** A lead in two reports is a
lead nobody owns.

| Report | Contents | Why it matters to them |
|---|---|---|
| **Customer care** | Another problem | Most urgent. Breakdowns and grievances. |
| **Retention / marketing** | `free_service_not_bookable`, split on `due_date IS NULL` into *chase* and *record-fix / win-back* | Highest commercial value — customers who *tried to book* and were turned away. This is the report that pays for the retainer. |
| **Service manager** | Forced day · nothing in 30 days · same-day demanded | Capacity vs demand. "Nothing in 30 days" is the loudest alarm in the system. |
| **CRM / data team** | Number not found · model not recognised · missing field | Data quality. Left alone, these make the agent fail for that customer every time. |
| **Reception** | Existing open booking | Operational. A rising count means nobody is closing completed bookings. |
| **Bookings — arrivals** | Every booking with `booking_date` = today, whatever day it was made | Reception's working document for receiving cars. |
| **Bookings — activity** | Everything booked in the previous day's window | The management number. |

**Cadence:** daily snapshots of the **previous day** (a report issued 27 Aug
covers 26 Aug 00:00–23:59). Only leads created that day appear. **No persistence,
no status tracking** — nobody marks a lead closed in our system.

**[Sep-06] Generated on demand, no scheduler.** Since nothing is persisted and
nothing is status-tracked, a report is just a date-filtered query
(`GET /reports/:audience?date=`). No cron job.

## F4. Call summary — the B3 resolution
The summary is **not LLM-generated**. We **render the session state we already
maintain** as the summary: code-assembled from the slots we hold, plus the
caller's raw quoted words where free text was captured.

This keeps B3 intact, removes hallucination risk entirely, and is faster and
cheaper. Reports carry: the **state-derived summary**, the **structured
fields**, and the **complete raw transcript**.

**[Sep-06] Transcripts are stored in our system and retained for 45 days.**
They are held in `transcripts`, separate from `sessions`, so the purge is one
`DELETE`. **No LLM ever reads a transcript** — showing the dealer their own
customer's call is not data egress; sending it to a third-party API would be.

## F5. API surface
Conversation state lives **server-side**, keyed on a session ID — which vehicle,
which pool, which day, which state, **and the pushback counter** (the 3-attempt
rule cannot work without it). The voice layer inherits it unchanged.

**[Sep-06] Split across the two apps**, per C1's two boundaries.

**Dealer app** — the swappable CRM boundary, plus the capacity it owns:

| endpoint | purpose |
|---|---|
| `GET /crm/vehicle/:registration` | vehicle + owner lookup |
| `GET /crm/service-due/:vehicleId` | → service number, type, free/paid, due date (no duration) |
| `GET`/`PUT /capacity/master` | the 7×6 weekday grid |
| `POST /capacity/regenerate` | rebuild `slot_capacity` 30 days forward |
| `POST /bookings` *(`source: 'dealer'`)* | the dealer's own channel — proves contention on the shared table |
| `GET /reports/:audience?date=` | the seven reports, on demand |

**Call app:**

| endpoint | purpose |
|---|---|
| `POST /identify` | mobile → customer + vehicles, or not-found |
| `POST /verify-otp` | OTP check, attempt counting, rate limit |
| `GET /slots` | centre + date range + pool + drop slot → availability |
| `GET /bookings/open/:registration` | duplicate check |
| `POST /bookings` *(`source: 'ai'`)* | create, decrement capacity conditionally, return reference |
| `POST /bookings/:id/resend-sms` | re-trigger confirmation |
| `POST /leads` | capture routed lead |
| `GET /kb` | org knowledge bank lookup |

Plus **one internal classification helper** wrapping the LLM — the only place the
LLM is touched. Redaction happens inside it, asserted by test.

## F6. Out of scope for v1
Payments · cancellations and rescheduling *(the agent says call the centre)* ·
PIN-code routing to the nearest branch (three centres are seeded; **only centre 1
is used**) · technician or bay allocation · roadside assistance · clock-time
slots · **Hindi**.

**On Hindi:** required to sell in India and it **will** be built, but as a second
pass. Hindi voice brings transcription accuracy problems, Hindi-English
code-mixing and a long tuning tail. Prove the flow in English first; the Hindi
layer reuses the same state machine and APIs. **Do not bake English word order or
English-only date expressions into the parsing** — "parson" and "day after" show
up even in the English build.

---

# PART G — Voice design (main focus)

## G1. The key insight
**The state machine is not what makes it feel like an IVR.** A human service
advisor also works from a script. What makes an IVR feel like an IVR is
**interaction shape**: closed questions in a fixed chain, re-asking what you were
told, verbatim re-prompts, field-by-field readback, no acknowledgement, no
proactive information.

## G2. Templates become variation pools
The mechanism that reconciles "natural" with B3: **3–5 phrasings per turn,
selected by the code.** Variation without generation. The LLM still never writes
prose and never sees customer data.

*This changes build-order step 4 from "templated responses" to "templated
response **sets** with code-side selection."*

## G3. The nine rules
1. Disclose the bot **once**, in one clause, then never again. Don't apologise
   for it.
2. Variation pools, code-selected.
3. Acknowledge before answering. Cheapest naturalness signal there is.
4. **Tell, don't interrogate.** Offer outcomes with consequence, not menu items.
5. Never re-ask what the caller volunteered.
6. Re-prompts rephrase **and** narrow.
7. Speak through **real** latency, never fake latency.
8. Caller's name **once**, near the end. At the start it sounds like a database
   lookup, because it is one.
9. Close with a one-sentence recap.

## G4. Caution — natural is not chatty
Fake warmth (*"I completely understand how frustrating that must be!"*) reads
worse than clean efficiency and burns call time. Target: **a competent
receptionist who knows the answer**, not a friend.

## G5. Where the IVR feel will leak
The routing exits, if written as error messages.

> ✗ *"This date is unavailable. Please contact the service centre."*
> ✓ *"Thursday's completely full for that kind of job, I'm afraid. The workshop
> can sometimes squeeze people in though — I'll text you their direct number,
> give them a call."*

Same outcome, same lead, same SMS. Completely different call.

## G6. Multi-slot extraction
**Approved in principle; scope below.**

- **Value is higher in voice than chat** — the frequency of rich utterances is
  similar, but a voice turn costs ~5 seconds of wall clock, so collapsing three
  questions into one confirmation saves real time.
- **Reliability:** extraction itself is highly reliable — it's a closed-set match
  against candidates we already hold (this caller's own vehicles, two slots, a
  date). The risk is **not** extraction, it's **silent acceptance**: if ASR
  mishears "Thursday" as "Tuesday", extraction confidently returns Tuesday.
  Mitigation: confirm all captured slots in one line.
- **Difficulty: low if built now** — the classifier returns an object with
  optional fields, and each state checks "is this slot already filled?" before
  asking. About a day's work.
  **High to retrofit** — every state's entry condition and the classifier
  contract change together.
- **Scope:** extract **vehicle, day, drop slot** only. Complaint and special
  request stay explicit questions. **Never** let extraction skip
  identification/OTP.
- **Honest cost:** the test matrix grows (2³ combinations of pre-filled state
  entering day selection).

## G7. Latency
Sub-1 s to first audio. **One LLM call per turn, maximum.** **Prefetch the CRM
lookup at identification.**

## G8. Barge-in
**Hard requirement, decided now not later.** The caller says "yeah yeah, book it"
mid-sentence. An answer can arrive before the question finishes. Painful to
retrofit into strict ask-then-listen turns.

---

# PART H — Competitive positioning

The user challenged: *"how is this different from an IVR — an IVR can also
integrate with CRM and create bookings?"* That challenge is fair, and CRM
integration alone is **not** a moat.

## H1. What an IVR structurally cannot do
1. **Enumeration.** DTMF has ~12 keys; natural date expression is unbounded. With
   30 bookable days × 2 slots × availability varying by pool, an IVR must offer a
   tiny fixed subset or become an unusable tree. It can never ask *"which day
   suits you?"* and accept *"Thursday if possible, otherwise Friday."*
   **This is the strongest structural difference — everything else is polish.**
2. **Free text.** The complaint is the highest-value field in the booking — it
   selects the pool and lands on the advisor's job card. An IVR's only option is a
   voicemail a human must transcribe, so it never reaches the booking record.
3. **Repair.** Mid-flow correction ("no, make it afternoon").
4. **Out-of-order questions.** "How much will it cost?" during day selection.
5. **Speed on the happy path.** One sentence to a booking vs walking the tree.

## H2. Who the real competitor is
**Not touch-tone IVR.** It is (a) the dealer's human call centre during hours,
(b) **nothing at all after hours** — the easiest measurable win — and (c) **other
AI voice agents**. That niche is already populated, including India-specific
vendors (Spyne, YuVerse.ai, Autocalls, Callsphere, Flai all sell dealership voice
booking/BDC agents as of Aug 2026). **Assume the buyer has already seen a demo.**

## H3. Evidence quality warning
Everything published comparing IVR to voice AI is vendor marketing. The commonly
repeated "30–50% IVR abandonment" figure circulates unattributed — a review of
the named reports behind it (Zendesk CX Trends, Salesforce State of Service,
McKinsey, NICE, Microsoft WTI) found **none of them publish specific IVR
abandonment or containment figures**.

**Do not build the pitch on these numbers.** Build it on the dealer's own call log
for one week: total calls, after-hours calls, abandoned calls, calls that became
bookings.

## H4. Where the moat probably is
- Integration depth into **that dealer's** stack (Indian dealer DMS/CRM is often
  bespoke or vendor-specific).
- **On-premise / data-never-leaves-your-servers** (B3) — a wedge the large
  voice-AI vendors will not do.
- **Hindi and Hindi-English code-mixing** done properly.
- **The seven reports.** A voice bot is replaceable next quarter by a cheaper
  voice bot. A report the service manager opens every morning is not. **The
  operational layer creates the switching cost, not the voice.**

## H5. The metric that settles it
**Booking completion rate** — the share of calls ending in a confirmed booking
rather than a handoff. **Track it from day one.** ~70% means this is
unambiguously not an IVR. ~30% means it is an expensive call router and the ten
routing exits need pruning.

---

# PART I — What has been built  **[Sep-06 — rewritten]**

> The old PART I described a schema and seed built in an earlier session. **That
> code is not in this repo and is gone.** Rather than migrate onto it, Step 1 was
> written once already carrying the C1 changes — so none of the eight defects the
> old I4 listed were ever built. That list is preserved in I5 as a regression
> checklist, not as outstanding work.

## I1. Stack

**TypeScript** on **Node + Express**, **SQLite via better-sqlite3**, **React +
Vite + Tailwind** for both screens, **Vitest** for tests. Claude **Haiku 4.5**
(`claude-haiku-4-5`) for classification only.

TypeScript rather than the JS of the earlier build: the Zod schema that
constrains the API response **is** the TypeScript type, so the classifier
contract cannot drift from what the code expects, and the state machine's
`switch` gets exhaustiveness checking — which catches the "added a state, forgot
to handle it" failure G6 warns is expensive to retrofit.

better-sqlite3 being synchronous is a real advantage here: the conditional
capacity `UPDATE` and the booking-counter increment sit inside one
`db.transaction()` with no async interleaving to reason about. A single file also
suits the on-premise pitch (H4). SQL kept plain and Postgres-portable.

### The voice vendor is transport only  **[Sep-19 — decided]**

The fork was: does **our** state machine drive the call, or does a voice
platform's LLM (Vapi, Retell, Bland, ElevenLabs Agents) drive it while we serve
data endpoints? **Our state machine drives it.**

The vendor handles audio, ASR, TTS, turn detection and barge-in, and calls
**our** endpoint for each turn's reply — the "custom LLM" / webhook mode both
Vapi and Retell support. We get their audio engineering without handing them
the conversation.

Why, concretely. A caller's free service is 75 days overdue, so D2 says refuse
and write a retention lead. Our code calls `assessBookability()` and gets
`free_service_not_bookable` — the same answer every time, for every caller. A
platform LLM would instead receive `{is_free: true, due_date: ...}` and have to
infer from its prompt that 75 > 60, that the rule is free-only, and which of the
nine reasons to log. Sometimes it would. **The problem is not that the LLM is
unreliable — it is that it cannot be tested.** A flow bug here is a failing
assertion; there it is "it did something different that time".

What the platform route would have cost: the reports stop being exact, because
the LLM decides when to hand off and why — and retention is the report that pays
for the retainer (F3). The model needs the customer's name and vehicle list to
hold a conversation at all, so B3 and the on-premise wedge (H4) both go. And per
H2, that route *is* what Spyne, YuVerse and the rest already sell — building the
same thing on Vapi makes us one more wrapper competing on price.

Accepted cost: roughly 5–6 sessions to a callable number rather than 1–2.

### There are no agents

B1 and B2 rule them out. **No agent loop, no tool use, no framework** — not
LangChain, not the Claude Agent SDK, not Managed Agents. The LLM is a pure
function: utterance in, small JSON out, called from a deterministic state
machine that discards anything failing the schema.

`client.messages.parse()` with `zodOutputFormat(schema)` and
`output_config.format`, so the response shape is guaranteed rather than hoped
for. `max_tokens: 256`, no thinking parameter, prompt caching on the stable
system prefix.

**One LLM call per turn, maximum** (G7). The schema at each state is the union of
what that state asks for **plus** the always-on overlay — cost question, general
question, correction, escalation — which can arrive at any turn (D9, D10). Never
a separate call per question type; that blows the latency budget.

**Date expressions go through the LLM; bookability does not.** The LLM turns
"Thursday" or "day after tomorrow" into an ISO date, and our code decides whether
that date is inside the window and has capacity. That is the B2 line exactly, and
it is why F6's warning about English-only date expressions costs nothing later.

*Escape hatch:* if multi-slot extraction proves short on accuracy, that one
function moves to `claude-sonnet-5` without touching anything else.

## I2. Files

```
svc-agent/
├── package.json · tsconfig.json · service.db
├── src/
│   ├── db/        schema.sql · seed.ts · index.ts
│   ├── shared/    dates.ts · booking-reference.ts
│   ├── dealer/    (Step 2)
│   ├── call/      (Step 4)
│   └── web/       (Steps 2 and 8)
└── tests/         schema.test.ts · dates.test.ts
```

`npm run db:rebuild` rebuilds from scratch. It is **destructive whether or not
you mean it to be** — `schema.sql` drops every table before recreating it. Only
`seed.ts` calls `resetSchema`, and it is named to say so.

`seed()` takes an injectable `now` and `dbPath`, which is what lets the tests
seed on all seven weekdays and at 00:30 local.

## I3. Seed data

Hand-written, not generated. Every row exercises a branch.

| mobile | customer | vehicle(s) | why it exists |
|---|---|---|---|
| 9810011001 | Rohit Sharma | Nexon | happy path — the E10 script |
| 9810022002 | Priya Menon | Swift + Creta | two models — disambiguation, and both due (D12 upsell) |
| 9810111011 | Arjun Das | Swift + Swift | **same model twice** — model alone can never disambiguate, so the cascade's third pass fails and the call ends (E2) |
| 9810033003 | Anil Verma | Baleno | due date in the **future** — not a blocker (D2) |
| 9810044004 | Sunita Rao | i20 | free, overdue but **inside** 60 days — bookable |
| 9810055005 | Karan Gill | Fortuner | free window exhausted, paid due |
| 9810066006 | Meera Joshi | Tiago | already has an open booking (E4) |
| 9810077007 | Vikram Nair | Venue | free + **null due date** → route out (D2) |
| 9810088008 | Deepa Iyer | Altroz | free, **75 days** overdue → route out (D2) |
| 9810099009 | Farhan Qureshi | Kwid | **service type null** → cannot book (D3) |
| 9810100010 | Neha Kapoor | Ertiga | **paid** + null due date → books normally (D2) |
| 9899999999 | — | — | deliberately absent — tests lead capture |

Capacity is bent on purpose at day **+2** (minor full both slots), **+3** (every
pool full — the day is gone) and **+4** (minor morning full, afternoon open — the
"only the afternoon is free" case in D6). Three centres seeded; **only centre 1
is used, and only centre 1 is bent** — 2 and 3 stay wide open.

## I4. Verification — what was actually checked

Verified by querying `service.db` and running the suite, not by reading comments
(PART L). **36 tests pass.**

- **Overbooking is impossible.** The conditional `UPDATE` takes the last slot
  once and refuses the second; the `CHECK` also rejects a direct overflow and a
  negative count.
- **The capacity bends land on all seven weekdays** — seeded seven times, each
  asserted. The old build's bends depended on which weekday you happened to run
  on.
- **Date arithmetic near midnight.** This machine is IST, and `toISOString` on
  local 00:30 really does return the previous day — so the test genuinely bites
  rather than passing vacuously.
- **Booking references** are unique per centre per day, start at `00000`, survive
  200 consecutive draws with no collision, and are rejected as duplicates at the
  table.
- **`leads.reason` accepts the nine and rejects a tenth** — including
  `free_service_overdue` and `free_service_no_due_date` *by name*, so the merge
  in F2 cannot silently come undone.

## I5. The old build's defects — regression checklist

All eight are fixed or were never built. Kept because each was invisible except
by querying the database.

1. ~~Seed bug: the day+4 "one slot left" case vanished~~ — the `isSunday` guard is
   gone (the centre is open 7 days), and the case is now asserted on every weekday.
2. ~~Stale `service.db` with Sunday-zeroed capacity~~ — rebuilt from the master.
3. ~~No DB guard against overbooking~~ — `CHECK (booked_slots <= total_slots)`.
4. ~~No unique constraint on `(vehicle_id, service_number)`~~ — moot;
   `service_history` is gone and `service_due` is keyed on `vehicle_id`.
5. ~~Redundant `idx_customers_mobile`~~ — dropped; `UNIQUE` already indexes it.
6. ~~`seed.js` arrays carrying discarded 4th elements~~ — seed rows are typed
   objects; the "why this row exists" note is a real field.
7. ~~`toISOString` (UTC) mixed with local date methods~~ — nothing in
   `dates.ts` touches `toISOString`, and `new Date(str)` parsing is banned too,
   since it reads a plain date as UTC midnight and reintroduces the bug from the
   other side.
8. ~~Capacity window only 21 days and shrinking~~ — generated 30 days forward
   from the weekday master.

---

# PART J — Still open

**Everything in v2's PART J is now closed.** For the record:

| v2 question | resolution |
|---|---|
| Last-4 keypad or spoken? | **Spoken**, with the model, in one turn (E2) |
| Duplicate check at intent or write? | **At intent**, and it ends the call (E4) |
| Transcript retention and location | **Our system, 45 days** (F4) |
| Knowledge bank fallback | **Ends the call.** Never guess (D10) |
| Does the dealer's call centre take advance bookings? | They do today; they have no capacity system at all, so we build it and share one table (D4) |
| Mention a second due vehicle at close? | **Yes**, mention only (D12) |
| Complaint classifier data exposure | B3 amended: redact known identifiers, accept the residue |
| Booking reference format | `YYMMDD-NNNNN`, per centre per day, from `00000` |

## J1. Genuinely open

1. **CRM failure handling.** If the lookup errors or times out: recoverable
   errors are surfaced to the caller; anything unknown drops out with a
   `missing_required_field` lead. The exact split is not yet written.
2. **Whether "end the call on a knowledge-bank miss" survives contact with real
   traffic.** See the recorded consequence in D10.
3. **Which telephony vendor** for phase 8. The *mode* is settled (transport
   only, custom-LLM webhook — see I1), so this is now a shortlist question, not
   an architecture one. **Custom-LLM / webhook support is a hard requirement**;
   a vendor that only offers its own LLM is disqualified whatever else it does.

## J2. Small defaults taken, reversible

- Reports are generated on demand by date range; no scheduler (F3).
- Centre is hardcoded to 1 (F6 already put PIN routing out of scope).
- `opens_at`/`closes_at` are knowledge-bank data only and never gate a booking.
- "Another problem" ends the call after capturing the caller's words.
- The multi-slot confirmation is one line; if the caller corrects it, re-ask only
  that slot and reconfirm — **bounded by D11's three-strike counter**, or a
  caller who keeps saying "no, that's wrong" loops forever.

---

# PART K — Build order

1. ~~**Backend + schema + seed data.**~~ **DONE.** v2's steps 1 and 2 collapsed
   into one — the schema was written once already carrying the C1 changes rather
   than migrated onto the old shape.
2. **Dealer app** — minimal backend and frontend. The CRM endpoints, the capacity
   master and its 30-day regeneration, a dealer-channel booking so contention is
   demonstrable rather than asserted, and a read-mostly screen: the 7×6 capacity
   grid, today's arrivals, the seven reports. *The main product is the call —
   keep this small.*
3. **Business rules** — the date rules, the EDD matrix, the capacity guard. Pure
   functions, no I/O, no LLM. Smaller than v2 planned, since service-due comes
   from the CRM.
4. **Call app state machine** + the `sessions` table. This is where flow holes
   surface — cheap to fix here, expensive once voice is attached.
5. **Templated response pools** — sets, not strings, with code-side selection
   (G2). Confirm no LLM-generated prose has crept in.
6. **LLM classification layer** — narrow calls including complaint/special-request
   and multi-slot extraction, plus redaction, asserted by test.
7. **SMS log + the seven reports + the state-derived summary.**
8. **Caller chat page.** Replaced entirely by voice in step 9, so keep the
   investment small. *(No terminal REPL — the chat page is the same typing
   surface and is demoable.)*
9. **Voice** — a separate phase needing a telephony provider and a real number.
   **Choose the provider on barge-in support** (G8): it is a property of the
   telephony layer, not something we build. Exotel or Plivo for Indian numbers;
   Twilio carries regulatory friction there. Deepgram / ElevenLabs for ASR/TTS.
10. **Hindi** — a separate phase; evaluate Sarvam here.

---

# PART L — Working agreement

- Work **step by step, object level**, confirming each step before moving on.
  **No high-level summaries, no diagrams.**
- **Minimal diffs.** Push back on unnecessary complexity or added state.
- **Verify with real queries or test runs** before declaring something done.
- The developer builds in a **local project folder**; flag any drift between
  versions.
- **Do not create anything new without being asked.**
