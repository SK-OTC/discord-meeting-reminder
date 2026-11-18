// /calendar and the guest-team command handlers (/add-team, /remove-team-member, /show-teams, /delete-team), plus the helpers other commands use for Google Calendar
// (event ids, private follow-up details, resolving which guest team a meeting invites).
//
// Rules that hold everywhere in this file:
//  - Every reply is private (ephemeral): email addresses and account names are never posted in a channel.
//  - Every failure says what went wrong and why.
import { ResponseType, MessageFlags } from './discord.js';
import { validateScriptUrl } from './bridge.js';
import {
  addGuests,
  countSyncedMeetings,
  createTeam,
  deleteCalendarAccount,
  deleteTeam,
  flagMeetingsOwnerDisconnected,
  getCalendarAccount,
  getTeam,
  listGuests,
  listTeams,
  markTeamMeetingsDirty,
  nameKey,
  normalizeName,
  removeGuests,
  saveCalendarAccount,
} from './store.js';
import { canManageOwner, fail, hasManagePerms, reply } from './replies.js';

export const FOLLOWUP_TTL_SEC = 14 * 60; // Discord allows 15 minutes; stay safely inside it
const MAX_TEAM_NAME = 50;
export const MAX_GUESTS_PER_TEAM = 100;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/; // the same rule Code.gs applies
const NO_GUESTS = new Set(['none', '(no guests)', 'no guests']);
const private_ = (text) => reply(text, { ephemeral: true, allowedMentions: { parse: [] } });

/** Random Google event id: 'v' + 24 characters from 0-9a-v (the only characters Google accepts). */
export function newEventId() {
  const alphabet = '0123456789abcdefghijklmnopqrstuv'; // 32 characters, so a byte % 32 is uniform
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return 'v' + Array.from(bytes, (b) => alphabet[b % 32]).join('');
}

/** What the sync step needs to send this person a private message later (valid ~15 minutes). */
export function followupFrom(ctx) {
  const { interaction, nowSec } = ctx;
  return interaction.application_id && interaction.token
    ? { appId: interaction.application_id, token: interaction.token, expires: nowSec + FOLLOWUP_TTL_SEC }
    : null;
}

export const isNoGuests = (raw) => NO_GUESTS.has(normalizeName(raw ?? '').toLowerCase());

/**
 * Which team a command invites. Returns { ok: true, key, name } (key null = nobody) or { ok: false, message }.
 *  - raw given: "none" / "(no guests)" = nobody, otherwise a team the caller owns (any team with Manage Server).
 *  - raw not given: the caller's only team; nobody if they own none; an error if they own several.
 */
export async function resolveTeam(ctx, raw) {
  const { db, guildId, userId, interaction } = ctx;
  if (raw !== undefined) {
    if (isNoGuests(raw)) return { ok: true, key: null, name: null };
    const team = await getTeam(db, guildId, raw);
    if (!team) {
      const mine = await listTeams(db, guildId, { ownerId: hasManagePerms(interaction) ? null : userId });
      const names = mine.map((t) => t.name).join(', ');
      return {
        ok: false,
        message: `I can't find a guest team called **${normalizeName(raw)}**. ${
          names ? `Your teams: ${names}.` : 'You have no teams yet; create one with `/add-team`.'
        } Use \`team:none\` to invite nobody.`,
      };
    }
    if (!canManageOwner(interaction, team.owner_id, userId)) {
      return { ok: false, message: `The team **${team.name}** belongs to someone else. You can only invite teams you own.` };
    }
    return { ok: true, key: team.team_key, name: team.name };
  }
  const owned = await listTeams(db, guildId, { ownerId: userId });
  if (owned.length === 0) return { ok: true, key: null, name: null };
  if (owned.length === 1) return { ok: true, key: owned[0].team_key, name: owned[0].name };
  return {
    ok: false,
    message: `You own several guest teams (${owned.map((t) => t.name).join(', ')}). Pick one with \`team\`, or \`team:none\` to invite nobody.`,
  };
}

/** Autocomplete choices for a `team` option: the caller's teams (all teams with Manage Server). */
export async function suggestTeams(ctx, query, { includeNone }) {
  const teams = await listTeams(ctx.db, ctx.guildId, {
    ownerId: hasManagePerms(ctx.interaction) ? null : ctx.userId,
    query,
  });
  const choices = teams.map((t) => ({ name: t.name.slice(0, 100), value: t.name }));
  const q = String(query ?? '').trim().toLowerCase();
  if (includeNone && (!q || 'none'.includes(q) || '(no guests)'.includes(q))) {
    choices.unshift({ name: '(no guests)', value: 'none' });
  }
  return choices.slice(0, 25);
}

// ---------- /calendar ----------

export const NOT_ENABLED =
  'Google Calendar sync is not enabled on this bot yet: the admin has not set the BRIDGE_SECRET secret. Ask your server admin.';

