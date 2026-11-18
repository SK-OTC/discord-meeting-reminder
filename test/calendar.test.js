import test from 'node:test';
import assert from 'node:assert/strict';
import { handleInteraction } from '../src/commands.js';
import { runCalendarSync, SYNC_BATCH_SIZE } from '../src/calendar-sync.js';
import { createDiscordClient } from '../src/discord.js';
import { runDueJobs } from '../src/scheduler.js';
import { markMeetingDirty, pruneOld, saveCalendarAccount } from '../src/store.js';
import { createFakeBridge, createFakeDiscord, createTestDb } from './helpers/d1.js';

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0) / 1000; // Tue 2026-11-17 12:00 UTC
const NOV25_3PM_CHI = Date.UTC(2026, 10, 25, 21, 0, 0) / 1000;
const SCRIPT_A = 'https://script.google.com/macros/s/AAAA/exec';
const SCRIPT_B = 'https://script.google.com/macros/s/BBBB/exec';

function setup({ bridge = createFakeBridge(), discordScript, enabled = true } = {}) {
  const db = createTestDb();
  const discord = createFakeDiscord(discordScript);
  const deferred = [];
  const run = (interaction, nowSec = NOW) =>
    handleInteraction(interaction, { db, discord, bridge: enabled ? bridge : null, defer: (p) => deferred.push(p), nowSec });
  return {
    db,
    discord,
    bridge,
    run,
    settle: () => Promise.all(deferred.splice(0)),
    sync: (nowSec = NOW) => runCalendarSync({ db, discord, bridge, nowSec }),
  };
}

const toOptions = (opts) => Object.entries(opts).map(([name, value]) => ({ name, value, type: typeof value === 'boolean' ? 5 : 3 }));
function cmd(name, sub, opts = {}, { user = 'u1', guild = 'g1', perms = '0', token = `tok-${user}` } = {}) {
  return {
    type: 2,
    guild_id: guild,
    channel_id: 'c1',
    application_id: 'app1',
    token,
    member: { user: { id: user }, permissions: perms },
    data: { name, options: sub ? [{ type: 1, name: sub, options: toOptions(opts) }] : toOptions(opts) },
  };
}
const MEETING_NAMES = { create: 'new-meeting', update: 'update-meeting', cancel: 'cancel-meeting', list: 'upcoming-meetings', 'preset-save': 'add-update-preset', presets: 'meeting-presets', 'preset-delete': 'delete-preset' };
const GUEST_NAMES = { add: 'add-team', remove: 'remove-team-member', list: 'show-teams', 'delete-team': 'delete-team' };
const meeting = (sub, opts, who) => cmd(MEETING_NAMES[sub], null, opts, who);
const guests = (sub, opts, who) => cmd(GUEST_NAMES[sub], null, opts, who);
const calendar = (sub, opts, who) => cmd('calendar', sub, opts, who);
const isEphemeral = (r) => (r.data.flags & 64) === 64;
const rows = (t, where = '1=1') => t.db.sql(`SELECT * FROM meetings WHERE ${where} ORDER BY id`);
const row = (t) => rows(t)[0];

async function tz(t, user = 'u1') {
  await t.run(cmd('set-timezone', null, { timezone: 'America/Chicago' }, { user }));
}
async function connect(t, user = 'u1', url = SCRIPT_A, email = 'pm@gmail.com') {
  await saveCalendarAccount(t.db, user, url, email, NOW);
}
/** A connected meeting organizer with the timezone set and a team "Design" of two guests. */
async function pm(t, user = 'u1', url = SCRIPT_A) {
  await tz(t, user);
  await connect(t, user, url);
  await t.run(guests('add', { team: 'Design', emails: 'a@gmail.com, b@gmail.com' }, { user }));
}
const create = (t, opts = {}, who) => t.run(meeting('create', { name: 'Team Sync', date: '2026-11-25', time: '3pm', ...opts }, who));

// ---------- guest teams ----------

