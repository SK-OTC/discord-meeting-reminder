import test from 'node:test';
import assert from 'node:assert/strict';
import { handleInteraction } from '../src/commands.js';
import { BATCH_SIZE, GRACE_SEC, MAX_ATTEMPTS, runDueJobs } from '../src/scheduler.js';
import { insertMeeting, meetingsWithFailedJobs, nameKey, replaceJobs } from '../src/store.js';
import { createFakeDiscord, createTestDb } from './helpers/d1.js';

const T0 = Date.UTC(2026, 10, 17, 12, 0, 0) / 1000;
const START = T0 + 3600; // meeting starts one hour after T0; reminder (15 min) fires at START - 900

async function seed(db, over = {}, nowSec = T0) {
  const m = {
    guild_id: 'g1',
    name: 'Team Sync',
    channel_id: 'c1',
    location: 'Voice Lounge',
    timezone: 'UTC',
    start_at: START,
    reminder_minutes: 15,
    repeat: 'none',
    role_id: null,
    created_by: 'u1',
    ...over,
  };
  m.name_key = nameKey(m.name);
  m.id = await insertMeeting(db, m, nowSec);
  await replaceJobs(db, m, nowSec);
  return m;
}

const setup = (script) => {
  const db = createTestDb();
  const discord = createFakeDiscord(script);
  const tick = (nowSec) => runDueJobs({ db, discord, nowSec });
  return { db, discord, tick };
};
const jobRows = (db) => db.sql('SELECT id, kind, fire_at, status, attempts, run_after, last_error FROM jobs ORDER BY fire_at');
const meeting = (db, id = 1) => db.sql('SELECT * FROM meetings WHERE id = ?', id)[0];

test('nothing is sent before a job is due', async () => {
  const t = setup();
  await seed(t.db);
  const s = await t.tick(START - 901);
  assert.equal(s.claimed, 0);
  assert.equal(t.discord.posts.length, 0);
});

test('the reminder and start messages are sent once each, to the meeting channel', async () => {
  const t = setup();
  await seed(t.db, { channel_id: 'c5', role_id: 'r1' });

  await t.tick(START - 900);
  assert.equal(t.discord.posts.length, 1);
  assert.equal(t.discord.posts[0].channelId, 'c5');
  assert.match(t.discord.posts[0].content, /Team Sync/);
  assert.match(t.discord.posts[0].content, /<@&r1>/);
  assert.match(t.discord.posts[0].content, new RegExp(`<t:${START}:R>`));
  assert.deepEqual(t.discord.posts[0].allowedMentions, { parse: [], roles: ['r1'] });

  await t.tick(START - 840); // a minute later: nothing new
  assert.equal(t.discord.posts.length, 1);

  await t.tick(START);
  assert.equal(t.discord.posts.length, 2);
  assert.match(t.discord.posts[1].content, /is starting now/);
  assert.deepEqual(jobRows(t.db).map((j) => j.status), ['sent', 'sent']);
});

test('a finished one-off meeting is marked done and its name becomes reusable', async () => {
  const t = setup();
  await seed(t.db);
  await t.tick(START);
  assert.equal(meeting(t.db).status, 'done');
  await seed(t.db, { name: 'Team Sync', start_at: START + 86400 }); // would violate the unique index if still active
});

test('two overlapping runs never double-send a job', async () => {
  const t = setup();
  await seed(t.db);
  await Promise.all([t.tick(START - 900), t.tick(START - 900)]);
  assert.equal(t.discord.posts.length, 1);
});

test('stale jobs are skipped instead of sent late', async () => {
  const t = setup();
  await seed(t.db);
  // bot was down: first tick happens 11 minutes after the reminder was due
  await t.tick(START - 900 + GRACE_SEC + 60);
  assert.equal(t.discord.posts.length, 0);
  const [reminder] = jobRows(t.db);
  assert.equal(reminder.status, 'skipped');
  assert.match(reminder.last_error, /too late/);

  // ...but a start message inside the grace window still goes out
  await t.tick(START + 120);
  assert.equal(t.discord.posts.length, 1);
  assert.match(t.discord.posts[0].content, /starting now/);
});

test('a missed one-off meeting is closed out, not left active forever', async () => {
  const t = setup();
  await seed(t.db);
  await t.tick(START + 3 * 3600); // down for hours
  assert.equal(t.discord.posts.length, 0);
  assert.equal(meeting(t.db).status, 'done');
});

