// Slash command handling. handleInteraction() is pure of the runtime: it takes the parsed
// interaction plus { db, discord, nowSec } and returns the JSON response for Discord.
import { InteractionType, ResponseType } from './discord.js';
import {
  allTimeZones,
  canonicalTimeZone,
  PLACE_ZONES,
  discordTimestamp as ts,
  localParts,
  parseDate,
  parseTime,
  zonedToUtc,
} from './time.js';
import {
  cancelMeeting,
  deletePreset,
  getCalendarAccount,
  getTeam,
  listGuests,
  listTeams,
  markMeetingDirty,
  findActiveMeetingByName,
  findLatestMeetingByName,
  getPreset,
  getUserTimezone,
  listPresets,
  savePreset,
  searchPastMeetingNames,
  searchPresetNames,
  insertMeeting,
  listUpcomingMeetings,
  meetingsWithFailedJobs,
  nameKey,
  normalizeName,
  replaceJobs,
  searchMeetingNames,
  setUserTimezone,
  updateMeeting,
} from './store.js';
import { PING_OPTION_NAMES } from './definitions.js';
import {
  allowedMentionsFor,
  cancelText,
  confirmationText,
  formatReminder,
  formatRoles,
  presetText,
  publicNoticeText,
} from './messages.js';
import { DEFAULT_DURATION_MIN, parseDuration, parseReminder } from './duration.js';
import { canManageOwner, fail, optionMap, reply } from './replies.js';
import { NOT_ENABLED, cmdCalendar, cmdGuests, followupFrom, newEventId, resolveTeam, suggestTeams } from './calendar-commands.js';

const MIN_LEAD_SEC = 60; // a meeting must start at least a minute from now
const MAX_NAME = 80;
const MAX_LOCATION = 200;

const COMMON_ZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Tokyo',
  'Australia/Sydney',
];

const canManage = (interaction, meeting, userId) => canManageOwner(interaction, meeting.created_by, userId);

// ---------- shared input handling ----------

/** Explicit option > the user's saved zone > (optional) fallback. */
async function resolveTimezone(db, userId, explicit, fallback = null) {
  if (explicit !== undefined) {
    const tz = canonicalTimeZone(explicit);
    return tz
      ? { ok: true, tz }
      : { ok: false, message: `I don't recognise the timezone \`${explicit}\`. Try something like \`America/Chicago\` (use the autocomplete list).` };
  }
  const saved = await getUserTimezone(db, userId);
  if (saved) return { ok: true, tz: saved };
  if (fallback) return { ok: true, tz: fallback };
  return {
    ok: false,
    message: 'I need to know your timezone first. Run `/set-timezone`, or pass the `timezone` option.',
  };
}

/** Role ids from ping, ping_2 ... ping_5 (comma-separated, no repeats), or undefined if none were given. */
function pingsFrom(o) {
  const ids = [...new Set(PING_OPTION_NAMES.map((n) => o[n]).filter(Boolean))];
  return ids.length ? ids.join(',') : undefined;
}

function cleanLocation(value) {
  if (value === undefined) return { ok: true, set: false };
  const v = String(value).trim();
  if (v.length > MAX_LOCATION) return { ok: false, message: `\`location\` is too long (max ${MAX_LOCATION} characters).` };
  if (v === '' || v === '-' || v.toLowerCase() === 'none') return { ok: true, set: true, value: null };
  return { ok: true, set: true, value: v };
}

/** Turns typed date + time into a UTC start, with friendly errors. */
function buildStart({ dateInput, timeInput, tz, nowSec, fallbackLocal }) {
  const nowMs = nowSec * 1000;
  let date;
  if (dateInput !== undefined) {
    date = parseDate(dateInput, tz, nowMs);
    if (!date.ok) return { ok: false, message: `I couldn't read the date \`${dateInput}\`. Use \`YYYY-MM-DD\`, \`today\` or \`tomorrow\`.` };
  } else {
    date = { y: fallbackLocal.y, m: fallbackLocal.m, d: fallbackLocal.d };
  }
  let time;
  if (timeInput !== undefined) {
    time = parseTime(timeInput);
    if (!time.ok) return { ok: false, message: `I couldn't read the time \`${timeInput}\`. Use \`15:00\` or \`3pm\`.` };
  } else {
    time = { h: fallbackLocal.h, mi: fallbackLocal.mi };
  }

  const z = zonedToUtc({ y: date.y, m: date.m, d: date.d, h: time.h, mi: time.mi }, tz);
  if (!z.ok) {
    return {
      ok: false,
      message: `That local time doesn't exist in ${tz} (clocks skip forward that hour for daylight saving). Pick a different time.`,
    };
  }
  const startAt = Math.floor(z.ms / 1000);
  if (startAt < nowSec + MIN_LEAD_SEC) {
    return { ok: false, message: `That time is in the past (as ${tz} time). Check the date and timezone.` };
  }
  return { ok: true, startAt, ambiguous: z.ambiguous };
}

