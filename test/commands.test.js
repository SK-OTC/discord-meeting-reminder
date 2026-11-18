import test from 'node:test';
import assert from 'node:assert/strict';
import { handleInteraction } from '../src/commands.js';
import { createFakeDiscord, createTestDb } from './helpers/d1.js';

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0) / 1000; // Tue 2026-11-17 12:00 UTC
const CHI_3PM_NOV20 = Date.UTC(2026, 10, 20, 21, 0, 0) / 1000; // 15:00 CST = 21:00Z

function setup(discordScript) {
  const db = createTestDb();
  const discord = createFakeDiscord(discordScript);
  const run = (interaction) => handleInteraction(interaction, { db, discord, nowSec: NOW });
  return { db, discord, run };
}

const toOptions = (opts) => Object.entries(opts).map(([name, value]) => ({ name, value, type: 3 }));

const COMMAND_NAMES = { create: 'new-meeting', update: 'update-meeting', cancel: 'cancel-meeting', list: 'upcoming-meetings', 'preset-save': 'add-update-preset', presets: 'meeting-presets', 'preset-delete': 'delete-preset' };
function slash(sub, opts = {}, { user = 'u1', guild = 'g1', channel = 'c1', perms = '0' } = {}) {
  return {
    type: 2,
    guild_id: guild,
    channel_id: channel,
    member: { user: { id: user }, permissions: perms },
    data: { name: COMMAND_NAMES[sub], options: toOptions(opts) },
  };
}

const setTz = (tz, user = 'u1') => ({
  type: 2,
  guild_id: 'g1',
  channel_id: 'c1',
  member: { user: { id: user }, permissions: '0' },
  data: { name: 'set-timezone', options: toOptions({ timezone: tz }) },
});

const isEphemeral = (r) => (r.data.flags & 64) === 64;
const jobs = (db, meetingId = 1) =>
  db.sql('SELECT kind, fire_at, status FROM jobs WHERE meeting_id = ? ORDER BY fire_at', meetingId);

async function createStandup(t, extra = {}) {
  await t.run(setTz('America/Chicago'));
  return t.run(slash('create', { name: 'Team Sync', date: '2026-11-20', time: '3pm', ...extra }));
}

