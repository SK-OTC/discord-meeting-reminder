// Google Calendar sync. runCalendarSync() is called by the cron trigger right after the reminder
// scheduler. Commands only mark meetings "dirty"; this step does the slow calls to Google, because a
// slash command has 3 seconds and the bridge can take longer.
//
// Safety properties (by design):
//  - Retries are safe: the event id is chosen and stored before the first call, create is idempotent
//    on it, update is a patch, and cancel on a missing event succeeds.
//  - The action is chosen from the meeting's CURRENT state, not from what changed.
//  - No lost updates: a sync only clears the dirty flag if nobody changed the meeting while the call
//    to Google was in flight (version check in finishSync).
//  - Every failure is explained: the reason is stored (shown in /upcoming-meetings) and sent privately
//    to the organizer when a private follow-up is still possible.
import { bridgeTimeZone } from './time.js';
import {
  claimDirtyMeetings,
  clearFollowup,
  finishSync,
  getCalendarAccount,
  getMeeting,
  getTeam,
  listGuests,
  markMeetingDirty,
  retrySyncLater,
} from './store.js';
import { calendarCreatedNote, calendarFailureNote, calendarFailurePublic, meetLinkText } from './messages.js';
import { MAX_ATTEMPTS, backoffSec } from './scheduler.js';

// Each meeting costs two outbound requests (POST + GET) plus Discord messages, and the Workers Free
// plan limits subrequests per invocation, so keep the batch small. The rest wait for the next minute.
export const SYNC_BATCH_SIZE = 2;

const bump = (summary, key) => {
  summary[key] = (summary[key] ?? 0) + 1;
};

/** Which call to make, from the meeting's current state. null = nothing to do, just clear the flags. */
export function chooseAction(m) {
  if (m.status === 'cancelled') return m.gcal_event_id ? 'cancel' : null;
  if (m.status === 'active') return m.gcal_created ? 'update' : 'create';
  return null; // done
}

function buildPayload(m, action, guests) {
  const payload = { action, eventId: m.gcal_event_id };
  if (action === 'cancel') return { ...payload, sendInvites: true };
  return {
    ...payload,
    title: m.name,
    startSec: m.start_at,
    durationMin: m.duration_min,
    timezone: bridgeTimeZone(m.timezone),
    repeat: m.repeat,
    location: m.location ?? '',
    description: `Discord: https://discord.com/channels/${m.guild_id}/${m.channel_id}`,
    guests,
    meet: m.gcal_meet !== 0, // can only be chosen when the event is created; Google cannot add or remove it later
    sendInvites: true,
  };
}

/** The interaction token saved with the meeting, if it can still be used for a private message. */
function validFollowup(m, nowSec) {
  return m.gcal_followup_token && m.gcal_followup_app_id && m.gcal_followup_expires > nowSec
    ? { appId: m.gcal_followup_app_id, token: m.gcal_followup_token }
    : null;
}

async function tellOrganizer({ db, discord, nowSec }, m, content) {
  const followup = validFollowup(m, nowSec);
  if (!followup) {
    await clearFollowup(db, m.id); // expired (or never saved): drop it
    return { sent: false, reason: 'the private follow-up window (15 minutes) has passed' };
  }
  const res = await discord.sendFollowup(followup.appId, followup.token, { content });
  await clearFollowup(db, m.id); // used or dead either way
  if (!res.ok) console.warn(`calendar sync: private follow-up for meeting ${m.id} failed: ${res.error}`);
  return res.ok ? { sent: true } : { sent: false, reason: res.error };
}

async function giveUp(ctx, m, action, error, version, summary) {
  const { db, discord } = ctx;
  await finishSync(db, m.id, version, { error });
  bump(summary, 'failed');
  const told = await tellOrganizer(ctx, m, calendarFailureNote(m, { action, error, attempts: m.gcal_attempts + 1 }));
  const pub = await discord.postMessage(m.channel_id, {
    content: calendarFailurePublic(m, { organizerTold: told.sent }),
    allowedMentions: { parse: [] },
  });
  if (!pub.ok) console.warn(`calendar sync: could not post the failure notice for meeting ${m.id}: ${pub.error}`);
}

