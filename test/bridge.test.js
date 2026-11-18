import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeClient, validateScriptUrl } from '../src/bridge.js';
import { DURATION_HELP, parseDuration, parseReminder } from '../src/duration.js';
import { bridgeTimeZone, canonicalTimeZone } from '../src/time.js';

const SCRIPT = 'https://script.google.com/macros/s/AKfycbxyz123/exec';
const ECHO = 'https://script.googleusercontent.com/macros/echo?user_content_key=abc';

// ---------- duration ----------

test('duration: a plain number is hours; min for minutes; 15 min to 2 h', () => {
  const ok = [['1', 60], ['1h', 60], ['1.5', 90], ['90min', 90], ['1h30min', 90], ['15min', 15], ['2h', 120], ['120min', 120], ['45 minutes', 45]];
  for (const [input, minutes] of ok) assert.deepEqual(parseDuration(input), { ok: true, minutes }, input);
  assert.deepEqual(parseDuration(undefined), { ok: true, minutes: undefined });
  for (const bad of ['14min', '0', '121min', '2.5h', '120', '3', 'none', 'soon', '1d', '']) {
    const r = parseDuration(bad);
    assert.equal(r.ok, false, `"${bad}" should be rejected`);
    assert.equal(r.message, DURATION_HELP);
  }
  assert.match(DURATION_HELP, /between 15 minutes and 2 hours/);
});

test('duration and reminder share one parser, so "1" means one hour in both', () => {
  assert.equal(parseDuration('1').minutes, 60);
  assert.equal(parseReminder('1').minutes, 60);
  assert.equal(parseReminder('30').ok, false); // 30 hours, like duration:120
});

// ---------- timezone for Google ----------

test('fixed offsets are sent to Google as UTC; IANA names are sent as they are', () => {
  assert.equal(bridgeTimeZone(canonicalTimeZone('UTC+3')), 'UTC');
  assert.equal(bridgeTimeZone(canonicalTimeZone('UTC-5:30')), 'UTC');
  assert.equal(bridgeTimeZone('+05:30'), 'UTC');
  assert.equal(bridgeTimeZone('America/Chicago'), 'America/Chicago');
  assert.equal(bridgeTimeZone(canonicalTimeZone('Nigeria')), 'Africa/Lagos');
  assert.equal(bridgeTimeZone('UTC'), 'UTC');
});

// ---------- URL validation ----------

test('only https://script.google.com/macros/s/<id>/exec is accepted', () => {
  assert.equal(validateScriptUrl(SCRIPT).ok, true);
  const bad = [
    ['not a url', /not a valid URL/],
    ['http://script.google.com/macros/s/abc/exec', /https/],
    ['https://evil.example.com/macros/s/abc/exec', /must be on script\.google\.com/],
    ['https://script.google.com.evil.example/macros/s/abc/exec', /must be on script\.google\.com/],
    ['https://user:pw@script.google.com/macros/s/abc/exec', /username or password/],
    ['https://script.google.com/macros/s/abc/dev', /path must look like/],
    ['https://script.google.com/', /path must look like/],
  ];
  for (const [url, why] of bad) {
    const r = validateScriptUrl(url);
    assert.equal(r.ok, false, url);
    assert.match(r.error, why, url);
  }
});

// ---------- the client ----------