test('guests add: a whole list at once, with commas, semicolons or spaces; bad ones are reported, duplicates ignored', async () => {
  const t = setup();
  const r = await t.run(guests('add', { team: 'Design', emails: 'a@gmail.com, b@gmail.com; c@gmail.com d@gmail.com,A@GMAIL.COM, nope, @x.com' }));
  assert.equal(isEphemeral(r), true);
  assert.deepEqual(r.data.allowed_mentions, { parse: [] });
  assert.match(r.data.content, /Created the team \*\*Design\*\*: added 4, 4 in total/);
  assert.match(r.data.content, /Not valid email addresses, skipped: nope, @x\.com/);
  assert.deepEqual(t.db.sql('SELECT email FROM guests ORDER BY email').map((g) => g.email), ['a@gmail.com', 'b@gmail.com', 'c@gmail.com', 'd@gmail.com']);
  assert.equal(t.db.sql('SELECT owner_id FROM guest_teams')[0].owner_id, 'u1');

  const again = await t.run(guests('add', { team: 'design', emails: 'a@gmail.com e@gmail.com' }));
  assert.match(again.data.content, /Updated the team \*\*Design\*\*: added 1, 5 in total/);
  assert.match(again.data.content, /Already on the team: a@gmail\.com/);

  const none = await t.run(guests('add', { team: 'Design', emails: 'nope, also-bad' }));
  assert.match(none.data.content, /couldn't find a valid email address/);
  assert.match(none.data.content, /skipped: nope, also-bad/);
});

const addrs = (from, n) => Array.from({ length: n }, (_, i) => `g${from + i}@example.com`);

test('guests add: a team holds 100; a batch that would go over adds NOTHING and says how many spaces are left', async () => {
  const t = setup();
  // a brand-new team cannot take 105 at once, and is not even created
  const big = await t.run(guests('add', { team: 'Big', emails: addrs(0, 105).join(', ') }));
  assert.equal(isEphemeral(big), true);
  assert.match(big.data.content, /nothing was added/);
  assert.match(big.data.content, /A new team has 100 spaces left, but 105 of the addresses you sent are new/);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM guest_teams')[0].n, 0);

  // exactly 100 fits
  const full = await t.run(guests('add', { team: 'Big', emails: addrs(0, 100).join(' ') }));
  assert.match(full.data.content, /added 100, 100 in total/);

  // one more does not, and nothing changes
  const over = await t.run(guests('add', { team: 'Big', emails: 'extra@example.com' }));
  assert.match(over.data.content, /\*\*Big\*\* has 0 spaces left, but 1 of the addresses you sent are new/);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM guests')[0].n, 100);

  // addresses already on the team do not use up spaces
  const same = await t.run(guests('add', { team: 'Big', emails: addrs(0, 100).join(',') }));
  assert.match(same.data.content, /added 0, 100 in total/);

  // 98 in, then a batch with 3 new ones and 2 spaces: refused whole, even though some are valid
  const t2 = setup();
  await t2.run(guests('add', { team: 'T', emails: addrs(0, 98).join(',') }));
  const r = await t2.run(guests('add', { team: 'T', emails: 'g0@example.com, n1@example.com, n2@example.com, n3@example.com, bad' }));
  assert.match(r.data.content, /\*\*T\*\* has 2 spaces left, but 3 of the addresses you sent are new/);
  assert.match(r.data.content, /skipped: bad/);
  assert.equal(t2.db.sql('SELECT COUNT(*) AS n FROM guests')[0].n, 98);
  const fits = await t2.run(guests('add', { team: 'T', emails: 'n1@example.com, n2@example.com' }));
  assert.match(fits.data.content, /added 2, 100 in total/);
});

test('guests add: invalid addresses do not block the valid ones; the reply lists added, already there and invalid', async () => {
  const t = setup();
  await t.run(guests('add', { team: 'Design', emails: 'a@gmail.com' }));
  const r = await t.run(guests('add', { team: 'Design', emails: 'a@gmail.com, b@gmail.com, oops, c@@x.com, d@gmail.com' }));
  assert.match(r.data.content, /added 2, 3 in total/);
  assert.match(r.data.content, /Already on the team: a@gmail\.com/);
  assert.match(r.data.content, /Not valid email addresses, skipped: oops, c@@x\.com/);
  assert.deepEqual(t.db.sql('SELECT email FROM guests ORDER BY email').map((g) => g.email), ['a@gmail.com', 'b@gmail.com', 'd@gmail.com']);
});

test('guests: a bulk add or remove updates the upcoming meetings of the team once, not once per person', async () => {
  const t = setup();
  await pm(t);
  await create(t);
  await t.sync();
  const v0 = row(t).gcal_version;
  await t.run(guests('add', { team: 'Design', emails: addrs(0, 40).join(', ') }));
  assert.equal(row(t).gcal_version, v0 + 1);
  await t.sync();
  assert.equal(t.bridge.calls.at(-1).guests.length, 42);

  const v1 = row(t).gcal_version;
  const rm = await t.run(guests('remove', { team: 'Design', emails: addrs(0, 30).join('; ') + ', nobody@example.com' }));
  assert.match(rm.data.content, /Removed 30 from \*\*Design\*\*, 12 left/);
  assert.match(rm.data.content, /Not on the team, nothing to remove: nobody@example\.com/);
  assert.equal(row(t).gcal_version, v1 + 1);
  await t.sync();
  assert.equal(t.bridge.calls.at(-1).guests.length, 12);

  // nothing actually removed or added -> no update at all
  const v2 = row(t).gcal_version;
  await t.run(guests('remove', { team: 'Design', emails: 'nobody@example.com' }));
  await t.run(guests('add', { team: 'Design', emails: 'a@gmail.com' }));
  assert.equal(row(t).gcal_version, v2);
});

test('guests add: newlines from a pasted column are treated like any other separator', async () => {
  const t = setup();
  const r = await t.run(guests('add', { team: 'Design', emails: 'a@gmail.com\nb@gmail.com\r\nc@gmail.com' }));
  assert.match(r.data.content, /added 3, 3 in total/);
});

test('guests: team names, ownership and Manage Server rules; every reply is private', async () => {
  const t = setup();
  await t.run(guests('add', { team: 'Design', emails: 'a@gmail.com' }));

  assert.match((await t.run(guests('add', { team: 'none', emails: 'x@gmail.com' }))).data.content, /reserved/);
  assert.match((await t.run(guests('add', { team: '(no guests)', emails: 'x@gmail.com' }))).data.content, /reserved/);
  assert.match((await t.run(guests('add', { team: 'x'.repeat(51), emails: 'x@gmail.com' }))).data.content, /too long/);

  const other = { user: 'u2' };
  assert.match((await t.run(guests('add', { team: 'Design', emails: 'x@gmail.com' }, other))).data.content, /belongs to someone else/);
  assert.match((await t.run(guests('remove', { team: 'Design', emails: 'a@gmail.com' }, other))).data.content, /belongs to someone else/);
  assert.match((await t.run(guests('list', { team: 'Design' }, other))).data.content, /belongs to someone else/);
  assert.match((await t.run(guests('delete-team', { team: 'Design' }, other))).data.content, /belongs to someone else/);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM guests')[0].n, 1);

  const admin = await t.run(guests('add', { team: 'Design', emails: 'b@gmail.com' }, { user: 'u3', perms: String(0x20) }));
  assert.match(admin.data.content, /added 1, 2 in total/);
  assert.match((await t.run(guests('remove', { team: 'nope', emails: 'a@gmail.com' }))).data.content, /can't find a guest team called \*\*nope\*\*/);
});

test('guests remove, list and delete-team', async () => {
  const t = setup();
  await t.run(guests('add', { team: 'Design', emails: 'a@gmail.com, b@gmail.com' }));
  await t.run(guests('add', { team: 'Eng', emails: 'c@gmail.com' }));

  const rm = await t.run(guests('remove', { team: 'Design', emails: 'b@gmail.com, zz@gmail.com' }));
  assert.match(rm.data.content, /Removed 1 from \*\*Design\*\*/);
  assert.match(rm.data.content, /Not on the team, nothing to remove: zz@gmail\.com/);

  const mine = await t.run(guests('list', {}));
  assert.equal(isEphemeral(mine), true);
  assert.match(mine.data.content, /\*\*Design\*\*: 1 guest\b/);
  assert.match(mine.data.content, /\*\*Eng\*\*: 1 guest\b/);
  assert.doesNotMatch(mine.data.content, /@gmail/); // the overview never shows addresses
  assert.match((await t.run(guests('list', {}, { user: 'u2' }))).data.content, /do not own any guest teams/);

  const one = await t.run(guests('list', { team: 'Design' }));
  assert.match(one.data.content, /a@gmail\.com/);
  assert.equal(isEphemeral(one), true);

  const del = await t.run(guests('delete-team', { team: 'Design' }));
  assert.match(del.data.content, /Deleted the team \*\*Design\*\*/);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM guests')[0].n, 1);
});

// ---------- /calendar ----------

test('calendar: not enabled without a bridge secret', async () => {
  const t = setup({ enabled: false });
  for (const sub of ['connect', 'disconnect', 'status']) {
    const r = await t.run(calendar(sub, { url: SCRIPT_A }));
    assert.equal(isEphemeral(r), true);
    assert.match(r.data.content, /not enabled.*BRIDGE_SECRET/);
  }
});

test('calendar connect: bad URLs are refused with the reason and nothing is sent to them', async () => {
  const t = setup();
  const cases = [
    ['https://evil.example.com/macros/s/abc/exec', /must be on script\.google\.com/],
    ['http://script.google.com/macros/s/abc/exec', /https/],
    ['https://script.google.com/macros/s/abc/dev', /path must look like/],
    ['garbage', /not a valid URL/],
  ];
  for (const [url, why] of cases) {
    const r = await t.run(calendar('connect', { url }));
    assert.equal(isEphemeral(r), true);
    assert.match(r.data.content, /Could not connect:/);
    assert.match(r.data.content, why);
  }
  assert.equal(t.bridge.calls.length, 0);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM calendar_accounts')[0].n, 0);
});

test('calendar connect: answers right away (deferred), then edits the reply with the result', async () => {
  const t = setup();
  const r = await t.run(calendar('connect', { url: SCRIPT_A }));
  assert.equal(r.type, 5);
  assert.equal(isEphemeral(r), true);
  await t.settle();
  assert.equal(t.bridge.calls[0].action, 'ping');
  assert.equal(t.bridge.calls[0].url, SCRIPT_A);
  assert.equal(t.discord.edits.length, 1);
  assert.deepEqual([t.discord.edits[0].appId, t.discord.edits[0].token], ['app1', 'tok-u1']);
  assert.match(t.discord.edits[0].content, /Connected as pm@gmail\.com/);
  const acct = t.db.sql('SELECT * FROM calendar_accounts')[0];
  assert.deepEqual([acct.user_id, acct.script_url, acct.account_email], ['u1', SCRIPT_A, 'pm@gmail.com']);

  const status = await t.run(calendar('status'));
  assert.match(status.data.content, /Connected as pm@gmail\.com/);
});

test('calendar connect: a failing ping is explained and nothing is saved', async () => {
  const t = setup({ bridge: createFakeBridge({ script: [{ ok: false, retryable: false, error: 'Google Calendar bridge: the script rejected the secret.' }] }) });
  await t.run(calendar('connect', { url: SCRIPT_A }));
  await t.settle();
  assert.match(t.discord.edits[0].content, /Could not connect: Google Calendar bridge: the script rejected the secret\./);
  assert.match(t.discord.edits[0].content, /GOOGLE_CALENDAR\.md/);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM calendar_accounts')[0].n, 0);
  assert.match((await t.run(calendar('status'))).data.content, /not connected/);
});

test('calendar connect: an unexpected error is reported, not swallowed; no token means an inline answer', async () => {
  const boom = { async call() { throw new Error('kaboom'); } };
  const t = setup({ bridge: boom });
  await t.run(calendar('connect', { url: SCRIPT_A }));
  await t.settle();
  assert.match(t.discord.edits[0].content, /Could not connect: unexpected error: kaboom/);

  const t2 = setup();
  const noToken = cmd('calendar', 'connect', { url: SCRIPT_A });
  delete noToken.token;
  const r = await t2.run(noToken);
  assert.equal(r.type, 4);
  assert.match(r.data.content, /Connected as pm@gmail\.com/);
});

test('calendar disconnect: stops syncing, keeps the Google events, and flags the affected meetings', async () => {
  const t = setup();
  await pm(t);
  await create(t);
  await t.sync(); // event created
  await create(t, { name: 'Other', calendar: false });

  const r = await t.run(calendar('disconnect'));
  assert.match(r.data.content, /Disconnected pm@gmail\.com/);
  assert.match(r.data.content, /1 upcoming meeting keeps its Google event but will no longer sync/);
  assert.equal(t.db.sql('SELECT COUNT(*) AS n FROM calendar_accounts')[0].n, 0);
  assert.equal(row(t).gcal_error, 'calendar disconnected by its owner');
  assert.equal(row(t).gcal_dirty, 0);

  const list = await t.run(meeting('list'));
  assert.match(list.data.content, /\(calendar sync failed: calendar disconnected by its owner\)/);
  assert.match((await t.run(calendar('disconnect'))).data.content, /not connected/);
});

// ---------- create / schedule ----------

test('create: a connected PM gets an event queued before any call to Google, with the default team', async () => {
  const t = setup();
  await pm(t);
  const r = await create(t, { location: 'Voice Lounge', duration: '90min' });
  assert.equal(isEphemeral(r), true);
  assert.match(r.data.content, /Duration: 1 h 30 min/);
  assert.match(r.data.content, /Guest team: Design \(2 guests\)/);
  assert.match(r.data.content, /Calendar: will be added to pm@gmail\.com shortly/);

  const m = row(t);
  assert.match(m.gcal_event_id, /^v[0-9a-v]{24}$/);
  assert.equal(m.gcal_owner_id, 'u1');
  assert.equal(m.guest_team_key, 'design');
  assert.equal(m.duration_min, 90);
  assert.equal(m.gcal_dirty, 1);
  assert.equal(m.gcal_created, 0);
  assert.deepEqual([m.gcal_followup_app_id, m.gcal_followup_token], ['app1', 'tok-u1']);
  assert.ok(m.gcal_followup_expires > NOW && m.gcal_followup_expires <= NOW + 15 * 60);
  assert.equal(t.bridge.calls.length, 0); // never calls Google inside the command

  // the public notice says nothing about guests, accounts or the calendar
  assert.equal(t.discord.posts.length, 1);
  assert.doesNotMatch(t.discord.posts[0].content, /calendar|guest|gmail|design/i);
});

test('create without a connection still creates the meeting and says how to connect', async () => {
  const t = setup();
  await tz(t);
  const r = await create(t);
  assert.match(r.data.content, /Calendar: not added to Google Calendar\. Run \/calendar connect first\./);
  assert.equal(rows(t).length, 1);
  assert.equal(row(t).gcal_event_id, null);
  assert.equal(row(t).gcal_dirty, 0);
});

test('create: calendar false, and a bot without the feature, explain what happened', async () => {
  const t = setup();
  await pm(t);
  const off = await create(t, { calendar: false });
  assert.match(off.data.content, /Calendar: off for this meeting\./);
  assert.equal(row(t).gcal_event_id, null);

  const t2 = setup({ enabled: false });
  await tz(t2);
  const asked = await create(t2, { calendar: true });
  assert.match(asked.data.content, /Google Calendar sync is not enabled on this bot/);
  const quiet = await create(t2, { name: 'Quiet' });
  assert.doesNotMatch(quiet.data.content, /Calendar:/);
});

test('create: team rules (default, several teams, none, not owned) and duration limits', async () => {
  const t = setup();
  await pm(t);
  await t.run(guests('add', { team: 'Eng', emails: 'c@gmail.com' }));

  const several = await create(t);
  assert.match(several.data.content, /You own several guest teams \(Design, Eng\)\. Pick one with `team`, or `team:none`/);
  assert.equal(rows(t).length, 0);

  assert.match((await create(t, { team: 'Eng' })).data.content, /Guest team: Eng \(1 guest\)/);
  assert.match((await create(t, { name: 'B', team: 'none' })).data.content, /Guest team: none/);
  assert.equal(rows(t, "name = 'B'")[0].guest_team_key, null);
  assert.match((await create(t, { name: 'C', team: 'Nope' })).data.content, /can't find a guest team called \*\*Nope\*\*.*Your teams: Design, Eng/);

  await tz(t, 'u2');
  await connect(t, 'u2', SCRIPT_B, 'two@gmail.com');
  const stolen = await create(t, { name: 'D', team: 'Design' }, { user: 'u2' });
  assert.match(stolen.data.content, /belongs to someone else/);
  const admin = await create(t, { name: 'E', team: 'Design' }, { user: 'u3', perms: String(0x20) });
  assert.doesNotMatch(admin.data.content, /belongs to someone else/);

  for (const bad of ['14min', '3h', '0', 'soon']) {
    assert.match((await create(t, { name: 'F', team: 'Eng', duration: bad })).data.content, /`duration` should look like/);
  }
  assert.equal(rows(t, "name = 'F'").length, 0);
});

test('schedule from a preset: the team is used only if the person scheduling owns it', async () => {
  const t = setup();
  await pm(t); // u1 owns Design
  await t.run(meeting('preset-save', { name: 'Weekly', time: '3pm', duration: '1h30min', team: 'Design' }));
  assert.equal(t.db.sql('SELECT guest_team_key, duration_min, calendar FROM presets')[0].guest_team_key, 'design');

  // another connected PM who does not own the team
  await tz(t, 'u2');
  await connect(t, 'u2', SCRIPT_B, 'two@gmail.com');
  const other = await t.run(meeting('create', { name: 'Weekly', date: '2026-11-25' }, { user: 'u2' }));
  assert.match(other.data.content, /Note: this preset invites Design, which you don't own\. Scheduled without guests\. Pick one of your teams with team: to invite people\./);
  const theirs = rows(t, "created_by = 'u2'")[0];
  assert.equal(theirs.guest_team_key, null);
  assert.equal(theirs.gcal_owner_id, 'u2'); // the event goes to the person running schedule
  assert.equal(theirs.duration_min, 90);

  await t.run(meeting('cancel', { name: 'Weekly' }, { user: 'u2' })); // the name is free again
  const mine = await t.run(meeting('create', { name: 'Weekly', date: '2026-12-02' }));
  assert.doesNotMatch(mine.data.content, /Note:/);
  const m = rows(t, "created_by = 'u1'")[0];
  assert.equal(m.guest_team_key, 'design');
  assert.equal(m.gcal_owner_id, 'u1');
  assert.equal(m.duration_min, 90);

  // overrides apply to this meeting only
  await t.run(meeting('cancel', { name: 'Weekly' }, { user: 'u1' }));
  await t.run(meeting('create', { name: 'Weekly', date: '2026-12-09', duration: '2h', team: 'none', calendar: false }));
  const last = rows(t, "created_by = 'u1'").at(-1);
  assert.deepEqual([last.duration_min, last.guest_team_key, last.gcal_event_id], [120, null, null]);
  assert.equal(t.db.sql('SELECT duration_min FROM presets')[0].duration_min, 90);
});

test('schedule: a preset whose team was deleted, and a past meeting, behave', async () => {
  const t = setup();
  await pm(t);
  await t.run(meeting('preset-save', { name: 'Weekly', time: '3pm', team: 'Design' }));
  await t.run(guests('delete-team', { team: 'Design' }));
  const r = await t.run(meeting('create', { name: 'Weekly', date: '2026-11-25' }));
  assert.match(r.data.content, /invites the team design, which no longer exists\. Scheduled without guests/);
  assert.equal(row(t).guest_team_key, null);

  // reuse of a past meeting copies duration, team and calendar from it
  const t2 = setup();
  await pm(t2);
  await create(t2, { duration: '2h' });
  await t2.run(meeting('cancel', { name: 'Team Sync' }));
  await t2.run(meeting('create', { name: 'Team Sync', date: '2026-12-02' }));
  const again = rows(t2, "status = 'active'")[0];
  assert.deepEqual([again.duration_min, again.guest_team_key, again.gcal_owner_id], [120, 'design', 'u1']);
});

test('preset-save: duration, team and calendar are stored, cleared and permission checked', async () => {
  const t = setup();
  await pm(t);
  const saved = await t.run(meeting('preset-save', { name: 'P', time: '3pm', duration: '45min', calendar: false }));
  assert.match(saved.data.content, /Duration: 45 min/);
  assert.match(saved.data.content, /Guest team: Design/); // a new preset defaults to your only team
  assert.match(saved.data.content, /Google Calendar: off/);

  await t.run(meeting('preset-save', { name: 'P', duration: 'none', team: 'none', calendar: true }));
  const p = t.db.sql('SELECT * FROM presets')[0];
  assert.deepEqual([p.duration_min, p.guest_team_key, p.calendar], [null, null, 1]);

  assert.match((await t.run(meeting('preset-save', { name: 'Q', duration: '5h' }))).data.content, /`duration` should look like/);
  assert.match((await t.run(meeting('preset-save', { name: 'Q', team: 'Nope' }))).data.content, /can't find a guest team/);
  await tz(t, 'u2');
  assert.match((await t.run(meeting('preset-save', { name: 'Q', team: 'Design' }, { user: 'u2' }))).data.content, /belongs to someone else/);

  const list = await t.run(meeting('presets'));
  assert.match(list.data.content, /duration 1 h \/ calendar on/);
});

// ---------- update / cancel ----------

test('update: only changes guests can see mark the meeting dirty', async () => {
  const t = setup();
  await pm(t);
  await create(t);
  await t.sync();
  assert.equal(row(t).gcal_dirty, 0);
  const version = row(t).gcal_version;

  // reminder and role pings are not visible to guests
  await t.run(meeting('update', { name: 'Team Sync', reminder: '2h', ping: 'role1' }));
  assert.equal(row(t).gcal_dirty, 0);
  assert.equal(row(t).gcal_version, version);
  // setting the same value again is not a change either
  await t.run(meeting('update', { name: 'Team Sync', location: 'none' }));
  assert.equal(row(t).gcal_dirty, 0);

  for (const [opts, label] of [
    [{ time: '4pm' }, 'time'],
    [{ date: '2026-11-26' }, 'date'],
    [{ new_name: 'Renamed' }, 'name'],
    [{ location: 'Room 9' }, 'location'],
    [{ duration: '2h' }, 'duration'],
    [{ channel: 'c9' }, 'channel'],
    [{ timezone: 'Europe/London' }, 'timezone'],
    [{ team: 'none' }, 'team'],
  ]) {
    await t.run(meeting('update', { name: row(t).name, ...opts }));
    assert.equal(row(t).gcal_dirty, 1, `${label} change should mark dirty`);
    await t.sync();
    assert.equal(row(t).gcal_dirty, 0);
  }
  assert.equal(t.bridge.calls.filter((c) => c.action === 'update').length, 8);
});

test('update: the confirmation says what happens on the calendar, in private', async () => {
  const t = setup();
  await pm(t);
  await create(t);
  await t.sync();
  const moved = await t.run(meeting('update', { name: 'Team Sync', time: '4pm' }));
  assert.equal(isEphemeral(moved), true);
  assert.match(moved.data.content, /Calendar: the Google event will be updated shortly \(guests get Google's update email\)\./);
  const quiet = await t.run(meeting('update', { name: 'Team Sync', reminder: '1h' }));
  assert.match(quiet.data.content, /Calendar: nothing in this change needs updating on Google Calendar\./);
  assert.doesNotMatch(t.discord.posts.at(-1).content, /calendar|gmail|guest/i);
});

test('update: repeat cannot change on a synced meeting; "calendar false" tells you to cancel instead', async () => {
  const t = setup();
  await pm(t);
  await create(t);
  const rep = await t.run(meeting('update', { name: 'Team Sync', repeat: 'weekly' }));
  assert.match(rep.data.content, /Google can't safely turn a single event into a repeating one.*Cancel it with `\/cancel-meeting`/);
  assert.equal(row(t).repeat, 'none');
  assert.equal((await t.run(meeting('update', { name: 'Team Sync', repeat: 'none', location: 'Room 1' }))).data.content.includes("can't safely"), false);

  const off = await t.run(meeting('update', { name: 'Team Sync', calendar: false }));
  assert.match(off.data.content, /cancel it with `\/cancel-meeting`.*cancels the meeting and its reminders together/);
  assert.equal(row(t).status, 'active');
  assert.equal(row(t).gcal_owner_id, 'u1');

  // an unsynced meeting may change repeat freely
  await create(t, { name: 'Plain', calendar: false });
  await t.run(meeting('update', { name: 'Plain', repeat: 'weekly' }));
  assert.equal(rows(t, "name = 'Plain'")[0].repeat, 'weekly');
});

test('update calendar:true attaches your calendar to a meeting that has none, or says why not', async () => {
  const t = setup();
  await tz(t);
  await create(t, { name: 'Late' }); // not connected yet
  const early = await t.run(meeting('update', { name: 'Late', calendar: true }));
  assert.match(early.data.content, /once you connect it\. Run `\/calendar connect` first/);

  await connect(t);
  await t.run(guests('add', { team: 'Design', emails: 'a@gmail.com' }));
  const ok = await t.run(meeting('update', { name: 'Late', calendar: true }));
  assert.match(ok.data.content, /Calendar: will be added to pm@gmail\.com shortly/);
  assert.match(ok.data.content, /Guest team: Design \(1 guest\)/);
  const m = row(t);
  assert.deepEqual([m.gcal_owner_id, m.guest_team_key, m.gcal_dirty], ['u1', 'design', 1]);
  assert.match(m.gcal_event_id, /^v[0-9a-v]{24}$/);
  assert.match((await t.run(meeting('update', { name: 'Late', calendar: true }))).data.content, /already on a Google Calendar/);

  const t2 = setup({ enabled: false });
  await tz(t2);
  await create(t2, { name: 'X' });
  assert.match((await t2.run(meeting('update', { name: 'X', calendar: true }))).data.content, /not enabled/);
});

test('update by a Manage Server admin syncs through the OWNER\'s script', async () => {
  const t = setup();
  await pm(t, 'u1', SCRIPT_A);
  await tz(t, 'u9');
  await connect(t, 'u9', SCRIPT_B, 'admin@gmail.com');
  await create(t);
  await t.sync();
  await t.run(meeting('update', { name: 'Team Sync', location: 'Room 2' }, { user: 'u9', perms: String(0x8) }));
  await t.sync();
  assert.deepEqual(t.bridge.calls.map((c) => [c.action, c.url]), [['create', SCRIPT_A], ['update', SCRIPT_A]]);
});

test('cancel: queues the Google event for deletion; meetings that never had one are not queued', async () => {
  const t = setup();
  await pm(t);
  await create(t);
  await create(t, { name: 'Plain', calendar: false });
  const r = await t.run(meeting('cancel', { name: 'Team Sync' }));
  assert.match(r.data.content, /Cancelled: \*\*Team Sync\*\*/);
  assert.equal(isEphemeral(r), false); // the public line is unchanged
  assert.doesNotMatch(r.data.content, /calendar|google/i);
  assert.deepEqual(rows(t).map((m) => [m.name, m.status, m.gcal_dirty]), [['Team Sync', 'cancelled', 1], ['Plain', 'active', 0]]);

  await t.run(meeting('cancel', { name: 'Plain' }));
  assert.equal(rows(t, "name = 'Plain'")[0].gcal_dirty, 0);
  const sum = await t.sync();
  assert.equal(sum.claimed, 1);
  assert.deepEqual(t.bridge.calls.map((c) => c.action), ['cancel']);
});

test('cancel of a meeting that was never created on Google still sends a safe cancel; an unsynced one sends nothing', async () => {
  const t = setup();
  await pm(t);
  await create(t);
  await t.run(meeting('cancel', { name: 'Team Sync' })); // event id exists, Google never saw it
  await t.sync();
  assert.deepEqual(t.bridge.calls.map((c) => c.action), ['cancel']); // Code.gs treats an unknown id as success
  assert.equal(row(t).gcal_dirty, 0);

  // cancelled with no event id: nothing to send, flags just clear
  const t2 = setup();
  await pm(t2);
  await create(t2, { calendar: false });
  await t2.run(meeting('cancel', { name: 'Team Sync' }));
  t2.db.sql("UPDATE meetings SET gcal_dirty = 1, gcal_version = 5"); // forced state
  const s = await t2.sync();
  assert.equal(s.cleared, 1);
  assert.equal(t2.bridge.calls.length, 0);
  assert.equal(row(t2).gcal_dirty, 0);
});

test('the weekly roll-forward does not mark the meeting dirty', async () => {
  const t = setup();
  await pm(t);
  await create(t, { repeat: 'weekly', reminder: '0' });
  await t.sync();
  const m0 = row(t);
  assert.equal(m0.gcal_dirty, 0);

  await runDueJobs({ db: t.db, discord: t.discord, nowSec: m0.start_at });
  const m1 = row(t);
  assert.equal(m1.start_at, m0.start_at + 7 * 86400);
  assert.equal(m1.gcal_dirty, 0);
  assert.equal(m1.gcal_version, m0.gcal_version);
  assert.equal((await t.sync(m0.start_at)).claimed, 0);
});

// ---------- the sync step ----------

test('sync: create sends the right payload, posts only the Meet link publicly, and tells the organizer privately', async () => {
  const t = setup();
  await pm(t);
  await create(t, { location: 'Voice Lounge', duration: '1h30min', ping: 'role1' });
  const before = t.discord.posts.length;
  const sum = await t.sync();
  assert.deepEqual(sum, { claimed: 1, created: 1 });

  const call = t.bridge.calls[0];
  assert.equal(call.url, SCRIPT_A);
  assert.equal(call.action, 'create');
  assert.equal(call.eventId, row(t).gcal_event_id);
  assert.deepEqual(
    { title: call.title, startSec: call.startSec, durationMin: call.durationMin, timezone: call.timezone, repeat: call.repeat, location: call.location, meet: call.meet, sendInvites: call.sendInvites },
    { title: 'Team Sync', startSec: NOV25_3PM_CHI, durationMin: 90, timezone: 'America/Chicago', repeat: 'none', location: 'Voice Lounge', meet: true, sendInvites: true },
  );
  assert.deepEqual(call.guests, ['a@gmail.com', 'b@gmail.com']);
  assert.equal(call.description, 'Discord: https://discord.com/channels/g1/c1');
  assert.equal('secret' in call, false); // the client adds the secret; it is never stored or logged here

  const m = row(t);
  assert.deepEqual([m.gcal_created, m.gcal_dirty, m.gcal_error, m.meet_link], [1, 0, null, 'https://meet.google.com/abc-defg-hij']);

  const pub = t.discord.posts.slice(before);
  assert.equal(pub.length, 1);
  assert.equal(pub[0].channelId, 'c1');
  assert.equal(pub[0].content, 'Google Meet link for Team Sync: https://meet.google.com/abc-defg-hij');
  assert.deepEqual(pub[0].allowedMentions, { parse: [] }); // no role pings

  assert.equal(t.discord.followups.length, 1);
  const f = t.discord.followups[0];
  assert.deepEqual([f.appId, f.token], ['app1', 'tok-u1']);
  assert.match(f.content, /added to the calendar of pm@gmail\.com/);
  assert.match(f.content, /team Design \(2 guests\)/);
  assert.match(f.content, /Meet link was posted in the meeting channel/);
  assert.equal(m.gcal_followup_token, null); // used, so deleted
});

test('sync: update then cancel use the right actions; update does not repost the link', async () => {
  const t = setup();
  await pm(t);
  await create(t);
  await t.sync();
  const posts = t.discord.posts.length;
  await t.run(meeting('update', { name: 'Team Sync', location: 'Room 4' }));
  await t.sync();
  assert.equal(t.bridge.calls[1].action, 'update');
  assert.equal(t.bridge.calls[1].location, 'Room 4');
  assert.equal(t.discord.posts.length, posts + 1); // only the public "Meeting updated" notice from the command
  assert.equal(row(t).meet_link, 'https://meet.google.com/abc-defg-hij'); // kept: update returned no link

  await t.run(meeting('cancel', { name: 'Team Sync' }));
  const s = await t.sync();
  assert.equal(s.cancelled, 1);
  assert.deepEqual(t.bridge.calls.map((c) => c.action), ['create', 'update', 'cancel']);
  assert.deepEqual(Object.keys(t.bridge.calls[2]).sort(), ['action', 'eventId', 'sendInvites', 'url']);
  assert.equal(row(t).gcal_dirty, 0);
});

test('sync: a fixed offset is sent as UTC; a place name is sent as its IANA zone', async () => {
  const t = setup();
  await pm(t);
  await create(t, { timezone: 'UTC+5:30' });
  await create(t, { name: 'Lagos', timezone: 'Nigeria', team: 'none' });
  await t.sync();
  assert.deepEqual(t.bridge.calls.map((c) => c.timezone), ['UTC', 'Africa/Lagos']);
  assert.equal(t.bridge.calls[0].startSec, Date.UTC(2026, 10, 25, 9, 30) / 1000); // 15:00 at UTC+5:30 is 09:30Z
});

test('sync: a failure is retried with backoff, the reason is stored and shown in the list, then success clears it', async () => {
  const t = setup({ bridge: createFakeBridge({ script: [{ ok: false, retryable: true, error: 'Google Calendar bridge: the script was busy with another request.' }] }) });
  await pm(t);
  await create(t);
  const s1 = await t.sync(NOW);
  assert.equal(s1.retried, 1);
  let m = row(t);
  assert.deepEqual([m.gcal_dirty, m.gcal_attempts, m.gcal_run_after], [1, 1, NOW + 60]);
  assert.match(m.gcal_error, /busy with another request.*attempt 1 of 4, will retry/);
  assert.match((await t.run(meeting('list'))).data.content, /\(calendar sync failed: .*busy/);
  assert.equal(t.discord.followups.length, 0); // not final yet

  assert.equal((await t.sync(NOW + 59)).claimed, 0); // not due
  const s2 = await t.sync(NOW + 60);
  assert.equal(s2.created, 1);
  m = row(t);
  assert.deepEqual([m.gcal_dirty, m.gcal_attempts, m.gcal_error, m.gcal_created], [0, 0, null, 1]);
});

test('sync: after 4 failed attempts it gives up, tells the organizer WHY in private, and posts only a short public notice', async () => {
  const fail = { ok: false, retryable: true, error: 'Google Calendar bridge: Google answered HTTP 503. This is usually temporary.' };
  const t = setup({ bridge: createFakeBridge({ script: [fail, fail, fail, fail] }) });
  await pm(t);
  await create(t);
  const before = t.discord.posts.length;
  const outcomes = [];
  for (const offset of [0, 60, 180, 420]) outcomes.push(await t.sync(NOW + offset)); // the backoff schedule: 60, 120, 240 seconds
  assert.deepEqual(outcomes.map((o) => Object.keys(o).filter((k) => k !== 'claimed')), [['retried'], ['retried'], ['retried'], ['failed']]);
  const m = row(t);
  assert.equal(m.gcal_dirty, 0);
  assert.match(m.gcal_error, /HTTP 503/);
  assert.equal(t.bridge.calls.length, 4);

  const f = t.discord.followups[0];
  assert.match(f.content, /I could not add it to Google Calendar \*\*Team Sync\*\* after 4 attempts/);
  assert.match(f.content, /Reason: Google Calendar bridge: Google answered HTTP 503/);
  assert.match(f.content, /Discord meeting and its reminders are not affected/);
  const pub = t.discord.posts.slice(before);
  assert.deepEqual(pub.map((p) => p.content), ['Calendar sync failed for Team Sync. The organizer has been told.']);
  assert.doesNotMatch(pub[0].content, /503|gmail/);
});

test('sync: a permanent failure gives up at once; if the private window has passed, the public notice points to /upcoming-meetings', async () => {
  const t = setup({ bridge: createFakeBridge({ script: [{ ok: false, retryable: false, error: 'Google Calendar bridge: unknown timezone: Mars/Base' }] }) });
  await pm(t);
  await create(t);
  const late = NOW + 20 * 60; // the 15-minute follow-up window is over
  const s = await t.sync(late);
  assert.equal(s.failed, 1);
  assert.equal(t.discord.followups.length, 0);
  assert.equal(t.discord.posts.at(-1).content, 'Calendar sync failed for Team Sync. The organizer can see the reason in /upcoming-meetings.');
  assert.match(row(t).gcal_error, /unknown timezone: Mars\/Base/);
  assert.equal(row(t).gcal_followup_token, null); // expired tokens are dropped
  assert.match((await t.run(meeting('list'), late)).data.content, /calendar sync failed: Google Calendar bridge: unknown timezone: Mars\/Base/);
});

test('sync: a private follow-up that cannot be delivered is reported honestly in the public notice', async () => {
  const t = setup({ bridge: createFakeBridge({ script: [{ ok: false, retryable: false, error: 'Google Calendar bridge: nope' }] }) });
  await pm(t);
  await create(t);
  t.discord.sendFollowup = async () => ({ ok: false, retryable: false, status: 404, error: 'HTTP 404: Unknown Webhook (code 10015)' });
  await t.sync();
  assert.match(t.discord.posts.at(-1).content, /The organizer can see the reason in \/upcoming-meetings\./);
  assert.doesNotMatch(t.discord.posts.at(-1).content, /has been told/);
  assert.match(row(t).gcal_error, /nope/);
});

test('sync: an update made while the call to Google was in flight is not lost', async () => {
  // someone runs /update-meeting while the first call is still out
  const bridge = createFakeBridge({ onCall: async (payload, n) => n === 1 && markMeetingDirty(t.db, row(t).id) });
  const t = setup({ bridge });
  await pm(t);
  await create(t);
  await t.sync();
  assert.equal(row(t).gcal_created, 1);
  assert.equal(row(t).gcal_dirty, 1); // still dirty: the newer state has not been sent
  await t.sync();
  assert.deepEqual(t.bridge.calls.map((c) => c.action), ['create', 'update']);
  assert.equal(row(t).gcal_dirty, 0);
});

test('sync: "already existed" (a retry after a lost answer) converges with an update and still posts the Meet link', async () => {
  const bridge = createFakeBridge({ script: [{ ok: true, eventId: 'x', meetLink: 'https://meet.google.com/zzz-zzzz-zzz', created: false }] });
  const t = setup({ bridge });
  await pm(t);
  await create(t);
  const before = t.discord.posts.length;
  await t.sync();
  assert.equal(row(t).gcal_dirty, 1);
  assert.match(t.discord.posts[before].content, /meet\.google\.com\/zzz-zzzz-zzz/);
  await t.sync();
  assert.deepEqual(t.bridge.calls.map((c) => c.action), ['create', 'update']);
  assert.equal(row(t).gcal_dirty, 0);
});

test('sync: if the Meet link cannot be posted in the channel, the private message carries it with the reason', async () => {
  const t = setup();
  await pm(t);
  await create(t);
  t.discord.postMessage = async () => ({ ok: false, retryable: false, error: 'HTTP 403: Missing Access (code 50001)' });
  await t.sync();
  const f = t.discord.followups[0];
  assert.match(f.content, /Warning: I could not post the Meet link in <#c1> \(HTTP 403: Missing Access \(code 50001\)\)\. Here it is: https:\/\/meet\.google\.com\/abc-defg-hij/);
});

test('sync: Google returning no Meet link is reported to the organizer', async () => {
  const t = setup({ bridge: createFakeBridge({ script: [{ ok: true, eventId: 'x', meetLink: '', created: true }] }) });
  await pm(t);
  await create(t);
  const before = t.discord.posts.length;
  await t.sync();
  assert.equal(t.discord.posts.length, before); // nothing to post
  assert.match(t.discord.followups[0].content, /Warning: Google did not return a Meet link/);
});

test('sync: if the owner disconnected, it stops without calling Google and says so', async () => {
  const t = setup();
  await pm(t);
  await create(t);
  t.db.sql('DELETE FROM calendar_accounts');
  const s = await t.sync();
  assert.equal(s.failed, 1);
  assert.equal(t.bridge.calls.length, 0);
  assert.match(row(t).gcal_error, /disconnected their Google Calendar/);
  assert.equal(row(t).gcal_dirty, 0);
  assert.match(t.discord.followups[0].content, /Reason: the owner of this calendar event has disconnected/);
});

test('sync: a team change re-syncs its upcoming meetings, with the new guest list', async () => {
  const t = setup();
  await pm(t);
  await create(t);
  await t.sync();
  const r = await t.run(guests('add', { team: 'Design', emails: 'new@gmail.com' }));
  assert.match(r.data.content, /1 upcoming meeting will be updated on Google Calendar shortly/);
  await t.sync();
  assert.deepEqual(t.bridge.calls[1].guests, ['a@gmail.com', 'b@gmail.com', 'new@gmail.com']);

  await t.run(guests('remove', { team: 'Design', emails: 'a@gmail.com' }));
  await t.sync();
  assert.deepEqual(t.bridge.calls[2].guests, ['b@gmail.com', 'new@gmail.com']);

  const del = await t.run(guests('delete-team', { team: 'Design' }));
  assert.match(del.data.content, /1 upcoming meeting will be updated on Google Calendar shortly, without guests/);
  await t.sync();
  assert.deepEqual(t.bridge.calls[3].guests, []);
  assert.equal(row(t).guest_team_key, null);
});

test('sync: only 2 meetings per run, and an unexpected error is recorded where the user can see it', async () => {
  const t = setup();
  await pm(t);
  for (const n of ['A', 'B', 'C']) await create(t, { name: n });
  assert.equal(SYNC_BATCH_SIZE, 2);
  assert.equal((await t.sync(NOW)).claimed, 2);
  assert.equal((await t.sync(NOW)).claimed, 1);

  const t2 = setup({ bridge: { async call() { throw new Error('disk on fire'); } } });
  await pm(t2);
  await create(t2);
  const s = await t2.sync();
  assert.equal(s.errors, 1);
  assert.match(row(t2).gcal_error, /unexpected error: disk on fire/);
  assert.equal(row(t2).gcal_dirty, 1); // will retry
});

test('housekeeping keeps meetings that still need a sync and drops stale follow-up tokens', async () => {
  const t = setup();
  await pm(t);
  await create(t);
  await create(t, { name: 'Plain', calendar: false });
  await t.run(meeting('cancel', { name: 'Team Sync' })); // dirty cancel, event not yet deleted
  await t.run(meeting('cancel', { name: 'Plain' }));
  const later = NOW + 40 * 86400;
  t.db.sql('UPDATE meetings SET updated_at = 1');
  await pruneOld(t.db, later);
  assert.deepEqual(rows(t).map((m) => m.name), ['Team Sync']); // the clean cancelled one is gone, the dirty one stays
  assert.equal(row(t).gcal_followup_token, null); // expired token cleared
});

// ---------- discord client ----------

test('discord client: follow-ups are ephemeral and need no bot header; the original reply is edited in place', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const d = createDiscordClient({ token: 'bot-token', apiBase: 'https://discord.test/api', fetchImpl });
  assert.deepEqual(await d.sendFollowup('app1', 'tok1', { content: 'private' }), { ok: true });
  assert.deepEqual(await d.editOriginal('app1', 'tok1', { content: 'edited' }), { ok: true });
  assert.equal(calls[0].url, 'https://discord.test/api/webhooks/app1/tok1');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.flags, 64);
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[1].url, 'https://discord.test/api/webhooks/app1/tok1/messages/@original');
  assert.equal(calls[1].method, 'PATCH');

  const gone = createDiscordClient({
    token: 't',
    fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({ message: 'Unknown Webhook', code: 10015 }) }),
  });
  assert.deepEqual(await gone.sendFollowup('a', 'b', { content: 'x' }), {
    ok: false,
    status: 404,
    retryable: false,
    error: 'HTTP 404: Unknown Webhook (code 10015)',
  });
});

test('autocomplete: team suggestions show only your teams (all for Manage Server), plus "(no guests)" for meetings', async () => {
  const t = setup();
  await t.run(guests('add', { team: 'Design', emails: 'a@gmail.com' }));
  await t.run(guests('add', { team: 'Eng', emails: 'b@gmail.com' }, { user: 'u2' }));
  const ask = (name, value, who = {}) =>
    t.run({
      type: 4,
      guild_id: 'g1',
      member: { user: { id: who.user ?? 'u1' }, permissions: who.perms ?? '0' },
      data: { name, options: [{ name: 'team', type: 3, value, focused: true }] },
    });
  const mine = await ask('new-meeting', '');
  assert.deepEqual(mine.data.choices.map((c) => c.value), ['none', 'Design']);
  const guestsOnly = await ask('add-team', '');
  assert.deepEqual(guestsOnly.data.choices.map((c) => c.value), ['Design']);
  const admin = await ask('new-meeting', '', { user: 'u9', perms: String(0x20) });
  assert.deepEqual(admin.data.choices.map((c) => c.value), ['none', 'Design', 'Eng']);
  const narrowed = await ask('new-meeting', 'des');
  assert.deepEqual(narrowed.data.choices.map((c) => c.value), ['Design']);
});

// ---------- fixes found in review ----------

test('sync: a meeting cancelled while its event was being created does not get a public Meet link', async () => {
  const bridge = createFakeBridge({ onCall: async (payload, n) => n === 1 && t.run(meeting('cancel', { name: 'Team Sync' })) });
  const t = setup({ bridge });
  await pm(t);
  await create(t);
  const before = t.discord.posts.length;
  await t.sync();
  assert.equal(t.discord.posts.slice(before).some((p) => /Meet link/.test(p.content)), false);
  assert.equal(t.discord.followups.length, 0);
  assert.equal(row(t).gcal_dirty, 1); // the cancel is still pending
  await t.sync();
  assert.deepEqual(t.bridge.calls.map((c) => c.action), ['create', 'cancel']);
  assert.equal(row(t).gcal_dirty, 0);
});

test('sync: a meeting that ended before its event was ever created is reported, not cleared silently', async () => {
  const t = setup();
  await pm(t);
  await create(t);
  t.db.sql("UPDATE meetings SET status = 'done'");
  const s = await t.sync();
  assert.equal(s.cleared, 1);
  assert.equal(t.bridge.calls.length, 0);
  assert.equal(row(t).gcal_error, 'the meeting ended before it could be added to Google Calendar');
  assert.equal(row(t).gcal_dirty, 0);
});

test('update: any change retries a sync that failed earlier, so a failure is never a dead end', async () => {
  const t = setup({ bridge: createFakeBridge({ script: [{ ok: false, retryable: false, error: 'Google Calendar bridge: nope' }] }) });
  await pm(t);
  await create(t);
  await t.sync();
  assert.equal(row(t).gcal_dirty, 0);
  assert.match(row(t).gcal_error, /nope/);

  const r = await t.run(meeting('update', { name: 'Team Sync', reminder: '1h' })); // not guest-visible, but a retry is due
  assert.match(r.data.content, /Calendar: retrying the Google sync that failed earlier\./);
  assert.equal(row(t).gcal_dirty, 1);
  assert.equal(row(t).gcal_error, null);
  await t.sync();
  assert.deepEqual([row(t).gcal_created, row(t).gcal_error, row(t).gcal_dirty], [1, null, 0]);
});

// ---------- Google Meet is optional ----------

test('meet:false creates the event without a Google Meet link: none requested, none posted, nothing to warn about', async () => {
  const t = setup();
  await pm(t);
  const r = await create(t, { meet: false });
  assert.match(r.data.content, /Calendar: will be added to pm@gmail\.com shortly\. No Google Meet link will be created\./);
  assert.doesNotMatch(r.data.content, /Meet link is posted/);
  assert.equal(row(t).gcal_meet, 0);

  const before = t.discord.posts.length;
  await t.sync(); // the fake Google would return a link anyway: it must be ignored
  assert.equal(t.bridge.calls[0].meet, false);
  assert.equal(t.discord.posts.length, before); // no public Meet line
  assert.equal(row(t).meet_link, null);
  const note = t.discord.followups[0].content;
  assert.match(note, /added to the calendar of pm@gmail\.com/);
  assert.match(note, /team Design \(2 guests\)/); // guests are still invited by Google
  assert.match(note, /No Google Meet link was created, as you asked\./);
  assert.doesNotMatch(note, /Warning/);
});

test('a Meet link is still the default', async () => {
  const t = setup();
  await pm(t);
  await create(t);
  assert.equal(row(t).gcal_meet, 1);
  await t.sync();
  assert.equal(t.bridge.calls[0].meet, true);
  assert.match(t.discord.posts.at(-1).content, /Google Meet link for Team Sync/);
});

test('update meet: allowed while the event is not on Google yet, refused afterwards with the reason', async () => {
  const t = setup();
  await pm(t);
  await create(t); // queued, not created yet
  const early = await t.run(meeting('update', { name: 'Team Sync', meet: false }));
  assert.doesNotMatch(early.data.content, /can't add or remove/);
  assert.equal(row(t).gcal_meet, 0);
  assert.equal(row(t).gcal_dirty, 1);
  await t.sync();
  assert.equal(t.bridge.calls[0].meet, false);

  // now the event exists: Google cannot add or remove a Meet link later
  const late = await t.run(meeting('update', { name: 'Team Sync', meet: true }));
  assert.match(late.data.content, /Google can't add or remove a Meet link once the event exists\. Cancel the meeting with `\/cancel-meeting` and create a new one/);
  assert.equal(row(t).gcal_meet, 0);
  assert.equal(row(t).gcal_dirty, 0);

  // asking for what the meeting already has is not an error
  const same = await t.run(meeting('update', { name: 'Team Sync', meet: false, location: 'Room 3' }));
  assert.doesNotMatch(same.data.content, /can't add or remove/);
  assert.equal(row(t).location, 'Room 3');

  // a meeting that is not on a calendar can store the choice for later
  await create(t, { name: 'Plain', calendar: false });
  await t.run(meeting('update', { name: 'Plain', meet: false }));
  assert.equal(rows(t, "name = 'Plain'")[0].gcal_meet, 0);
});

test('presets remember the Meet choice, past meetings keep it, and typing meet overrides it for one meeting', async () => {
  const t = setup();
  await pm(t);
  const saved = await t.run(meeting('preset-save', { name: 'Quiet', time: '3pm', meet: false }));
  assert.match(saved.data.content, /Google Meet link: no/);
  assert.equal(t.db.sql('SELECT gcal_meet FROM presets')[0].gcal_meet, 0);

  await t.run(meeting('create', { name: 'Quiet', date: '2026-11-25' }));
  assert.equal(rows(t, "name = 'Quiet'")[0].gcal_meet, 0);

  await t.run(meeting('cancel', { name: 'Quiet' }));
  await t.run(meeting('create', { name: 'Quiet', date: '2026-12-02', meet: true }));
  assert.equal(rows(t, "name = 'Quiet' AND status = 'active'")[0].gcal_meet, 1);
  assert.equal(t.db.sql('SELECT gcal_meet FROM presets')[0].gcal_meet, 0); // the preset itself is unchanged

  // no preset: a past meeting without Meet is reused the same way
  await t.run(meeting('create', { name: 'Old', date: '2026-11-25', time: '3pm', meet: false, team: 'none' }));
  await t.run(meeting('cancel', { name: 'Old' }));
  await t.run(meeting('create', { name: 'Old', date: '2026-12-02' }));
  assert.equal(rows(t, "name = 'Old' AND status = 'active'")[0].gcal_meet, 0);

  const list = await t.run(meeting('presets'));
  assert.doesNotMatch(list.data.content, /undefined/);
});
