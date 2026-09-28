// The browser reads the same definitions the server does. shared/ has no node
// imports, which is what makes one source of truth possible across both.
export { DROP_SLOTS, POOLS, type DropSlot, type Pool } from '../../shared/types.ts';
export { WEEKDAY_NAMES as WEEKDAYS } from '../../shared/dates.ts';
import { DROP_TIMES, type DropSlot, type Pool } from '../../shared/types.ts';

/** The drop clock time for a slot that arrived as loose JSON. */
export function dropTime(slot: unknown): string {
  return slot === 'morning' || slot === 'afternoon' ? DROP_TIMES[slot] : '';
}

export type Cell = { total: number; booked: number; free: number };
export type CapacityDay = {
  date: string;
  weekday: number;
  pools: Record<Pool, Record<DropSlot, Cell>>;
};
export type Master = Record<string, Record<Pool, Record<DropSlot, number>>>;

export type Conflict = {
  date: string;
  pool: Pool;
  dropSlot: DropSlot;
  requested: number;
  heldAt: number;
};

export type Applied = {
  from: string;
  to: string;
  created: number;
  updated: number;
  conflicts: Conflict[];
};

export type Vehicle = {
  id: number;
  registration_number: string;
  model: string;
  customer_name: string;
  mobile_number: string;
  service_type: Pool | null;
  is_free: number;
  due_date: string | null;
  has_open_booking: number;
};

export type CallRow = {
  id: string;
  state: string;
  started_at: string;
  ended_at: string | null;
  caller_number: string;
  customer_name: string | null;
  model: string | null;
  registration: string | null;
  booking_reference: string | null;
  lead_reason: string | null;
  external_id: string | null;
  turns: number;
};

export type CallDetail = {
  id: string;
  state: string;
  started_at: string;
  data: Record<string, string | undefined>;
  transcript: { turn_index: number; speaker: 'agent' | 'caller'; text: string }[];
};

export type KbEntry = { key: string; answer: string };

/** One turn of the conversation — the same contract a voice layer receives. */
export type ChatReply = {
  sessionId: string;
  reply: string;
  ended: boolean;
  /** The agent is waiting for a number — a phone would switch to its keypad. */
  expectsDigits?: boolean;
  bookingReference?: string;
  leadReason?: string;
  /** DEMO_MODE only: what the caller's phone would have received this turn. */
  sms?: string[];
};

export type Report = {
  audience: string;
  title: string;
  why: string;
  date: string;
  rows: Record<string, unknown>[];
  groups?: { label: string; hint: string; rows: Record<string, unknown>[] }[];
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error?: string; kind?: string; reference?: string },
  ) {
    super(body.error ?? `request failed (${status})`);
  }
}

/**
 * The admin password, held for this tab only.
 *
 * Reads need none — the portal link is meant to be shareable. Only writes
 * carry it, and it is asked for once, when the first write is attempted,
 * rather than gating the whole page behind a login nobody needs.
 */
const PASSWORD_KEY = 'svc-agent-admin';

function storedPassword(): string {
  try {
    return sessionStorage.getItem(PASSWORD_KEY) ?? '';
  } catch {
    return ''; // private window, or storage blocked
  }
}

function rememberPassword(value: string): void {
  try {
    sessionStorage.setItem(PASSWORD_KEY, value);
  } catch {
    /* nothing to do; the header still goes on this request */
  }
}

function forgetPassword(): void {
  try {
    sessionStorage.removeItem(PASSWORD_KEY);
  } catch {
    /* ignore */
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body) headers['content-type'] = 'application/json';
  const password = storedPassword();
  if (password) headers['x-admin-password'] = password;

  const res = await fetch(`/api${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A rejected password should not stay cached, or every later write fails
    // silently with the same stale value.
    if (res.status === 401) forgetPassword();
    throw new ApiError(res.status, body);
  }
  return body as T;
}

/**
 * Run a write, asking for the password if the server rejects it, then retry
 * once. One prompt at the moment it is needed.
 */
export async function withPassword<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    // 503 means the server has no password configured at all — prompting
    // would be asking for something that cannot work.
    if ((e as ApiError).status !== 401) throw e;
    const entered = window.prompt('Admin password to make changes:');
    if (!entered) throw e;
    rememberPassword(entered);
    return run();
  }
}

export const api = {
  summary: () =>
    request<{
      today: string;
      centre: { name: string; landline: string; opens_at: string; closes_at: string };
      counts: Record<string, number>;
    }>('/summary'),

  master: () => request<Master>('/capacity/master'),
  /** Saving applies to the live window too, and reports what could not shrink. */
  saveMaster: (m: Master) =>
    request<{ ok: true; master: Master; applied: Applied }>('/capacity/master', {
      method: 'PUT',
      body: JSON.stringify(m),
    }),
  regenerate: () => request<Applied>('/capacity/regenerate', { method: 'POST' }),
  window: (days = 30) => request<CapacityDay[]>(`/capacity/window?days=${days}`),

  vehicles: () => request<Vehicle[]>('/vehicles'),
  arrivals: (date: string) =>
    request<{ date: string; rows: Record<string, unknown>[] }>(`/bookings/arrivals?date=${date}`),
  book: (b: { vehicleId: number; pool: Pool; bookingDate: string; dropSlot: DropSlot }) =>
    request<{ reference: string; bookingDate: string; dropSlot: DropSlot; expectedPickup: string }>(
      '/bookings',
      { method: 'POST', body: JSON.stringify(b) },
    ),
  closeBooking: (reference: string, status: 'completed' | 'cancelled') =>
    request<{ ok: true }>(`/bookings/${encodeURIComponent(reference)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  chatStart: (callerNumber: string) =>
    request<ChatReply>('/chat/start', { method: 'POST', body: JSON.stringify({ callerNumber }) }),
  chatTurn: (sessionId: string, utterance: string) =>
    request<ChatReply>('/chat/turn', {
      method: 'POST',
      body: JSON.stringify({ sessionId, utterance }),
    }),

  calls: (date: string) => request<{ date: string; rows: CallRow[] }>(`/calls?date=${date}`),
  call: (id: string) => request<CallDetail>(`/calls/${id}`),

  kb: () => request<KbEntry[]>('/kb'),
  saveKb: (key: string, answer: string) =>
    request<{ ok: true; entries: KbEntry[] }>(`/kb/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ answer }),
    }),
  deleteKb: (key: string) =>
    request<{ ok: true; entries: KbEntry[] }>(`/kb/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }),

  reportList: () => request<{ audience: string; title: string; why: string }[]>('/reports'),
  report: (audience: string, date: string) =>
    request<Report>(`/reports/${audience}?date=${date}`),
};