const AMBIGUOUS_NOTE = '\nNote: that wall-clock time happens twice (clocks go back), so I used the first one.';
const NO_REMINDER_WARNING = 'the reminder time has already passed, so there will only be a start message.';

const sameValue = (a, b) => (a ?? null) === (b ?? null);

/** "Guest team: Design (3 guests)" or "Guest team: none" for the private confirmation. */
async function teamLine(db, meeting) {
  if (!meeting.guest_team_key) return 'Guest team: none (nobody is invited)';
  const team = await getTeam(db, meeting.guild_id, meeting.guest_team_key);
  if (!team) return `Guest team: ${meeting.guest_team_key} (this team no longer exists, so nobody is invited)`;
  const n = (await listGuests(db, meeting.guild_id, team.team_key)).length;
  return `Guest team: ${team.name} (${n} ${n === 1 ? 'guest' : 'guests'})`;
}

/**
 * Private confirmation to the person running the command, plus a public notice in the
 * meeting's channel (name, time, location, warning).
 */
async function confirmAndAnnounce(ctx, meeting, { header, publicHeader, reminderScheduled, ambiguous, extraLines = [] }) {
  const { discord } = ctx;
  const warning = meeting.reminder_minutes > 0 && !reminderScheduled ? NO_REMINDER_WARNING : null;

  let text = confirmationText(meeting, { header, extraLines });
  if (warning) text += `\nWarning: ${warning}`;
  if (ambiguous) text += AMBIGUOUS_NOTE;

  const posted = await discord.postMessage(meeting.channel_id, {
    content: publicNoticeText(meeting, { header: publicHeader, warning }),
    allowedMentions: allowedMentionsFor(meeting, { ping: false }),
  });
  text += posted.ok
    ? `\nPosted in <#${meeting.channel_id}> for everyone to see.`
    : `\nWarning: I couldn't post in <#${meeting.channel_id}> (${posted.error}). ` +
      'Make sure I can view and send messages there, or reminders will fail too.';
  return reply(text, { ephemeral: true, allowedMentions: allowedMentionsFor(meeting, { ping: false }) });
}

// ---------- subcommands ----------

