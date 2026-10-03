import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { today } from '../shared/dates.ts';
import { answerQuestion, type CallDeps } from '../call/machine.ts';
import {
  createKnowledge,
  KnowledgeError,
  LANGUAGE_OPTIONS,
  listKnowledge,
  PAYMENT_OPTIONS,
  readEssentials,
  removeKnowledge,
  saveEssentials,
  SERVICE_OPTIONS,
  updateKnowledge,
} from '../kb/knowledge.ts';

/**
 * The Knowledge page. Every write lands in the table the agent reads on its
 * next turn — there is no publish step, so none of these routes has one.
 */
export function knowledgeApi(db: Database, deps: () => CallDeps): Router {
  const r = Router();

  const refusal = (res: import('express').Response, e: unknown) => {
    if (e instanceof KnowledgeError) return res.status(400).json({ error: e.message, kind: 'invalid' });
    throw e;
  };

  r.get('/', (_req, res) => {
    res.json({
      today: today(),
      entries: listKnowledge(db, today()),
      ...readEssentials(db),
      options: { payment: PAYMENT_OPTIONS, services: SERVICE_OPTIONS, languages: LANGUAGE_OPTIONS },
    });
  });

  r.post('/', (req, res) => {
    try {
      const id = createKnowledge(db, req.body ?? {});
      res.status(201).json({ ok: true, id });
    } catch (e) {
      refusal(res, e);
    }
  });

  r.put('/essentials', (req, res) => {
    try {
      saveEssentials(db, req.body ?? {});
      res.json({ ok: true, ...readEssentials(db) });
    } catch (e) {
      refusal(res, e);
    }
  });

  r.put('/:id', (req, res) => {
    try {
      if (!updateKnowledge(db, Number(req.params.id), req.body ?? {})) {
        return res.status(404).json({ error: 'no such entry' });
      }
      res.json({ ok: true });
    } catch (e) {
      refusal(res, e);
    }
  });

  r.delete('/:id', (req, res) => {
    const outcome = removeKnowledge(db, Number(req.params.id));
    if (outcome === 'not_found') return res.status(404).json({ error: 'no such entry' });
    if (outcome === 'essential') {
      return res.status(400).json({ error: 'Centre essentials are changed in their own form', kind: 'invalid' });
    }
    res.json({ ok: true });
  });

  /** What the agent would say — through the same code a call runs. */
  r.post('/ask', async (req, res) => {
    const question = String(req.body?.question ?? '').trim().slice(0, 300);
    if (question.length < 3) return res.status(400).json({ error: 'Type a question first' });
    res.json(await answerQuestion(db, deps(), question, today()));
  });

  return r;
}
