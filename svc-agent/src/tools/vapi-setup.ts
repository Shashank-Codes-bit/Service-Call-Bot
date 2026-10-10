/**
 * One-time (and safe to repeat) setup of the Vapi assistant the public page
 * calls. Run on the server, where the keys live:
 *
 *   docker compose exec app npm run vapi:setup
 *
 * Needs VAPI_PRIVATE_KEY, CALL_API_SECRET and PUBLIC_URL in .env. Prints the
 * assistant id to put in VAPI_ASSISTANT_ID, and the voice it set. Nothing else
 * is printed: the keys go to Vapi's API and nowhere else.
 *
 * The voice: VAPI_VOICE (provider:voiceId) when set; otherwise whatever the
 * assistant already has — so a voice picked in Vapi's dashboard survives a
 * re-run — and Azure's Neerja for a new assistant.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';

export const ASSISTANT_NAME = 'Service desk agent';

/** Words a service-booking call turns on, for Deepgram's keyterm prompting. */
export const KEYTERMS = [
  'Nexon', 'Swift', 'Creta', 'Fortuner', 'Tiago', 'Altroz', 'Venue', 'Baleno', 'Kwid', 'Ertiga', 'i20', 'Curvv', 'XUV',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'morning', 'afternoon', 'service', 'booking', 'registration',
];
const API = 'https://api.vapi.ai';

export type Voice = { provider: string; voiceId: string; model?: string } & Record<string, unknown>;

export const DEFAULT_VOICE: Voice = { provider: 'azure', voiceId: 'en-IN-NeerjaNeural' };

/** Vapi's voice providers, as its API names them. */
const VOICE_PROVIDERS = ['azure', '11labs', 'cartesia', 'deepgram', 'openai', 'playht', 'rime-ai', 'lmnt', 'neets', 'vapi', 'hume', 'inworld'];

/** "11labs:abc123" (+ VAPI_VOICE_MODEL) → { provider, voiceId, model }. Anything else is a mistake worth stopping for. */
export function parseVoice(spec: string, model = ''): Voice {
  const m = /^([a-z0-9-]+):(\S+)$/.exec(spec.trim());
  if (!m || !VOICE_PROVIDERS.includes(m[1]!)) {
    throw new Error(
      `VAPI_VOICE must be provider:voiceId, e.g. azure:en-IN-NeerjaNeural or 11labs:<voice id> (providers: ${VOICE_PROVIDERS.join(', ')}).`,
    );
  }
  return { provider: m[1]!, voiceId: m[2]!, ...(model.trim() ? { model: model.trim() } : {}) };
}

/**
 * The voice to send: the chosen one, else the assistant's current one, else
 * the default — always with Vapi's phrase-splitting off. Our adapter hands
 * over each reply as one finished sentence; split at commas and voiced phrase
 * by phrase, it came out choppy and flat on the first live calls.
 */
export function voiceFor(chosen: Voice | undefined, current: unknown): Voice {
  const have = current && typeof current === 'object' && typeof (current as Voice).provider === 'string' ? (current as Voice) : undefined;
  const base = chosen ?? have ?? DEFAULT_VOICE;
  return { ...base, chunkPlan: { enabled: false } };
}

export const describeVoice = (v: Voice) => `${v.provider} ${v.voiceId}${v.model ? ` (${v.model})` : ''}, whole sentences`;

/**
 * The assistant. Vapi carries the audio; every word the caller hears comes
 * from our state machine through the custom-LLM adapter (`/vapi`).
 *
 * - The system message is never shown to a model: it only carries the call's
 *   variables, which Vapi fills in from the page's `variableValues` and our
 *   adapter reads back (vapi.ts `callIdentity`).
 * - The assistant speaks first, so our greeting opens the call.
 * - en-IN on both sides: Deepgram transcribes Indian English, and an Indian
 *   English neural voice answers.
 */
