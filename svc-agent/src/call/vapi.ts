import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { handleTurn, startCall, type CallDeps } from './machine.ts';
import { buildDeps, sessionIdForExternal } from './http.ts';
import { loadSession } from './session.ts';

/**
 * The Vapi adapter. Its custom-LLM mode expects an OpenAI-compatible
 * `/chat/completions` streaming SSE; this translates that shape onto our
 * state machine and nothing more. The machine does not know Vapi exists.
 *
 * The load-bearing detail: Vapi resends the whole message history every turn,
 * because that is how a stateless LLM is driven. We ignore it. Our state is
 * server-side and keyed on a session (F5); reading the history would give two
 * sources of truth that disagree the first time a turn is retried.
 *
 * So: newest user message, Vapi's call id, our session, one turn.
 */

type OpenAIMessage = { role: string; content?: unknown };

type VapiBody = {
  messages?: OpenAIMessage[];
  stream?: boolean;
  /** Vapi nests the live call under `call`, with the caller under `customer`. */
  call?: { id?: string; customer?: { number?: string } };
  customer?: { number?: string };
  metadata?: Record<string, unknown>;
};

/** Content may be a plain string or OpenAI's array-of-parts form. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : ((part as { text?: string })?.text ?? '')))
      .join(' ');
  }
  return '';
}

function latestUserUtterance(messages: OpenAIMessage[] = []): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') return textOf(m.content).trim();
  }
  return '';
}

/** One SSE chunk in OpenAI's streaming shape. */
function chunk(id: string, delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'svc-agent',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

export function vapiApi(db: Database, deps: CallDeps = buildDeps(db)): Router {
  const r = Router();

  r.post('/chat/completions', async (req, res) => {
    const body = (req.body ?? {}) as VapiBody;

    const externalId = body.call?.id ?? String(body.metadata?.['callId'] ?? '');
    const callerNumber = (body.call?.customer?.number ?? body.customer?.number ?? '').replace(
      /\D/g,
      '',
    );
    const utterance = latestUserUtterance(body.messages);

    if (!externalId) {
      return res.status(400).json({ error: { message: 'no call id on the request' } });
    }

    let reply: string;
    try {
      // First turn of this call: no session yet, so open one. Vapi's greeting
      // and ours would collide, so its assistant must be configured with no
      // first message of its own — we speak first.
      let sessionId = sessionIdForExternal(db, externalId);

      if (!sessionId) {
        const opened = await startCall(db, callerNumber || '0000000000', new Date(), externalId);
        sessionId = opened.sessionId;
        // If Vapi already has audio from the caller, answer it rather than
        // making them repeat themselves; otherwise open with the greeting.
        reply = utterance
          ? (await handleTurn(db, deps, sessionId, utterance)).reply
          : opened.reply;
      } else if (!utterance) {
        // A turn with nothing in it — stay put rather than advancing the flow
        // on silence.
        reply = '';
      } else {
        const session = loadSession(db, sessionId);
        reply = session?.state === 'ended'
          ? ''
          : (await handleTurn(db, deps, sessionId, utterance)).reply;
      }
    } catch (err) {
      // The caller is on a live phone line. They hear a sentence, never a
      // stack trace, and the call stays up.
      console.error('vapi turn failed', err);
      reply = "Sorry, I lost that for a moment. Could you say it again?";
    }

    // Non-streaming is supported for easy curl testing; Vapi itself streams.
    if (body.stream === false) {
      return res.json({
        id: externalId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'svc-agent',
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      });
    }

    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.write(chunk(externalId, { role: 'assistant', content: '' }));
    if (reply) res.write(chunk(externalId, { content: reply }));
    res.write(chunk(externalId, {}, 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  });

  return r;
}
