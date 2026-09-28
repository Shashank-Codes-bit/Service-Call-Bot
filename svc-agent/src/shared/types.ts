/** The three capacity pools. A complaint moves a booking here regardless of
 *  what the CRM said the service was (D8). */
export const POOLS = ['minor', 'major', 'complaint'] as const;
export type Pool = (typeof POOLS)[number];

/** Drop-off is 08:30 or 14:00 (D7). Capacity is split by these (C1). */
export const DROP_SLOTS = ['morning', 'afternoon'] as const;
export type DropSlot = (typeof DROP_SLOTS)[number];

/** What the CRM returns for service type — never 'complaint' (D1). */
export type ServiceType = 'minor' | 'major';

/** Which channel created a booking. */
export type BookingSource = 'ai' | 'dealer';

/**
 * The nine routing outcomes (F2). Exactly the values of the leads.reason CHECK.
 * The two free-service cases are deliberately merged — the retention report
 * splits them again on `due_date IS NULL`.
 */
export const LEAD_REASONS = [
  'number_not_found',
  'model_not_recognised',
  'missing_required_field',
  'another_problem',
  'free_service_not_bookable',
  'existing_open_booking',
  'forced_full_day',
  'nothing_available_30_days',
  'same_day_demanded',
] as const;
export type LeadReason = (typeof LEAD_REASONS)[number];

/** D5: earliest bookable day is tomorrow, latest is 30 days out. */
export const BOOKING_WINDOW_DAYS = 30;

/** Only centre 1 is used (F6). */
export const CENTRE_ID = 1;

export const DROP_TIMES: Record<DropSlot, string> = {
  morning: '08:30',
  afternoon: '14:00',
};