const CONNECT_HELP =
  'See the setup steps in GOOGLE_CALENDAR.md (Part A): the deployment must be "Execute as: Me" with "Who has access: Anyone", and BOT_SECRET in your script properties must match the bot\'s BRIDGE_SECRET.';

export async function cmdCalendar(ctx, sub, o) {
  const { db, discord, bridge, userId, nowSec, interaction } = ctx;
  if (!bridge) return fail(NOT_ENABLED);

  if (sub === 'connect') {
    const check = validateScriptUrl(o.url ?? '', { extraHosts: ctx.extraHosts ?? [] });
    if (!check.ok) return fail(`Could not connect: ${check.error}`);

    // Apps Script can be slow, so the real work happens after we answer Discord.
    const run = async () => {
      const res = await bridge.call(check.url, { action: 'ping' });
      if (!res.ok) return `Could not connect: ${res.error}\n${CONNECT_HELP}`;
      const account = res.account ?? null;
      await saveCalendarAccount(db, userId, check.url, account, nowSec);
      return (
        `Connected as ${account ?? 'your Google account (the script did not report an address)'}. ` +
        'Meetings you schedule from now on are added to this Google Calendar. Set up who to invite with `/add-team`.'
      );
    };

    const { application_id: appId, token } = interaction;
    if (!ctx.defer || !appId || !token) return private_(await run().catch((e) => `Could not connect: unexpected error: ${e?.message ?? e}`));
    ctx.defer(
      (async () => {
        let content;
        try {
          content = await run();
        } catch (e) {
          console.error('calendar connect failed:', e?.stack ?? e);
          content = `Could not connect: unexpected error: ${e?.message ?? e}`;
        }
        const res = await discord.editOriginal(appId, token, { content });
        if (!res.ok) console.error(`calendar connect: could not edit the reply: ${res.error}`);
      })(),
    );
    return { type: ResponseType.DEFERRED, data: { flags: MessageFlags.EPHEMERAL } };
  }

  if (sub === 'disconnect') {
    const account = await getCalendarAccount(db, userId);
    if (!account) return private_('Your Google Calendar is not connected, so there is nothing to disconnect.');
    await deleteCalendarAccount(db, userId);
    const affected = await flagMeetingsOwnerDisconnected(db, userId);
    return private_(
      `Disconnected${account.account_email ? ` ${account.account_email}` : ''}. ` +
        (affected
          ? `${affected === 1 ? '1 upcoming meeting keeps its Google event' : `${affected} upcoming meetings keep their Google events`} but will no longer sync; ` +
            '`/upcoming-meetings` marks them. Reconnect with `/calendar connect`; you can then change a meeting to sync it again.'
          : 'None of your upcoming meetings were synced, so nothing else changed.'),
    );
  }

  if (sub === 'status') {
    const account = await getCalendarAccount(db, userId);
    if (!account) return private_('Your Google Calendar is not connected. Run `/calendar connect url:<your Apps Script URL>`.');
    const { synced, failed } = await countSyncedMeetings(db, userId);
    return private_(
      `Connected as ${account.account_email ?? 'an unknown account'} (since <t:${account.connected_at}:D>).\n` +
        `Upcoming synced meetings: ${synced}${failed ? `, ${failed} with a sync problem (see \`/upcoming-meetings\`)` : ''}.`,
    );
  }

  return fail("I don't know that /calendar command.");
}

// ---------- guest teams ----------

function parseEmails(raw) {
  const valid = [];
  const invalid = [];
  for (const part of String(raw ?? '').split(/[\s,;]+/).filter(Boolean)) {
    const email = part.toLowerCase();
    if (email.length <= 254 && EMAIL_RE.test(email)) {
      if (!valid.includes(email)) valid.push(email);
    } else {
      invalid.push(part.slice(0, 60));
    }
  }
  return { valid, invalid };
}

const invalidNote = (invalid) => (invalid.length ? `\nNot valid email addresses, skipped: ${invalid.join(', ')}` : '');

function checkTeamName(raw) {
  const name = normalizeName(raw ?? '');
  if (!name) return { ok: false, message: 'Give the team a name.' };
  if (name.length > MAX_TEAM_NAME) return { ok: false, message: `The team name is too long (max ${MAX_TEAM_NAME} characters).` };
  if (isNoGuests(name)) return { ok: false, message: `"${name}" is reserved (it means "invite nobody"). Pick another team name.` };
  return { ok: true, name };
}

const updatedNote = (n) =>
  n ? `\n${n} upcoming meeting${n === 1 ? '' : 's'} will be updated on Google Calendar shortly.` : '';

export async function cmdGuests(ctx, sub, o) {
  const { db, guildId, userId, nowSec, interaction } = ctx;

  if (sub === 'list' && o.team === undefined) {
    const teams = await listTeams(db, guildId, { ownerId: hasManagePerms(interaction) ? null : userId });
    if (!teams.length) return private_('You do not own any guest teams yet. Create one with `/add-team team:Design emails:someone@example.com`.');
    const lines = teams.map((t) => `- **${t.name}**: ${t.guest_count} ${t.guest_count === 1 ? 'guest' : 'guests'}${t.owner_id === userId ? '' : ` (owner <@${t.owner_id}>)`}`);
    return private_(`**Guest teams**\n${lines.join('\n')}`);
  }

  const nameCheck = checkTeamName(o.team);
  if (!nameCheck.ok) return fail(nameCheck.message);
  const teamName = nameCheck.name;
  let team = await getTeam(db, guildId, teamName);

  if (sub === 'add') {
    const { valid, invalid } = parseEmails(o.emails);
    if (!valid.length) {
      return fail(`I couldn't find a valid email address in what you typed.${invalidNote(invalid)}\nExample: \`/add-team team:Design emails:a@example.com, b@example.com\``);
    }
    if (team && !canManageOwner(interaction, team.owner_id, userId)) {
      return fail(`The team **${team.name}** belongs to someone else, so you can't add to it. Pick another team name.`);
    }
    // All or nothing against the limit: work out what is new BEFORE changing anything.
    const have = team ? new Set(await listGuests(db, guildId, team.team_key)) : new Set();
    const already = valid.filter((e) => have.has(e));
    const fresh = valid.filter((e) => !have.has(e));
    const spaces = MAX_GUESTS_PER_TEAM - have.size;
    if (fresh.length > spaces) {
      return fail(
        `A team holds at most ${MAX_GUESTS_PER_TEAM} addresses, and nothing was added. ` +
          `${team ? `**${team.name}** has` : 'A new team has'} ${spaces} ${spaces === 1 ? 'space' : 'spaces'} left, ` +
          `but ${fresh.length} of the addresses you sent are new. Send fewer, or remove some people first with \`/remove-team-member\`.` +
          invalidNote(invalid),
      );
    }

    const created = !team;
    if (created) {
      await createTeam(db, guildId, teamName, userId, nowSec);
      team = await getTeam(db, guildId, teamName);
    }
    await addGuests(db, guildId, team.team_key, fresh);
    // One update for the team's upcoming meetings, however many people were added.
    const affected = fresh.length && !created ? await markTeamMeetingsDirty(db, guildId, team.team_key, nowSec) : 0;
    const total = have.size + fresh.length;
    const lines = [`${created ? 'Created the team' : 'Updated the team'} **${team.name}**: added ${fresh.length}, ${total} in total.`];
    if (already.length) lines.push(`Already on the team: ${already.join(', ')}`);
    return private_(lines.join('\n') + invalidNote(invalid) + updatedNote(affected));
  }

  if (!team) return fail(`I can't find a guest team called **${teamName}**. Try \`/show-teams\`.`);
  if (!canManageOwner(interaction, team.owner_id, userId)) {
    return fail(`The team **${team.name}** belongs to someone else, so you can't ${sub === 'list' ? 'see its addresses' : sub === 'remove' ? 'remove people from it' : 'delete it'}.`);
  }

  if (sub === 'remove') {
    const { valid, invalid } = parseEmails(o.emails);
    if (!valid.length) return fail(`I couldn't find a valid email address in what you typed.${invalidNote(invalid)}`);
    const have = new Set(await listGuests(db, guildId, team.team_key));
    const removed = valid.filter((e) => have.has(e));
    const missing = valid.filter((e) => !have.has(e));
    await removeGuests(db, guildId, team.team_key, removed);
    const affected = removed.length ? await markTeamMeetingsDirty(db, guildId, team.team_key, nowSec) : 0;
    const lines = [`Removed ${removed.length} from **${team.name}**, ${have.size - removed.length} left.`];
    if (missing.length) lines.push(`Not on the team, nothing to remove: ${missing.join(', ')}`);
    return private_(lines.join('\n') + invalidNote(invalid) + updatedNote(affected));
  }

  if (sub === 'list') {
    const emails = await listGuests(db, guildId, team.team_key);
    return private_(`**${team.name}** (${emails.length} ${emails.length === 1 ? 'guest' : 'guests'})\n${emails.length ? emails.join('\n') : 'No addresses yet. Add some with `/add-team`.'}`);
  }

  if (sub === 'delete-team') {
    const affected = await markTeamMeetingsDirty(db, guildId, team.team_key, nowSec, { clearTeam: true });
    await deleteTeam(db, guildId, team.team_key);
    return private_(
      `Deleted the team **${team.name}** and its addresses.` +
        (affected ? `\n${affected} upcoming meeting${affected === 1 ? '' : 's'} will be updated on Google Calendar shortly, without guests.` : '') +
        ' Presets that used this team will schedule without guests.',
    );
  }

  return fail("I don't know that team command.");
}
