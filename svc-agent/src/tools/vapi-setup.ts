/**
 * One-time (and safe to repeat) setup of the Vapi assistant the public page
 * calls. Run on the server, where the keys live:
 *
 *   docker compose exec app npm run vapi:setup
 *
 * Needs VAPI_PRIVATE_KEY, CALL_API_SECRET and PUBLIC_URL in .env. Prints the
 * assistant id to put in VAPI_ASSISTANT_ID. Nothing here is printed back but
 * that id: the keys go to Vapi's API and nowhere else.
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
export function assistantPayload({ publicUrl, callSecret }: { publicUrl: string; callSecret: string }) {
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
      language: 'en-IN',
      // The words a booking turns on, so "Nexon" isn't heard as "next one".
      keyterm: KEYTERMS,
    },
    // Hearing, tuned after the first live call (2026-10-04), where the agent's
    // own voice and a long greeting garbled a plain "yes":
    // - two words to interrupt the agent, so an echo, a cough or "um" doesn't;
    stopSpeakingPlan: { numWords: 2, voiceSeconds: 0.3, backoffSeconds: 1 },
    // - a moment's patience before answering, so a caller isn't cut off mid-thought;
    startSpeakingPlan: { waitSeconds: 0.6, smartEndpointingPlan: { provider: 'livekit' } },
    // - background noise removed before transcription.
    backgroundSpeechDenoisingPlan: { smartDenoisingPlan: { enabled: true } },
    voice: { provider: 'azure', voiceId: 'en-IN-NeerjaNeural' },
    // A demo call, not an open line: five minutes is a whole booking twice over.
    maxDurationSeconds: 300,
    silenceTimeoutSeconds: 20,
    // The adapter ends every finished conversation with this word, and says it
    // nowhere else, so the line closes exactly when the conversation does.
    endCallPhrases: ['goodbye'],
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

  const payload = assistantPayload({ publicUrl: config.publicUrl, callSecret: config.callApiSecret });
  const list = (await vapi('/assistant?limit=100')) as unknown as Array<{ id: string; name: string }>;
  const existing = (Array.isArray(list) ? list : []).find((a) => a.name === ASSISTANT_NAME);
  const saved = existing
    ? await vapi(`/assistant/${existing.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
    : await vapi('/assistant', { method: 'POST', body: JSON.stringify(payload) });

  console.log(`${existing ? 'Updated' : 'Created'} the "${ASSISTANT_NAME}" assistant.`);
  console.log(`Add this to .env, then restart:  VAPI_ASSISTANT_ID=${String(saved['id'])}`);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  main().catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