/** Creates the meeting from fully resolved options (used by cmdCreate). */
async function createMeeting(ctx, o, { notes = [] } = {}) {
  const { db, nowSec, userId, guildId, interaction } = ctx;

  const name = normalizeName(o.name ?? '');
  if (!name) return fail('Give the meeting a name.');
  if (name.length > MAX_NAME) return fail(`The name is too long (max ${MAX_NAME} characters).`);

  const rem = parseReminder(o.reminder);
  if (!rem.ok) return fail(rem.message);
  const dur = parseDuration(o.duration);
  if (!dur.ok) return fail(dur.message);
  const loc = cleanLocation(o.location);
  if (!loc.ok) return fail(loc.message);

  // Google Calendar: only when the bot has it enabled, this person wants it, and they have connected.
  const wantCalendar = o.calendar !== false;
  const account = ctx.bridge && wantCalendar ? await getCalendarAccount(db, userId) : null;
  const team = o.team !== undefined || account ? await resolveTeam(ctx, o.team) : { ok: true, key: null, name: null };
  if (!team.ok) return fail(team.message);

  const tzRes = await resolveTimezone(db, userId, o.timezone);
  if (!tzRes.ok) return fail(tzRes.message);

  const start = buildStart({ dateInput: o.date, timeInput: o.time, tz: tzRes.tz, nowSec });
  if (!start.ok) return fail(start.message);

  if (await findActiveMeetingByName(db, guildId, name)) {
    return fail(`There's already a meeting called **${name}**. Use \`/update-meeting\` to change it, or pick another name.`);
  }

  const followup = account ? followupFrom(ctx) : null;
  const meeting = {
    guild_id: guildId,
    name,
    name_key: nameKey(name),
    channel_id: o.channel ?? interaction.channel_id,
    location: loc.value ?? null,
    timezone: tzRes.tz,
    start_at: start.startAt,
    reminder_minutes: rem.minutes ?? 15,
    repeat: o.repeat ?? 'none',
    role_id: pingsFrom(o) ?? null,
    created_by: userId,
    duration_min: dur.minutes ?? DEFAULT_DURATION_MIN,
    gcal_meet: o.meet === false ? 0 : 1,
    guest_team_key: team.key,
    gcal_owner_id: account ? userId : null,
    gcal_event_id: account ? newEventId() : null, // chosen and saved BEFORE any call to Google, so retries are safe
    gcal_dirty: Boolean(account),
    gcal_followup_app_id: followup?.appId ?? null,
    gcal_followup_token: followup?.token ?? null,
    gcal_followup_expires: followup?.expires ?? null,
  };
  try {
    meeting.id = await insertMeeting(db, meeting, nowSec);
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) return fail(`There's already a meeting called **${name}**.`);
    throw e;
  }
  const { reminderScheduled } = await replaceJobs(db, meeting, nowSec);

  const extraLines = [];
  if (account) {
    extraLines.push(await teamLine(db, meeting));
    extraLines.push(
      `Calendar: will be added to ${account.account_email ?? 'your Google Calendar'} shortly. ` +
        (meeting.gcal_meet ? 'The Meet link is posted in the channel when it is ready.' : 'No Google Meet link will be created.'),
    );
  } else if (!ctx.bridge) {
    if (o.calendar === true) extraLines.push('Calendar: Google Calendar sync is not enabled on this bot, so this meeting was not added.');
  } else if (!wantCalendar) {
    extraLines.push('Calendar: off for this meeting.');
  } else {
    extraLines.push('Calendar: not added to Google Calendar. Run /calendar connect first.');
  }
  if (!account && team.key) {
    extraLines.push(`Guest team: ${team.name} (nobody is invited because this meeting is not on a Google Calendar)`);
  }
  extraLines.push(...notes);

  return confirmAndAnnounce(ctx, meeting, {
    header: 'Meeting scheduled',
    publicHeader: 'New meeting',
    reminderScheduled,
    ambiguous: start.ambiguous,
    extraLines,
  });
}

