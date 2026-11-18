// End-to-end smoke test on the real Workers runtime (workerd) with a local D1 database and a
// mock Discord API. Needs no Discord account, no Cloudflare login, and no network:
//   npm run smoke
// It signs requests exactly like Discord does, runs the slash commands, fast-forwards a meeting
// into the past, fires the cron trigger, and checks the message reaches the (mock) Discord API.
// It also runs a mock Apps Script bridge (POST -> 302 -> GET) to check the Google Calendar sync end to end.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, createWriteStream, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wranglerJs = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const PORT = 8799;
const persist = mkdtempSync(path.join(tmpdir(), 'meeting-bot-smoke-'));
const logFile = path.join(persist, 'wrangler.log');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
};

// ---- mock Discord API ----
const received = [];
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"id":"1"}');
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;

// ---- mock Apps Script bridge: answers every POST with a redirect, and the real answer on GET ----
const BRIDGE_SECRET = 'smoke-secret';
const scriptCalls = [];
const scriptAnswers = new Map();
const script = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const port = script.address().port;
    if (req.method === 'POST') {
      const payload = JSON.parse(body || '{}');
      scriptCalls.push({ url: req.url, contentType: req.headers['content-type'], ...payload });
      let answer;
      if (payload.secret !== BRIDGE_SECRET) answer = { ok: false, error: 'unauthorized' };
      else if (payload.action === 'ping') answer = { ok: true, account: 'smoke@example.com' };
      else if (payload.action === 'cancel') answer = { ok: true, eventId: payload.eventId, cancelled: true };
      else answer = { ok: true, eventId: payload.eventId, meetLink: 'https://meet.google.com/smk-test-xyz', htmlLink: '', created: payload.action === 'create' };
      const id = String(scriptAnswers.size + 1);
      scriptAnswers.set(id, answer);
      res.writeHead(302, { Location: `http://127.0.0.1:${port}/macros/echo?id=${id}` }).end();
    } else {
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(scriptAnswers.get(id) ?? { ok: false, error: 'unknown' }));
    }
  });
});
await new Promise((r) => script.listen(0, '127.0.0.1', r));
const scriptHost = `127.0.0.1:${script.address().port}`;
const scriptUrl = `http://${scriptHost}/macros/s/SMOKE123/exec`;

// ---- signing keys ----
const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const hex = (b) => Buffer.from(b).toString('hex');
const publicKey = hex(await crypto.subtle.exportKey('raw', pair.publicKey));
async function post(payload, { badSignature = false } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  let signature = hex(await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(timestamp + body)));
  if (badSignature) signature = signature.replace(/^../, signature.startsWith('00') ? 'ff' : '00');
  const res = await fetch(`http://127.0.0.1:${PORT}/`, {
    method: 'POST',
    headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp, 'Content-Type': 'application/json' },
    body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON (e.g. 401 text)
  }
  return { status: res.status, json, text };
}

const slash = (name, options, channel = 'c1') => ({
  type: 2,
  guild_id: 'g1',
  channel_id: channel,
  application_id: 'app1',
  token: 'smoke-token',
  member: { user: { id: 'u1' }, permissions: '0' },
  data: { name, options },
});
const opts = (o = {}) => Object.entries(o).map(([n, v]) => ({ name: n, value: v, type: 3 }));
const sub = (name, opts = {}) => [{ type: 1, name, options: Object.entries(opts).map(([n, v]) => ({ name: n, value: v, type: 3 })) }];

