# Session handoff — AI Service Booking Agent (`svc-agent`)

> Written 2026-09-28 so that a new Claude Code session — including a cloud
> session with no memory of the earlier ones — can pick the work up exactly
> where it stopped. Covers the whole history of the build, every file, every
> decision taken since `CONTEXT.md` was last updated, what is verified, and
> what is left.
>
> **Where this file and `CONTEXT.md` disagree, this file is newer and wins.**
> `CONTEXT.md` (v3, 2026-09-06) still holds every business rule; its PART I
> ("what has been built") and PART J ("still open") have not been updated since
> 6 September.

---

## 0. Read this first

**Working agreement** (PART L of `CONTEXT.md`, plus the user's standing preferences):

- Work **one step at a time, at object level**. Finish a step, report what was
  verified and how, then stop and confirm before the next. The exception is
  when the user explicitly asks for a batch ("I want everything done") — then
  do it all, still verifying each step.
- **Minimal diffs.** Push back on unnecessary complexity or new state.
- **Verify with real queries or test runs**, never by reading code. The
  previous build's defects were all invisible except by querying the database.
- **No high-level summaries, no diagrams** in normal replies.
- **Do not create anything new without being asked.**
- Report failures plainly; mutation-test a new test (break the code, watch it
  fail, restore) before trusting it.

**Secrets:**

- `svc-agent/.env` holds `ANTHROPIC_API_KEY`, `ADMIN_PASSWORD`,
  `CALL_API_SECRET`, `DEMO_MODE`. It is gitignored. **Never commit it, never
  print its values.** Key rotation has been discussed and decided by the user;
  do not raise it again.
- Claude does not type API keys or passwords into anything (forms, CLI
  arguments, Fly secrets). The user runs those commands; Claude prepares them.
- `ADMIN_PASSWORD` in `.env` is still a weak demo value. The user should
  change it before deploying — on a public URL it is the only thing guarding
  capacity edits and booking cancellation.

---

## 1. What this is

An **AI agent that books car-service appointments for a dealer service centre
in India**. A customer talks to it (by chat now, by phone later); it identifies
them from their number, states what service their car is due, asks about
faults, finds a day and a drop-off slot, writes the booking, texts a
confirmation — or, when it cannot help, ends the call and files a **lead** for
the right team at the dealer. A dealer portal shows capacity, arrivals, every
conversation, and on-demand reports.

**End goal:** a public, shareable portal link, with a chat panel anyone can use
to make a booking. A phone number (Vapi) comes later.

**Current framing (user, 2026-09-25):** *"Think of it as a chat-based app only.
Voice will be integrated later, but when that comes minimum changes should be
needed."* The chat panel uses the same start/turn contract a voice layer will;
the Vapi adapter already exists and is untouched.

---

## 2. Where everything is

```
Voice Bot for Car Service Centers/        <- project root (NOT a git repo yet)
├── CONTEXT.md          business rules and design, v3 (980 lines)
├── HANDOFF.md          this file
├── .claude/
│   ├── launch.json     preview config "dealer": npm --prefix svc-agent run start, port 3001
│   └── settings.local.json   local permission allow-list (2 entries) — do not commit
└── svc-agent/          the application
    ├── src/            6,237 lines
    ├── tests/          3,516 lines, 13 files
    ├── dist/dealer/    built portal (gitignored)
    ├── service.db (+ -wal, -shm)   local SQLite (gitignored)
    ├── .env / .env.example
    ├── Dockerfile, .dockerignore, fly.toml
    ├── package.json, package-lock.json
    ├── tsconfig.json, vite.config.ts, vitest.config.ts, vitest.live.config.ts
    └── .gitignore      node_modules, service.db*, dist, .env, .env.* (not .env.example)
```

**Stack:** TypeScript on Node 22.17, run directly by `tsx` (no compile step) ·
Express 5 · better-sqlite3 13 (single file, WAL) · React 19 + Vite 8 +
Tailwind 4 for the portal · Vitest 5 · `@anthropic-ai/sdk` with
`claude-haiku-4-5` for classification · Zod 4 for structured output.
TypeScript is v7 (`tsc --noEmit` only; `noUnusedLocals` and
`noUnusedParameters` are on).

**Commands** (run inside `svc-agent/`):

| command | what it does |
|---|---|
| `npm install` | install dependencies |
| `npm run dev` | server with file watching (`tsx watch`) — use this while editing |
| `npm start` | build the portal, then serve. **No file watching** — restart after edits |
| `npm run serve` | serve only (portal must already be built) |
| `npm run build:web` | build the portal into `dist/dealer` |
| `npm run dev:web` | Vite dev server on 5173, proxies `/api` to 3001 |
| `npm test` | 298 offline tests, ~6 s, no network, no key needed |
| `npm run test:live` | 19 tests against the real Haiku model; needs `ANTHROPIC_API_KEY`; costs a few cents |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:rebuild` | **destructive** — drops and reseeds `service.db`. **Stop the server first**; running it against a live server once left the schema half-dropped |

Local URL: <http://localhost:3001>. Health: `GET /health`.

---

## 3. Architecture

### Principles (PART B of CONTEXT.md)

- **B1** — a deterministic state machine decides what happens next, every turn.
  The LLM never does.
- **B2** — the LLM only classifies what the caller said, against closed
  candidate sets our code supplies.
- **B3 (amended)** — no database record is ever sent to the LLM; known
  identifiers (name, mobile, registration, model) are redacted from the
  caller's words before they leave the process. Residual risk accepted.
- **G7** — at most one LLM call per turn; sub-1 s target.
- The LLM never writes a word the caller hears. Every reply is chosen by code
  from phrasing pools in `templates.ts`.

### How a turn flows

```
chat panel (browser)        voice later (Vapi)
  POST /api/chat/turn          POST /vapi/chat/completions  (OpenAI-shaped SSE)
          \                       /
           callApi  (src/call/http.ts)     vapiApi (src/call/vapi.ts)
                     \           /
                 handleTurn  (src/call/machine.ts)
                   1. fast path: StubClassifier — regex; answers a bare
                      yes/no, a slot, a run of digits in ~4 ms, no network
                   2. otherwise HaikuClassifier — one model call, ~1.2 s
                   3. the state machine acts on the classification using
                      the rules in src/shared/*, reads/writes SQLite
                   4. reply text chosen from templates.ts
```

The same `callApi` router is mounted twice: open at `/api/chat` (the chat
panel), and behind `CALL_API_SECRET` at `/call` (for a future voice layer or
integration). Adding voice changes the channel, not the conversation.

### Call states

`greeting` → (`awaiting_number` → `awaiting_otp`) → `vehicle` → `open_turn` →
`complaint` → `special_request` → `day` → `drop_slot` → `confirm` → `ended`.
Out-of-band at any turn: a cost question (D9, answered without a number) or a
general question (D10, answered from the knowledge bank or the call ends with
an `another_problem` lead — never a guess). Resume after an aside re-asks the
exact question pending, keeping the keypad hint (`expectsDigits`).

### Endpoints

| path | guard | purpose |
|---|---|---|
| `GET /health` | open | liveness, no DB |
| `POST /api/chat/start` `{callerNumber}` | open, 30/min/IP | begin a conversation; the number stands in for caller ID |
| `POST /api/chat/turn` `{sessionId, utterance}` | open, 30/min/IP | one turn → `TurnResult` (+ `sms[]` in DEMO_MODE only) |
| `GET /api/summary` | open | centre + counts for the header |
| `GET /api/capacity/master` | open | 7×6 weekday master |
| `PUT /api/capacity/master` | admin | save **and** apply to the live window, one transaction; returns conflicts |
| `POST /api/capacity/regenerate` | admin | walk the window forward |
| `GET /api/capacity/window?days=` | open | live window, `days` clamped 1..30 |
| `GET /api/bookings/arrivals?date=` | open | open bookings arriving that day |
| `GET /api/bookings/open/:registration` | open | D13 duplicate check |
| `POST /api/bookings` | admin | dealer-channel booking (may be same-day) |
| `PATCH /api/bookings/:reference` `{status}` | admin | `completed` keeps the slot used; `cancelled` gives it back; 404 unknown, 409 already closed |
| `GET /api/vehicles` | open | vehicles + owner, for the portal's pickers |
| `GET /api/reports`, `GET /api/reports/:audience?date=` | open | seven on-demand reports (F3) |
| `GET /api/calls?date=`, `GET /api/calls/:id` | open | conversations + transcript; `otpCode` is stripped |
| `GET/PUT/DELETE /api/kb[/:key]` | writes admin | the dealer's FAQ |
| any other `/api/*` | — | JSON 404 (not the SPA) |
| `/call/start`, `/call/turn` | `CALL_API_SECRET`, 120/min | same contract as the chat, for integrations |
| `/vapi/chat/completions` | `CALL_API_SECRET`, 240/min | Vapi custom-LLM adapter |
| everything else | open | the portal SPA |

Guards accept `Authorization: Bearer <value>` or `x-admin-password`. **An unset
secret refuses (503), it never opens** — fail closed.

---

## 4. Every file

### `src/` — server

| file | role |
|---|---|
| `config.ts` | the only place `process.env` is read. Loads `.env` if present. Exposes `port`, `dbPath`, `adminPassword`, `callApiSecret`, `anthropicApiKey`, `demoMode`, `centreTimezone`, `behindProxy`. **Sets `process.env.TZ = centreTimezone` at load**, pinning every date to the centre's clock regardless of host. `configWarnings()` lists unset secrets at boot. |
| `auth.ts` | `requireAdmin`, `requireCallSecret` (constant-time compare, fail closed), `rateLimit()` fixed-window per IP per route |
| `db/schema.sql` | 13 tables. Drops everything first — only `seed` runs it |
| `db/index.ts` | `open()` (foreign keys on, WAL), `resetSchema()` |
| `db/seed.ts` | `seed({now, dbPath})` — **destructive** rebuild with hand-written demo data, every row exercising a branch; runs directly via `npm run db:rebuild` |
| `db/bootstrap.ts` | `seedIfEmpty()` — seeds only if the file is missing or has none of our tables; a schema with no rows is **kept**; a corrupt file throws |
| `dealer/server.ts` | boot: `seedIfEmpty` → `open` → trust proxy if `BEHIND_PROXY` → mount `/api/chat`, `/api`, `/call`, `/vapi`, `/health`, JSON 404, SPA, error handler. Schedules the 45-day transcript purge (boot + daily) and the capacity roll (boot + every 6 h). Logs database, classifier, clock, demo mode |
| `dealer/api.ts` | every `/api` route above |
| `dealer/reports.ts` | `LEAD_REPORTS` (5 lead reports, each reason owned by exactly one), `BOOKING_REPORTS` (arrivals, activity), `runReport`, `auditReasonCoverage` |
| `call/machine.ts` | the state machine: `startCall`, `handleTurn`, `routeOut` (lead + SMS + end), `identify`, `resolveVehicle`, `afterIntent` (E4 duplicate + D2/D3 blockers), `askDay`, `offerFirstAvailable` (E7), `considerDay` (D5/D6), `offerSlotLine`/`reaskSlotLine` (E8, E0), `maybeNudgeThenBook` (D7), `book` (E9, D12) |
| `call/classifier.ts` | `Classifier` interface, `ClassifyRequest`, `Classification` (incl. `noPreference`, `kbKey`, `confident`), `redactUtterance`, `matchKbKey`, `StubClassifier` (fast path + offline tests) |
| `call/haiku-classifier.ts` | `HaikuClassifier`: per-state Zod schema, dated 14-day calendar in the prompt, `kb_key` as a closed enum of the dealer's own rows, redaction before send, `toClassification` |
| `call/crm.ts` | `Crm` interface; `LocalCrm` (reads tables); `DemoCrm` — in DEMO_MODE an unknown number gets customer "Guest" with a paid minor-service Swift, registration `DEMO<mobile>`, one record per number |
| `call/http.ts` | `buildDeps` (Haiku if key else stub; fast stub ahead of Haiku; `DemoCrm` when `demoMode`); `callApi` router (`/start`, `/turn`; echoes `sms[]` in DEMO_MODE only); `sessionIdForExternal` |
| `call/vapi.ts` | OpenAI-compatible `/chat/completions` over SSE. Ignores Vapi's resent history; keys on `call.id` → our session |
| `call/session.ts` | sessions (state + JSON data) and transcripts; `appendTranscript` draws `turn_index` inside the INSERT (atomic); `purgeOldTranscripts` |
| `call/sms.ts` | F1: SMS is **logged** to `sms_log`, not sent. `smsForBooking`, `smsForLead`, `lastSmsId`, `smsSince` |
| `call/templates.ts` | every line the caller hears, 1–3 phrasings per pool, picked by turn number; spoken dates/times |
| `call/types.ts` | `CallState`, `SessionData`, `TurnResult` |
| `kb/index.ts` | `KnowledgeBank` interface, `TableKnowledgeBank`, `normaliseKey`, `upsertEntry`, `deleteEntry` |
| `shared/types.ts` | pools, drop slots, the nine lead reasons, `BOOKING_WINDOW_DAYS = 30`, `CENTRE_ID = 1`, `DROP_TIMES` |
| `shared/dates.ts` | local-time date arithmetic (I4-7), `WEEKDAY_NAMES` |
| `shared/availability.ts` | D5 window (from call **start**, never the clock), D6 day offers, `firstAvailable`, `canTake` |
| `shared/bookings.ts` | `createBooking` — the **only** write path (conditional UPDATE, `changes === 1`, reference draw, insert, one transaction); `closeBooking`; `arrivals` (single implementation); EDD matrix `expectedPickup`; `nextBookingReference` (`YYMMDD-NNNNN`) |
| `shared/capacity.ts` | `regenerateCapacity` (never touches the past, clamps cuts to what's booked, reports conflicts), `capacityWindow`, `readMaster`, `writeMaster` |
| `shared/service-due.ts` | D2/D3 `assessBookability`, D8 `poolFor`, D12 `otherDueVehicles`, D11 pushback limit (3) |
| `shared/leads.ts` | `buildLead` (one builder for all nine outcomes), `insertLead` |

### `src/web/dealer/` — portal

| file | role |
|---|---|
| `App.tsx` | header with counts, four tabs, **Chat with the agent** toggle; `version` counter bumped when a chat ends or a booking closes so open views refetch |
| `api.ts` | typed client; re-exports shared constants; `dropTime()`; `withPassword()` prompts once for the admin password on a 401 and keeps it for the tab (sessionStorage) |
| `views/Chat.tsx` | the side panel: "Call as" (seeded customers or another number), transcript, round-trip time under each agent reply, SMS cards, outcome banner |
| `views/Capacity.tsx` | master grid (save = apply), 30-day window, take a slot as the dealer |
| `views/Arrivals.tsx` | bookings arriving on a day; **Completed / Cancel** buttons |
| `views/Calls.tsx` | every conversation and its transcript |
| `views/Reports.tsx` | the seven reports |

### `tests/` — 298 offline + 19 live, all passing

| file | tests | covers |
|---|---|---|
| `machine.test.ts` | 53 | full calls end to end with the stub: E10 reference call, pushback, nudge, complaints, KB, resume, single-slot acceptance, phrasing rotation, E7 no-preference, day change at slot, DEMO_MODE |
| `api.test.ts` | 40 | portal routes, capacity save/apply, dealer bookings, close booking, OTP never exposed, `/crm/*` gone |
| `schema.test.ts` | 32 | CHECK constraints, capacity bends, references, lead reasons, seeded branches, `seedIfEmpty` |
| `rules.test.ts` | 29 | D2/D3 matrix, D8, D11, D12, lead builder |
| `bookings.test.ts` | 28 | write path, races, `closeBooking`, EDD matrix |
| `kb.test.ts` | 28 | KB from data, never-guess, editing, key normalisation on delete |
| `http.test.ts` | 21 | guards, rate limits, call API, concurrency, Vapi adapter, SMS echo only in demo |
| `availability.test.ts` | 17 | D5/D6 |
| `classifier.test.ts` | 17 | stub, redaction, KB matching |
| `capacity.test.ts` | 12 | regenerate, clamps, conflicts |
| `reports.test.ts` | 12 | F3 ownership, report contents |
| `dates.test.ts` | 9 | local-time arithmetic; **UTC host still gets India dates** |
| `classifier.live.test.ts` | 19 | real Haiku (opt-in) |

---

## 5. Environment

| variable | default | local `.env` | Fly |
|---|---|---|---|
| `PORT` | 3001 | — | `8080` (fly.toml) |
| `DB_PATH` | `svc-agent/service.db` | — | `/data/service.db` (volume) |
| `ANTHROPIC_API_KEY` | none → stub classifier | set | **secret** (user sets) |
| `ADMIN_PASSWORD` | none → writes refused | set (weak demo value) | **secret** (user sets) |
| `CALL_API_SECRET` | none → `/call`, `/vapi` refused | set | **secret** (user sets) |
| `DEMO_MODE` | `false` | `true` | `true` (fly.toml) |
| `CENTRE_TIMEZONE` | `Asia/Kolkata` | — | — |
| `BEHIND_PROXY` | `false` | — | `true` (fly.toml) |

Boot log should read: capacity line, `database … (existing data kept | seeded
fresh)`, `classifier Haiku (live)`, `clock Asia/Kolkata, today YYYY-MM-DD`,
`demo mode on`, and **no** `warning` lines.

---

## 6. State as of 2026-09-28

- **Code:** complete for the chat app. `tsc` clean, **298/298** offline,
  **19/19** live, portal builds.
- **Verified in a real browser:** a stranger's number booked end to end
  through the chat panel; SMS card shown; Capacity grid and header counts
  updated beside it without a reload; Arrivals Cancel reaches the password
  prompt (declined — Claude does not enter passwords); panel full-width on a
  390 px phone, beside the portal on desktop.
- **Local database** holds test clutter from verification: two "Guest" demo
  customers (`9000012345`, `9000054321`), 7 AI bookings and 1 dealer booking
  open, 28 sessions, 21 leads. Several seeded customers are now blocked by
  their open booking (D13). `npm run db:rebuild` (server stopped) gives a clean
  slate; a cloud checkout has no `service.db` at all and seeds itself on boot.
- **Not deployed.** Stopped before creating billable Fly resources — waiting on
  the user's "yes" (section 10).

### Measured performance (local, 2026-09-22 / 25)

| | |
|---|---|
| fast-path turn (no model) | **3–7 ms** — about half of every call |
| model turn, warm | **~1.2 s** median (1.0–1.4 s) |
| full booking | ~5 s of agent time across ~7 turns |
| cost | ~$0.006 per call (measured earlier) |
| first use of each state's schema after a long idle | **+2–4 s** (seen 3–6.5 s turns) |

The last row is server-side at Anthropic: the first request with a given
structured-output schema pays a compilation cost, then it is cached. A **new
enum value costs nothing** (measured); a schema not used for a day or more
does. That is why the first chat after a quiet spell is slow. Possible fix, not
built: at boot, one cheap classify per state to warm them (~$0.01).

### Seeded demo customers (fresh seed; dates are relative to seed day)

| mobile | name | vehicle | what it exercises |
|---|---|---|---|
| 9810011001 | Rohit Sharma | Nexon HR26AB4471, major, paid | the E10 reference call |
| 9810022002 | Priya Menon | Swift DL8CAF2213 + Creta DL8CAG5567 | two vehicles → asks which |
| 9810033003 | Anil Verma | Baleno KA05MN0918, free | due date in the future — still bookable |
| 9810044004 | Sunita Rao | i20 MH12PQ3344, free | overdue < 60 days — bookable |
| 9810055005 | Karan Gill | Fortuner PB10RS7788, major, paid | afternoon → next day → same-day nudge |
| 9810066006 | Meera Joshi | Tiago GJ01TU2255 | already has an open booking (E4/D13) |
| 9810077007 | Vikram Nair | Venue TN09VW6600, free | free service, no due date → refused (D2) |
| 9810088008 | Deepa Iyer | Altroz RJ14XY1177, free | free, > 60 days overdue → refused (D2) |
| 9810099009 | Farhan Qureshi | Kwid UP16ZA8899 | null service type → refused (D3) |
| 9810100010 | Neha Kapoor | Ertiga KL07BC4433, major, paid | paid with no due date → bookable |
| 9810111011 | Arjun Das | Swift KA01AA1234 + Swift KA01AA5678 | two cars, same model → needs last four |
| 9899999999 | — | — | deliberately absent → `number_not_found` (or a demo car in DEMO_MODE) |

Centre 1 "Voltas Motors Service — Sector 44", 09:00–19:00, seven days. Only
centre 1 is used. Capacity bends on centre 1: +2 days minor full, +3 days
everything full, +4 days only the minor afternoon free. KB keys:
`loaner_car, location, opening_hours, parking, payment_methods, pickup_drop,
waiting_area`.

---

## 7. Decisions (user's, in order)

1. Our own state machine; a telephony vendor for audio only (Vapi custom-LLM mode).
2. Haiku as the classifier; one LLM call per turn.
3. Vehicle problems end the call; a duplicate booking ends the call; last four
   digits + car name spoken to identify.
4. Transcripts stored in our system with a summary; 45-day retention (F4).
5. Knowledge bank: start as a FAQ table, keep the door open to a vector store
   (hence the `KnowledgeBank` interface). A KB miss ends the call (D10).
6. Second-vehicle mention at the close (D12).
7. Central slot table (no batch); we own capacity (D4).
8. Booking reference `YYMMDD-NNNNN` per centre per day, from 00000.
9. The dealer desk can book any day incl. today; the bot only tomorrow to +30 (D5).
10. Reports on demand, no scheduler (F3).
11. API key handling: decided by the user; not to be reopened.
12. Portal reads stay open (shareable link); writes need the admin password.
13. Deploy target Fly.io; build everything deploy-ready first, deploy last.
14. Unknown caller → demo customer created on the fly, behind `DEMO_MODE`.
15. Repeat demo caller → add a close-booking action (D13 still fires).
16. **Chat-first. Voice later, with minimum changes.**
17. **"Everything done except the Vapi number."**
18. Region: Singapore — Fly has no Indian region; `sin` is ~70 ms from India vs ~230 ms for `iad`.
19. **(2026-09-28) Order of work:** correct and verify what exists before
    building more; nothing that is not built yet is to be added now. Held back:
    - the live classifier suite — run later;
    - the CONTEXT items not built (E1 OTP timing, F1/F5 SMS resend, J1 CRM
      failure handling) — not now;
    - warming the schemas at boot — future scope;
    - the Fly deploy — after everything is finalised;
    - login, real SMS, OTP, `DEMO_MODE` off — when there is real data;
    - voice — once the app is live.

---

## 8. History of the work

**Up to 2026-09-06** — every open design question closed; `CONTEXT.md` v3.

**Build (PART K steps)** — schema + seed, capacity system, shared rules,
dealer portal, state machine, Haiku classifier, call API, Vapi adapter, Calls
tab, KB via the classifier, fast path.

**Bugs the user found testing** — capacity Save did not apply to the live
window (now save + regenerate in one transaction); same-day booking from the
dealer desk.

**Bugs found while building** — two divergent `arrivals` queries (merged); bad
`vehicleId` gave 500 (now 404); agent accepted a slot it had said was gone
(`canTake` + `SLOT_GONE`); complaint pool promised same-evening (D7,
`SLOT_BOTH_NEXT_DAY`); clock strings in speech (`spokenDropTime`); no
acknowledgement after a fault (`ACK_COMPLAINT`); Haiku got "Thursday" wrong by
a day (it was doing arithmetic — fixed with a dated 14-day calendar in the
prompt); hardcoded question lists in three places (the KB router, the stub, the
Haiku prompt) — general questions are now recognised by shape and only the
data decides what has an answer.

**Cleanup pass 1 (2026-09-21)** — three defects fixed with tests written first:
`resumeQuestion` covered 4 of 11 states and dropped `expectsDigits`; a
zero-vehicle account asked "which one?" and blamed the caller; `confirm_slots`
was an unreachable state. Dead code removed. `edd.ts` and
`booking-reference.ts` merged into `bookings.ts`, `pushback.ts` into
`service-due.ts`; `WEEKDAY` consolidated from four copies. Transcript purge
wired to a scheduler. Comments 967 → 800 lines.

**Review pass 2 (2026-09-21)** — *"yes"* to a single-slot statement was read as
silence, repeated verbatim and charged a pushback (three yeses routed the
caller out); the phrasing seed counted transcript rows (two per turn) so it was
always even, so all 16 of the 25 pools that have two phrasings were frozen on
phrasing #1; KB
delete did not normalise the key. Six unused imports found by turning on
`noUnusedLocals`; duplicated constants in the web layer; `tests/edd.test.ts`
folded into `bookings.test.ts`.

**The four remaining items (2026-09-21/22)** — three `/api/crm/*` endpoints
nothing called, which let anyone enumerate customers by mobile, **deleted**;
`/api` rate-limited; `days` clamped; unknown `/api/*` returns JSON 404. E7:
"whenever suits you" now picks the first available day instead of routing out.
Transcript index drawn inside the INSERT. A date can be given at the slot
question.

**Go-live build (2026-09-25)** —
- Timezone pinned in `config.ts`. Reproduced first: on a UTC host at 00:30 IST
  the agent offered **today** as earliest (breaks D5).
- `closeBooking` + `PATCH /api/bookings/:reference` + Arrivals buttons.
- `GET /api/calls/:id` was returning the **live OTP code** on an open endpoint
  — stripped.
- `DemoCrm`; SMS echoed to the chat **only** in DEMO_MODE (otherwise it would
  hand a stranger someone else's OTP).
- `seedIfEmpty`; capacity roll at boot + every 6 h (the local window had
  drifted to end 21 Oct; rolled to 25 Oct on restart).
- Duplicate `GET /call/:sessionId` removed (`/api/calls/:id` is the one the
  portal uses).
- `trust proxy` behind `BEHIND_PROXY`, so rate limits are per visitor on Fly.
- Chat side panel, refresh-on-change, loading states instead of false "none".
- **Crash found in the browser:** in Chrome 152, `scrollIntoView()` returns a
  Promise (TypeScript still types it `void`); an expression-bodied
  `useEffect(() => el.scrollIntoView())` returned it, React called it as the
  cleanup, and the whole portal unmounted. Now a block body.
- `Dockerfile`, `.dockerignore`, `fly.toml`; `tsx` moved to dependencies;
  lockfile refreshed (it had `tsx` marked dev-only, which would have produced an
  image that could not start).

---

## 9. Gotchas that cost time

- **Python heredocs on this machine:** writing `"\b"` into a file through a
  Python string produced a literal backspace byte, silently breaking a regex.
  Prefer the Edit tool for anything with backslashes; after a scripted edit,
  scan for control characters.
- **`npx tsx -e` with top-level `await` hangs** — write a file, or use a
  throwaway vitest file.
- **vitest swallows `console.log`** in a grep pipeline — write results to a file.
- **Stop the server before `npm run db:rebuild`.**
- **`npm start` does not watch.** After edits, restart, or use `npm run dev`.
- The browser pane throttles rendering when behind other windows —
  screenshots time out; read the DOM with JS instead.
- Express 5 widens `req.params` to `string | string[] | undefined` when a guard
  sits in front of the handler — wrap in `String()` (see the `/kb` routes).
- The project folder syncs to OneDrive — `.env` reaches the tenant; production
  secrets belong in Fly.
- `dates.ts` is local-time by design; never use `toISOString()` or
  `new Date('YYYY-MM-DD')` for calendar dates.

---

## 10. What's left

1. **Deploy to Fly — waiting on the user's "yes"** (billable: one always-on
   `shared-cpu-1x` 512 MB machine + 1 GB volume in `sin`, roughly $4–5/month;
   Fly did not print the exact regional price). Account is logged in on the
   laptop; a cloud session needs its own `fly auth login` or a `FLY_API_TOKEN`
   the user provides. Steps, from `svc-agent/`:

   ```bash
   fly apps create svc-agent-voltas
   fly volumes create svc_data --app svc-agent-voltas --region sin --size 1 --yes
   fly deploy --app svc-agent-voltas --remote-only
   ```

   Then **the user** sets the secrets (after strengthening `ADMIN_PASSWORD`):

   ```bash
   grep -E '^(ANTHROPIC_API_KEY|ADMIN_PASSWORD|CALL_API_SECRET)=' .env | fly secrets import --app svc-agent-voltas
   ```

   **Checked 2026-09-28 in a cloud session**, by running both Dockerfile stages'
   commands in `node:22.17.0-slim`: the Windows-generated lockfile installs
   the Linux native binaries. The image as first written would **not** have
   built: `better-sqlite3` has a `binding.gyp`, so npm runs an implicit
   `node-gyp rebuild`, which needs Python, which the slim image lacks.
   Both `npm ci` lines now pass `--ignore-scripts`: better-sqlite3 loads its
   bundled `prebuilds/linux-x64.node`, and esbuild finds its binary through
   its optional dependency. After that, the portal built, the server booted
   and seeded, and a stranger booked end to end in `DEMO_MODE`. Still
   unverified: the `apt-get install tzdata` step, which the cloud sandbox's
   network blocks.

2. **Verify the deploy**, in order: `fly status` (one machine, health passing)
   · `fly logs` (`seeded fresh`, `Haiku (live)`, `clock Asia/Kolkata`, no
   warnings; the `clock` line is the timezone check — a separate
   `fly ssh console -C "node -p …"` shows UTC, because `config.ts` pins `TZ`
   inside the server process only) · no `.env` in `/app`, the db in `/data` · unauthenticated
   `PUT /api/capacity/master` → 401 · **persistence:** make a booking,
   `fly machine restart`, log must say `existing data kept` and the booking
   survives · a full chat on the public URL.

3. **Optional:** warm the structured-output schemas at boot (section 6).
4. ~~Update `CONTEXT.md` PART I and J~~ — done 2026-09-28.
5. **Before real customer data:** the portal and chat are open by design;
   they need a login. The chat's "call as" number is self-asserted, so with
   real data every chat must go through OTP to a real SMS provider, and
   `DEMO_MODE` must be off. **The OTP itself is only partly built** (found
   2026-09-28): `awaiting_otp` in `machine.ts` checks the digits and ends the
   call after 3 wrong codes. None of CONTEXT E1's timing rules exist — no
   5-minute validity, no reminder at 15 s, no resend at 45 s (max 3, a resend
   kills the old code), and no 3-calls-per-hour block after a failed OTP. The
   expiry and the hourly block are security controls; build them before real
   data. Not yet decided by the user.
6. **Voice (later):** Vapi account and number; custom LLM URL
   `https://<app>.fly.dev/vapi` (Vapi appends `/chat/completions`), header
   `Authorization: Bearer <CALL_API_SECRET>`, no first message of its own. If
   Vapi runs only in the US, consider moving the region — config, not code.
7. **Still open from `CONTEXT.md` J1:** CRM failure handling; whether "end the
   call on a KB miss" survives real use; telephony vendor.
8. **Known and accepted:** ~15 s downtime per deploy (one machine, one volume,
   one SQLite writer); rate limits reset on restart.

---

## 11. The repository and the cloud session

**Done 2026-09-28.** The project root is a git repository, pushed to
<https://github.com/Shashank-Codes-bit/Service-Call-Bot> — **public**, by the
user's choice, made knowing that `CONTEXT.md` becomes readable by anyone.
Branch `main`, first commit `c8db4cc`, 66 files. Verified on GitHub: `.env`,
`service.db*`, `.claude/settings.local.json`, `node_modules` and `dist` are not
in it (root `.gitignore` + `svc-agent/.gitignore`). Commits use a repo-local
identity with a GitHub no-reply address, so no real email is public.

Because the repository is public: **never commit a secret**, and keep anything
about the API key out of committed files.

In a cloud session:

1. `cd svc-agent && npm install && npm test` — needs no secrets; 298 should pass.
2. `npm run test:live` and a live classifier need `ANTHROPIC_API_KEY` set in the
   cloud environment's settings — the user adds it; do not commit it.
3. `npm run dev` starts the server; with no `service.db` it seeds itself.
4. Things that did **not** travel: the local `service.db`, the laptop's Fly
   login (`fly auth login` or a user-provided `FLY_API_TOKEN` is needed to
   deploy), the laptop's Claude memory (its content is in section 0), and
   earlier chat transcripts (this file replaces them).