test('weekly meetings roll forward after the start message, keeping the wall-clock time across DST', async () => {
  const t = setup();
  // Sun 2026-10-25 15:00 America/Chicago (CDT) = 20:00Z; one week later the clocks have gone back
  const start = Date.UTC(2026, 9, 25, 20, 0, 0) / 1000;
  await seed(t.db, { timezone: 'America/Chicago', start_at: start, repeat: 'weekly' }, start - 7200);

  await t.tick(start - 900); // reminder
  await t.tick(start); // start
  assert.equal(t.discord.posts.length, 2);

  const m = meeting(t.db);
  assert.equal(m.status, 'active');
  assert.equal(m.start_at, Date.UTC(2026, 10, 1, 21, 0, 0) / 1000); // 15:00 CST
  const pending = jobRows(t.db).filter((j) => j.status === 'pending');
  assert.deepEqual(
    pending.map((j) => [j.kind, j.fire_at]),
    [['reminder', m.start_at - 900], ['start', m.start_at]],
  );

  // and the following week's messages are sent too
  await t.tick(m.start_at - 900);
  assert.equal(t.discord.posts.length, 3);
});

test('a weekly meeting that was down for weeks resumes at the next future occurrence', async () => {
  const t = setup();
  await seed(t.db, { repeat: 'weekly' });
  const now = START + 20 * 86400 + 5 * 3600; // ~20 days late
  await t.tick(now);
  assert.equal(t.discord.posts.length, 0); // nothing stale is sent
  const m = meeting(t.db);
  assert.equal(m.status, 'active');
  assert.ok(m.start_at > now);
  assert.equal((m.start_at - START) % (7 * 86400), 0);
  assert.ok(m.start_at - now <= 7 * 86400);
});

test('retryable failures back off and eventually succeed', async () => {
  const t = setup([{ ok: false, retryable: true, error: 'HTTP 502: bad gateway' }]);
  await seed(t.db, { reminder_minutes: 0 });
  await t.tick(START);
  let [job] = jobRows(t.db);
  assert.equal(job.status, 'pending');
  assert.equal(job.attempts, 1);
  assert.equal(job.run_after, START + 60);
  assert.match(job.last_error, /502/);

  await t.tick(START + 30); // not yet
  assert.equal(t.discord.posts.length, 1);
  await t.tick(START + 60); // retry succeeds
  assert.equal(t.discord.posts.length, 2);
  [job] = jobRows(t.db);
  assert.equal(job.status, 'sent');
});

test('rate limits wait for the time Discord asked for', async () => {
  const t = setup([{ ok: false, retryable: true, retryAfterSec: 120, error: 'HTTP 429' }]);
  await seed(t.db, { reminder_minutes: 0 });
  await t.tick(START);
  assert.equal(jobRows(t.db)[0].run_after, START + 120);
});

test('repeated retryable failures give up after MAX_ATTEMPTS and are reported', async () => {
  const fails = Array.from({ length: MAX_ATTEMPTS }, () => ({ ok: false, retryable: true, error: 'HTTP 500: boom' }));
  const t = setup(fails);
  await seed(t.db, { reminder_minutes: 0 });
  let now = START;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await t.tick(now);
    now = jobRows(t.db)[0].run_after; // next attempt happens exactly when the backoff allows
  }
  const [job] = jobRows(t.db);
  assert.equal(job.status, 'failed');
  assert.equal(job.attempts, MAX_ATTEMPTS);
  assert.equal(t.discord.posts.length, MAX_ATTEMPTS);
  assert.ok(now - START <= GRACE_SEC, 'all backed-off attempts fit inside the grace window');
  const flagged = await meetingsWithFailedJobs(t.db, [1], now);
  assert.match(flagged.get(1).last_error, /boom/);
});

test('a retry that comes too late is reported as failed with the original error, not a silent skip', async () => {
  const t = setup([{ ok: false, retryable: true, error: 'HTTP 502: bad gateway' }]);
  await seed(t.db, { reminder_minutes: 0 });
  await t.tick(START); // attempt 1 fails
  await t.tick(START + GRACE_SEC + 120); // cron was down; the retry is far past the grace window
  assert.equal(t.discord.posts.length, 1); // nothing sent late
  const [job] = jobRows(t.db);
  assert.equal(job.status, 'failed');
  assert.match(job.last_error, /502.*gave up retrying/);
});

test('permanent errors (missing permissions) fail immediately; weekly meetings keep going', async () => {
  const t = setup([{ ok: false, retryable: false, status: 403, error: 'HTTP 403: Missing Access (code 50001)' }]);
  await seed(t.db, { repeat: 'weekly', reminder_minutes: 0 });
  await t.tick(START);
  assert.equal(t.discord.posts.length, 1); // no retries
  const failed = jobRows(t.db).find((j) => j.fire_at === START);
  assert.equal(failed.status, 'failed');
  assert.match(failed.last_error, /Missing Access/);
  assert.equal(meeting(t.db).start_at, START + 7 * 86400); // still rolled forward
});