async function cmdUpdate(ctx, o) {
  const { db, nowSec, userId, guildId, interaction } = ctx;

  const meeting = await findActiveMeetingByName(db, guildId, o.name ?? '');
  if (!meeting) return fail(`I can't find an active meeting named **${normalizeName(o.name ?? '')}**. Try \`/upcoming-meetings\`.`);
  if (!canManage(interaction, meeting, userId)) {
    return fail('Only the person who created this meeting, or someone with Manage Server, can change it.');
  }

  const changes = {};

  if (o.new_name !== undefined) {
    const newName = normalizeName(o.new_name);
    if (!newName) return fail('The new name is empty.');
    if (newName.length > MAX_NAME) return fail(`The new name is too long (max ${MAX_NAME} characters).`);
    if (nameKey(newName) !== meeting.name_key && (await findActiveMeetingByName(db, guildId, newName))) {
      return fail(`There's already a meeting called **${newName}**.`);
    }
    changes.name = newName;
    changes.name_key = nameKey(newName);
  }

  let ambiguous = false;
  if (o.date !== undefined || o.time !== undefined || o.timezone !== undefined) {
    const tzRes = await resolveTimezone(db, userId, o.timezone, meeting.timezone);
    if (!tzRes.ok) return fail(tzRes.message);
    changes.timezone = tzRes.tz;
    if (o.date !== undefined || o.time !== undefined) {
      const current = localParts(meeting.start_at * 1000, tzRes.tz);
      const start = buildStart({ dateInput: o.date, timeInput: o.time, tz: tzRes.tz, nowSec, fallbackLocal: current });
      if (!start.ok) return fail(start.message);
      changes.start_at = start.startAt;
      ambiguous = Boolean(start.ambiguous);
    }
  }

  const rem = parseReminder(o.reminder);
  if (!rem.ok) return fail(rem.message);
  if (rem.minutes !== undefined) changes.reminder_minutes = rem.minutes;

  const dur = parseDuration(o.duration);
  if (!dur.ok) return fail(dur.message);
  if (dur.minutes !== undefined) changes.duration_min = dur.minutes;

  const loc = cleanLocation(o.location);
  if (!loc.ok) return fail(loc.message);
  if (loc.set) changes.location = loc.value;

  if (o.channel !== undefined) changes.channel_id = o.channel;
  const pings = pingsFrom(o);
  if (pings !== undefined) changes.role_id = pings;

  // ---- Google Calendar ----
  const synced = Boolean(meeting.gcal_owner_id && meeting.gcal_event_id);
  if (o.repeat !== undefined) {
    if (synced && o.repeat !== meeting.repeat) {
      return fail(
        "Google can't safely turn a single event into a repeating one (or back), so `repeat` can't be changed on a meeting that is on a Google Calendar. Cancel it with `/cancel-meeting` and create a new one.",
      );
    }
    changes.repeat = o.repeat;
  }
  if (o.meet !== undefined && (o.meet ? 1 : 0) !== (meeting.gcal_meet ?? 1)) {
    if (synced && meeting.gcal_created) {
      return fail(
        "Google can't add or remove a Meet link once the event exists. Cancel the meeting with `/cancel-meeting` and create a new one with the `meet` option you want.",
      );
    }
    changes.gcal_meet = o.meet ? 1 : 0; // the event is not on Google yet, so the choice still applies
  }
  if (o.calendar === false && synced) {
    return fail(
      "To stop syncing this meeting, cancel it with `/cancel-meeting`. That removes the Google event (guests get Google's cancellation email) and cancels the meeting and its reminders together. I can't remove only the Google event and keep the meeting running.",
    );
  }
  let attach = null;
  if (o.calendar === true && !synced) {
    if (!ctx.bridge) return fail(NOT_ENABLED);
    attach = await getCalendarAccount(db, userId);
    if (!attach) return fail('I can only add this meeting to your Google Calendar once you connect it. Run `/calendar connect` first.');
    changes.gcal_owner_id = userId;
    changes.gcal_event_id = newEventId();
    changes.gcal_created = 0;
  }
  if (o.team !== undefined || attach) {
    const team = await resolveTeam(ctx, o.team);
    if (!team.ok) return fail(team.message);
    if (o.team !== undefined || team.key) changes.guest_team_key = team.key;
  }

  if (!Object.keys(changes).length) {
    if (o.calendar === true && synced) return fail('This meeting is already on a Google Calendar, so there is nothing to change.');
    return fail('Nothing to change. Add at least one option besides `name` (for example `time` or `location`).');
  }

  // Only changes guests can see need a Google update (reminders, repeat-free settings and role pings do not).
  const guestVisible = ['name', 'start_at', 'timezone', 'location', 'duration_min', 'guest_team_key', 'channel_id', 'gcal_meet'].some(
    (k) => k in changes && !sameValue(changes[k], meeting[k]),
  );

  try {
    await updateMeeting(db, meeting.id, changes, nowSec);
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) return fail('Another meeting already has that name.');
    throw e;
  }
  const updated = { ...meeting, ...changes };
  const { reminderScheduled } = await replaceJobs(db, updated, nowSec);

  // A synced meeting whose last sync failed is retried by any update, so a failure is never a dead end.
  const retrying = synced && Boolean(meeting.gcal_error);
  const syncNow = Boolean(attach) || (synced && (guestVisible || retrying));
  if (syncNow) await markMeetingDirty(db, meeting.id, followupFrom(ctx)); // the sync always goes through the OWNER's script

  const extraLines = [];
  if (attach) {
    extraLines.push(await teamLine(db, updated));
    extraLines.push(`Calendar: will be added to ${attach.account_email ?? 'your Google Calendar'} shortly.`);
  } else if (synced) {
    extraLines.push(await teamLine(db, updated));
    extraLines.push(
      guestVisible
        ? "Calendar: the Google event will be updated shortly (guests get Google's update email)."
        : syncNow
          ? 'Calendar: retrying the Google sync that failed earlier.'
          : 'Calendar: nothing in this change needs updating on Google Calendar.',
    );
  }

  return confirmAndAnnounce(ctx, updated, {
    header: 'Meeting updated',
    publicHeader: 'Meeting updated',
    reminderScheduled,
    ambiguous,
    extraLines,
  });
}

