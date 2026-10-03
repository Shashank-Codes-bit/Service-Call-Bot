import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config.ts';
import { rateLimit } from '../auth.ts';
import { readEssentials } from '../kb/knowledge.ts';
import { SAMPLE_CALLERS } from '../db/sample.ts';
import type { Accounts, Org } from '../orgs/accounts.ts';
import { dailyTurnCap, type OrgHandle, type Registry } from '../orgs/registry.ts';

/**
 * The public "Talk to the agent" page (`/try/<slug>`): what it shows about the
 * centre, and the conversation it drives. No sign-in — this is the link a
 * centre shares — so it hands out only what a visitor should see: the centre's
 * public essentials, the handful of sample callers, and Vapi's public key.
 * Never the customer list, never a booking, never a secret.
 */
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
      return row ? { name: row.name, model: row.model, mobile: s.mobile, shows: s.shows } : undefined;
    }).filter(Boolean);
    res.json({
      slug: c.org.slug,
      name,
      address: essentials.address,
      landmark: essentials.landmark,
      days: essentials.days,
      opens: essentials.opens,
      closes: essentials.closes,
      callers,
      // A number nobody has: in demo mode the agent gives it a demo car.
      anyNumber: config.demoMode,
      voice:
        config.vapiPublicKey && config.vapiAssistantId
          ? { provider: 'vapi', publicKey: config.vapiPublicKey, assistantId: config.vapiAssistantId }
          : { provider: 'browser' },
    });
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
      if (!config.demoMode && !SAMPLE_CALLERS.some((s) => s.mobile === n)) {
        return res.status(403).json({ error: 'Pick one of the sample callers.' });
      }
    }
    dailyTurnCap(c.h.db, capFor(c.org))(req, res, (err?: unknown) => (err ? next(err) : c.h.call(req, res, next)));
  });

  return r;
}
