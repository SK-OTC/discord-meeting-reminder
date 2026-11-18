// Cloudflare Worker entry point.
//   fetch      – Discord interactions endpoint (slash commands)
//   scheduled  – cron trigger, runs the reminder scheduler then the Google Calendar sync every minute
import { handleInteraction } from './commands.js';
import { createBridgeClient } from './bridge.js';
import { runCalendarSync } from './calendar-sync.js';
import { createDiscordClient, verifyDiscordSignature } from './discord.js';
import { runDueJobs } from './scheduler.js';

const MAX_CLOCK_SKEW_SEC = 300; // reject replayed requests older than 5 minutes

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

function makeDiscord(env) {
  return createDiscordClient({ token: env.DISCORD_BOT_TOKEN, apiBase: env.DISCORD_API_BASE });
}

// Google Calendar is optional: without BRIDGE_SECRET the feature is off and nothing else is affected.
// BRIDGE_ALLOWED_HOSTS exists only so the smoke test can point at a local mock; never set it in production.
const extraBridgeHosts = (env) =>
  String(env.BRIDGE_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);

function makeBridge(env) {
  return env.BRIDGE_SECRET ? createBridgeClient({ secret: env.BRIDGE_SECRET, extraHosts: extraBridgeHosts(env) }) : null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return new Response('meeting-time-bot is running');
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    if (!env.DISCORD_PUBLIC_KEY || !env.DISCORD_BOT_TOKEN || !env.DB) {
      console.error('Missing DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN, or the DB binding.');
      return new Response('Server is not configured', { status: 500 });
    }

    const body = await request.text();
    const timestamp = request.headers.get('X-Signature-Timestamp');
    const valid = await verifyDiscordSignature({
      publicKey: env.DISCORD_PUBLIC_KEY,
      signature: request.headers.get('X-Signature-Ed25519'),
      timestamp,
      body,
    });
    if (!valid) return new Response('Invalid request signature', { status: 401 });

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - Number(timestamp)) > MAX_CLOCK_SKEW_SEC) {
      return new Response('Stale request', { status: 401 });
    }

    let interaction;
    try {
      interaction = JSON.parse(body);
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    try {
      const response = await handleInteraction(interaction, {
        db: env.DB,
        discord: makeDiscord(env),
        bridge: makeBridge(env),
        defer: (promise) => ctx.waitUntil(promise),
        extraHosts: extraBridgeHosts(env),
        nowSec,
      });
      return json(response);
    } catch (e) {
      console.error('interaction failed:', e?.stack ?? e);
      const detail = String(e?.message ?? e).slice(0, 300);
      return json({
        type: 4,
        data: {
          content: `Something went wrong on my side: ${detail}
Please try again. If it keeps happening, tell the server admin.`,
          flags: 64,
          allowed_mentions: { parse: [] },
        },
      });
    }
  },

  async scheduled(event, env, ctx) {
    if (!env.DISCORD_BOT_TOKEN || !env.DB) {
      console.error('Scheduler skipped: missing DISCORD_BOT_TOKEN or DB binding.');
      return;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const discord = makeDiscord(env);
    ctx.waitUntil(
      (async () => {
        // Reminders are time-critical, so they run first; each step has its own try/catch so one cannot block the other.
        try {
          const summary = await runDueJobs({ db: env.DB, discord, nowSec });
          if (summary.claimed) console.log('scheduler:', JSON.stringify(summary));
        } catch (e) {
          console.error('scheduler failed:', e?.stack ?? e);
        }
        const bridge = makeBridge(env);
        if (!bridge) return;
        try {
          const summary = await runCalendarSync({ db: env.DB, discord, bridge, nowSec });
          if (summary.claimed) console.log('calendar sync:', JSON.stringify(summary));
        } catch (e) {
          console.error('calendar sync failed:', e?.stack ?? e);
        }
      })(),
    );
  },
};