test('set-timezone saves the canonical zone and confirms privately', async () => {
  const t = setup();
  const r = await t.run(setTz('america/chicago'));
  assert.equal(isEphemeral(r), true);
  assert.match(r.data.content, /America\/Chicago/);
  assert.equal(t.db.sql('SELECT timezone FROM users WHERE user_id = ?', 'u1')[0].timezone, 'America/Chicago');

  const bad = await t.run(setTz('Mars/Olympus'));
  assert.match(bad.data.content, /don't recognise/);
});

test('create needs a timezone, then schedules reminder + start jobs and confirms privately', async () => {
  const t = setup();
  const noTz = await t.run(slash('create', { name: 'Team Sync', date: '2026-11-20', time: '3pm' }));
  assert.equal(isEphemeral(noTz), true);
  assert.match(noTz.data.content, /set-timezone/);

  const r = await createStandup(t, { location: 'Voice Lounge' });
  assert.equal(isEphemeral(r), true);
  // a separate public notice goes to the channel with name, time and location, but not the private details
  assert.equal(t.discord.posts.length, 1);
  assert.equal(t.discord.posts[0].channelId, 'c1');
  assert.match(t.discord.posts[0].content, /New meeting: Team Sync/);
  assert.match(t.discord.posts[0].content, new RegExp(`<t:${CHI_3PM_NOV20}:F>`));
  assert.match(t.discord.posts[0].content, /Where: Voice Lounge/);
  assert.doesNotMatch(t.discord.posts[0].content, /only you|Entered as|Reminder:/);
  assert.doesNotMatch(r.data.content, /❌|✅|⏰|🕒/u);
  assert.match(r.data.content, new RegExp(`<t:${CHI_3PM_NOV20}:F>`));
  assert.match(r.data.content, new RegExp(`<t:${CHI_3PM_NOV20}:R>`));
  assert.match(r.data.content, /Team Sync/);
  assert.match(r.data.content, /Voice Lounge/);
  assert.match(r.data.content, /America\/Chicago/);
  assert.deepEqual(r.data.allowed_mentions, { parse: [] });

  assert.deepEqual(jobs(t.db), [
    { kind: 'reminder', fire_at: CHI_3PM_NOV20 - 900, status: 'pending' },
    { kind: 'start', fire_at: CHI_3PM_NOV20, status: 'pending' },
  ]);
});

test('an explicit timezone option works without a saved zone and does not overwrite it', async () => {
  const t = setup();
  const r = await t.run(slash('create', { name: 'Karachi Call', date: '2026-11-20', time: '20:00', timezone: 'Asia/Karachi' }));
  assert.equal(isEphemeral(r), true);
  const row = t.db.sql('SELECT start_at, timezone FROM meetings')[0];
  assert.equal(row.start_at, Date.UTC(2026, 10, 20, 15, 0, 0) / 1000); // UTC+5
  assert.equal(row.timezone, 'Asia/Karachi');
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM users')[0].n, 0);
});

test('create rejects past times, DST-gap times, bad input, and duplicate names', async () => {
  const t = setup();
  await t.run(setTz('America/Chicago'));
  const attempt = (o) => t.run(slash('create', { name: 'X', date: '2026-11-20', time: '3pm', ...o }));

  assert.match((await attempt({ date: '2026-11-16' })).data.content, /in the past/);
  assert.match((await attempt({ date: 'today', time: '6am' })).data.content, /in the past/); // 06:00 CST is before 12:00Z now
  assert.match((await attempt({ date: '2027-03-14', time: '2:30am' })).data.content, /doesn't exist/);
  assert.match((await attempt({ date: 'soon' })).data.content, /couldn't read the date/);
  assert.match((await attempt({ time: 'noonish' })).data.content, /couldn't read the time/);
  assert.match((await attempt({ reminder: '25h' })).data.content, /should look like/);
  assert.match((await attempt({ reminder: 'soon' })).data.content, /should look like/);
  assert.match((await attempt({ reminder: '1d' })).data.content, /should look like/);
  assert.match((await attempt({ name: '   ' })).data.content, /Give the meeting a name/);
  assert.match((await attempt({ name: 'x'.repeat(81) })).data.content, /too long/);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM meetings')[0].n, 0);

  await attempt({ name: 'Team Sync' });
  const dup = await attempt({ name: '  team   SYNC ' });
  assert.match(dup.data.content, /already a meeting called/);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM meetings')[0].n, 1);
});

test('create with a reminder that has already passed warns and only schedules the start', async () => {
  const t = setup();
  await t.run(setTz('UTC'));
  const r = await t.run(slash('create', { name: 'Soon', date: 'today', time: '12:10' })); // starts in 10 min, reminder 15
  assert.match(r.data.content, /reminder time has already passed/);
  assert.deepEqual(jobs(t.db).map((j) => j.kind), ['start']);
});

test('reminder 0 schedules only the start message', async () => {
  const t = setup();
  const r = await createStandup(t, { reminder: 0 });
  assert.match(r.data.content, /Reminder: none/);
  assert.deepEqual(jobs(t.db).map((j) => j.kind), ['start']);
});

test('create for another channel posts the public notice there; a failed post is reported privately', async () => {
  const t = setup();
  await t.run(setTz('America/Chicago'));
  const r = await t.run(slash('create', { name: 'Elsewhere', date: '2026-11-20', time: '3pm', channel: 'c9' }));
  assert.equal(isEphemeral(r), true);
  assert.match(r.data.content, /<#c9>/);
  assert.equal(t.discord.posts.length, 1);
  assert.equal(t.discord.posts[0].channelId, 'c9');
  assert.match(t.discord.posts[0].content, /Elsewhere/);

  const t2 = setup([{ ok: false, retryable: false, error: 'HTTP 403: Missing Access (code 50001)' }]);
  await t2.run(setTz('America/Chicago'));
  const r2 = await t2.run(slash('create', { name: 'Blocked', date: '2026-11-20', time: '3pm', channel: 'c9' }));
  assert.equal(isEphemeral(r2), true);
  assert.match(r2.data.content, /couldn't post/);
  assert.match(r2.data.content, /Missing Access/);
  assert.equal(t2.db.sql('SELECT COUNT(*) AS n FROM meetings')[0].n, 1); // still saved
});

test('a passed reminder is warned about both privately and in the public notice', async () => {
  const t = setup();
  await t.run(setTz('UTC'));
  const r = await t.run(slash('create', { name: 'Soon', date: 'today', time: '12:10' }));
  assert.match(r.data.content, /Warning: the reminder time has already passed/);
  assert.match(t.discord.posts[0].content, /Heads up: the reminder time has already passed/);
});

test('role ping is stored and only the reminder/start messages are allowed to mention it', async () => {
  const t = setup();
  const r = await createStandup(t, { ping: 'role7' });
  assert.match(r.data.content, /<@&role7>/);
  assert.deepEqual(r.data.allowed_mentions, { parse: [] }); // announcement does not ping
  assert.equal(t.db.sql('SELECT role_id FROM meetings')[0].role_id, 'role7');
});

test('update: changing only the time keeps the date, and rebuilds the jobs', async () => {
  const t = setup();
  await createStandup(t);
  const r = await t.run(slash('update', { name: 'team sync', time: '4:30pm' }));
  assert.match(r.data.content, /Meeting updated/);
  const start = Date.UTC(2026, 10, 20, 22, 30, 0) / 1000;
  assert.equal(t.db.sql('SELECT start_at FROM meetings')[0].start_at, start);
  assert.deepEqual(
    jobs(t.db).filter((j) => j.status === 'pending'),
    [
      { kind: 'reminder', fire_at: start - 900, status: 'pending' },
      { kind: 'start', fire_at: start, status: 'pending' },
    ],
  );
  assert.equal(jobs(t.db).length, 2); // old pending jobs were replaced, not accumulated
});

test('update: changing only the date keeps the local time; rename; clear location; reminder', async () => {
  const t = setup();
  await createStandup(t, { location: 'Old Room' });
  const r = await t.run(slash('update', { name: 'Team Sync', date: '2026-11-24', new_name: 'Weekly Sync', location: 'none', reminder: '5min' }));
  const m = t.db.sql('SELECT * FROM meetings')[0];
  assert.equal(m.start_at, Date.UTC(2026, 10, 24, 21, 0, 0) / 1000);
  assert.equal(m.name, 'Weekly Sync');
  assert.equal(m.name_key, 'weekly sync');
  assert.equal(m.location, null);
  assert.equal(m.reminder_minutes, 5);
  assert.doesNotMatch(r.data.content, /Old Room/);
  assert.equal(jobs(t.db).find((j) => j.kind === 'reminder').fire_at, m.start_at - 300);
});

test('update: validation and permissions', async () => {
  const t = setup();
  await createStandup(t);
  await t.run(slash('create', { name: 'Other', date: '2026-11-21', time: '1pm' }));

  assert.match((await t.run(slash('update', { name: 'Nope', time: '1pm' }))).data.content, /can't find/);
  assert.match((await t.run(slash('update', { name: 'Team Sync' }))).data.content, /Nothing to change/);
  assert.match((await t.run(slash('update', { name: 'Team Sync', new_name: 'other' }))).data.content, /already a meeting called/);
  assert.match((await t.run(slash('update', { name: 'Team Sync', date: '2026-11-01' }))).data.content, /in the past/);

  // a different user without permissions
  const denied = await t.run(slash('update', { name: 'Team Sync', time: '5pm' }, { user: 'u2' }));
  assert.match(denied.data.content, /Only the person who created/);
  assert.equal(t.db.sql('SELECT start_at FROM meetings WHERE id = 1')[0].start_at, CHI_3PM_NOV20);

  // Manage Server (0x20) and Administrator (0x8) are allowed
  const mod = await t.run(slash('update', { name: 'Team Sync', location: 'Room 1' }, { user: 'u2', perms: String(0x20) }));
  assert.match(mod.data.content, /Meeting updated/);
  const admin = await t.run(slash('update', { name: 'Team Sync', location: 'Room 2' }, { user: 'u3', perms: String(0x8) }));
  assert.match(admin.data.content, /Meeting updated/);
});

test('update: a timezone-only change keeps the same instant', async () => {
  const t = setup();
  await createStandup(t);
  await t.run(slash('update', { name: 'Team Sync', timezone: 'Asia/Karachi' }));
  const m = t.db.sql('SELECT start_at, timezone FROM meetings')[0];
  assert.equal(m.start_at, CHI_3PM_NOV20);
  assert.equal(m.timezone, 'Asia/Karachi');
});

test('cancel removes pending jobs, frees the name, and is permission checked', async () => {
  const t = setup();
  await createStandup(t);
  const denied = await t.run(slash('cancel', { name: 'Team Sync' }, { user: 'u2' }));
  assert.match(denied.data.content, /Only the person who created/);

  const r = await t.run(slash('cancel', { name: 'Team Sync' }));
  assert.match(r.data.content, /Cancelled/);
  assert.equal(t.db.sql('SELECT status FROM meetings')[0].status, 'cancelled');
  assert.equal(jobs(t.db).length, 0);

  assert.match((await t.run(slash('cancel', { name: 'Team Sync' }))).data.content, /can't find/);
  const again = await t.run(slash('create', { name: 'Team Sync', date: '2026-11-22', time: '3pm' }));
  assert.equal(isEphemeral(again), true); // name is reusable after cancelling
});

test('meetings are scoped to their server', async () => {
  const t = setup();
  await createStandup(t);
  await t.run(setTz('America/Chicago', 'u9'));
  const other = await t.run(slash('create', { name: 'Team Sync', date: '2026-11-20', time: '3pm' }, { guild: 'g2', user: 'u9' }));
  assert.equal(isEphemeral(other), true); // same name in another server is fine
  assert.match((await t.run(slash('cancel', { name: 'Team Sync' }, { guild: 'g3' }))).data.content, /can't find/);
});

test('list shows upcoming meetings privately and flags failed messages', async () => {
  const t = setup();
  const empty = await t.run(slash('list'));
  assert.match(empty.data.content, /No upcoming meetings/);

  await createStandup(t, { repeat: 'weekly' });
  const r = await t.run(slash('list'));
  assert.equal(isEphemeral(r), true);
  assert.match(r.data.content, /Team Sync/);
  assert.match(r.data.content, new RegExp(`<t:${CHI_3PM_NOV20}:F>`));
  assert.match(r.data.content, /weekly/);
  assert.doesNotMatch(r.data.content, /failed/);

  t.db.sql("UPDATE jobs SET status = 'failed', last_error = 'HTTP 403: Missing Access' WHERE kind = 'reminder'");
  const flagged = await t.run(slash('list'));
  assert.match(flagged.data.content, /reminder message failed: HTTP 403: Missing Access/);
});

test('autocomplete suggests meeting names (this server only) and timezones', async () => {
  const t = setup();
  await createStandup(t);
  await t.run(slash('create', { name: 'Design Review', date: '2026-11-21', time: '1pm' }));

  const names = await t.run({
    type: 4,
    guild_id: 'g1',
    member: { user: { id: 'u1' } },
    data: { name: 'update-meeting', options: [{ name: 'name', type: 3, value: 'rev', focused: true }] },
  });
  assert.equal(names.type, 8);
  assert.deepEqual(names.data.choices, [{ name: 'Design Review', value: 'Design Review' }]);

  const zones = await t.run({
    type: 4,
    guild_id: 'g1',
    member: { user: { id: 'u1' } },
    data: { name: 'set-timezone', options: [{ name: 'timezone', type: 3, value: 'karachi', focused: true }] },
  });
  assert.deepEqual(zones.data.choices, [{ name: 'Asia/Karachi', value: 'Asia/Karachi' }]);

  const common = await t.run({
    type: 4,
    guild_id: 'g1',
    member: { user: { id: 'u1' } },
    data: { name: 'set-timezone', options: [{ name: 'timezone', type: 3, value: '', focused: true }] },
  });
  assert.ok(common.data.choices.length > 0 && common.data.choices.length <= 25);
});

test('PING gets a PONG and DMs are refused', async () => {
  const t = setup();
  assert.deepEqual(await t.run({ type: 1 }), { type: 1 });
  const dm = await t.run({ type: 2, user: { id: 'u1' }, data: { name: 'upcoming-meetings' } });
  assert.match(dm.data.content, /inside a server/);
});

// ---------- presets ----------

const completeName = (t, sub, value) =>
  t.run({
    type: 4,
    guild_id: 'g1',
    member: { user: { id: 'u1' } },
    data: { name: COMMAND_NAMES[sub], options: [{ name: 'name', type: 3, value, focused: true }] },
  });

test('preset-save stores the settings and schedule reuses them for any date', async () => {
  const t = setup();
  await t.run(setTz('America/Chicago'));
  const saved = await t.run(
    slash('preset-save', { name: 'Team Sync', time: '3pm', location: 'Voice Lounge', reminder: '30min', ping: 'r5', channel: 'c9', repeat: 'weekly' }),
  );
  assert.equal(isEphemeral(saved), true);
  assert.match(saved.data.content, /Preset saved: \*\*Team Sync\*\*/);
  assert.match(saved.data.content, /Usual time: 15:00/);
  assert.equal(t.discord.posts.length, 0); // saving is private and posts nothing
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM meetings')[0].n, 0);

  const r = await t.run(slash('create', { name: 'team sync', date: '2026-11-20' }));
  assert.equal(isEphemeral(r), true);
  const m = t.db.sql('SELECT * FROM meetings')[0];
  assert.equal(m.name, 'Team Sync');
  assert.equal(m.start_at, CHI_3PM_NOV20);
  assert.equal(m.location, 'Voice Lounge');
  assert.equal(m.reminder_minutes, 30);
  assert.equal(m.role_id, 'r5');
  assert.equal(m.channel_id, 'c9');
  assert.equal(m.repeat, 'weekly');
  assert.equal(t.discord.posts[0].channelId, 'c9');
  assert.match(t.discord.posts[0].content, /Where: Voice Lounge/);
});

test('schedule lets you change the time and any other setting for one occurrence only', async () => {
  const t = setup();
  await t.run(setTz('America/Chicago'));
  await t.run(slash('preset-save', { name: 'Team Sync', time: '3pm', location: 'Voice Lounge', reminder: '30min' }));

  await t.run(slash('create', { name: 'Team Sync', date: '2026-11-20', time: '4:30pm', location: 'Room 2', reminder: '5min' }));
  const m = t.db.sql('SELECT * FROM meetings')[0];
  assert.equal(m.start_at, CHI_3PM_NOV20 + 90 * 60);
  assert.equal(m.location, 'Room 2');
  assert.equal(m.reminder_minutes, 5);

  const p = t.db.sql('SELECT * FROM presets')[0];
  assert.equal(p.default_time, '15:00'); // the preset itself is unchanged
  assert.equal(p.location, 'Voice Lounge');
  assert.equal(p.reminder_minutes, 30);
});

test('schedule needs a time when the preset has none, and location "none" clears it', async () => {
  const t = setup();
  await t.run(setTz('America/Chicago'));
  await t.run(slash('preset-save', { name: 'Standup', location: 'Room 1' }));
  const noTime = await t.run(slash('create', { name: 'Standup', date: '2026-11-20' }));
  assert.equal(isEphemeral(noTime), true);
  assert.match(noTime.data.content, /no saved time/);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM meetings')[0].n, 0);

  await t.run(slash('create', { name: 'Standup', date: '2026-11-20', time: '9am', location: 'none' }));
  assert.equal(t.db.sql('SELECT location FROM meetings')[0].location, null);
});

test('schedule falls back to the latest past meeting with that name, keeping its local time', async () => {
  const t = setup();
  await createStandup(t, { location: 'Voice Lounge', reminder: '10min' }); // Nov 20, 3pm Chicago
  await t.run(slash('cancel', { name: 'Team Sync' }));

  const r = await t.run(slash('create', { name: 'Team Sync', date: '2026-11-27' }));
  assert.match(r.data.content, /Meeting scheduled: \*\*Team Sync\*\*/);
  const active = t.db.sql("SELECT * FROM meetings WHERE status = 'active'");
  assert.equal(active.length, 1);
  assert.equal(active[0].start_at, Date.UTC(2026, 10, 27, 21, 0, 0) / 1000); // still 3pm Chicago
  assert.equal(active[0].location, 'Voice Lounge');
  assert.equal(active[0].reminder_minutes, 10);

  // a name with nothing saved behaves like a plain create, which needs a time
  const unknown = await t.run(slash('create', { name: 'Nope', date: '2026-11-27' }));
  assert.match(unknown.data.content, /Give a time, for example `time:3pm`/);
  assert.match(unknown.data.content, /pick its name from the list/);
  assert.equal(t.db.sql("SELECT COUNT(*) AS n FROM meetings WHERE name = 'Nope'")[0].n, 0);
});

test('scheduling a name that is already active is refused', async () => {
  const t = setup();
  await t.run(setTz('America/Chicago'));
  await t.run(slash('preset-save', { name: 'Team Sync', time: '3pm' }));
  await t.run(slash('create', { name: 'Team Sync', date: '2026-11-20' }));
  const dup = await t.run(slash('create', { name: 'Team Sync', date: '2026-11-21' }));
  assert.match(dup.data.content, /already a meeting called/);
});

test('preset-save edits only the options passed, validates input, and is permission checked', async () => {
  const t = setup();
  await t.run(setTz('America/Chicago'));
  await t.run(slash('preset-save', { name: 'Team Sync', time: '3pm', location: 'Voice Lounge', reminder: '30min' }));

  const edit = await t.run(slash('preset-save', { name: 'Team Sync', time: '4pm' }));
  assert.match(edit.data.content, /Preset updated/);
  const p = t.db.sql('SELECT * FROM presets')[0];
  assert.equal(p.default_time, '16:00');
  assert.equal(p.location, 'Voice Lounge'); // untouched
  assert.equal(p.reminder_minutes, 30);

  await t.run(slash('preset-save', { name: 'Team Sync', time: 'none', location: 'none' }));
  const cleared = t.db.sql('SELECT * FROM presets')[0];
  assert.equal(cleared.default_time, null);
  assert.equal(cleared.location, null);

  assert.match((await t.run(slash('preset-save', { name: 'X', time: 'noonish' }))).data.content, /couldn't read the time/);
  assert.match((await t.run(slash('preset-save', { name: 'X', timezone: 'Mars/Olympus' }))).data.content, /don't recognise/);
  assert.match((await t.run(slash('preset-save', { name: 'X', reminder: '25h' }))).data.content, /should look like/);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM presets')[0].n, 1);

  const denied = await t.run(slash('preset-save', { name: 'Team Sync', time: '5pm' }, { user: 'u2' }));
  assert.match(denied.data.content, /Only the person who saved/);
  const mod = await t.run(slash('preset-save', { name: 'Team Sync', time: '5pm' }, { user: 'u2', perms: String(0x20) }));
  assert.match(mod.data.content, /Preset updated/);
});

test('presets lists privately, is scoped to the server, and preset-delete is permission checked', async () => {
  const t = setup();
  assert.match((await t.run(slash('presets'))).data.content, /No saved presets/);

  await t.run(slash('preset-save', { name: 'Team Sync', time: '3pm', location: 'Voice Lounge' }));
  await t.run(slash('preset-save', { name: 'Design Review' }));
  const list = await t.run(slash('presets'));
  assert.equal(isEphemeral(list), true);
  assert.match(list.data.content, /Team Sync/);
  assert.match(list.data.content, /Design Review/);
  assert.match((await t.run(slash('presets', {}, { guild: 'g2' }))).data.content, /No saved presets/);

  const denied = await t.run(slash('preset-delete', { name: 'Team Sync' }, { user: 'u2' }));
  assert.match(denied.data.content, /Only the person who saved/);
  const ok = await t.run(slash('preset-delete', { name: 'team sync' }));
  assert.match(ok.data.content, /Deleted the preset/);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM presets')[0].n, 1);
  assert.match((await t.run(slash('preset-delete', { name: 'Team Sync' }))).data.content, /can't find a preset/);
});

test('autocomplete for create offers presets then past meetings; preset commands only offer presets', async () => {
  const t = setup();
  await createStandup(t); // meeting "Team Sync"
  await t.run(slash('preset-save', { name: 'Design Review', time: '1pm' }));

  const sched = await completeName(t, 'create', '');
  assert.deepEqual(sched.data.choices.map((c) => c.value), ['Design Review', 'Team Sync']);

  const del = await completeName(t, 'preset-delete', '');
  assert.deepEqual(del.data.choices.map((c) => c.value), ['Design Review']);
  const save = await completeName(t, 'preset-save', 'rev');
  assert.deepEqual(save.data.choices.map((c) => c.value), ['Design Review']);
});

// ---------- reminder units and multiple roles ----------

test('reminder: a plain number is hours, "min" means minutes, 0/none turns it off', async () => {
  const cases = [
    ['2', 120],
    ['2h', 120],
    ['2 hours', 120],
    ['1.5', 90],
    ['1h30min', 90],
    ['1h 30m', 90],
    ['15min', 15],
    ['15 minutes', 15],
    ['45m', 45],
    ['24h', 1440],
    ['0', 0],
    ['none', 0],
  ];
  for (const [input, minutes] of cases) {
    const t = setup();
    await t.run(setTz('America/Chicago'));
    await t.run(slash('create', { name: 'R', date: '2026-11-25', time: '3pm', reminder: input }));
    assert.equal(t.db.sql('SELECT reminder_minutes AS r FROM meetings')[0].r, minutes, `reminder "${input}"`);
  }
});

test('reminder: invalid values are rejected with a hint and nothing is saved', async () => {
  const t = setup();
  await t.run(setTz('America/Chicago'));
  for (const bad of ['25h', '1441min', '30', 'soon', '1d', '-5', 'min', '2h15']) {
    const r = await t.run(slash('create', { name: 'R', date: '2026-11-25', time: '3pm', reminder: bad }));
    assert.match(r.data.content, /A plain number means hours/, `reminder "${bad}"`);
  }
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM meetings')[0].n, 0);
});

test('an hours-ahead reminder is scheduled hours before and shown in hours', async () => {
  const t = setup();
  await t.run(setTz('America/Chicago'));
  const r = await t.run(slash('create', { name: 'Big Day', date: '2026-11-25', time: '3pm', reminder: '2h' }));
  assert.match(r.data.content, /Reminder: 2 h before/);
  const start = Date.UTC(2026, 10, 25, 21, 0, 0) / 1000;
  assert.deepEqual(t.db.sql('SELECT kind, fire_at FROM jobs ORDER BY fire_at'), [
    { kind: 'reminder', fire_at: start - 7200 },
    { kind: 'start', fire_at: start },
  ]);
  const odd = await t.run(slash('create', { name: 'Odd', date: '2026-11-25', time: '3pm', reminder: '1h30min' }));
  assert.match(odd.data.content, /Reminder: 1 h 30 min before/);
});

test('several roles can be pinged: stored together, listed, and all allowed in reminder and start', async () => {
  const t = setup();
  await t.run(setTz('America/Chicago'));
  const r = await t.run(slash('create', { name: 'Big Day', date: '2026-11-25', time: '3pm', ping: 'r1', ping_2: 'r2', ping_3: 'r3' }));
  assert.match(r.data.content, /Pings: <@&r1> <@&r2> <@&r3>/);
  assert.equal(t.db.sql('SELECT role_id FROM meetings')[0].role_id, 'r1,r2,r3');
  assert.deepEqual(r.data.allowed_mentions, { parse: [] }); // the announcement itself pings nobody
  assert.deepEqual(t.discord.posts[0].allowedMentions, { parse: [] });

  const dup = await t.run(slash('create', { name: 'Dup', date: '2026-11-25', time: '3pm', ping: 'r1', ping_2: 'r1' }));
  assert.match(dup.data.content, /Pings: <@&r1>$/m);
  assert.equal(t.db.sql("SELECT role_id FROM meetings WHERE name = 'Dup'")[0].role_id, 'r1');
});

test('update replaces the whole set of roles; leaving them out keeps them', async () => {
  const t = setup();
  await t.run(setTz('America/Chicago'));
  await t.run(slash('create', { name: 'Big Day', date: '2026-11-25', time: '3pm', ping: 'r1', ping_2: 'r2' }));

  await t.run(slash('update', { name: 'Big Day', location: 'Room 1' }));
  assert.equal(t.db.sql('SELECT role_id FROM meetings')[0].role_id, 'r1,r2');

  const r = await t.run(slash('update', { name: 'Big Day', ping: 'r3', ping_2: 'r4' }));
  assert.match(r.data.content, /Pings: <@&r3> <@&r4>/);
  assert.equal(t.db.sql('SELECT role_id FROM meetings')[0].role_id, 'r3,r4');
});

test('presets keep several roles and the reminder unit; schedule reuses or overrides them', async () => {
  const t = setup();
  await t.run(setTz('America/Chicago'));
  const saved = await t.run(slash('preset-save', { name: 'Town Hall', time: '3pm', reminder: '3h', ping: 'r1', ping_2: 'r2' }));
  assert.match(saved.data.content, /Reminder: 3 h before/);
  assert.match(saved.data.content, /Pings: <@&r1> <@&r2>/);
  assert.equal(t.db.sql('SELECT role_id, reminder_minutes FROM presets')[0].role_id, 'r1,r2');
  assert.equal(t.db.sql('SELECT reminder_minutes AS r FROM presets')[0].r, 180);

  await t.run(slash('create', { name: 'Town Hall', date: '2026-11-25' }));
  const m = t.db.sql('SELECT * FROM meetings')[0];
  assert.equal(m.role_id, 'r1,r2');
  assert.equal(m.reminder_minutes, 180);

  await t.run(slash('cancel', { name: 'Town Hall' }));
  await t.run(slash('create', { name: 'Town Hall', date: '2026-11-26', ping: 'r9', reminder: '20min' }));
  const m2 = t.db.sql("SELECT * FROM meetings WHERE status = 'active'")[0];
  assert.equal(m2.role_id, 'r9'); // replaced for this meeting only
  assert.equal(m2.reminder_minutes, 20);
  assert.equal(t.db.sql('SELECT role_id FROM presets')[0].role_id, 'r1,r2'); // preset unchanged
});

test('presets and past meetings with no roles schedule with no roles', async () => {
  const t = setup();
  await t.run(setTz('America/Chicago'));
  await t.run(slash('preset-save', { name: 'Quiet', time: '3pm' }));
  await t.run(slash('create', { name: 'Quiet', date: '2026-11-25' }));
  assert.equal(t.db.sql('SELECT role_id FROM meetings')[0].role_id, null);
});

test('create: reusing a saved name says so, and reuse:false starts from scratch', async () => {
  const t = setup();
  await t.run(setTz('America/Chicago'));
  await t.run(slash('preset-save', { name: 'Team Sync', time: '3pm', location: 'Voice Lounge', reminder: '30min' }));

  const reused = await t.run(slash('create', { name: 'Team Sync', date: '2026-11-20' }));
  assert.match(reused.data.content, /Used the saved settings from the preset \*\*Team Sync\*\*\./);
  assert.match(reused.data.content, /Add `reuse:false` to start from scratch/);
  assert.match(reused.data.content, /Where: Voice Lounge/);
  assert.equal(t.db.sql('SELECT reminder_minutes FROM meetings')[0].reminder_minutes, 30);
  await t.run(slash('cancel', { name: 'Team Sync' }));

  // reuse:false ignores the preset entirely: defaults, and the time is required
  const needsTime = await t.run(slash('create', { name: 'Team Sync', date: '2026-11-20', reuse: false }));
  assert.match(needsTime.data.content, /Give a time/);
  const fresh = await t.run(slash('create', { name: 'Team Sync', date: '2026-11-20', time: '9am', reuse: false }));
  assert.doesNotMatch(fresh.data.content, /Used the saved settings/);
  assert.doesNotMatch(fresh.data.content, /Voice Lounge/);
  const m = t.db.sql("SELECT * FROM meetings WHERE status = 'active'")[0];
  assert.deepEqual([m.location, m.reminder_minutes], [null, 15]);
});

test('create: a brand-new name never mentions saved settings; a past meeting is described as "your earlier meeting"', async () => {
  const t = setup();
  await t.run(setTz('America/Chicago'));
  const plain = await t.run(slash('create', { name: 'Brand New', date: '2026-11-20', time: '3pm' }));
  assert.doesNotMatch(plain.data.content, /Used the saved settings/);

  await t.run(slash('cancel', { name: 'Brand New' }));
  const again = await t.run(slash('create', { name: 'brand new', date: '2026-11-27' }));
  assert.match(again.data.content, /Used the saved settings from your earlier meeting \*\*Brand New\*\*\./);
});
