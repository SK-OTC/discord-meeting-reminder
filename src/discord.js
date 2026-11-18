// Discord plumbing: request signature verification and the REST client used to post messages.

export const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, AUTOCOMPLETE: 4 };
export const ResponseType = { PONG: 1, MESSAGE: 4, DEFERRED: 5, AUTOCOMPLETE: 8 };
export const MessageFlags = { EPHEMERAL: 64 };

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error('invalid hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Node and recent workerd accept "Ed25519"; older workerd uses the "NODE-ED25519" name.
const ED25519_VARIANTS = [{ name: 'Ed25519' }, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }];
const keyCache = new Map();

async function importPublicKey(publicKeyHex) {
  const cached = keyCache.get(publicKeyHex);
  if (cached) return cached;
  const raw = hexToBytes(publicKeyHex);
  for (const alg of ED25519_VARIANTS) {
    try {
      const key = await crypto.subtle.importKey('raw', raw, alg, false, ['verify']);
      const entry = { key, algName: alg.name };
      keyCache.set(publicKeyHex, entry);
      return entry;
    } catch {
      // try the next variant
    }
  }
  throw new Error('Ed25519 is not supported by this runtime');
}

/** Verifies Discord's Ed25519 signature over `timestamp + body`. Never throws. */
export async function verifyDiscordSignature({ publicKey, signature, timestamp, body }) {
  if (!publicKey || !signature || !timestamp) return false;
  try {
    const { key, algName } = await importPublicKey(publicKey);
    const message = new TextEncoder().encode(timestamp + body);
    return await crypto.subtle.verify(algName, key, hexToBytes(signature), message);
  } catch {
    return false;
  }
}

/**
 * Minimal Discord REST client. Every function never throws; each returns:
 *   { ok: true }
 *   { ok: false, retryable, retryAfterSec?, status?, error }
 * postMessage posts as the bot. sendFollowup and editOriginal use an interaction token (valid for
 * 15 minutes after the command) and need no bot header.
 */
export function createDiscordClient({ token, apiBase = 'https://discord.com/api/v10', fetchImpl }) {
  const doFetch = fetchImpl ?? ((...args) => fetch(...args));

  async function send(method, url, payload, { asBot }) {
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (meeting-time-bot, 1.0.0)' };
    if (asBot) headers.Authorization = `Bot ${token}`;
    let res;
    try {
      res = await doFetch(url, { method, headers, body: JSON.stringify(payload) });
    } catch (e) {
      return { ok: false, retryable: true, error: `network error: ${e?.message ?? e}` };
    }
    if (res.ok) return { ok: true };

    let body = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON error body
    }
    const status = res.status;
    const detail = body?.message ? `${body.message}${body.code ? ` (code ${body.code})` : ''}` : 'no details';
    const result = {
      ok: false,
      status,
      retryable: status === 429 || status >= 500,
      error: `HTTP ${status}: ${detail}`,
    };
    if (status === 429) {
      const fromBody = Number(body?.retry_after);
      const fromHeader = Number(res.headers.get('retry-after'));
      result.retryAfterSec = Math.ceil(
        Number.isFinite(fromBody) && fromBody > 0 ? fromBody : Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : 5,
      );
    }
    return result;
  }

  const postMessage = (channelId, { content, allowedMentions }) =>
    send('POST', `${apiBase}/channels/${channelId}/messages`, { content, allowed_mentions: allowedMentions ?? { parse: [] } }, { asBot: true });

  /** A message only the person who ran the command can see. */
  const sendFollowup = (appId, interactionToken, { content }) =>
    send(
      'POST',
      `${apiBase}/webhooks/${appId}/${interactionToken}`,
      { content, flags: MessageFlags.EPHEMERAL, allowed_mentions: { parse: [] } },
      { asBot: false },
    );

  /** Replaces the "thinking..." placeholder of a deferred reply. */
  const editOriginal = (appId, interactionToken, { content }) =>
    send(
      'PATCH',
      `${apiBase}/webhooks/${appId}/${interactionToken}/messages/@original`,
      { content, allowed_mentions: { parse: [] } },
      { asBot: false },
    );

  return { postMessage, sendFollowup, editOriginal };
}