function cleanup() {
  try {
    server?.kill('SIGTERM');
  } catch {
    // already gone
  }
  mock.close();
  script.close();
  try {
    // On Windows the worker process may still hold files for a moment; retry, and never fail the run over a temp folder.
    rmSync(persist, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (e) {
    console.warn(`(could not delete the temp folder ${persist}: ${e.code ?? e.message})`);
  }
}

// ---- boot the Worker ----
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' };
const migrate = spawnSync(process.execPath, [wranglerJs, 'd1', 'migrations', 'apply', 'meeting-bot', '--local', '--persist-to', persist], { cwd: root, env, encoding: 'utf8' });
check(migrate.status === 0, 'D1 migrations apply on workerd/miniflare', migrate.stdout + migrate.stderr);

const vars = [
  `DISCORD_PUBLIC_KEY:${publicKey}`,
  'DISCORD_BOT_TOKEN:test-token',
  `DISCORD_API_BASE:http://127.0.0.1:${mockPort}/api`,
  `BRIDGE_SECRET:${BRIDGE_SECRET}`,
  `BRIDGE_ALLOWED_HOSTS:${scriptHost}`, // smoke test only: lets the Worker talk to the local mock
];
const server = spawn(
  process.execPath,
  [wranglerJs, 'dev', '--local', '--port', String(PORT), '--persist-to', persist, '--test-scheduled', ...vars.flatMap((v) => ['--var', v])],
  { cwd: root, env },
);
const log = createWriteStream(logFile);
server.stdout.pipe(log);
server.stderr.pipe(log);

async function waitForWorker() {
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

try {
  const up = await waitForWorker();
  check(up, 'Worker starts on workerd');
  if (!up) throw new Error('worker did not start');

  // 1. Discord's endpoint verification
  const ping = await post({ type: 1 });
  check(ping.status === 200 && ping.json?.type === 1, 'PING is answered with PONG', ping.text);
  const forged = await post({ type: 1 }, { badSignature: true });
  check(forged.status === 401, 'a request with a bad signature is rejected (401)', `got ${forged.status}`);

  // 2. Commands
  const tz = await post(slash('set-timezone', [{ name: 'timezone', value: 'America/Chicago', type: 3 }]));
  check(/America\/Chicago/.test(tz.json?.data?.content ?? ''), '/set-timezone saves a zone', tz.text);

  // Start in ~3 minutes, in the saved Chicago zone, using today's Chicago date.
  const soon = new Date(Date.now() + 3 * 60_000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(soon)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  const created = await post(
    slash('new-meeting', opts({ name: 'Smoke Test', date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, reminder: 0, location: 'Room 1' })), // Discord sends INTEGER options as numbers
  );
  const content = created.json?.data?.content ?? '';
  check(/Meeting scheduled.*Smoke Test/s.test(content) && /<t:\d+:F>/.test(content) && /<t:\d+:R>/.test(content), '/new-meeting announces with Discord timestamps', created.text);

  const other = await post(slash('new-meeting', opts({ name: 'Other Channel', date: 'tomorrow', time: '9am', channel: 'c9' })));
  const announce = received.find((r) => r.url === '/api/channels/c9/messages');
  check((other.json?.data?.flags & 64) === 64 && announce?.auth === 'Bot test-token' && /Other Channel/.test(announce?.body?.content ?? ''), 'create with channel posts via the Discord REST API', JSON.stringify(received));

  const listed = await post(slash('upcoming-meetings', []));
  check(/Smoke Test/.test(listed.json?.data?.content ?? '') && /Other Channel/.test(listed.json?.data?.content ?? ''), '/upcoming-meetings shows both meetings', listed.text);

  const dup = await post(slash('new-meeting', opts({ name: 'smoke test', date: 'tomorrow', time: '9am' })));
  check(/already a meeting/.test(dup.json?.data?.content ?? ''), 'duplicate names are refused', dup.text);

  // 3. Scheduler: nothing is due yet, then fast-forward the meeting 400s and fire the cron.
  const before = received.length;
  await fetch(`http://127.0.0.1:${PORT}/__scheduled?cron=*+*+*+*+*`);
  await new Promise((r) => setTimeout(r, 1500));
  check(received.length === before, 'cron sends nothing while no job is due');

  const sql = "UPDATE meetings SET start_at = start_at - 400 WHERE name = 'Smoke Test'; UPDATE jobs SET fire_at = fire_at - 400, run_after = run_after - 400 WHERE meeting_id = (SELECT id FROM meetings WHERE name = 'Smoke Test');";
  const shift = spawnSync(process.execPath, [wranglerJs, 'd1', 'execute', 'meeting-bot', '--local', '--persist-to', persist, '--command', sql], { cwd: root, env, encoding: 'utf8' });
  check(shift.status === 0, 'fast-forwarded the meeting (test setup)', shift.stdout + shift.stderr);

  await fetch(`http://127.0.0.1:${PORT}/__scheduled?cron=*+*+*+*+*`);
  let startMsg;
  for (let i = 0; i < 20 && !startMsg; i++) {
    await new Promise((r) => setTimeout(r, 500));
    startMsg = received.find((r) => r.url === '/api/channels/c1/messages' && /starting now/.test(r.body.content));
  }
  check(Boolean(startMsg) && /Smoke Test/.test(startMsg.body.content) && /Room 1/.test(startMsg.body.content), 'cron trigger delivers the start message to the meeting channel', JSON.stringify(received));
  check(startMsg?.auth === 'Bot test-token' && JSON.stringify(startMsg?.body.allowed_mentions) === '{"parse":[]}', 'message carries bot auth and a no-mass-mention guard');

  await fetch(`http://127.0.0.1:${PORT}/__scheduled?cron=*+*+*+*+*`);
  await new Promise((r) => setTimeout(r, 1000));
  check(received.filter((r) => /starting now/.test(r.body.content ?? '')).length === 1, 'a second cron run does not send it again');

  const after = await post(slash('upcoming-meetings', []));
  check(!/Smoke Test/.test(after.json?.data?.content ?? '') && /Other Channel/.test(after.json?.data?.content ?? ''), 'finished one-off meeting drops off the list', after.text);

  // 4. Google Calendar through the mock Apps Script bridge
  const waitFor = async (fn, tries = 30) => {
    for (let i = 0; i < tries; i++) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  };
  const cron = () => fetch(`http://127.0.0.1:${PORT}/__scheduled?cron=*+*+*+*+*`);
  const isPrivate = (r) => (r.body.flags & 64) === 64;

  const badUrl = await post(slash('calendar', sub('connect', { url: 'https://evil.example.com/macros/s/abc/exec' })));
  check(/must be on script\.google\.com/.test(badUrl.json?.data?.content ?? ''), '/calendar connect refuses a URL that is not on script.google.com', badUrl.text);

  const connect = await post(slash('calendar', sub('connect', { url: scriptUrl })));
  check(connect.json?.type === 5, '/calendar connect answers at once with a deferred reply', connect.text);
  const edit = await waitFor(() => received.find((r) => r.method === 'PATCH' && r.url === '/api/webhooks/app1/smoke-token/messages/@original'));
  check(/Connected as smoke@example\.com/.test(edit?.body.content ?? ''), 'the deferred reply is edited with the result of the ping', JSON.stringify(edit));
  const pingCall = scriptCalls.find((c) => c.action === 'ping');
  check(pingCall?.secret === BRIDGE_SECRET && /text\/plain/.test(pingCall?.contentType ?? ''), 'the bridge received the secret in a text/plain POST, then answered via redirect + GET', JSON.stringify(pingCall));

  const added = await post(slash('add-team', opts({ team: 'Design', emails: 'a@example.com, b@example.com; c@example.com' })));
  check(/added 3/.test(added.json?.data?.content ?? '') && (added.json?.data?.flags & 64) === 64, '/add-team takes a whole list and replies privately', added.text);

  const cal = await post(slash('new-meeting', opts({ name: 'Calendar Test', date: 'tomorrow', time: '9am', reminder: 0 })));
  check(/Calendar: will be added to smoke@example\.com/.test(cal.json?.data?.content ?? '') && /Guest team: Design \(3 guests\)/.test(cal.json?.data?.content ?? ''), 'create queues the event and says so privately', cal.text);
  check(!scriptCalls.some((c) => c.action === 'create'), 'the command itself never calls Google');

  await cron();
  const createCall = await waitFor(() => scriptCalls.find((c) => c.action === 'create'));
  check(Boolean(createCall) && createCall.title === 'Calendar Test' && createCall.guests?.join() === 'a@example.com,b@example.com,c@example.com' && /^v[0-9a-v]{24}$/.test(createCall.eventId ?? '') && createCall.timezone === 'America/Chicago', 'the cron trigger sends create with title, guests, event id and timezone', JSON.stringify(createCall));
  const meetPost = await waitFor(() => received.find((r) => r.url === '/api/channels/c1/messages' && /Google Meet link for Calendar Test/.test(r.body.content ?? '')));
  check(meetPost?.body.content === 'Google Meet link for Calendar Test: https://meet.google.com/smk-test-xyz', 'the channel gets one plain Meet link line', JSON.stringify(meetPost));
  const followup = await waitFor(() => received.find((r) => r.method === 'POST' && r.url === '/api/webhooks/app1/smoke-token' && /Calendar Test/.test(r.body.content ?? '')));
  check(Boolean(followup) && isPrivate(followup) && !followup.auth && /smoke@example\.com/.test(followup.body.content) && /Design \(3 guests\)/.test(followup.body.content), 'the organizer gets a private follow-up (ephemeral, no bot header) with account and guest count', JSON.stringify(followup));

  const cancel = await post(slash('cancel-meeting', opts({ name: 'Calendar Test' })));
  check(/Cancelled/.test(cancel.json?.data?.content ?? ''), 'cancel still posts the public cancellation', cancel.text);
  await cron();
  const cancelCall = await waitFor(() => scriptCalls.find((c) => c.action === 'cancel'));
  check(cancelCall?.eventId === createCall?.eventId, 'the cron trigger deletes the same Google event', JSON.stringify(cancelCall));
} catch (e) {
  failures++;
  console.error('Smoke test aborted:', e.message);
  console.error('--- wrangler log ---\n' + readFileSync(logFile, 'utf8').slice(-3000));
} finally {
  cleanup();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll smoke checks passed');
process.exit(failures ? 1 : 0);