export function assistantPayload({
  publicUrl,
  callSecret,
  voice = voiceFor(undefined, undefined),
  language = 'multi',
}: {
  publicUrl: string;
  callSecret: string;
  voice?: Voice;
  /** Deepgram's language: `multi` (Hindi–English mixed, the default) or e.g. `en-IN`. */
  language?: string;
}) {
  return {
    name: ASSISTANT_NAME,
    firstMessageMode: 'assistant-speaks-first-with-model-generated-message',
    model: {
      provider: 'custom-llm',
      url: `${publicUrl.replace(/\/+$/, '')}/vapi`,
      model: 'svc-agent',
      messages: [{ role: 'system', content: 'svc-agent org={{org}} caller={{callerNumber}}' }],
    },
    credentials: [{ provider: 'custom-llm', apiKey: callSecret }],
    transcriber: {
      provider: 'deepgram',
      model: 'nova-3',
      // `multi` hears Hindi and English mixed mid-sentence, as callers speak
      // ("kal subah aa jaunga"); en-IN guessed English words for the Hindi.
      language,
      // The words a booking turns on, so "Nexon" isn't heard as "next one".
      // Multilingual keyterm prompting works in `multi` too.
      keyterm: KEYTERMS,
    },
    // Hearing, tuned after the first live call (2026-10-04), where the agent's
    // own voice and a long greeting garbled a plain "yes":
    // - two words to interrupt the agent, so an echo, a cough or "um" doesn't;
    stopSpeakingPlan: { numWords: 2, voiceSeconds: 0.3, backoffSeconds: 1 },
    // - a moment's patience before answering, so a caller isn't cut off
    //   mid-thought ("So, basically, I…"): 0.6 s and 0.8 s both answered
    //   half a sentence on the live calls ("Do the same day pickup as");
    startSpeakingPlan: { waitSeconds: 1.0, smartEndpointingPlan: { provider: 'livekit' } },
    // - background noise removed before transcription.
    backgroundSpeechDenoisingPlan: { smartDenoisingPlan: { enabled: true } },
    voice,
    // A demo call, not an open line: five minutes is a whole booking twice over.
    maxDurationSeconds: 300,
    // Room to think — "which day suits me?" — before the line closes.
    silenceTimeoutSeconds: 30,
    // The adapter ends every finished conversation with this word, and says it
    // nowhere else, so the line closes exactly when the conversation does.
    endCallPhrases: ['goodbye'],
    // Why each call ended, for the server log and `npm run calls`
    // (vapi.ts `/events`). The secret goes as `X-Vapi-Secret`.
    server: { url: `${publicUrl.replace(/\/+$/, '')}/vapi/events`, secret: callSecret },
    serverMessages: ['end-of-call-report'],
  };
}

async function vapi(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${config.vapiPrivateKey}`, 'content-type': 'application/json' },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Vapi ${init.method ?? 'GET'} ${path}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function main() {
  const missing = [
    ['VAPI_PRIVATE_KEY', config.vapiPrivateKey],
    ['CALL_API_SECRET', config.callApiSecret],
    ['PUBLIC_URL', config.publicUrl],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`Set ${missing.join(', ')} in .env first.`);
    process.exit(1);
  }
  if (!config.publicUrl.startsWith('https://')) {
    console.error('PUBLIC_URL must be the https:// address Vapi can reach.');
    process.exit(1);
  }

  let chosen: Voice | undefined;
  try {
    chosen = config.vapiVoice ? parseVoice(config.vapiVoice, config.vapiVoiceModel) : undefined;
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const list = (await vapi('/assistant?limit=100')) as unknown as Array<{ id: string; name: string }>;
  const existing = (Array.isArray(list) ? list : []).find((a) => a.name === ASSISTANT_NAME);
  const current = existing && !chosen ? (await vapi(`/assistant/${existing.id}`))['voice'] : undefined;
  const voice = voiceFor(chosen, current);
  const payload = assistantPayload({
    publicUrl: config.publicUrl,
    callSecret: config.callApiSecret,
    voice,
    language: config.vapiTranscriberLanguage,
  });
  const saved = existing
    ? await vapi(`/assistant/${existing.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
    : await vapi('/assistant', { method: 'POST', body: JSON.stringify(payload) });

  console.log(`${existing ? 'Updated' : 'Created'} the "${ASSISTANT_NAME}" assistant.`);
  console.log(`Voice: ${describeVoice(voice)}${chosen ? ' (from VAPI_VOICE)' : existing ? ' (kept)' : ''}`);
  console.log(`Transcriber: deepgram nova-3, ${config.vapiTranscriberLanguage}${config.vapiTranscriberLanguage === 'multi' ? ' (Hindi + English)' : ''}`);
  console.log(`Add this to .env, then restart:  VAPI_ASSISTANT_ID=${String(saved['id'])}`);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  main().catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
