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

type Vars = Record<string, unknown>;
type VapiBody = {
  messages?: OpenAIMessage[];
  stream?: boolean;
  /** Vapi nests the live call under `call`, with the caller under `customer`. */
  call?: {
    id?: string;
    customer?: { number?: string };
    assistantOverrides?: { variableValues?: Vars };
    metadata?: Vars;
  };
  customer?: { number?: string };
  assistantOverrides?: { variableValues?: Vars };
  metadata?: Vars;
};

/**
 * Which centre a web call is for and who is calling, as the public page set
 * them (`variableValues: { org, callerNumber }`). Read first from the system
 * message, where Vapi substitutes variables into the assistant's prompt
 * (`svc-agent org={{org}} caller={{callerNumber}}`, written by vapi:setup) —
 * the one place a custom LLM is sure to receive them — then from wherever
 * else Vapi carries them. Untrusted either way: the org must exist, and the
 * caller only ever gets a demo caller's view.
 */
export function callIdentity(body: unknown): { org?: string; callerNumber?: string } {
  const b = (body ?? {}) as VapiBody;
  const system = (b.messages ?? []).find((m) => m.role === 'system');
  const text = system ? textOf(system.content) : '';
  const tag = (name: string) => /^[\w-]+$/.exec(new RegExp(`\\b${name}=(\\S+)`).exec(text)?.[1] ?? '')?.[0];
  const vars = [b.call?.assistantOverrides?.variableValues, b.assistantOverrides?.variableValues, b.call?.metadata, b.metadata];
  const pick = (k: string) => {
    for (const v of vars) {
      const x = v?.[k];
      if (typeof x === 'string' && x && !x.includes('{{')) return x;
    }
    return undefined;
  };
  const org = (tag('org') ?? pick('org'))?.toLowerCase();
  const caller = (tag('caller') ?? pick('callerNumber') ?? '').replace(/\D/g, '');
  return {
    ...(org && /^[a-z0-9][a-z0-9-]{1,29}$/.test(org) ? { org } : {}),
    ...(caller.length >= 10 ? { callerNumber: caller.slice(-10) } : {}),
  };
}

/** The assistant's end-call phrase. Only ever said at the end. */
export const GOODBYE = 'Goodbye.';

/** Said, then silence, when a centre has used its day: a caller hears a sentence, not a dead line. */
export const DAILY_CAP_LINE =
  "Sorry, this demo line has had all its calls for today. Please try again tomorrow — thanks for calling.";

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

class CapReached extends Error {}

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

export function vapiApi(
  db: Database,
  deps: CallDeps = buildDeps(db),
  opts: {
    overCap?: () => boolean;
    /** Whether a number the public page named may be used (registry: sample callers, or any on a demo centre). */
    webCaller?: (mobile: string) => boolean;
  } = {},
): Router {
  const r = Router();

  r.post('/chat/completions', async (req, res) => {
    const body = (req.body ?? {}) as VapiBody;

    const externalId = body.call?.id ?? String(body.metadata?.['callId'] ?? '');
    // The page's number is the visitor's say-so: kept only when this centre
    // allows it, so nobody reaches a real customer's record by naming them.
    const named = callIdentity(body).callerNumber;
    const callerNumber =
      (named && (opts.webCaller?.(named) ?? true) ? named : undefined) ??
      (body.call?.customer?.number ?? body.customer?.number ?? '').replace(/\D/g, '').slice(-10);
    const utterance = latestUserUtterance(body.messages);

    if (!externalId) {
      return res.status(400).json({ error: { message: 'no call id on the request' } });
    }

    let reply: string;
    try {
      if (opts.overCap?.()) throw new CapReached();
      // First turn of this call: no session yet, so open one. Vapi's greeting
      // and ours would collide, so its assistant must be configured with no
      // first message of its own — we speak first.
      let sessionId = sessionIdForExternal(db, externalId);

      if (!sessionId) {
        // One line per call, so the first real call shows how it was routed.
        // The number is masked; no message content is logged.
        const centre = (db.prepare(`SELECT name FROM centres WHERE id = 1`).get() as { name: string } | undefined)?.name;
        console.log(
          `  vapi call  ${externalId.slice(0, 8)} → ${centre ?? '?'}, caller ${callerNumber ? `******${callerNumber.slice(-4)}` : 'unknown'}` +
            `${callIdentity(body).org ? '' : ' (no centre in the call; default used)'}`,
        );
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
        if (session?.state === 'ended') {
          reply = '';
        } else {
          const t = await handleTurn(db, deps, sessionId, utterance);
          reply = t.reply;
          // Labels only — what the agent understood, never what was said.
          if (t.understood) console.log(`  vapi turn  ${externalId.slice(0, 8)} ${t.understood}${t.ended ? ' · call ended' : ''}`);
        }
      }
      // The conversation is over: say so in the one word the assistant is set
      // to hang up on (vapi-setup.ts), so the line closes with the call.
      if (reply && loadSession(db, sessionId)?.state === 'ended') reply = `${reply} ${GOODBYE}`;
    } catch (err) {
      if (err instanceof CapReached) {
        reply = `${DAILY_CAP_LINE} ${GOODBYE}`;
      } else {
        // The caller is on a live phone line. They hear a sentence, never a
        // stack trace, and the call stays up.
        console.error('vapi turn failed', err);
        reply = "Sorry, I lost that for a moment. Could you say it again?";
      }
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
