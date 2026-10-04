/**
 * Every flow, in a real browser, against a throwaway copy of the app.
 *
 *   npm run e2e
 *
 * Starts the server on a free port with its own temporary data folder, demo
 * mode, the offline classifier (no API key, no cost) and placeholder Vapi
 * settings, then drives Chromium through the portal, the Knowledge page and
 * the public voice page. Prints a ✓ or ✗ per check, exits non-zero on any ✗,
 * and deletes everything it made. Nothing touches the live site or your data.
 *
 * Needs a Chromium for Playwright: present in the cloud sandbox; on a laptop,
 * once, `npx playwright install chromium`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASSWORD = 'e2e-desk-pass';

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
async function check(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    const detail = (e as Error).message.split('\n')[0]!.slice(0, 600);
    results.push({ name, ok: false, detail });
    console.log(`  ✗ ${name}\n      ${detail}`);
  }
}
function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

async function startServer(dataDir: string, port: number): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DB_PATH: join(dataDir, 'service.db'),
    ADMIN_PASSWORD: PASSWORD,
    // Empty, not absent: a laptop's .env must not switch the run onto Haiku.
    CLAUDE_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    DEMO_MODE: 'true',
    BEHIND_PROXY: 'false',
    // Placeholders: enough for the page to load Vapi's SDK and start a call,
    // which Vapi then refuses — exactly the path the live bug broke.
    VAPI_PUBLIC_KEY: '00000000-0000-0000-0000-000000000000',
    VAPI_ASSISTANT_ID: '11111111-1111-1111-1111-111111111111',
  };
  const child = spawn(join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx'), ['src/dealer/server.ts'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  let log = '';
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://localhost:${port}/health`);
      if (r.ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`server did not start:\n${log}`);
}

/** A microphone that "hears" the next scripted line on each listen, and a voice that speaks instantly. */
function fakeSpeech(script: string[]) {
  return `(() => {
    const script = ${JSON.stringify(script)};
    class FakeRec {
      start() {
        const text = script.shift();
        setTimeout(() => {
          if (text) {
            const res = [[{ transcript: text }]]; res[0].isFinal = true;
            this.onresult && this.onresult({ results: res });
          }
          this.onend && this.onend();
        }, 120);
      }
      abort() {}
    }
    window.SpeechRecognition = FakeRec;
    window.speechSynthesis.speak = (u) => setTimeout(() => u.onend && u.onend(), 20);
    window.speechSynthesis.cancel = () => {};
  })();`;
}

/** Console errors that mean something — not the expected 401 before sign-in or a 404 we asked for. */
function watch(page: Page, errors: string[]) {
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${String(e)}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/status of (401|404)|api\.vapi\.ai|CORS|ERR_FAILED|ERR_NAME|Failed to load resource/.test(t)) return;
    errors.push(`${page.url()}: ${t}`);
  });
}

async function noSideScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

