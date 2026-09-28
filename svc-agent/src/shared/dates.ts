/**
 * Date arithmetic — local time throughout.
 *
 * I4-7: the earlier build mixed `toISOString()` (UTC) with local date methods.
 * In IST (UTC+05:30) that silently shifts every date back a day for any run
 * between 00:00 and 05:30 local. Nothing here touches `toISOString`, and
 * nothing parses a date string with `new Date(str)` — which would read
 * "2026-09-06" as UTC midnight and hit the same bug from the other side.
 */

/** A calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

const pad = (n: number) => String(n).padStart(2, '0');

/** The one weekday table. Was duplicated in four files. */
export const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

/** Format a Date as `YYYY-MM-DD` using its LOCAL calendar fields. */
export function toIsoDate(d: Date): IsoDate {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse `YYYY-MM-DD` into a Date at LOCAL midnight. */
export function parseIsoDate(s: IsoDate): Date {
  const parts = s.split('-');
  if (parts.length !== 3) throw new Error(`Bad date: ${s}`);
  const [y, m, d] = parts.map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  // Reject impossible dates that JS would silently roll over (2026-02-30).
  if (toIsoDate(date) !== s) throw new Error(`Bad date: ${s}`);
  return date;
}

/** Today's local calendar date. */
export function today(now: Date = new Date()): IsoDate {
  return toIsoDate(now);
}

/**
 * Add days to a date. Goes through local Date so DST and month/year ends are
 * handled by the platform rather than by hand.
 */
export function addDays(from: IsoDate, days: number): IsoDate {
  const d = parseIsoDate(from);
  d.setDate(d.getDate() + days);
  return toIsoDate(d);
}

/** Whole days from `a` to `b`; negative when `b` is earlier. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  const ms = parseIsoDate(b).getTime() - parseIsoDate(a).getTime();
  // Round rather than floor: a DST boundary makes the span 23 or 25 hours.
  return Math.round(ms / 86_400_000);
}

/** 0 = Sunday .. 6 = Saturday, matching `capacity_master.weekday`. */
export function weekdayOf(date: IsoDate): number {
  return parseIsoDate(date).getDay();
}

/** An ISO timestamp in local time with offset, e.g. `2026-09-06T14:30:00+05:30`. */
export function timestamp(now: Date = new Date()): string {
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${toIsoDate(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