test('jobs are skipped when the meeting was cancelled or rescheduled behind their back', async () => {
  const t = setup();
  await seed(t.db);
  await seed(t.db, { name: 'Other', start_at: START + 600 });
  t.db.sql("UPDATE meetings SET status = 'cancelled' WHERE id = 1");
  t.db.sql('UPDATE meetings SET start_at = start_at + 7200 WHERE id = 2'); // moved without replaceJobs

  await t.tick(START + 600);
  assert.equal(t.discord.posts.length, 0);
  assert.ok(jobRows(t.db).filter((j) => j.status === 'skipped').length >= 2);
  assert.ok(jobRows(t.db).some((j) => /cancelled/.test(j.last_error ?? '')));
  assert.ok(jobRows(t.db).some((j) => /rescheduled/.test(j.last_error ?? '')));
});

test('a job whose worker crashed is re-claimed only after its lease expires', async () => {
  const t = setup();
  await seed(t.db, { reminder_minutes: 0 });
  t.db.sql(`UPDATE jobs SET status = 'sending', attempts = 1, lease_until = ${START + 100}`);

  await t.tick(START + 50); // lease still held by the (presumably alive) worker
  assert.equal(t.discord.posts.length, 0);
  await t.tick(START + 101); // lease expired: pick it up
  assert.equal(t.discord.posts.length, 1);
  assert.equal(jobRows(t.db)[0].status, 'sent');
});

test('each cron run handles at most BATCH_SIZE jobs and the rest follow on the next run', async () => {
  const t = setup();
  const total = BATCH_SIZE + 3;
  for (let i = 0; i < total; i++) await seed(t.db, { name: `M${i}`, reminder_minutes: 0 });
  await t.tick(START);
  assert.equal(t.discord.posts.length, BATCH_SIZE);
  await t.tick(START + 60);
  assert.equal(t.discord.posts.length, total);
});

test('editing a meeting after its reminder went out does not send the reminder again', async () => {
  const db = createTestDb();
  const discord = createFakeDiscord();
  const run = (i, nowSec) => handleInteraction(i, { db, discord, nowSec });
  const slash = (sub, options) => ({
    type: 2,
    guild_id: 'g1',
    channel_id: 'c1',
    member: { user: { id: 'u1' }, permissions: '0' },
    data: { name: { create: 'new-meeting', update: 'update-meeting' }[sub], options: Object.entries(options).map(([name, value]) => ({ name, value, type: 3 })) },
  });

  await run({ type: 2, guild_id: 'g1', channel_id: 'c1', member: { user: { id: 'u1' } }, data: { name: 'set-timezone', options: [{ name: 'timezone', value: 'UTC', type: 3 }] } }, T0);
  await run(slash('create', { name: 'Team Sync', date: '2026-11-17', time: '13:00' }), T0);
  const start = START;

  // create and update each post a public notice; only count the scheduled reminder/start messages
  const scheduled = () => discord.posts.filter((p) => /kicks off|starting now/.test(p.content));

  await runDueJobs({ db, discord, nowSec: start - 900 });
  assert.equal(scheduled().length, 1);

  await run(slash('update', { name: 'Team Sync', location: 'Room 9' }), start - 800);
  await runDueJobs({ db, discord, nowSec: start - 700 });
  assert.equal(scheduled().length, 1); // still just the one reminder

  await runDueJobs({ db, discord, nowSec: start });
  assert.equal(scheduled().length, 2);
  assert.match(scheduled()[1].content, /Room 9/);
});

test('reminder and start messages mention every role and allow exactly those roles', async () => {
  const t = setup();
  await seed(t.db, { role_id: 'r1,r2,r3', reminder_minutes: 180, start_at: START + 3 * 3600 });

  await t.tick(START);
  assert.equal(t.discord.posts.length, 1);
  assert.match(t.discord.posts[0].content, /^<@&r1> <@&r2> <@&r3> Heads up/);
  assert.deepEqual(t.discord.posts[0].allowedMentions, { parse: [], roles: ['r1', 'r2', 'r3'] });

  await t.tick(START + 3 * 3600);
  assert.match(t.discord.posts[1].content, /^<@&r1> <@&r2> <@&r3> /);
  assert.deepEqual(t.discord.posts[1].allowedMentions, { parse: [], roles: ['r1', 'r2', 'r3'] });
});
