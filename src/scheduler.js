// Reminder scheduler. runDueJobs() is called by the cron trigger once a minute.
//
// Delivery guarantees (by design):
//  - At-least-once: a job claimed by a worker that dies is re-claimed after its lease expires,
//    so a crash can cause a duplicate message but never a silently missed one.
//  - Stale jobs are skipped: if a reminder is more than GRACE_SEC late (bot/cron outage),
//    it is marked 'skipped' instead of sending a misleading "starts in 5 minutes" message.
//  - Retries with backoff for network errors / 5xx / rate limits; permanent errors
//    (missing channel or permissions) fail immediately and show up in /upcoming-meetings.
import { addDaysLocal } from './time.js';
import {
  claimDueJobs,
  finishJob,
  getMeeting,
  pruneOld,
  replaceJobs,
  retryJobLater,
  updateMeeting,
} from './store.js';
import { allowedMentionsFor, reminderText, startText } from './messages.js';

export const GRACE_SEC = 600; // don't send a job that is more than 10 minutes late
export const MAX_ATTEMPTS = 4;
// Kept small so one invocation stays well under per-invocation query/subrequest limits on the
// Workers Free plan; anything left over is picked up by the next minute's run.
export const BATCH_SIZE = 5;

export const backoffSec = (attempts) => Math.min(60 * 2 ** (attempts - 1), 900);

/** A job only counts if the meeting still has exactly the time it was scheduled for. */
function isCurrent(job, meeting) {
  const expected =
    job.kind === 'reminder' ? meeting.start_at - meeting.reminder_minutes * 60 : meeting.start_at;
  return expected === job.fire_at;
}

/** After a meeting's start job finishes (any outcome), roll it forward or mark it done. */
async function afterStart(db, meeting, nowSec) {
  if (meeting.repeat !== 'weekly') {
    await updateMeeting(db, meeting.id, { status: 'done' }, nowSec);
    return;
  }
  let next = meeting.start_at;
  for (let i = 0; i < 600; i++) {
    next = Math.floor(addDaysLocal(next * 1000, meeting.timezone, 7) / 1000);
    if (next > nowSec) break;
  }
  await updateMeeting(db, meeting.id, { start_at: next }, nowSec);
  await replaceJobs(db, { ...meeting, start_at: next }, nowSec);
}

async function processJob({ db, discord, nowSec }, job, summary) {
  const finish = async (status, error = null, { advance = false, meeting = null } = {}) => {
    await finishJob(db, job.id, status, error);
    summary[status] = (summary[status] ?? 0) + 1;
    if (advance && job.kind === 'start' && meeting) await afterStart(db, meeting, nowSec);
  };

  const meeting = await getMeeting(db, job.meeting_id);
  if (!meeting || meeting.status !== 'active') return finish('skipped', 'meeting cancelled or removed');
  if (!isCurrent(job, meeting)) return finish('skipped', 'meeting was rescheduled');
  if (nowSec - job.fire_at > GRACE_SEC) {
    const lateBy = `${Math.round((nowSec - job.fire_at) / 60)} min overdue`;
    // If earlier attempts already failed, keep that real error visible (in /upcoming-meetings)
    // and report the job as failed, not as a harmless skip.
    if (job.last_error) {
      return finish('failed', `${job.last_error} (gave up retrying: ${lateBy})`, { advance: true, meeting });
    }
    return finish('skipped', `too late to send (${lateBy})`, { advance: true, meeting });
  }

  const content = job.kind === 'reminder' ? reminderText(meeting) : startText(meeting);
  const res = await discord.postMessage(meeting.channel_id, {
    content,
    allowedMentions: allowedMentionsFor(meeting, { ping: true }),
  });

  if (res.ok) return finish('sent', null, { advance: true, meeting });

  const permanent = !res.retryable;
  if (permanent || job.attempts >= MAX_ATTEMPTS) {
    return finish('failed', res.error, { advance: true, meeting });
  }
  const delay = res.retryAfterSec ?? backoffSec(job.attempts);
  await retryJobLater(db, job.id, nowSec + delay, res.error);
  summary.retried = (summary.retried ?? 0) + 1;
}

/** Processes up to BATCH_SIZE due jobs. Never throws; returns a summary for logging. */
export async function runDueJobs({ db, discord, nowSec }) {
  const summary = { claimed: 0 };
  const jobs = await claimDueJobs(db, nowSec, BATCH_SIZE);
  summary.claimed = jobs.length;
  for (const job of jobs) {
    try {
      await processJob({ db, discord, nowSec }, job, summary);
    } catch (e) {
      // Unexpected error (e.g. database hiccup). Leave the job leased: it is re-claimed once
      // the lease expires, so it is retried rather than lost.
      summary.errors = (summary.errors ?? 0) + 1;
      console.error(`job ${job.id} (${job.kind}) failed unexpectedly:`, e?.message ?? e);
    }
  }
  if (new Date(nowSec * 1000).getUTCMinutes() === 0) {
    try {
      await pruneOld(db, nowSec);
    } catch (e) {
      console.error('prune failed:', e?.message ?? e);
    }
  }
  return summary;
}
