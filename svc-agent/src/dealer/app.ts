import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import {
  cookie,
  rateLimit,
  readSession,
  requireCallSecret,
  requireOrg,
  SESSION_COOKIE,
  SESSION_HOURS,
  sessionCookie,
  signSession,
} from '../auth.ts';
import { today } from '../shared/dates.ts';
import { AccountError, initials, type Accounts, type Org } from '../orgs/accounts.ts';
import { dailyTurnCap, turnsToday, type OrgHandle, type Registry } from '../orgs/registry.ts';
import { callIdentity } from '../call/vapi.ts';
import { publicApi } from './public.ts';

/**
 * The whole HTTP surface, built over a set of centres. Kept apart from the
 * boot in server.ts so tests can drive it without a listening port.
 */
export function buildApp({
  accounts,
  registry,
  dist,
}: {
  accounts: Accounts;
  registry: Registry;
  /** The built portal; absent in tests. */
  dist?: string;
}): express.Express {
  const secret = () => accounts.secret(config.sessionSecret);
  const capFor = (org: Org) => () => org.daily_turn_cap ?? config.orgDailyTurns;

  const app = express();
  if (config.behindProxy) app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  // -------------------------------------------------------------------------
  // Sign-in. Rate limited hard: these are the doors anyone on the internet can
  // knock on, and each password check is deliberately slow.
  // -------------------------------------------------------------------------

  const auth = express.Router();

  function startSession(res: express.Response, org: Org) {
    const { value } = signSession(org, secret());
    res.setHeader('set-cookie', sessionCookie(value, SESSION_HOURS * 3600));
  }

  /** The name the centre gave itself in Centre essentials, which can change after sign-up. */
  const nameOf = (org: Org): string => {
    const row = registry.get(org.slug)?.db.prepare(`SELECT name FROM centres WHERE id = 1`).get() as
      | { name: string }
      | undefined;
    return row?.name || org.name;
  };

  const me = (org: Org) => {
    const name = nameOf(org);
    return { slug: org.slug, name, userId: org.user_id, initials: initials(name), today: today() };
  };

  auth.post('/login', rateLimit({ max: 10 }), (req, res) => {
    const org = accounts.verify(String(req.body?.userId ?? ''), String(req.body?.password ?? ''));
    if (!org) return res.status(401).json({ error: 'That user ID and password don’t match.', kind: 'unauthorised' });
    startSession(res, org);
    res.json(me(org));
  });

  auth.post('/signup', rateLimit({ windowMs: 60 * 60_000, max: 5 }), (req, res) => {
    try {
      const org = accounts.create({
        name: String(req.body?.centreName ?? ''),
        userId: String(req.body?.userId ?? ''),
        password: String(req.body?.password ?? ''),
      });
      startSession(res, org);
      res.status(201).json(me(org));
    } catch (e) {
      if (e instanceof AccountError) {
        return res.status(e.kind === 'taken' ? 409 : 400).json({ error: e.message, kind: e.kind });
      }
      throw e;
    }
  });

  auth.post('/logout', (_req, res) => {
    res.setHeader('set-cookie', sessionCookie('', 0));
    res.json({ ok: true });
  });

  auth.get('/me', (req, res) => {
    const org = readSession(cookie(req, SESSION_COOKIE), accounts, secret());
    if (!org) return res.status(401).json({ error: 'Please sign in', kind: 'unauthorised' });
    const h = registry.get(org.slug);
    res.json({ ...me(org), turnsToday: h ? turnsToday(h.db) : 0, turnCap: capFor(org)() });
  });

  app.use('/auth', auth);

  // -------------------------------------------------------------------------
  // The portal and its chat panel: signed in, and only ever the signed-in
  // centre's own file.
  // -------------------------------------------------------------------------

  const signedIn = requireOrg(accounts, secret);
  const handleOf = (res: express.Response): OrgHandle | undefined =>
    registry.get((res.locals['org'] as Org).slug);

  app.use('/api/chat', rateLimit({ max: 30 }), signedIn, (req, res, next) => {
    const h = handleOf(res);
    if (!h) return res.status(404).json({ error: 'no such centre' });
    dailyTurnCap(h.db, capFor(res.locals['org'] as Org))(req, res, (err?: unknown) =>
      err ? next(err) : h.call(req, res, next),
    );
  });

  app.use('/api', rateLimit({ max: 600 }), signedIn, (req, res, next) => {
    const h = handleOf(res);
    if (!h) return res.status(404).json({ error: 'no such centre' });
    h.api(req, res, next);
  });

  // -------------------------------------------------------------------------
  // The voice layer: a shared secret, and the centre named by `x-org`,
  // `?org=`, or (a web call from the public page) the call's own variables —
  // else the first one.
  // -------------------------------------------------------------------------

  function voice(pick: (h: OrgHandle) => express.Router, { capInVoice = false } = {}): express.RequestHandler {
    return (req, res, next) => {
      const slug = String(req.get('x-org') ?? req.query['org'] ?? callIdentity(req.body).org ?? config.defaultOrg);
      const org = accounts.get(slug);
      const h = org && registry.get(slug);
      if (!org || !h) return res.status(404).json({ error: `no centre ${slug}` });
      // Vapi speaks the cap itself (vapi.ts): a 429 would be dead air.
      if (capInVoice) return pick(h)(req, res, next);
      dailyTurnCap(h.db, capFor(org))(req, res, (err?: unknown) =>
        err ? next(err) : pick(h)(req, res, next),
      );
    };
  }
  app.use('/call', rateLimit({ max: 120 }), requireCallSecret, voice((h) => h.call));
  app.use('/vapi', rateLimit({ max: 240 }), requireCallSecret, voice((h) => h.vapi, { capInVoice: true }));

  // The public "Talk to the agent" page's data and its typed / browser-voice
  // conversation. No sign-in: it is the page a centre shares.
  app.use('/public', publicApi({ accounts, registry, capFor }));

  // The platform needs somewhere to check we are alive that costs nothing.
  app.get('/health', (_req, res) => res.json({ ok: true, today: new Date().toISOString() }));

  // An unknown /api path is a client bug and should say so in JSON. Without
  // this the SPA catch-all below answers it with index.html and a 200, so a
  // mistyped endpoint — or one that has been removed — looks like it worked.
  app.use(['/api', '/auth', '/public'], (_req, res) => res.status(404).json({ error: 'no such endpoint' }));

  if (dist && existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/.*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
  } else {
    app.get('/', (_req, res) =>
      res
        .status(503)
        .type('text/plain')
        .send('Frontend not built yet. Run `npm run build:web`, or use `npm run dev:web`.'),
    );
  }

  // Anything reaching here is a genuine fault — expected outcomes like a full
  // slot or a bad password already returned their own status.
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      console.error(err);
      res.status(500).json({ error: err.message });
    },
  );

  return app;
  }