const res = (status, body, headers = {}) => ({
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/** A fetch that behaves like Apps Script: POST -> 302 -> GET returns JSON. */
function appsScript(answer, log = []) {
  return async (url, init) => {
    log.push({ url: String(url), method: init.method, redirect: init.redirect, body: init.body });
    if (init.method === 'POST') return res(302, '', { location: ECHO });
    return res(200, answer);
  };
}

test('bridge: POST without following redirects, then GET the redirect, secret in the body', async () => {
  const log = [];
  const bridge = createBridgeClient({ secret: 's3cret', fetchImpl: appsScript({ ok: true, account: 'pm@gmail.com' }, log) });
  const r = await bridge.call(SCRIPT, { action: 'ping' });
  assert.deepEqual(r, { ok: true, account: 'pm@gmail.com' });
  assert.equal(log.length, 2);
  assert.equal(log[0].method, 'POST');
  assert.equal(log[0].redirect, 'manual');
  assert.deepEqual(JSON.parse(log[0].body), { action: 'ping', secret: 's3cret' });
  assert.equal(log[1].method, 'GET');
  assert.equal(log[1].url, ECHO);
  assert.doesNotMatch(log[1].body ?? '', /s3cret/); // the secret is never sent to the redirect target
});

test('bridge: an answer that is not JSON gets the "Anyone" hint and is not retryable', async () => {
  const bridge = createBridgeClient({ secret: 'x', fetchImpl: appsScript('<html>Sign in</html>') });
  const r = await bridge.call(SCRIPT, { action: 'ping' });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, false);
  assert.match(r.error, /non-JSON \(is the deployment set to "Anyone"\?\)/);
});

test('bridge: script answers: busy is retryable, unauthorized explains the secret, others are permanent and quoted', async () => {
  const run = (answer) => createBridgeClient({ secret: 'x', fetchImpl: appsScript(answer) }).call(SCRIPT, { action: 'create' });

  const busy = await run({ ok: false, error: 'busy, retry' });
  assert.equal(busy.retryable, true);
  assert.match(busy.error, /busy/);

  const unauthorized = await run({ ok: false, error: 'unauthorized' });
  assert.equal(unauthorized.retryable, false);
  assert.match(unauthorized.error, /BOT_SECRET.*BRIDGE_SECRET/);

  const other = await run({ ok: false, error: 'unknown timezone: Mars/Base' });
  assert.equal(other.retryable, false);
  assert.match(other.error, /unknown timezone: Mars\/Base/);
});

test('bridge: network errors, timeouts and 5xx are retryable and say why', async () => {
  const down = createBridgeClient({ secret: 'x', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  const r1 = await down.call(SCRIPT, { action: 'ping' });
  assert.equal(r1.retryable, true);
  assert.match(r1.error, /could not reach the bridge \(ECONNRESET\)/);

  const slow = createBridgeClient({
    secret: 'x',
    timeoutMs: 20,
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  });
  const r2 = await slow.call(SCRIPT, { action: 'ping' });
  assert.equal(r2.retryable, true);
  assert.match(r2.error, /did not answer within/);

  const err5 = createBridgeClient({ secret: 'x', fetchImpl: async () => res(503, 'unavailable') });
  const r3 = await err5.call(SCRIPT, { action: 'ping' });
  assert.equal(r3.retryable, true);
  assert.match(r3.error, /HTTP 503/);

  const err404 = createBridgeClient({ secret: 'x', fetchImpl: async () => res(404, 'nope') });
  const r4 = await err404.call(SCRIPT, { action: 'ping' });
  assert.equal(r4.retryable, false);
  assert.match(r4.error, /HTTP 404.*"Anyone"/);
});

test('bridge: a redirect to any host other than script.googleusercontent.com is refused', async () => {
  const log = [];
  const evil = async (url, init) => {
    log.push(String(url));
    return res(302, '', { location: 'https://evil.example.com/steal' });
  };
  const r = await createBridgeClient({ secret: 'x', fetchImpl: evil }).call(SCRIPT, { action: 'ping' });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, false);
  assert.match(r.error, /refused to follow a redirect to evil\.example\.com/);
  assert.deepEqual(log, [SCRIPT]); // never even requested the evil URL

  const http = async () => res(302, '', { location: 'http://script.googleusercontent.com/x' });
  const r2 = await createBridgeClient({ secret: 'x', fetchImpl: http }).call(SCRIPT, { action: 'ping' });
  assert.match(r2.error, /refused to follow a redirect/);
});

test('bridge: a registered URL on the wrong host is refused at call time and the secret is never sent', async () => {
  let called = false;
  const bridge = createBridgeClient({ secret: 'x', fetchImpl: async () => { called = true; return res(200, {}); } });
  const r = await bridge.call('https://evil.example.com/macros/s/abc/exec', { action: 'ping' });
  assert.equal(r.ok, false);
  assert.equal(r.retryable, false);
  assert.match(r.error, /not allowed.*secret was NOT sent.*Reconnect/s);
  assert.equal(called, false);
});

test('bridge: extraHosts (smoke test only) allows a local mock, nothing else', async () => {
  const local = 'http://127.0.0.1:9999/macros/s/abc/exec';
  assert.equal(validateScriptUrl(local).ok, false);
  assert.equal(validateScriptUrl(local, { extraHosts: ['127.0.0.1:9999'] }).ok, true);
  assert.equal(validateScriptUrl('http://127.0.0.1:1/macros/s/abc/exec', { extraHosts: ['127.0.0.1:9999'] }).ok, false);
});

test('bridge: a redirect without a Location header is reported as such; saved URLs lose any query string', async () => {
  const noLocation = async () => res(302, '', {});
  const r = await createBridgeClient({ secret: 'x', fetchImpl: noLocation }).call(SCRIPT, { action: 'ping' });
  assert.equal(r.ok, false);
  assert.match(r.error, /redirect had no Location header/);

  assert.equal(validateScriptUrl(`${SCRIPT}?x=1#frag`).url, SCRIPT);
});
