import type { Database } from 'better-sqlite3';
import { timestamp } from '../shared/dates.ts';
import type { ServiceDueRecord } from '../shared/service-due.ts';
import type { KnownVehicle } from './types.ts';

export type CrmAccount = {
  customerId: number;
  name: string;
  mobile: string;
  vehicles: KnownVehicle[];
};

/**
 * The dealer's data, behind an interface (C1).
 *
 * Vehicle and service-due records belong to the dealer and will one day be a
 * real integration, so the call app never reads those tables directly — it
 * goes through here. Today the implementation is a local query; tomorrow it is
 * an HTTP client against the dealer app, and later a real DMS adapter. The
 * state machine does not change either time.
 *
 * Capacity is deliberately **not** here: we own that permanently (D4), so the
 * call app writes it directly.
 */
export interface Crm {
  findByMobile(mobile: string): Promise<CrmAccount | null>;
}

/** Prefetched at identification (E5) — never at the moment we need to speak it. */
export class LocalCrm implements Crm {
  constructor(private readonly db: Database) {}

  async findByMobile(mobile: string): Promise<CrmAccount | null> {
    const customer = this.db
      .prepare(`SELECT id, name, mobile_number FROM customers WHERE mobile_number = ?`)
      .get(mobile) as { id: number; name: string; mobile_number: string } | undefined;
    if (!customer) return null;

    const rows = this.db
      .prepare(
        `SELECT v.id, v.registration_number, v.model,
                s.service_number, s.service_type, s.is_free, s.due_date
         FROM vehicles v LEFT JOIN service_due s ON s.vehicle_id = v.id
         WHERE v.customer_id = ? ORDER BY v.id`,
      )
      .all(customer.id) as Array<{
      id: number;
      registration_number: string;
      model: string;
      service_number: number | null;
      service_type: 'minor' | 'major' | null;
      is_free: number | null;
      due_date: string | null;
    }>;

    return {
      customerId: customer.id,
      name: customer.name,
      mobile: customer.mobile_number,
      vehicles: rows.map((r) => ({
        id: r.id,
        registration: r.registration_number,
        model: r.model,
        due:
          r.service_number === null
            ? null
            : ({
                service_number: r.service_number,
                service_type: r.service_type,
                is_free: r.is_free ?? 0,
                due_date: r.due_date,
              } satisfies ServiceDueRecord),
      })),
    };
  }
}

/** Every demo vehicle's registration starts with this, so they are easy to find and clear. */
export const DEMO_PLATE_PREFIX = 'DEMO';

/**
 * DEMO_MODE only. A number the CRM has never seen gets a customer and one car,
 * so a stranger on the public demo can reach a real booking instead of
 * `number_not_found`. The state machine never learns the difference — this is
 * what the `Crm` seam is for.
 *
 * One record per number, so a caller who comes back is the same customer and
 * D13 still applies; closing the booking from Arrivals lets them go again.
 * The car is a paid minor service with no due date: nothing in D2 can refuse
 * it, and it comes back the same evening — the demo shows the good path.
 */
export class DemoCrm implements Crm {
  constructor(
    private readonly db: Database,
    private readonly inner: Crm,
  ) {}

  async findByMobile(mobile: string): Promise<CrmAccount | null> {
    const found = await this.inner.findByMobile(mobile);
    if (found) return found;

    const at = timestamp();
    this.db.transaction(() => {
      // OR IGNORE: two first turns from the same number must not collide.
      this.db
        .prepare(`INSERT OR IGNORE INTO customers (mobile_number, name, created_at) VALUES (?, 'Guest', ?)`)
        .run(mobile, at);
      const { id } = this.db
        .prepare(`SELECT id FROM customers WHERE mobile_number = ?`)
        .get(mobile) as { id: number };
      this.db
        .prepare(`INSERT OR IGNORE INTO vehicles (customer_id, registration_number, model) VALUES (?, ?, 'Swift')`)
        .run(id, `${DEMO_PLATE_PREFIX}${mobile}`);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO service_due (vehicle_id, service_number, service_type, is_free, due_date)
           SELECT id, 2, 'minor', 0, NULL FROM vehicles WHERE registration_number = ?`,
        )
        .run(`${DEMO_PLATE_PREFIX}${mobile}`);
    })();

    // Read back through the real path, so the shape is exactly what LocalCrm returns.
    return this.inner.findByMobile(mobile);
  }
}
