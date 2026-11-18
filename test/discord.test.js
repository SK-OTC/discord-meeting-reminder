import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordClient, verifyDiscordSignature } from '../src/discord.js';

const hex = (buf) => Buffer.from(buf).toString('hex');

async function makeKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = hex(await crypto.subtle.exportKey('raw', pair.publicKey));
  const sign = async (timestamp, body) =>
    hex(await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(timestamp + body)));
  return { publicKey, sign };
}

test('verifyDiscordSignature accepts a valid signature and rejects tampering', async () => {
  const { publicKey, sign } = await makeKeys();
  const timestamp = '1700000000';
  const body = '{"type":1}';
  const signature = await sign(timestamp, body);

  assert.equal(await verifyDiscordSignature({ publicKey, signature, timestamp, body }), true);
  assert.equal(await verifyDiscordSignature({ publicKey, signature, timestamp, body: '{"type":2}' }), false);
  assert.equal(await verifyDiscordSignature({ publicKey, signature, timestamp: '1700000001', body }), false);
});

test('verifyDiscordSignature rejects missing, malformed, or wrong-key inputs without throwing', async () => {
  const { publicKey, sign } = await makeKeys();
  const other = await makeKeys();
  const timestamp = '1700000000';
  const body = 'x';
  const signature = await sign(timestamp, body);

  assert.equal(await verifyDiscordSignature({ publicKey, signature: null, timestamp, body }), false);
  assert.equal(await verifyDiscordSignature({ publicKey, signature: 'zz', timestamp, body }), false);
  assert.equal(await verifyDiscordSignature({ publicKey: 'nothex', signature, timestamp, body }), false);
  assert.equal(await verifyDiscordSignature({ publicKey: other.publicKey, signature, timestamp, body }), false);
});

function fakeFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };
  return { impl, calls };
}

test('postMessage success sends bot auth and the allowed_mentions guard', async () => {
  const f = fakeFetch(new Response('{}', { status: 200 }));
  const client = createDiscordClient({ token: 'T', apiBase: 'http://x/api', fetchImpl: f.impl });
  const r = await client.postMessage('123', { content: 'hi' });
  assert.deepEqual(r, { ok: true });
  assert.equal(f.calls[0].url, 'http://x/api/channels/123/messages');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bot T');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { content: 'hi', allowed_mentions: { parse: [] } });
});

test('postMessage classifies errors: 429 retryable with retry_after, 403 permanent, 500 and network retryable', async () => {
  const mk = (resp) => createDiscordClient({ token: 'T', fetchImpl: fakeFetch(resp).impl });

  const limited = await mk(new Response(JSON.stringify({ message: 'slow down', retry_after: 2.3 }), { status: 429 })).postMessage('1', { content: 'x' });
  assert.equal(limited.ok, false);
  assert.equal(limited.retryable, true);
  assert.equal(limited.retryAfterSec, 3);

  const denied = await mk(new Response(JSON.stringify({ message: 'Missing Access', code: 50001 }), { status: 403 })).postMessage('1', { content: 'x' });
  assert.equal(denied.retryable, false);
  assert.match(denied.error, /403.*Missing Access.*50001/);

  const down = await mk(new Response('oops', { status: 502 })).postMessage('1', { content: 'x' });
  assert.equal(down.retryable, true);

  const net = await mk(new Error('connection reset')).postMessage('1', { content: 'x' });
  assert.equal(net.retryable, true);
  assert.match(net.error, /connection reset/);
});