async function main() {
  expect(existsSync(join(ROOT, 'dist', 'dealer', 'index.html')), 'Build the portal first: npm run build:web');
  const dataDir = mkdtempSync(join(tmpdir(), 'svc-e2e-'));
  const port = await freePort();
  const B = `http://localhost:${port}`;
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  const errors: string[] = [];

  try {
    console.log(`\nStarting a throwaway server on ${B} …`);
    server = await startServer(dataDir, port);
    browser = await chromium.launch(
      process.env['PLAYWRIGHT_CHROMIUM'] ? { executablePath: process.env['PLAYWRIGHT_CHROMIUM'] } : {},
    );
    const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'Asia/Kolkata', acceptDownloads: true });
    const p = await ctx.newPage();
    watch(p, errors);

    // -----------------------------------------------------------------------
    console.log('\nSign-in');
    await check('the API refuses anyone not signed in', async () => {
      const r = await fetch(`${B}/api/summary`);
      expect(r.status === 401, `expected 401, got ${r.status}`);
    });
    await check('a wrong password is refused', async () => {
      await p.goto(B);
      await p.fill('#uid', 'voltas');
      await p.fill('#pw', 'not-the-password');
      await p.click('button[type=submit]');
      await p.waitForSelector('text=don’t match');
    });
    await check('sign-up opens a new centre with the sample data', async () => {
      await p.click('text=Create an account');
      await p.fill('#su-name', 'E2E Motors');
      await p.fill('#uid', 'e2e-motors');
      await p.fill('#pw', PASSWORD);
      await p.click('button[type=submit]');
      await p.waitForSelector('text=Morning drop');
      expect((await p.textContent('.brand h1'))?.includes('E2E Motors'), 'header should name the new centre');
    });

    // -----------------------------------------------------------------------
    console.log('\nToday');
    await check('the board shows today’s 9 cars in two columns', async () => {
      await p.waitForSelector('.card');
      const n = await p.locator('.board .card').count();
      expect(n === 9, `expected 9 cards, saw ${n}`);
      expect((await p.locator('.days .day').count()) === 14, 'expected a 14-day strip');
    });
    await check('a car can be marked arrived, and undone', async () => {
      const before = await p.locator('.card.arrived').count();
      await p.locator('.card:not(.arrived) >> text=Arrived').first().click();
      await p.waitForFunction((b) => document.querySelectorAll('.card.arrived').length > b, before);
      await p.locator('.card.arrived >> text=Undo').first().click();
      await p.waitForFunction((b) => document.querySelectorAll('.card.arrived').length === b, before);
    });

    // -----------------------------------------------------------------------
    console.log('\nBookings');
    let reference = '';
    await check('a new booking goes through find → car → day → slot', async () => {
      await p.keyboard.press('n');
      await p.fill('input[aria-label="Phone, plate or name"]', 'Priya');
      await p.click('.results .pick');
      await p.click('.carpick .pick >> nth=0');
      await p.click('.strip .slotday:not([disabled]) >> nth=1');
      await p.click('.slots .slot:not([disabled]) >> nth=0');
      await p.fill('#bk-note', 'E2E note');
      await p.click('footer >> text=Book');
      await p.waitForSelector('.ticket .ref');
      reference = (await p.textContent('.ticket .ref'))!.trim();
      expect(/^\d{6}-\d{5}$/.test(reference), `odd reference ${reference}`);
    });
    await check('the booking reschedules and cancels', async () => {
      await p.click('text=Open booking');
      await p.waitForSelector('text=Reschedule');
      await p.click('.drawer .strip .slotday:not([disabled]) >> nth=3');
      await p.click('.drawer .slots .slot:not([disabled]) >> nth=0');
      await p.click('text=Move booking');
      await p.waitForSelector('text=The old place is free again');
      await p.click('footer >> text=Cancel booking');
      await p.click('.confirmrow >> text=Cancel booking');
      await p.waitForSelector('.drawer', { state: 'detached' });
      const r = await p.evaluate(async (ref) => (await fetch(`/api/bookings/${ref}`)).json(), reference);
      expect(r.status === 'cancelled', `expected cancelled, got ${r.status}`);
    });
    await check('the header search finds a plate', async () => {
      await p.fill('input[aria-label="Find a plate, phone or name"]', 'HR26');
      await p.waitForSelector('.finder .drop button');
      await p.keyboard.press('Escape');
    });

    // -----------------------------------------------------------------------
    console.log('\nFollow-ups');
    await check('9 are open, and one closes with an outcome, then reopens', async () => {
      await p.click('nav >> text=Follow-ups');
      await p.waitForSelector('.qrow');
      expect((await p.textContent('.segc[aria-label=Status]'))?.includes('Open 9'), 'expected "Open 9"');
      await p.click('.qrow >> nth=0 >> text=Close…');
      await p.click('.closer >> text=Booked');
      await p.click('.closer >> text=Close follow-up');
      await p.waitForSelector('text=Open 8');
      await p.click('.segc[aria-label=Status] >> text=Done');
      await p.locator('.qrow >> text=Reopen').first().click();
      await p.click('.segc[aria-label=Status] >> text=Open');
      await p.waitForSelector('text=Open 9');
    });
    await check('selecting rows shows the bulk bar', async () => {
      await p.check('.qrow >> nth=0 >> input.tick');
      await p.waitForSelector('.bulk');
      await p.click('.bulk >> text=Clear');
    });
    await check('Export CSV downloads 13 columns', async () => {
      const [dl] = await Promise.all([p.waitForEvent('download'), p.click('text=Export CSV')]);
      const file = join(dataDir, 'fu.csv');
      await dl.saveAs(file);
      const header = readFileSync(file, 'utf8').replace(/^﻿/, '').split('\r\n')[0]!;
      expect(header.split(',').length === 13, `expected 13 columns: ${header}`);
    });

    // -----------------------------------------------------------------------
    console.log('\nConversations and places');
    await check('Conversations lists calls with transcripts', async () => {
      await p.click('nav >> text=Conversations');
      await p.waitForSelector('.transcript .msg');
    });
    await check('the weekly places drawer saves', async () => {
      await p.click('button.avatar');
      await p.click('text=Places and booking window');
      const cell = p.locator('table input').first();
      await cell.fill(String(Number(await cell.inputValue()) + 1));
      await p.click('text=Save changes');
      await p.waitForSelector('text=Saved and applied');
      await p.keyboard.press('Escape');
    });
    await check('the demo switch turns off and back on, each with a confirm', async () => {
      await p.click('button.avatar');
      await p.click('text=Demo centre · On');
      await p.waitForSelector('.menu .confirmrow >> text=Turn demo off?');
      await p.click('.menu .confirmrow >> text=Turn off');
      await p.waitForSelector('.toast >> text=Demo off');
      await p.click('button.avatar');
      await p.click('text=Demo centre · Off');
      expect((await p.locator('text=Reset demo data now').count()) === 0, 'reset offered on a centre that isn’t a demo');
      await p.click('.menu .confirmrow >> text=Turn on');
      await p.waitForSelector('.toast >> text=Demo on');
    });

    // -----------------------------------------------------------------------
    console.log('\nKnowledge');
    await check('a new entry answers in the test panel', async () => {
      await p.click('nav >> text=Knowledge');
      await p.click('text=+ Add to knowledge');
      await p.fill('#kf-title', 'Tata Nexon EV');
      await p.fill('#kf-say', 'Yes, we service the Nexon EV and it takes about three hours.');
      await p.fill('#kf-phr', 'nexon ev, electric nexon');
      await p.click('.topicform >> button[type=submit]');
      await p.waitForSelector('.topic h4:text("Tata Nexon EV")');
      await p.fill('input[aria-label="A question a customer might ask"]', 'is the nexon ev something you work on?');
      await p.click('text=Ask the agent');
      await p.waitForSelector('.ktest .answer:has-text("Tata Nexon EV")');
    });

    const chat = await ctx.newPage();
    watch(chat, errors);
    const sayLine = async (t: string) => {
      const n = await chat.locator('.thread .msg.agent').count();
      await chat.fill('input[aria-label="Your reply"]', t);
      await chat.click('text=Send');
      await chat.waitForFunction((k) => document.querySelectorAll('.thread .msg.agent').length > k, n);
      return (await chat.locator('.thread .msg.agent').last().textContent()) ?? '';
    };
    await check('the agent uses it mid-call, then its edit on the very next turn', async () => {
      await chat.goto(`${B}/#/agent`);
      await chat.click('text=Start the conversation');
      await chat.waitForSelector('.thread .msg');
      await sayLine('Yes, that is me');
      await sayLine('Book the Nexon in for Friday.');
      expect((await sayLine('is the nexon ev something you work on?')).includes('three hours'), 'first answer missing');
      await p.click('.topic:has(h4:text("Tata Nexon EV")) >> text=Edit');
      await p.fill('#kf-say', 'Yes, and EV services now take two hours.');
      await p.click('.topicform >> button[type=submit]');
      await p.waitForSelector('text=two hours');
      expect((await sayLine('is the nexon ev something you work on?')).includes('two hours'), 'the edit was not used');
    });
    await check('an unanswered question is passed on and the booking carries on', async () => {
      expect((await sayLine('do you handle insurance claims?')).includes('passed'), 'not passed on');
      await sayLine("No, it's fine.");
      await sayLine('No.');
      expect((await sayLine('Morning.')).includes('Shall I book it?'), 'no readback before booking');
      expect(/booked|Done/.test(await sayLine('Yes.')), 'the booking did not finish');
      expect(/Thanks|see you/.test(await sayLine("No, that's all.")), 'no sign-off');
      const fu = await p.evaluate(async () => (await fetch('/api/followups?status=open&when=today&q=insurance')).json());
      expect(fu.total >= 1, 'no follow-up filed');
    });
    await check('an ended offer is hidden from the agent', async () => {
      await p.click('.kcats >> text=Offers');
      await p.waitForSelector('.topic.gone');
    });
    await check('a new desk number in Essentials reaches the SMS', async () => {
      await p.click('.kcats >> text=Centre essentials');
      await p.fill('#ess-desk', '0124 777 8888');
      await p.click('text=Save essentials');
      await p.waitForSelector('text=Last saved');
      await chat.click('text=Start again');
      await chat.selectOption('#ag-who', { index: 4 });
      await chat.click('text=Start the conversation');
      await chat.waitForSelector('.thread .msg');
      await sayLine('Yes.');
      await sayLine('do you handle insurance claims?');
      const sms = (await chat.locator('.thread .sms').last().textContent()) ?? '';
      expect(sms.includes('01247778888'), `SMS had: ${sms}`);
    });
    await chat.close();

    // -----------------------------------------------------------------------
    console.log('\nThe public voice page');
    const pub = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone'] });
    // Karan, not Rohit: Rohit's Nexon was booked by the agent chat above, and
    // the agent rightly refuses a second open booking for the same car.
    await pub.addInitScript(fakeSpeech(['Yes, that is me.', 'Book it in for Friday.', 'do you service the curvv?', "No, it's fine.", 'No.', 'Morning.', 'Yes.', "No, that's all."]));
    const t = await pub.newPage();
    watch(t, errors);
    await check('Vapi mode loads the SDK and starts a call at Vapi (no "not a constructor")', async () => {
      const calls: string[] = [];
      t.on('request', (r) => r.url().includes('api.vapi.ai') && calls.push(`${r.method()} ${r.url()}`));
      await t.goto(`${B}/try/e2e-motors`);
      await t.waitForSelector('text=Speaks Indian English');
      await t.click('button.talk');
      await t.waitForSelector('.voice .notice.alert', { timeout: 20000 });
      const text = (await t.textContent('.voice .notice.alert')) ?? '';
      expect(!/not a constructor|did not load/.test(text), `the SDK failed to load: ${text}`);
      expect(calls.some((c) => c.includes('/call/web')), `no call reached Vapi (saw: ${calls.join(', ') || 'nothing'})`);
    });
    await check('falling back to the browser voice books by speech, with the SMS card', async () => {
      await t.click('text=Use the browser’s voice instead');
      await t.selectOption('#try-who', '9810055005');
      await t.click('button.talk');
      await t.waitForSelector('text=Call ended', { timeout: 30000 });
      const lines = await t.locator('.captions .msg.agent').allTextContents();
      expect(lines.some((l) => l.includes('Curvv')), `the knowledge answer is missing: ${JSON.stringify(await t.locator('.captions .msg').allTextContents())}`);
      expect(lines.some((l) => /booked|Done/.test(l)), `never booked: ${JSON.stringify(lines)}`);
      expect(/Thanks|see you/.test(lines.at(-1) ?? ''), `last line: ${lines.at(-1)}`);
      expect((await t.locator('.captions .sms').count()) >= 1, 'no SMS card');
    });
    await check('typed chat works on the same page', async () => {
      await t.click('text=Start again');
      await t.click('text=Prefer typing? Chat instead');
      await t.waitForSelector('.captions .msg.agent');
      await t.fill('input[aria-label="Your reply"]', 'Yes.');
      await t.click('text=Send');
      await t.waitForFunction(() => document.querySelectorAll('.captions .msg.agent').length > 1);
    });
    await check('a booked sample caller says so, and a free one is picked first', async () => {
      await t.goto(`${B}/try/e2e-motors`);
      await t.waitForSelector('#try-who');
      const rohit = (await t.locator('#try-who option[value="9810011001"]').textContent()) ?? '';
      expect(/already booked \w{3} (8:30|2:00)/.test(rohit), `Rohit reads: ${rohit}`);
      const picked = await t.locator('#try-who').inputValue();
      const pickedText = (await t.locator(`#try-who option[value="${picked}"]`).textContent()) ?? '';
      expect(picked !== '9810011001' && !pickedText.includes('already booked'), `picked: ${pickedText}`);
      expect(!(await t.locator('text=My own number').count()), 'the old own-number option is still there');
    });
    await check('+ New demo caller adds a made-up caller who books by chat', async () => {
      await t.click('text=+ New demo caller');
      await t.waitForFunction(() => (document.querySelector('#try-who') as HTMLSelectElement).value.startsWith('9799'));
      await t.click('text=Prefer typing? Chat instead');
      await t.waitForSelector('.captions .msg.agent');
      for (const line of ['Yes.', 'Book it in for Friday.', "No, it's fine.", 'No.', 'Morning.', 'Yes.']) {
        const n = await t.locator('.captions .msg.agent').count();
        await t.fill('input[aria-label="Your reply"]', line);
        await t.click('text=Send');
        await t.waitForFunction((k) => document.querySelectorAll('.captions .msg.agent').length > k, n);
      }
      const last = (await t.locator('.captions .msg.agent').last().textContent()) ?? '';
      expect(/booked|Done/.test(last) && last.includes('Anything else'), `last line: ${last}`);
    });
    await check('a browser without its own speech still gets Vapi voice and the chat', async () => {
      const ff = await browser!.newContext();
      await ff.addInitScript('delete window.SpeechRecognition; delete window.webkitSpeechRecognition;');
      const fp = await ff.newPage();
      watch(fp, errors);
      await fp.goto(`${B}/try/e2e-motors`);
      await fp.waitForSelector('text=Prefer typing?');
      // With Vapi set, voice still works there: the hint must not claim otherwise.
      expect((await fp.locator('button.talk').count()) === 1, 'Vapi talk button should still show');
      await ff.close();
    });
    await check('an unknown centre shows Not found', async () => {
      await t.goto(`${B}/try/nowhere-at-all`);
      await t.waitForSelector('text=Not found');
    });
    await check('Reset demo data now puts the sample back, and Rohit is free again', async () => {
      await p.click('button.avatar');
      await p.click('text=Reset demo data now');
      await p.click('.menu .confirmrow >> text=Reset now');
      await p.waitForSelector('.toast >> text=Back to the sample');
      await t.goto(`${B}/try/e2e-motors`);
      await t.waitForSelector('#try-who');
      const rohit = (await t.locator('#try-who option[value="9810011001"]').textContent()) ?? '';
      expect(!rohit.includes('already booked'), `Rohit still reads: ${rohit}`);
      expect(!(await t.locator('#try-who option[value^="9799"]').count()), 'the demo caller survived the reset');
    });
    await pub.close();

    // -----------------------------------------------------------------------
    console.log('\nPhone width');
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const m = await phone.newPage();
    watch(m, errors);
    for (const [name, path] of [
      ['Today', '/#/today'],
      ['Follow-ups', '/#/followups'],
      ['Knowledge', '/#/knowledge'],
      ['the public page', '/try/e2e-motors'],
    ] as const) {
      await check(`${name} has no sideways scroll at 390 px`, async () => {
        if (!(await m.locator('.brand').count()) && path.startsWith('/#')) {
          await m.goto(B);
          await m.fill('#uid', 'e2e-motors');
          await m.fill('#pw', PASSWORD);
          await m.click('button[type=submit]');
          await m.waitForSelector('text=Morning drop');
        }
        await m.goto(B + path);
        await m.waitForTimeout(600);
        const over = await noSideScroll(m);
        expect(over <= 0, `${over}px too wide`);
      });
    }
    await phone.close();

    console.log('\nConsole');
    await check('no unexpected errors in any page', async () => {
      expect(errors.length === 0, errors.slice(0, 3).join(' | '));
    });
  } finally {
    await browser?.close().catch(() => {});
    server?.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` — ${failed.length} failed` : ''}\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
