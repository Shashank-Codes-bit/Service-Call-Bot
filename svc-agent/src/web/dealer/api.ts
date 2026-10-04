// The browser reads the same definitions the server does. shared/ has no node
// imports, which is what makes one source of truth possible across both.
export { DROP_SLOTS, POOLS, type DropSlot, type Pool } from '../../shared/types.ts';
import type { DropSlot, Pool } from '../../shared/types.ts';

export type Me = {
  slug: string;
  name: string;
  userId: string;
  initials: string;
  today: string;
  turnsToday?: number;
  turnCap?: number;
  /** This centre's demo switch: on, its activity goes back to the sample every night. */
  demo: boolean;
  /** Whether the server runs demo centres at all (DEMO_MODE). */
  demoAvailable: boolean;
};

export type DayBooking = {
  reference: string;
  booking_date: string;
  drop_slot: DropSlot;
  expected_pickup: string;
  pool: Pool;
  note: string | null;
  status: 'open' | 'completed' | 'cancelled';
  source: 'ai' | 'dealer';
  created_at: string;
  arrived_at: string | null;
  customer_name: string;
  mobile_number: string;
  vehicle_id: number;
  model: string;
  registration_number: string;
  service_number: number | null;
  service_type: 'minor' | 'major' | null;
  is_free: number | null;
  late: boolean;
  /** Minutes past the drop time, when late. */
  late_min: number;
};

export type Place = { pool: Pool; drop_slot: DropSlot; total: number; used: number };
export type DayView = { date: string; today: string; bookings: DayBooking[]; places: Place[] };
export type StripDay = { date: string; cars: number; free: number | null };
export type FreeDay = { date: string; pools: Record<Pool, Record<DropSlot, number>> };

export type Hit = {
  customer_id: number;
  name: string;
  mobile_number: string;
  vehicle_id: number;
  registration_number: string;
  model: string;
  open_reference: string | null;
  open_date: string | null;
  open_slot: DropSlot | null;
};

export type Car = {
  id: number;
  registration_number: string;
  model: string;
  service_number: number | null;
  service_type: 'minor' | 'major' | null;
  is_free: number | null;
  due_date: string | null;
  blocker: string | null;
};
export type Customer = { id: number; name: string; mobile_number: string; cars: Car[] };

export type Booked = {
  id: number;
  reference: string;
  bookingDate: string;
  dropSlot: DropSlot;
  expectedPickup: string;
};

export type Team = 'customer-care' | 'retention' | 'service-manager' | 'crm-data' | 'reception';
export type Outcome = 'booked' | 'will_call_back' | 'no_answer' | 'not_interested' | 'wrong_number';

export type FollowUp = {
  id: number;
  created_at: string;
  reason: string;
  reason_label: string;
  team: Team;
  customer_name: string | null;
  mobile_number: string;
  vehicle_registration: string | null;
  vehicle_model: string | null;
  caller_words: string | null;
  status: 'open' | 'done';
  outcome: Outcome | null;
  outcome_label: string | null;
  note: string | null;
  closed_by: string | null;
  closed_at: string | null;
  session_id: string | null;
  waited_min: number;
};

export type TeamTile = {
  team: Team;
  title: string;
  open: number;
  oldestWaitingMin: number | null;
  doneToday: number;
};

export type FollowUpPage = {
  rows: FollowUp[];
  total: number;
  openTotal: number;
  teams: TeamTile[];
  week: { from: string; total: number; closed: number; booked: number; medianWaitMin: number | null };
  outcomes: Record<Outcome, string>;
};

export type FollowUpFilter = {
  status: 'open' | 'done' | 'all';
  when: 'today' | 'yesterday' | '7d' | 'all';
  teams: Team[];
  q: string;
  sort: 'oldest' | 'newest';
};

export type CallRow = {
  id: string;
  state: string;
  started_at: string;
  ended_at: string | null;
  caller_number: string;
  customer_name: string | null;
  known_name: string | null;
  model: string | null;
  registration: string | null;
  booking_reference: string | null;
  lead_reason: string | null;
  last_caller_words: string | null;
  turns: number;
};

export type CallDetail = {
  id: string;
  state: string;
  started_at: string;
  ended_at: string | null;
  data: Record<string, unknown>;
  transcript: { turn_index: number; speaker: 'agent' | 'caller'; text: string; created_at: string }[];
};

export type Master = Record<string, Record<Pool, Record<DropSlot, number>>>;
export type Applied = {
  from: string;
  to: string;
  created: number;
  updated: number;
  conflicts: { date: string; pool: Pool; dropSlot: DropSlot; requested: number; heldAt: number }[];
};

export type Summary = {
  today: string;
  centre: { id: number; name: string; landline: string; opens_at: string; closes_at: string };
  counts: { customers: number; vehicles: number; openBookings: number; leads: number };
};

