// Text for every message the bot posts. Times use Discord timestamps so each reader sees
// them in their own timezone.
import { discordTimestamp as ts, formatLocal } from './time.js';

// A meeting or preset can ping several roles; role_id holds their ids separated by commas.
export const roleIds = (m) => (m.role_id ? String(m.role_id).split(',').filter(Boolean) : []);
export const formatRoles = (m) => roleIds(m).map((id) => `<@&${id}>`).join(' ');
const roleMention = (m) => (roleIds(m).length ? `${formatRoles(m)} ` : '');
const whereLine = (m) => (m.location ? `\nWhere: ${m.location}` : '');

/** 90 -> "1 h 30 min", 120 -> "2 h", 15 -> "15 min". */
export function formatReminder(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
}
const reminderLine = (minutes) =>
  minutes > 0 ? `Reminder: ${formatReminder(minutes)} before` : 'Reminder: none';

/** Mentions are only allowed for the meeting's roles, and only where we pass ping: true. */
export function allowedMentionsFor(meeting, { ping }) {
  const roles = roleIds(meeting);
  return ping && roles.length ? { parse: [], roles } : { parse: [] };
}

/** Private confirmation shown only to the person who created or updated the meeting. */
export function confirmationText(m, { header = 'Meeting scheduled', extraLines = [] } = {}) {
  const lines = [
    `${header}: **${m.name}** (only you can see this)`,
    `When: ${ts(m.start_at, 'F')} (${ts(m.start_at, 'R')})`,
    `Entered as: ${formatLocal(m.start_at * 1000, m.timezone)} (${m.timezone})`,
  ];
  if (m.location) lines.push(`Where: ${m.location}`);
  lines.push(`Duration: ${formatReminder(m.duration_min ?? 60)}`);
  lines.push(reminderLine(m.reminder_minutes));
  if (m.repeat === 'weekly') lines.push('Repeats: weekly');
  if (m.role_id) lines.push(`Pings: ${formatRoles(m)}`);
  lines.push(`Channel: <#${m.channel_id}>`);
  lines.push(...extraLines);
  return lines.join('\n');
}

/** Public post for the meeting's channel: name, time, location, and any warning. */
export function publicNoticeText(m, { header = 'New meeting', warning = null } = {}) {
  let text = `**${header}: ${m.name}**\nWhen: ${ts(m.start_at, 'F')} (${ts(m.start_at, 'R')})` + whereLine(m);
  if (warning) text += `\nHeads up: ${warning}`;
  return text;
}

/** Private description of a saved preset. */
export function presetText(p, { header = 'Preset', teamName = null } = {}) {
  const lines = [`${header}: **${p.name}**`];
  lines.push(p.default_time ? `Usual time: ${p.default_time}` : 'Usual time: not set (give a time when scheduling)');
  if (p.location) lines.push(`Where: ${p.location}`);
  lines.push(reminderLine(p.reminder_minutes));
  if (p.repeat === 'weekly') lines.push('Repeats: weekly');
  if (p.role_id) lines.push(`Pings: ${formatRoles(p)}`);
  lines.push(`Channel: ${p.channel_id ? `<#${p.channel_id}>` : 'wherever you schedule it'}`);
  lines.push(`Duration: ${p.duration_min ? formatReminder(p.duration_min) : '1 h (default)'}`);
  lines.push(`Guest team: ${p.guest_team_key ? (teamName ?? p.guest_team_key) : 'none'}`);
  lines.push(`Google Calendar: ${p.calendar === 0 ? 'off' : 'on (if the person scheduling it is connected)'}`);
  lines.push(`Google Meet link: ${p.gcal_meet === 0 ? 'no' : 'yes'}`);
  lines.push(`Timezone: ${p.timezone ?? "the scheduler's saved timezone"}`);
  return lines.join('\n');
}

export function reminderText(m) {
  return `${roleMention(m)}Heads up: **${m.name}** kicks off ${ts(m.start_at, 'R')} (${ts(m.start_at, 't')})` + whereLine(m);
}

export function startText(m) {
  return `${roleMention(m)}**${m.name}** is starting now. See you there!` + whereLine(m);
}

export function cancelText(m) {
  return `Cancelled: **${m.name}** (was ${ts(m.start_at, 'F')}).`;
}

// ---------- Google Calendar ----------

/** The only calendar text posted in a channel: no emails, no account names. */
export function meetLinkText(m, link) {
  return `Google Meet link for ${m.name}: ${link}`;
}

/** Private note to the organizer after the event was created. */
export function calendarCreatedNote(m, { account, teamName, guestCount, meetRequested = true, meetLink, linkPosted, linkPostError }) {
  const lines = [`Google Calendar: **${m.name}** was added to the calendar of ${account ?? 'your Google account'}.`];
  if (teamName) {
    lines.push(`Invited: team ${teamName} (${guestCount} ${guestCount === 1 ? 'guest' : 'guests'}). Google emails the invites.`);
  } else {
    lines.push('Invited: nobody (no guest team on this meeting).');
  }
  if (!meetRequested) {
    lines.push('No Google Meet link was created, as you asked.');
  } else if (!meetLink) {
    lines.push('Warning: Google did not return a Meet link for this event.');
  } else if (linkPosted) {
    lines.push('The Meet link was posted in the meeting channel.');
  } else {
    lines.push(`Warning: I could not post the Meet link in <#${m.channel_id}> (${linkPostError}). Here it is: ${meetLink}`);
  }
  return lines.join('\n');
}

const ACTION_FAILED = {
  create: 'add it to Google Calendar',
  update: 'update it on Google Calendar',
  cancel: 'remove it from Google Calendar',
};

/** Private note to the organizer when syncing gave up. Always says why. */
export function calendarFailureNote(m, { action, error, attempts }) {
  const tries = attempts > 1 ? ` after ${attempts} attempts` : '';
  return (
    `Google Calendar: I could not ${ACTION_FAILED[action] ?? 'sync'} **${m.name}**${tries}.\n` +
    `Reason: ${error}\n` +
    (m.status === 'cancelled'
      ? 'The Discord meeting is cancelled, but its Google event may still exist. Delete it in Google Calendar if so.'
      : 'The Discord meeting and its reminders are not affected. Fix the problem, then change the meeting (for example update its location) to try again.')
  );
}

/** Short public notice (no reason, no emails). */
export function calendarFailurePublic(m, { organizerTold }) {
  return organizerTold
    ? `Calendar sync failed for ${m.name}. The organizer has been told.`
    : `Calendar sync failed for ${m.name}. The organizer can see the reason in /upcoming-meetings.`;
}
