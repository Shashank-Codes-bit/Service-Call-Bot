import type { Database } from 'better-sqlite3';
import { addDays, today, weekdayOf, type IsoDate } from './dates.ts';
import { BOOKING_WINDOW_DAYS, DROP_SLOTS, POOLS, type DropSlot, type Pool } from './types.ts';

export type CapacityCell = { total: number; booked: number; free: number };
export type CapacityDay = {
  date: IsoDate;
  weekday: number;
  pools: Record<Pool, Record<DropSlot, CapacityCell>>;
};

/** A day whose master was cut below what is already booked. */
export type ShrinkConflict = {
  date: IsoDate;
  pool: Pool;
  dropSlot: DropSlot;
  requested: number;
  heldAt: number;
};

export type RegenerateResult = {
  from: IsoDate;
  to: IsoDate;
  created: number;
  updated: number;
  /** Days the dealer's cut could not fully apply to. Surfaced, never swallowed. */
  conflicts: ShrinkConflict[];
};

/**
 * Ensure slot_capacity covers `today..today+30` and refresh totals from the
 * weekday master.
 *
 * Three rules, all deliberate:
 *
 * 1. **Never touch the past.** Dates before today are history — a dealer
 *    editing next Tuesday's master must not rewrite last Tuesday.
 * 2. **Never break the CHECK.** A reduced master is clamped to
 *    `MAX(master, booked_slots)`, so `booked_slots > total_slots` is
 *    unreachable even when the dealer cuts capacity below what they've sold.
 * 3. **Report what didn't apply.** Clamped days come back in `conflicts`. A cut
 *    that silently didn't take effect is worse than one that's refused.
 *
 * Rerunning this also walks the window forward, which is what keeps the
 * database from going stale as days pass.
 */
export function regenerateCapacity(
  db: Database,
  { now = new Date(), days = BOOKING_WINDOW_DAYS }: { now?: Date; days?: number } = {},
): RegenerateResult {
  const from = today(now);
  const to = addDays(from, days);

  const centres = db.prepare(`SELECT id FROM centres ORDER BY id`).all() as { id: number }[];
  const masterFor = db.prepare(
    `SELECT total_slots FROM capacity_master
     WHERE weekday = ? AND service_type = ? AND drop_slot = ?`,
  );
  const existing = db.prepare(
    `SELECT total_slots, booked_slots FROM slot_capacity
     WHERE centre_id = ? AND date = ? AND service_type = ? AND drop_slot = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO slot_capacity (centre_id, date, service_type, drop_slot, total_slots, booked_slots)
     VALUES (?, ?, ?, ?, ?, 0)`,
  );
  const update = db.prepare(
    `UPDATE slot_capacity SET total_slots = ?
     WHERE centre_id = ? AND date = ? AND service_type = ? AND drop_slot = ?`,
  );

  const result: RegenerateResult = { from, to, created: 0, updated: 0, conflicts: [] };

  db.transaction(() => {
    for (let offset = 0; offset <= days; offset++) {
      const date = addDays(from, offset);
      const weekday = weekdayOf(date);

      for (const pool of POOLS) {
        for (const dropSlot of DROP_SLOTS) {
          const master = masterFor.get(weekday, pool, dropSlot) as
            | { total_slots: number }
            | undefined;
          if (!master) continue; // master row missing — leave the day alone

          for (const { id: centreId } of centres) {
            const row = existing.get(centreId, date, pool, dropSlot) as
              | { total_slots: number; booked_slots: number }
              | undefined;

            if (!row) {
              insert.run(centreId, date, pool, dropSlot, master.total_slots);
              result.created++;
              continue;
            }

            // Rule 2: a cut can never go below what is already sold.
            const clamped = Math.max(master.total_slots, row.booked_slots);
            if (clamped !== row.total_slots) {
              update.run(clamped, centreId, date, pool, dropSlot);
              result.updated++;
            }
            // Rule 3: say so when the cut didn't fully land.
            if (master.total_slots < row.booked_slots) {
              result.conflicts.push({
                date,
                pool,
                dropSlot,
                requested: master.total_slots,
                heldAt: row.booked_slots,
              });
            }
          }
        }
      }
    }
  })();

  return result;
}

/** The live window, shaped for the dealer grid. */
export function capacityWindow(
  db: Database,
  centreId: number,
  { now = new Date(), days = BOOKING_WINDOW_DAYS }: { now?: Date; days?: number } = {},
): CapacityDay[] {
  const from = today(now);
  const rows = db
    .prepare(
      `SELECT date, service_type, drop_slot, total_slots, booked_slots
       FROM slot_capacity
       WHERE centre_id = ? AND date >= ? AND date <= ?
       ORDER BY date`,
    )
    .all(centreId, from, addDays(from, days)) as Array<{
    date: IsoDate;
    service_type: Pool;
    drop_slot: DropSlot;
    total_slots: number;
    booked_slots: number;
  }>;

  const byDate = new Map<IsoDate, CapacityDay>();
  for (const r of rows) {
    let day = byDate.get(r.date);
    if (!day) {
      day = {
        date: r.date,
        weekday: weekdayOf(r.date),
        pools: Object.fromEntries(
          POOLS.map((p) => [
            p,
            Object.fromEntries(DROP_SLOTS.map((s) => [s, { total: 0, booked: 0, free: 0 }])),
          ]),
        ) as CapacityDay['pools'],
      };
      byDate.set(r.date, day);
    }
    day.pools[r.service_type][r.drop_slot] = {
      total: r.total_slots,
      booked: r.booked_slots,
      free: r.total_slots - r.booked_slots,
    };
  }

  return [...byDate.values()];
}

/** The 7x6 master, shaped as the grid the dealer edits. */
export function readMaster(db: Database): Record<number, Record<Pool, Record<DropSlot, number>>> {
  const rows = db
    .prepare(`SELECT weekday, service_type, drop_slot, total_slots FROM capacity_master`)
    .all() as Array<{ weekday: number; service_type: Pool; drop_slot: DropSlot; total_slots: number }>;

  const grid = Object.fromEntries(
    Array.from({ length: 7 }, (_, w) => [
      w,
      Object.fromEntries(POOLS.map((p) => [p, Object.fromEntries(DROP_SLOTS.map((s) => [s, 0]))])),
    ]),
  ) as Record<number, Record<Pool, Record<DropSlot, number>>>;

  for (const r of rows) grid[r.weekday]![r.service_type][r.drop_slot] = r.total_slots;
  return grid;
}

/** Save edits to the master. Regeneration is a separate call; the portal's
 *  save route runs both in one transaction so a saved figure always applies. */
export function writeMaster(
  db: Database,
  grid: Record<number, Record<Pool, Record<DropSlot, number>>>,
): void {
  const upsert = db.prepare(
    `UPDATE capacity_master SET total_slots = ?
     WHERE weekday = ? AND service_type = ? AND drop_slot = ?`,
  );
  db.transaction(() => {
    for (let weekday = 0; weekday <= 6; weekday++) {
      for (const pool of POOLS) {
        for (const dropSlot of DROP_SLOTS) {
          const v = grid[weekday]?.[pool]?.[dropSlot];
          if (typeof v !== 'number' || v < 0 || !Number.isInteger(v)) {
            throw new Error(`bad master value at ${weekday}/${pool}/${dropSlot}: ${v}`);
          }
          upsert.run(v, weekday, pool, dropSlot);
        }
      }
    }
  })();
}