export type KbCategory = 'cars' | 'services' | 'offers' | 'essentials';
export type KnowledgeEntry = {
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
export type Essentials = {
  name: string;
  address: string;
  landmark: string;
  days: string;
  opens: string;
  closes: string;
  desk: string;
  parking: string;
  waiting: string;
  payment: string[];
  pickup: boolean;
  pickupTerms: string;
  services: string[];
  languages: string[];
};
export type KnowledgeView = {
  today: string;
  entries: KnowledgeEntry[];
  essentials: Essentials;
  saved: boolean;
  updated_at: string | null;
  options: { payment: string[]; services: string[]; languages: string[] };
};
export type KnowledgeInput = {
  category: KbCategory;
  title: string;
  answer: string;
  phrases: string;
  validUntil: string | null;
};
export type AskResult =
  | { kind: 'answer'; key: string; title: string; answer: string; shortlisted: string[] }
  | { kind: 'passed' | 'cost' | 'not_a_question'; shortlisted: string[] };

/** One turn of the conversation — the same contract a voice layer receives. */
export type ChatReply = {
  sessionId: string;
  reply: string;
  ended: boolean;
  bookingReference?: string;
  sms?: string[];
};

/** A refusal the UI shows as a message rather than as a fault. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Anywhere a 401 lands, the app goes back to the sign-in page. */
let onSignedOut: () => void = () => {};
export const whenSignedOut = (fn: () => void) => {
  onSignedOut = fn;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; kind?: string };
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onSignedOut();
    throw new ApiError(body.error ?? `${res.status} ${res.statusText}`, res.status, body.kind);
  }
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export function followUpQuery(f: FollowUpFilter, extra: Record<string, string | number> = {}): string {
  const p = new URLSearchParams({
    status: f.status,
    when: f.when,
    sort: f.sort,
    ...(f.teams.length ? { teams: f.teams.join(',') } : {}),
    ...(f.q.trim() ? { q: f.q.trim() } : {}),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])),
  });
  return p.toString();
}

export const api = {
  me: () => request<Me>('/auth/me'),
  login: (userId: string, password: string) => request<Me>('/auth/login', json('POST', { userId, password })),
  signup: (centreName: string, userId: string, password: string) =>
    request<Me>('/auth/signup', json('POST', { centreName, userId, password })),
  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),
  setDemo: (demo: boolean) => request<Me>('/auth/demo', json('PUT', { demo })),
  resetDemo: () => request<{ ok: true; bookings: number; leads: number }>('/auth/demo/reset', { method: 'POST' }),

  summary: () => request<Summary>('/api/summary'),
  vehicles: () => request<{ id: number; customer_name: string; mobile_number: string; model: string }[]>('/api/vehicles'),
  day: (date?: string) => request<DayView>(`/api/day${date ? `?date=${date}` : ''}`),
  days: (n = 14) => request<StripDay[]>(`/api/days?days=${n}`),
  free: (n = 14) => request<FreeDay[]>(`/api/free?days=${n}`),
  search: (q: string) => request<Hit[]>(`/api/search?q=${encodeURIComponent(q)}`),
  customer: (id: number) => request<Customer>(`/api/customers/${id}`),

  booking: (reference: string) =>
    request<DayBooking & { call: { id: string; started_at: string } | null }>(`/api/bookings/${encodeURIComponent(reference)}`),
  book: (b: { vehicleId: number; pool: Pool; bookingDate: string; dropSlot: DropSlot; complaintNote?: string | null }) =>
    request<Booked>('/api/bookings', json('POST', b)),
  reschedule: (reference: string, bookingDate: string, dropSlot: DropSlot) =>
    request<Booked>(`/api/bookings/${reference}/reschedule`, json('POST', { bookingDate, dropSlot })),
  setStatus: (reference: string, status: 'completed' | 'cancelled') =>
    request<{ ok: true }>(`/api/bookings/${reference}`, json('PATCH', { status })),
  arrived: (reference: string, arrived: boolean) =>
    request<{ ok: true }>(`/api/bookings/${reference}`, json('PATCH', { arrived })),

  followUps: (f: FollowUpFilter, offset: number, limit = 10) =>
    request<FollowUpPage>(`/api/followups?${followUpQuery(f, { offset, limit })}`),
  changeFollowUp: (id: number, change: Record<string, unknown>) =>
    request<{ ok: true; changed: number }>(`/api/followups/${id}`, json('PATCH', change)),
  bulkFollowUps: (ids: number[], change: Record<string, unknown>) =>
    request<{ ok: true; changed: number }>('/api/followups/bulk', json('POST', { ids, ...change })),
  csvUrl: (f: FollowUpFilter, ids?: number[]) =>
    `/api/followups.csv?${followUpQuery(f, ids?.length ? { ids: ids.join(',') } : {})}`,

  calls: (days = 7) => request<{ date: string; from: string; rows: CallRow[] }>(`/api/calls?days=${days}`),
  call: (id: string) => request<CallDetail>(`/api/calls/${encodeURIComponent(id)}`),

  master: () => request<Master>('/api/capacity/master'),
  saveMaster: (m: Master) => request<{ ok: true; master: Master; applied: Applied }>('/api/capacity/master', json('PUT', m)),

  knowledge: () => request<KnowledgeView>('/api/knowledge'),
  addKnowledge: (k: KnowledgeInput) => request<{ ok: true; id: number }>('/api/knowledge', json('POST', k)),
  editKnowledge: (id: number, k: KnowledgeInput) => request<{ ok: true }>(`/api/knowledge/${id}`, json('PUT', k)),
  removeKnowledge: (id: number) => request<{ ok: true }>(`/api/knowledge/${id}`, { method: 'DELETE' }),
  saveEssentials: (e: Essentials) => request<{ ok: true }>('/api/knowledge/essentials', json('PUT', e)),
  ask: (question: string) => request<AskResult>('/api/knowledge/ask', json('POST', { question })),

  chatStart: (callerNumber: string) => request<ChatReply>('/api/chat/start', json('POST', { callerNumber })),
  chatTurn: (sessionId: string, utterance: string) =>
    request<ChatReply>('/api/chat/turn', json('POST', { sessionId, utterance })),
};