async function afterCreate(ctx, m, res) {
  const { db, discord } = ctx;
  const link = m.gcal_meet !== 0 ? res.meetLink || '' : '';
  let linkPosted = false;
  let linkPostError = null;
  if (link) {
    const post = await discord.postMessage(m.channel_id, { content: meetLinkText(m, link), allowedMentions: { parse: [] } });
    linkPosted = post.ok;
    linkPostError = post.ok ? null : post.error;
    if (!post.ok) console.warn(`calendar sync: could not post the Meet link for meeting ${m.id}: ${post.error}`);
  }
  const team = m.guest_team_key ? await getTeam(db, m.guild_id, m.guest_team_key) : null;
  const guestCount = team ? (await listGuests(db, m.guild_id, team.team_key)).length : 0;
  const account = await getCalendarAccount(db, m.gcal_owner_id);
  await tellOrganizer(ctx, m, calendarCreatedNote(m, {
    account: account?.account_email,
    teamName: team?.name ?? null,
    guestCount,
    meetRequested: m.gcal_meet !== 0,
    meetLink: link,
    linkPosted,
    linkPostError,
  }));
}

async function processMeeting(ctx, m, summary) {
  const { db, bridge } = ctx;
  const version = m.gcal_version;
  const action = chooseAction(m);
  if (!action) {
    // Cancelled with no event, or the meeting is over. If its event was never created, say so instead of clearing silently.
    const neverCreated = m.status === 'done' && m.gcal_event_id && !m.gcal_created;
    await finishSync(db, m.id, version, {
      error: neverCreated ? 'the meeting ended before it could be added to Google Calendar' : null,
    });
    return bump(summary, 'cleared');
  }

  const account = m.gcal_owner_id ? await getCalendarAccount(db, m.gcal_owner_id) : null;
  if (!account) {
    return giveUp(
      ctx,
      m,
      action,
      'the owner of this calendar event has disconnected their Google Calendar (or never connected it), so it can no longer be synced.',
      version,
      summary,
    );
  }

  const guests = action !== 'cancel' && m.guest_team_key ? await listGuests(db, m.guild_id, m.guest_team_key) : [];
  const res = await bridge.call(account.script_url, buildPayload(m, action, guests));

  if (res.ok) {
    if (action === 'cancel') {
      await finishSync(db, m.id, version);
      return bump(summary, 'cancelled');
    }
    await finishSync(db, m.id, version, { created: true, meetLink: m.gcal_meet !== 0 ? res.meetLink : null });
    bump(summary, action === 'create' ? 'created' : 'updated');
    if (action === 'create') {
      // The event already existed (a retry after a lost answer): send one more update so it converges.
      if (res.created === false) await markMeetingDirty(db, m.id);
      // Cancelled while the call was in flight: the next run deletes the event, so don't announce its link.
      const current = await getMeeting(db, m.id);
      if (current?.status === 'active') await afterCreate(ctx, m, res);
      else await clearFollowup(db, m.id);
    }
    return;
  }

  const attempts = m.gcal_attempts + 1;
  if (res.retryable && attempts < MAX_ATTEMPTS) {
    await retrySyncLater(db, m.id, ctx.nowSec + backoffSec(attempts), `${res.error} (attempt ${attempts} of ${MAX_ATTEMPTS}, will retry)`);
    return bump(summary, 'retried');
  }
  return giveUp(ctx, m, action, res.error, version, summary);
}

/** Syncs up to SYNC_BATCH_SIZE dirty meetings. Never throws; returns a summary for logging. */
export async function runCalendarSync({ db, discord, bridge, nowSec }) {
  const summary = { claimed: 0 };
  const ctx = { db, discord, bridge, nowSec };
  const meetings = await claimDirtyMeetings(db, nowSec, SYNC_BATCH_SIZE);
  summary.claimed = meetings.length;
  for (const m of meetings) {
    try {
      await processMeeting(ctx, m, summary);
    } catch (e) {
      // Unexpected error (code or database problem). Record it where the user can see it and retry.
      bump(summary, 'errors');
      const message = `unexpected error: ${e?.message ?? e}`;
      console.error(`calendar sync of meeting ${m.id} failed unexpectedly:`, e?.stack ?? e);
      try {
        const attempts = m.gcal_attempts + 1;
        if (attempts < MAX_ATTEMPTS) await retrySyncLater(db, m.id, nowSec + backoffSec(attempts), message);
        else await giveUp(ctx, m, chooseAction(m) ?? 'update', message, m.gcal_version, summary);
      } catch (inner) {
        console.error(`could not record the failure of meeting ${m.id}:`, inner?.message ?? inner);
      }
    }
  }
  return summary;
}
