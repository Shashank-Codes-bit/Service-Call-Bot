import type { CapacityDay } from './capacity.ts';
import { addDays, today, type IsoDate } from './dates.ts';
import { BOOKING_WINDOW_DAYS, type DropSlot, type Pool } from './types.ts';

/** Which drop slots a day can actually take (D6). */
export type DayOffer = 'both' | 'morning' | 'afternoon' | 'none';

export type BookableDay = {
  date: IsoDate;
  weekday: number;
  offer: Exclude<DayOffer, 'none'>;
};

export type Window = { earliest: IsoDate; latest: IsoDate };

/**
 * The bookable window (D5): tomorrow to +30, never today.
 *
 * Takes the call's start time, never the clock. A call starting at 23:59 on
 * the 26th offers the 27th and must keep offering it after midnight — reading
 * `new Date()` here would withdraw the day mid-sentence.
 */
export function bookingWindow(callStartedAt: Date): Window {
  const callDate = today(callStartedAt);
  return {
    earliest: addDays(callDate, 1),
    latest: addDays(callDate, BOOKING_WINDOW_DAYS),
  };
}

export function isWithinWindow(date: IsoDate, window: Window): boolean {
  return date >= window.earliest && date <= window.latest;
}

/**
 * What a day can offer for a pool (D6). Available if either slot has room;
 * where only one is free the agent states it rather than asking a question
 * whose answer is already determined.
 */
export function dayOffer(day: CapacityDay, pool: Pool): DayOffer {
  const morning = day.pools[pool].morning.free > 0;
  const afternoon = day.pools[pool].afternoon.free > 0;
  if (morning && afternoon) return 'both';
  if (morning) return 'morning';
  if (afternoon) return 'afternoon';
  return 'none';
}

/**
 * Every day in the window that can take this job, in date order. Pure over the
 * rows `capacityWindow()` already returned. An empty result is the
 * `nothing_available_30_days` outcome — F3's loudest alarm.
 */
export function findBookable(days: CapacityDay[], pool: Pool, window: Window): BookableDay[] {
  const out: BookableDay[] = [];
  for (const day of days) {
    if (!isWithinWindow(day.date, window)) continue;
    const offer = dayOffer(day, pool);
    if (offer === 'none') continue;
    out.push({ date: day.date, weekday: day.weekday, offer });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** What a specific day can offer, or undefined if it is outside the window. */
export function offerForDate(
  days: CapacityDay[],
  date: IsoDate,
  pool: Pool,
  window: Window,
): DayOffer | undefined {
  if (!isWithinWindow(date, window)) return undefined;
  const day = days.find((d) => d.date === date);
  return day ? dayOffer(day, pool) : undefined;
}

/** The next two available days after a full one (D6). Two, not a list: E0
 *  allows at most two options per turn. */
export function nextTwoAvailable(
  days: CapacityDay[],
  pool: Pool,
  window: Window,
  after: IsoDate,
): BookableDay[] {
  return findBookable(days, pool, window)
    .filter((d) => d.date > after)
    .slice(0, 2);
}

/** The first day that can take the job — used when the caller has no preference. */
export function firstAvailable(
  days: CapacityDay[],
  pool: Pool,
  window: Window,
): BookableDay | undefined {
  return findBookable(days, pool, window)[0];
}

/** Guards the agent against confirming a slot it cannot actually take. */
export function canTake(day: CapacityDay, pool: Pool, dropSlot: DropSlot): boolean {
  return day.pools[pool][dropSlot].free > 0;
}
