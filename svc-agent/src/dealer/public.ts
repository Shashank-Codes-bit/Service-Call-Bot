import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config.ts';
import { rateLimit } from '../auth.ts';
import { readEssentials } from '../kb/knowledge.ts';
import { addDemoCaller, allowedCaller, demoCallerCount, SAMPLE_CALLERS } from '../db/sample.ts';
import type { Accounts, Org } from '../orgs/accounts.ts';
import { dailyTurnCap, type OrgHandle, type Registry } from '../orgs/registry.ts';

/**
 * The public "Talk to the agent" page (`/try/<slug>`): what it shows about the
 * centre, and the conversation it drives. No sign-in — this is the link a
 * centre shares — so it hands out only what a visitor should see: the centre's
 * public essentials, the handful of sample callers, and Vapi's public key.
 * Never the customer list, never a booking, never a secret.
 */
/** Made-up callers one demo centre can have at once (cleared nightly). */
export const DEMO_CALLERS_PER_DAY = 50;

/** A caller's first open booking, and whether any of their cars is still free to book. */
function openBookings(h: OrgHandle, mobile: string): { booked: { date: string; slot: string } | null; canBook: boolean } {
  const rows = h.db
    .prepare(
      `SELECT v.id,
              (SELECT b.booking_date || ' ' || b.drop_slot FROM bookings b
                WHERE b.vehicle_id = v.id AND b.status = 'open' ORDER BY b.booking_date LIMIT 1) AS open
       FROM vehicles v JOIN customers c ON c.id = v.customer_id
       WHERE c.mobile_number = ?`,
    )
    .all(mobile) as { id: number; open: string | null }[];
  const first = rows.map((r) => r.open).filter((o): o is string => Boolean(o)).sort()[0];
  const [date, slot] = first?.split(' ') ?? [];
  return { booked: date && slot ? { date, slot } : null, canBook: rows.some((r) => !r.open) };
}

export function publicApi({
  accounts,
  registry,
  capFor,
}: {
  accounts: Accounts;
  registry: Registry;
  capFor: (org: Org) => () => number;
}): Router {
  const r = Router();

  const centre = (req: Request, res: Response): { org: Org; h: OrgHandle } | undefined => {
    const slug = String(req.params['slug'] ?? '').toLowerCase();
    const org = /^[a-z0-9][a-z0-9-]{1,29}$/.test(slug) ? accounts.get(slug) : undefined;
    const h = org && registry.get(slug);
    if (!org || !h) {
      res.status(404).json({ error: 'There is no centre at this address.' });
      return undefined;
    }
    return { org, h };
  };

  r.get('/:slug', rateLimit({ max: 60 }), (req, res) => {
    const c = centre(req, res);
    if (!c) return;
    const { essentials } = readEssentials(c.h.db);
    const name = (c.h.db.prepare(`SELECT name FROM centres WHERE id = 1`).get() as { name: string } | undefined)?.name ?? c.org.name;
    const callers = SAMPLE_CALLERS.map((s) => {
      const row = c.h.db
        .prepare(
          `SELECT c.name, (SELECT v.model FROM vehicles v WHERE v.customer_id = c.id ORDER BY v.id LIMIT 1) AS model
           FROM customers c WHERE c.mobile_number = ?`,
        )
        .get(s.mobile) as { name: string; model: string | null } | undefined;
      return row ? { name: row.name, model: row.model, mobile: s.mobile, shows: s.shows, ...openBookings(c.h, s.mobile) } : undefined;
    })
      .filter((x) => x !== undefined)
      // Who can book first: a caller whose every car is booked meets the
      // one-open-booking rule (D13), and the call ends there.
      .sort((a, b) => Number(!a.canBook) - Number(!b.canBook));
    res.json({
      slug: c.org.slug,
      name,
      address: essentials.address,
      landmark: essentials.landmark,
      days: essentials.days,
      opens: essentials.opens,
      closes: essentials.closes,
      callers,
      // A demo centre lets a visitor add a made-up caller of their own.
      demo: c.h.demo,
      voice:
        config.vapiPublicKey && config.vapiAssistantId
          ? { provider: 'vapi', publicKey: config.vapiPublicKey, assistantId: config.vapiAssistantId }
          : { provider: 'browser' },
    });
  });

  /**
   * "+ New demo caller": a made-up customer with one car and a paid service
   * due, so the visitor always has someone free to book. Demo centres only,
   * and a ceiling per centre per day (the nightly reset clears them).
   */
  r.post('/:slug/demo-caller', rateLimit({ max: 10 }), (req, res) => {
    const c = centre(req, res);
    if (!c) return;
    if (!c.h.demo) return res.status(403).json({ error: 'This centre isn’t taking demo callers.' });
    if (demoCallerCount(c.h.db) >= DEMO_CALLERS_PER_DAY) {
      return res.status(429).json({ error: 'That’s all the demo callers for today. Pick one above, or try tomorrow.' });
    }
    const d = addDemoCaller(c.h.db);
    res.status(201).json({ name: d.name, model: d.model, mobile: d.mobile, shows: 'a new demo caller', booked: null, canBook: true });
  });

  /**
   * The typed chat and the browser-voice path: the centre's own call router,
   * behind a tight per-visitor limit and the centre's daily cap.
   */
  r.use('/:slug/chat', rateLimit({ max: 20 }), (req: Request, res: Response, next: NextFunction) => {
    const c = centre(req, res);
    if (!c) return;
    if (req.path === '/start') {
      // Only the sample callers, or any number in demo mode — never someone
      // else's real record by guessing their number.
      const n = String(req.body?.callerNumber ?? '').replace(/\D/g, '');
      if (!allowedCaller(c.h, n)) {
        return res.status(403).json({ error: 'Pick one of the sample callers.' });
      }
    }
    dailyTurnCap(c.h.db, capFor(c.org))(req, res, (err?: unknown) => (err ? next(err) : c.h.call(req, res, next)));
  });

  return r;
}
