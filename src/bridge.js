// Client for the Google Calendar bridge (the Apps Script web app each meeting organizer deploys, see Code.gs).
//
// Apps Script answers every POST with a redirect to a one-time script.googleusercontent.com URL,
// and the real JSON answer is only available by GETting that URL. So: POST without following
// redirects, read Location, GET it.
//
// SECURITY: the shared secret is sent in every request body, so a registered URL is a place the
// secret gets sent. Only https://script.google.com/macros/s/<id>/exec is accepted (checked when
// connecting AND again on every call), and a redirect is only followed to exactly
// script.googleusercontent.com. `extraHosts` exists only so the smoke test can point at a local mock;
// production must never configure it.

const SCRIPT_HOST = 'script.google.com';
const REDIRECT_HOST = 'script.googleusercontent.com';
const SCRIPT_PATH = /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
export const BRIDGE_TIMEOUT_MS = 15000;

/** Checks a script URL. Returns { ok: true, url } or { ok: false, error } saying exactly what is wrong. */
export function validateScriptUrl(input, { extraHosts = [] } = {}) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    return { ok: false, error: 'That is not a valid URL. Paste the full web app URL that ends in /exec.' };
  }
  const override = extraHosts.includes(u.host);
  if (u.protocol !== 'https:' && !override) {
    return { ok: false, error: 'The URL must start with https://.' };
  }
  if (u.host !== SCRIPT_HOST && !override) {
    return { ok: false, error: `The URL must be on ${SCRIPT_HOST} (it is on ${u.host}). Use the Web app URL from your Apps Script deployment.` };
  }
  if (u.username || u.password) return { ok: false, error: 'The URL must not contain a username or password.' };
  if (!SCRIPT_PATH.test(u.pathname)) {
    return { ok: false, error: 'The URL path must look like /macros/s/<id>/exec. Copy the Web app URL from Deploy > Manage deployments.' };
  }
  return { ok: true, url: `${u.origin}${u.pathname}` };
}

/**
 * Calls the bridge. Never throws. Returns:
 *   { ok: true, ...fields from the script (account, eventId, meetLink, created, ...) }
 *   { ok: false, retryable, error }   error always says what failed and why
 */
export function createBridgeClient({ secret, fetchImpl, timeoutMs = BRIDGE_TIMEOUT_MS, extraHosts = [] }) {
  const doFetch = fetchImpl ?? ((...args) => fetch(...args));

  async function hop(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return { res: await doFetch(url, { ...init, redirect: 'manual', signal: controller.signal }) };
    } catch (e) {
      const timedOut = e?.name === 'AbortError' || controller.signal.aborted;
      return {
        error: timedOut
          ? `the bridge did not answer within ${Math.round(timeoutMs / 1000)} seconds`
          : `could not reach the bridge (${e?.message ?? e})`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(scriptUrl, payload) {
    const checked = validateScriptUrl(scriptUrl, { extraHosts });
    if (!checked.ok) {
      return {
        ok: false,
        retryable: false,
        error: `The saved script URL is not allowed (${checked.error}) The secret was NOT sent. Reconnect with /calendar connect.`,
      };
    }

    const first = await hop(checked.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, secret }),
    });
    if (first.error) return { ok: false, retryable: true, error: `Google Calendar bridge: ${first.error}.` };

    let res = first.res;
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) {
        return { ok: false, retryable: false, error: 'Google Calendar bridge: the redirect had no Location header.' };
      }
      let target;
      try {
        target = new URL(location, checked.url);
      } catch {
        return { ok: false, retryable: false, error: 'Google Calendar bridge: the redirect had no usable Location header.' };
      }
      const hostOk = target.host === REDIRECT_HOST || extraHosts.includes(target.host);
      if (!hostOk || (target.protocol !== 'https:' && !extraHosts.includes(target.host))) {
        return {
          ok: false,
          retryable: false,
          error: `Google Calendar bridge: refused to follow a redirect to ${target.host} (only ${REDIRECT_HOST} is allowed).`,
        };
      }
      const second = await hop(target.toString(), { method: 'GET' });
      if (second.error) return { ok: false, retryable: true, error: `Google Calendar bridge: ${second.error}.` };
      res = second.res;
    }

    if (res.status >= 500) {
      return { ok: false, retryable: true, error: `Google Calendar bridge: Google answered HTTP ${res.status}. This is usually temporary.` };
    }
    if (res.status >= 300) {
      return {
        ok: false,
        retryable: false,
        error: `Google Calendar bridge: unexpected HTTP ${res.status}. Check the script URL and that the deployment is set to "Anyone".`,
      };
    }

    let data;
    try {
      data = JSON.parse(await res.text());
    } catch {
      return { ok: false, retryable: false, error: 'Google Calendar bridge: the bridge returned non-JSON (is the deployment set to "Anyone"?)' };
    }
    if (!data || typeof data !== 'object') {
      return { ok: false, retryable: false, error: 'Google Calendar bridge: the bridge returned an unexpected reply.' };
    }
    if (data.ok === true) return data;

    const message = String(data.error ?? 'no details');
    if (/^busy,\s*retry/i.test(message)) {
      return { ok: false, retryable: true, error: 'Google Calendar bridge: the script was busy with another request.' };
    }
    if (message === 'unauthorized') {
      return {
        ok: false,
        retryable: false,
        error:
          'Google Calendar bridge: the script rejected the secret. BOT_SECRET in the meeting organizer\'s script properties must match the bot\'s BRIDGE_SECRET.',
      };
    }
    return { ok: false, retryable: false, error: `Google Calendar bridge: ${message}` };
  }

  return { call };
}
