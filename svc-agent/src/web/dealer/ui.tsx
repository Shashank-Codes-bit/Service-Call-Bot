import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DropSlot, Pool, Team } from './api.ts';

// ---------------------------------------------------------------------------
// Words and numbers, the way the desk says them.
// ---------------------------------------------------------------------------

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `YYYY-MM-DD` read as a local calendar day, never as UTC midnight. */
export function dateOf(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}
export const isoOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const addDays = (iso: string, n: number) => {
  const d = dateOf(iso);
  d.setDate(d.getDate() + n);
  return isoOf(d);
};
export const dow = (iso: string) => DOW[dateOf(iso).getDay()]!;
export const dayNum = (iso: string) => dateOf(iso).getDate();
export const isWeekend = (iso: string) => dateOf(iso).getDay() % 6 === 0;
/** "Sat 3 Oct" */
export const shortDay = (iso: string) => {
  const d = dateOf(iso);
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
};
/** "Saturday 3 October" */
export const longDay = (iso: string) => {
  const d = dateOf(iso);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
/** "9:05" from a stored timestamp, which carries the centre's own offset. */
export const clock = (ts: string) => ts.slice(11, 16).replace(/^0/, '');
/** "today 9:05", "yesterday 18:10", "Wed 30 Sep 10:15" */
export function when(ts: string, today: string): string {
  const day = ts.slice(0, 10);
  const label = day === today ? 'today' : day === addDays(today, -1) ? 'yesterday' : shortDay(day);
  return `${label} ${clock(ts)}`;
}

export const SLOT: Record<DropSlot, { time: string; back: string; name: string }> = {
  morning: { time: '8:30', back: 'back the same evening', name: 'Morning' },
  afternoon: { time: '2:00', back: 'back the next day', name: 'Afternoon' },
};
/** The pool, as the desk calls it. The complaint pool is the fault-check places. */
export const POOL_NAME: Record<Pool, string> = { minor: 'Minor', major: 'Major', complaint: 'Fault' };

export const fmtPlate = (r: string) => r.replace(/^([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{4})$/, '$1 $2 $3 $4');
export const phone = (m: string) => `${m.slice(0, 5)} ${m.slice(5)}`;
export const ord = (n: number) =>
  n + (n % 100 > 10 && n % 100 < 14 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th');
export function jobText(type: string | null, isFree: number | null): string {
  if (!type) return 'Type unknown';
  return `${type === 'major' ? 'Major' : 'Minor'} · ${isFree ? 'free' : 'paid'}`;
}
export function dur(m: number): string {
  if (m < 60) return `${m} m`;
  if (m < 1440) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ''}`;
  return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
}
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const TEAMS: Record<Team, { name: string; dot: string }> = {
  retention: { name: 'Retention', dot: 't-retention' },
  'crm-data': { name: 'Data team', dot: 't-data' },
  'customer-care': { name: 'Customer care', dot: 't-care' },
  reception: { name: 'Reception', dot: 't-reception' },
  'service-manager': { name: 'Service manager', dot: 't-manager' },
};
export const TEAM_ORDER: Team[] = ['retention', 'crm-data', 'customer-care', 'reception', 'service-manager'];

/** Where a call went, in a few words, from what the session recorded. */
export function callOutcome(c: { booking_reference: string | null; lead_reason: string | null; state: string }, bookedLabel?: string) {
  if (c.booking_reference) return { kind: 'booked' as const, text: bookedLabel ?? 'Booked' };
  if (c.lead_reason) {
    const team = LEAD_TEAM[c.lead_reason];
    return { kind: 'lead' as const, text: team ? `Passed to ${TEAMS[team].name.toLowerCase()}` : 'Passed to the team' };
  }
  if (c.state !== 'ended') return { kind: 'info' as const, text: 'In progress or dropped' };
  return { kind: 'info' as const, text: 'Ended without a booking' };
}
const LEAD_TEAM: Record<string, Team> = {
  another_problem: 'customer-care',
  free_service_not_bookable: 'retention',
  forced_full_day: 'service-manager',
  nothing_available_30_days: 'service-manager',
  same_day_demanded: 'service-manager',
  number_not_found: 'crm-data',
  model_not_recognised: 'crm-data',
  missing_required_field: 'crm-data',
  existing_open_booking: 'reception',
};

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** The HSRP plate: the signature element, and the tab every card hangs from. */
export function Plate({ reg }: { reg: string }) {
  return (
    <span className="plate" aria-label={`Registration ${reg}`}>
      <span className="ind" aria-hidden="true">
        IND
      </span>
      <span className="num">{fmtPlate(reg)}</span>
    </span>
  );
}

export function TeamDot({ team }: { team: Team }) {
  return <span className={`tdot ${TEAMS[team]?.dot ?? ''}`} aria-hidden="true" />;
}

/** A side drawer with a scrim. Escape closes it; focus moves into it on open. */
export function Drawer({
  title,
  ctx,
  children,
  foot,
  onClose,
}: {
  title: string;
  ctx?: ReactNode;
  children: ReactNode;
  foot?: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      (el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>('button'))?.focus();
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header>
          <div>
            <h2>{title}</h2>
            {ctx && <div className="ctx">{ctx}</div>}
          </div>
          <button type="button" className="btn sm" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="body">{children}</div>
        {foot && <footer>{foot}</footer>}
      </aside>
    </>
  );
}

/** Copy to the clipboard, saying so on the button for a moment. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [said, setSaid] = useState('');
  return (
    <button
      type="button"
      className="btn sm"
      aria-label={`Copy ${phone(text)}`}
      onClick={() => {
        const done = (m: string) => {
          setSaid(m);
          setTimeout(() => setSaid(''), 1400);
        };
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => done('Copied'), () => done(phone(text)));
        else done(phone(text));
      }}
    >
      {said || label}
    </button>
  );
}

/** Run something async with a busy flag and a message for a refusal. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(undefined);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}