async function cmdCancel(ctx, o) {
  const { db, nowSec, userId, guildId, interaction } = ctx;
  const meeting = await findActiveMeetingByName(db, guildId, o.name ?? '');
  if (!meeting) return fail(`I can't find an active meeting named **${normalizeName(o.name ?? '')}**.`);
  if (!canManage(interaction, meeting, userId)) {
    return fail('Only the person who created this meeting, or someone with Manage Server, can cancel it.');
  }
  // Cancels the meeting and its reminders. A meeting on a Google Calendar is also queued so the sync
  // step deletes the event (guests get Google's cancellation email); failures are reported privately.
  await cancelMeeting(db, meeting.id, nowSec);
  if (meeting.gcal_owner_id && meeting.gcal_event_id) await markMeetingDirty(db, meeting.id, followupFrom(ctx));
  return reply(cancelText(meeting));
}

async function cmdList(ctx) {
  const { db, nowSec, guildId } = ctx;
  const meetings = await listUpcomingMeetings(db, guildId);
  if (!meetings.length) return reply('No upcoming meetings. Create one with `/new-meeting`.', { ephemeral: true });

  const failed = await meetingsWithFailedJobs(db, meetings.map((m) => m.id), nowSec);
  const lines = meetings.map((m) => {
    const bits = [`**${m.name}** — ${ts(m.start_at, 'F')} (${ts(m.start_at, 'R')})`, `<#${m.channel_id}>`];
    bits.push(m.reminder_minutes > 0 ? `reminder ${formatReminder(m.reminder_minutes)}` : 'no reminder');
    if (m.repeat === 'weekly') bits.push('weekly');
    let line = `• ${bits.join(' · ')}`;
    const problem = failed.get(m.id);
    if (problem) line += `\n   Problem: the ${problem.kind} message failed: ${problem.last_error}`;
    if (m.gcal_error) line += `\n   (calendar sync failed: ${String(m.gcal_error).slice(0, 300)})`;
    return line;
  });
  return reply(`**Upcoming meetings**\n${lines.join('\n')}`, { ephemeral: true });
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Saved settings for a name: a saved preset first, then the latest past meeting with that name.
 * Returns null when there is none. Anything typed in the command overrides these values.
 */
async function findSavedSettings(ctx, name) {
  const { db, guildId } = ctx;
  const preset = await getPreset(db, guildId, name);
  if (preset) {
    return {
      source: 'preset',
      name: preset.name,
      time: preset.default_time ?? undefined,
      channel: preset.channel_id ?? undefined,
      location: preset.location ?? undefined,
      reminder: `${preset.reminder_minutes}min`,
      duration: preset.duration_min ? `${preset.duration_min}min` : undefined,
      timezone: preset.timezone ?? undefined,
      repeat: preset.repeat,
      team: preset.guest_team_key || 'none',
      calendar: preset.calendar !== 0,
      meet: preset.gcal_meet !== 0,
      ping: preset.role_id ? preset.role_id.split(',') : [],
    };
  }
  const past = await findLatestMeetingByName(db, guildId, name);
  if (!past) return null;
  const lp = localParts(past.start_at * 1000, past.timezone);
  return {
    source: 'meeting',
    name: past.name,
    time: `${pad2(lp.h)}:${pad2(lp.mi)}`,
    channel: past.channel_id,
    location: past.location ?? undefined,
    reminder: `${past.reminder_minutes}min`,
    duration: `${past.duration_min}min`,
    timezone: past.timezone,
    repeat: past.repeat,
    team: past.guest_team_key || 'none',
    calendar: true,
    meet: past.gcal_meet !== 0,
    ping: past.role_id ? past.role_id.split(',') : [],
  };
}

/**
 * /new-meeting. If the name matches a saved preset (or an earlier meeting), its settings are
 * reused and anything typed here overrides them for this meeting only. `reuse:false` starts from scratch.
 * The Google Calendar event always goes to the person running this command.
 */
async function cmdCreate(ctx, o) {
  const { db, guildId, userId, interaction } = ctx;
  const wanted = normalizeName(o.name ?? '');
  const base = wanted && o.reuse !== false ? await findSavedSettings(ctx, wanted) : null;

  if (!base) {
    if (o.time === undefined) {
      return fail(
        'Give a time, for example `time:3pm`. (To reuse the settings of a saved preset or an earlier meeting, pick its name from the list as you type `name`.)',
      );
    }
    return createMeeting(ctx, o);
  }

  const merged = { ...base };
  for (const key of ['time', 'channel', 'location', 'reminder', 'duration', 'timezone', 'repeat', 'team']) {
    if (o[key] !== undefined) merged[key] = o[key];
  }
  merged.calendar = o.calendar !== undefined ? o.calendar : base.calendar ? undefined : false;
  merged.meet = o.meet !== undefined ? o.meet : base.meet ? undefined : false;
  // Roles given here replace the saved set; otherwise the saved roles are reused.
  const givenPings = pingsFrom(o);
  const roles = givenPings ? givenPings.split(',') : base.ping;
  delete merged.ping;
  roles.slice(0, PING_OPTION_NAMES.length).forEach((id, i) => {
    merged[PING_OPTION_NAMES[i]] = id;
  });
  delete merged.source;
  merged.date = o.date;
  if (merged.time === undefined) {
    return fail(`**${base.name}** has no saved time, so add the \`time\` option (for example \`time:3pm\`).`);
  }

  const notes = [
    `Used the saved settings from ${base.source === 'preset' ? 'the preset' : 'your earlier meeting'} **${base.name}**. ` +
      'Anything you typed replaced the saved value for this meeting only. Add `reuse:false` to start from scratch.',
  ];
  // A team that came from the saved settings (not typed now) must be one this person may invite.
  if (o.team === undefined && base.team !== 'none') {
    const team = await getTeam(db, guildId, base.team);
    if (!team) {
      merged.team = 'none';
      notes.push(`Note: this ${base.source} invites the team ${base.team}, which no longer exists. Scheduled without guests. Pick one of your teams with team: to invite people.`);
    } else if (!canManageOwner(interaction, team.owner_id, userId)) {
      merged.team = 'none';
      notes.push(`Note: this ${base.source} invites ${team.name}, which you don't own. Scheduled without guests. Pick one of your teams with team: to invite people.`);
    } else {
      merged.team = team.team_key;
    }
  }
  return createMeeting(ctx, merged, { notes });
}

async function cmdPresetSave(ctx, o) {
  const { db, nowSec, userId, guildId, interaction } = ctx;

  const name = normalizeName(o.name ?? '');
  if (!name) return fail('Give the preset a name.');
  if (name.length > MAX_NAME) return fail(`The name is too long (max ${MAX_NAME} characters).`);

  const existing = await getPreset(db, guildId, name);
  if (existing && !canManage(interaction, existing, userId)) {
    return fail('Only the person who saved this preset, or someone with Manage Server, can change it.');
  }

  const rem = parseReminder(o.reminder);
  if (!rem.ok) return fail(rem.message);
  const clearDuration = o.duration !== undefined && String(o.duration).trim().toLowerCase() === 'none';
  const dur = clearDuration ? { ok: true, minutes: undefined } : parseDuration(o.duration);
  if (!dur.ok) return fail(dur.message);
  const loc = cleanLocation(o.location);
  if (!loc.ok) return fail(loc.message);

  const next = {
    guild_id: guildId,
    name,
    name_key: nameKey(name),
    channel_id: existing?.channel_id ?? null,
    location: existing?.location ?? null,
    timezone: existing?.timezone ?? null,
    default_time: existing?.default_time ?? null,
    reminder_minutes: existing?.reminder_minutes ?? 15,
    repeat: existing?.repeat ?? 'none',
    role_id: existing?.role_id ?? null,
    created_by: existing?.created_by ?? userId,
    duration_min: existing?.duration_min ?? null,
    guest_team_key: existing?.guest_team_key ?? null,
    calendar: existing?.calendar ?? 1,
    gcal_meet: existing?.gcal_meet ?? 1,
  };

  if (o.time !== undefined) {
    const raw = String(o.time).trim();
    if (raw.toLowerCase() === 'none') {
      next.default_time = null;
    } else {
      const t = parseTime(raw);
      if (!t.ok) return fail(`I couldn't read the time \`${o.time}\`. Use \`15:00\` or \`3pm\`.`);
      next.default_time = `${pad2(t.h)}:${pad2(t.mi)}`;
    }
  }
  if (o.timezone !== undefined) {
    const tz = canonicalTimeZone(o.timezone);
    if (!tz) return fail(`I don't recognise the timezone \`${o.timezone}\`. Try something like \`America/Chicago\` (use the autocomplete list).`);
    next.timezone = tz;
  }
  if (loc.set) next.location = loc.value;
  if (o.channel !== undefined) next.channel_id = o.channel;
  if (rem.minutes !== undefined) next.reminder_minutes = rem.minutes;
  if (clearDuration) next.duration_min = null;
  else if (dur.minutes !== undefined) next.duration_min = dur.minutes;
  if (o.repeat !== undefined) next.repeat = o.repeat;
  const pings = pingsFrom(o);
  if (pings !== undefined) next.role_id = pings;
  if (o.calendar !== undefined) next.calendar = o.calendar ? 1 : 0;
  if (o.meet !== undefined) next.gcal_meet = o.meet ? 1 : 0;

  // Team: a team you own, or "none". A new preset defaults to your only team (if you have exactly one).
  if (o.team !== undefined) {
    const team = await resolveTeam(ctx, o.team);
    if (!team.ok) return fail(team.message);
    next.guest_team_key = team.key;
  } else if (!existing) {
    const owned = await listTeams(db, guildId, { ownerId: userId });
    if (owned.length === 1) next.guest_team_key = owned[0].team_key;
  }

  await savePreset(db, next, nowSec);
  const team = next.guest_team_key ? await getTeam(db, guildId, next.guest_team_key) : null;
  const text =
    presetText(next, { header: existing ? 'Preset updated' : 'Preset saved', teamName: team?.name ?? null }) +
    `\nSchedule it any time with \`/new-meeting name:${next.name} date:...\` (change anything by adding options).`;
  return reply(text, { ephemeral: true, allowedMentions: { parse: [] } });
}

async function cmdPresets(ctx) {
  const presets = await listPresets(ctx.db, ctx.guildId);
  if (!presets.length) {
    return reply('No saved presets yet. Save one with `/add-update-preset`.', { ephemeral: true });
  }
  const teams = new Map((await listTeams(ctx.db, ctx.guildId, { limit: 100 })).map((t) => [t.team_key, t.name]));
  const lines = presets.map((p) => {
    const bits = [`**${p.name}**`, p.default_time ? p.default_time : 'no usual time'];
    if (p.location) bits.push(p.location);
    bits.push(p.channel_id ? `<#${p.channel_id}>` : 'current channel');
    bits.push(p.reminder_minutes > 0 ? `reminder ${formatReminder(p.reminder_minutes)}` : 'no reminder');
    bits.push(`duration ${p.duration_min ? formatReminder(p.duration_min) : '1 h'}`);
    if (p.repeat === 'weekly') bits.push('weekly');
    if (p.role_id) bits.push(`pings ${formatRoles(p)}`);
    if (p.guest_team_key) bits.push(`team ${teams.get(p.guest_team_key) ?? `${p.guest_team_key} (deleted)`}`);
    bits.push(p.calendar === 0 ? 'calendar off' : 'calendar on');
    return `- ${bits.join(' / ')}`;
  });
  return reply(`**Saved presets**\n${lines.join('\n')}`, { ephemeral: true, allowedMentions: { parse: [] } });
}

async function cmdPresetDelete(ctx, o) {
  const { db, userId, guildId, interaction } = ctx;
  const preset = await getPreset(db, guildId, o.name ?? '');
  if (!preset) return fail(`I can't find a preset named **${normalizeName(o.name ?? '')}**. Try \`/meeting-presets\`.`);
  if (!canManage(interaction, preset, userId)) {
    return fail('Only the person who saved this preset, or someone with Manage Server, can delete it.');
  }
  await deletePreset(db, preset.id);
  return reply(`Deleted the preset **${preset.name}**. Meetings already scheduled from it are not affected.`, { ephemeral: true });
}

async function cmdSetTimezone(ctx, o) {
  const { db, nowSec, userId } = ctx;
  const tz = canonicalTimeZone(o.timezone);
  if (!tz) return fail(`I don't recognise \`${o.timezone}\`. Try something like \`America/Chicago\` (use the autocomplete list).`);
  await setUserTimezone(db, userId, tz, nowSec);
  const lp = localParts(nowSec * 1000, tz);
  const clock = `${String(lp.h).padStart(2, '0')}:${String(lp.mi).padStart(2, '0')}`;
  return reply(`Timezone saved: **${tz}**. It's currently ${clock} there, so times you type will be read in that zone.`, {
    ephemeral: true,
  });
}

// ---------- autocomplete ----------

const placeChoice = ([name, zone]) => ({ name: `${name} (${zone})`, value: zone });

function suggestZones(query) {
  const q = String(query ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  const offset = canonicalTimeZone(String(query ?? ""));
  if (offset && /^[+-]\d\d:\d\d$/.test(offset)) {
    return [{ name: `UTC${offset} (fixed offset, no daylight saving)`, value: offset }];
  }
  if (!q) {
    return [...COMMON_ZONES.map((z) => ({ name: z, value: z })), ...PLACE_ZONES.slice(0, 13).map(placeChoice)];
  }
  const places = PLACE_ZONES.filter(([n, z]) => {
    const nk = n.toLowerCase().replace(/\s+/g, '_');
    return nk.includes(q) || z.toLowerCase().includes(q);
  }).map(placeChoice);
  const placeValues = new Set(places.map((p) => p.value));
  const zones = allTimeZones()
    .filter((z) => z.toLowerCase().includes(q) && !placeValues.has(z))
    .map((z) => ({ name: z, value: z }));
  return [...places, ...zones].slice(0, 25);
}

async function handleAutocomplete(interaction, ctx) {
  const root = interaction.data.options ?? [];
  const command = interaction.data.name;
  // Only /calendar has subcommands; every other command has its options at the top level.
  const inner = command === 'calendar' ? root[0]?.options ?? [] : root;
  const focused = inner.find((o) => o.focused);
  let choices = [];
  if (focused?.name === 'timezone') {
    choices = suggestZones(focused.value);
  } else if (focused?.name === 'team' && ctx.guildId && ctx.userId) {
    // "(no guests)" is only a sensible answer where a team is optional.
    const optionalTeam = ['new-meeting', 'update-meeting', 'add-update-preset'].includes(command);
    choices = await suggestTeams(ctx, focused.value, { includeNone: optionalTeam });
  } else if (focused?.name === 'name' && ctx.guildId) {
    let names;
    if (command === 'add-update-preset' || command === 'delete-preset') {
      names = await searchPresetNames(ctx.db, ctx.guildId, focused.value);
    } else if (command === 'new-meeting') {
      // Saved presets first, then names of past meetings (without repeating a name).
      const presets = await searchPresetNames(ctx.db, ctx.guildId, focused.value);
      const taken = new Set(presets.map((n) => nameKey(n)));
      const past = (await searchPastMeetingNames(ctx.db, ctx.guildId, focused.value)).filter((n) => !taken.has(nameKey(n)));
      names = [...presets, ...past].slice(0, 25);
    } else {
      names = await searchMeetingNames(ctx.db, ctx.guildId, focused.value);
    }
    choices = names.map((n) => ({ name: n.slice(0, 100), value: n }));
  }
  return { type: ResponseType.AUTOCOMPLETE, data: { choices } };
}

// ---------- entry point ----------

/**
 * `bridge` (Google Calendar) is null when the bot has no BRIDGE_SECRET: the calendar feature is then off.
 * `defer` runs a promise after the response is sent (ctx.waitUntil in the Worker).
 * `extraHosts` is for the smoke test only; production never sets it.
 */
export async function handleInteraction(interaction, { db, discord, bridge = null, defer = null, extraHosts = [], nowSec }) {
  if (interaction.type === InteractionType.PING) return { type: ResponseType.PONG };

  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  const ctx = { db, discord, bridge, defer, extraHosts, nowSec, interaction, userId, guildId: interaction.guild_id };

  if (interaction.type === InteractionType.AUTOCOMPLETE) return handleAutocomplete(interaction, ctx);
  if (interaction.type !== InteractionType.APPLICATION_COMMAND) return fail('I can only handle slash commands.');
  if (!ctx.guildId || !userId) return fail('Please use this command inside a server.');

  const { name, options } = interaction.data;
  const o = optionMap(options);
  switch (name) {
    case 'new-meeting':
      return cmdCreate(ctx, o);
    case 'update-meeting':
      return cmdUpdate(ctx, o);
    case 'cancel-meeting':
      return cmdCancel(ctx, o);
    case 'upcoming-meetings':
      return cmdList(ctx);
    case 'add-update-preset':
      return cmdPresetSave(ctx, o);
    case 'meeting-presets':
      return cmdPresets(ctx);
    case 'delete-preset':
      return cmdPresetDelete(ctx, o);
    case 'add-team':
      return cmdGuests(ctx, 'add', o);
    case 'remove-team-member':
      return cmdGuests(ctx, 'remove', o);
    case 'show-teams':
      return cmdGuests(ctx, 'list', o);
    case 'delete-team':
      return cmdGuests(ctx, 'delete-team', o);
    case 'calendar':
      return cmdCalendar(ctx, options?.[0]?.name, optionMap(options?.[0]?.options));
    case 'set-timezone':
      return cmdSetTimezone(ctx, o);
  }
  return fail("I don't know that command.");
}
