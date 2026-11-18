// Database access (Cloudflare D1 / SQLite). Every function takes the D1 binding as `db`.

export const normalizeName = (s) => String(s).trim().replace(/\s+/g, ' ');
export const nameKey = (s) => normalizeName(s).toLowerCase();

const MEETING_COLUMNS = new Set([
  'name',
  'name_key',
  'channel_id',
  'location',
  'timezone',
  'start_at',
  'reminder_minutes',
  'repeat',
  'role_id',
  'status',
  'duration_min',
  'guest_team_key',
  'gcal_owner_id',
  'gcal_event_id',
  'gcal_created',
  'gcal_dirty',
  'gcal_attempts',
  'gcal_run_after',
  'gcal_error',
  'meet_link',
  'gcal_followup_app_id',
  'gcal_followup_token',
  'gcal_followup_expires',
  'gcal_meet',
]);

// ---------- users ----------

export async function getUserTimezone(db, userId) {
  const row = await db.prepare('SELECT timezone FROM users WHERE user_id = ?').bind(userId).first();
  return row?.timezone ?? null;
}

export async function setUserTimezone(db, userId, timezone, nowSec) {
  await db
    .prepare(
      `INSERT INTO users (user_id, timezone, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET timezone = excluded.timezone, updated_at = excluded.updated_at`,
    )
    .bind(userId, timezone, nowSec)
    .run();
}

// ---------- meetings ----------

export async function getMeeting(db, id) {
  return (await db.prepare('SELECT * FROM meetings WHERE id = ?').bind(id).first()) ?? null;
}

export async function findActiveMeetingByName(db, guildId, name) {
  return (
    (await db
      .prepare("SELECT * FROM meetings WHERE guild_id = ? AND name_key = ? AND status = 'active'")
      .bind(guildId, nameKey(name))
      .first()) ?? null
  );
}

export async function listUpcomingMeetings(db, guildId, limit = 15) {
  const { results } = await db
    .prepare("SELECT * FROM meetings WHERE guild_id = ? AND status = 'active' ORDER BY start_at LIMIT ?")
    .bind(guildId, limit)
    .all();
  return results;
}

export async function searchMeetingNames(db, guildId, query, limit = 25) {
  const key = nameKey(query ?? '');
  const { results } = await db
    .prepare(
      `SELECT name FROM meetings
       WHERE guild_id = ? AND status = 'active' AND (? = '' OR instr(name_key, ?) > 0)
       ORDER BY start_at LIMIT ?`,
    )
    .bind(guildId, key, key, limit)
    .all();
  return results.map((r) => r.name);
}

export async function insertMeeting(db, m, nowSec) {
  const res = await db
    .prepare(
      `INSERT INTO meetings
         (guild_id, name, name_key, channel_id, location, timezone, start_at, reminder_minutes,
          repeat, role_id, created_by, status, created_at, updated_at,
          duration_min, guest_team_key, gcal_owner_id, gcal_event_id, gcal_dirty, gcal_version,
          gcal_followup_app_id, gcal_followup_token, gcal_followup_expires, gcal_meet)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      m.guild_id,
      m.name,
      m.name_key,
      m.channel_id,
      m.location ?? null,
      m.timezone,
      m.start_at,
      m.reminder_minutes,
      m.repeat,
      m.role_id ?? null,
      m.created_by,
      nowSec,
      nowSec,
      m.duration_min ?? 60,
      m.guest_team_key || null,
      m.gcal_owner_id ?? null,
      m.gcal_event_id ?? null,
      m.gcal_dirty ? 1 : 0,
      m.gcal_dirty ? 1 : 0,
      m.gcal_followup_app_id ?? null,
      m.gcal_followup_token ?? null,
      m.gcal_followup_expires ?? null,
      m.gcal_meet === 0 || m.gcal_meet === false ? 0 : 1,
    )
    .run();
  return res.meta.last_row_id;
}

export async function updateMeeting(db, id, changes, nowSec) {
  const cols = Object.keys(changes).filter((c) => MEETING_COLUMNS.has(c));
  if (!cols.length) return;
  const sql = `UPDATE meetings SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
  await db
    .prepare(sql)
    .bind(...cols.map((c) => changes[c] ?? null), nowSec, id)
    .run();
}

export async function cancelMeeting(db, id, nowSec) {
  await db.batch([
    db.prepare("DELETE FROM jobs WHERE meeting_id = ? AND status = 'pending'").bind(id),
    // A meeting with a Google event is queued so the sync step deletes the event (guests get Google's
    // cancellation email). Meetings that never had one are not queued.
    db
      .prepare(
        `UPDATE meetings SET status = 'cancelled', updated_at = ?,
           gcal_dirty = CASE WHEN gcal_event_id IS NOT NULL AND gcal_owner_id IS NOT NULL THEN 1 ELSE gcal_dirty END,
           gcal_version = gcal_version + 1, gcal_attempts = 0, gcal_run_after = 0, gcal_error = NULL
         WHERE id = ?`,
      )
      .bind(nowSec, id),
  ]);
}

/** Meeting ids (from the given list) that have a failed message in the last 7 days. */
export async function meetingsWithFailedJobs(db, ids, nowSec) {
  if (!ids.length) return new Map();
  const marks = ids.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT meeting_id, kind, last_error FROM jobs
       WHERE status = 'failed' AND fire_at > ? AND meeting_id IN (${marks})
       ORDER BY fire_at`,
    )
    .bind(nowSec - 7 * 86400, ...ids)
    .all();
  const out = new Map();
  for (const r of results) out.set(r.meeting_id, r);
  return out;
}

/** The most recent meeting with this name in any state, used as a template when no preset exists. */
export async function findLatestMeetingByName(db, guildId, name) {
  return (
    (await db
      .prepare('SELECT * FROM meetings WHERE guild_id = ? AND name_key = ? ORDER BY id DESC LIMIT 1')
      .bind(guildId, nameKey(name))
      .first()) ?? null
  );
}

/** Distinct names of every meeting ever scheduled here (any state), newest first. */
export async function searchPastMeetingNames(db, guildId, query, limit = 25) {
  const key = nameKey(query ?? '');
  const { results } = await db
    .prepare(
      `SELECT name, MAX(id) AS last_id FROM meetings
       WHERE guild_id = ? AND (? = '' OR instr(name_key, ?) > 0)
       GROUP BY name_key ORDER BY last_id DESC LIMIT ?`,
    )
    .bind(guildId, key, key, limit)
    .all();
  return results.map((r) => r.name);
}

// ---------- presets ----------

export async function getPreset(db, guildId, name) {
  return (
    (await db.prepare('SELECT * FROM presets WHERE guild_id = ? AND name_key = ?').bind(guildId, nameKey(name)).first()) ??
    null
  );
}

export async function listPresets(db, guildId, limit = 25) {
  const { results } = await db
    .prepare('SELECT * FROM presets WHERE guild_id = ? ORDER BY name_key LIMIT ?')
    .bind(guildId, limit)
    .all();
  return results;
}

export async function searchPresetNames(db, guildId, query, limit = 25) {
  const key = nameKey(query ?? '');
  const { results } = await db
    .prepare(
      `SELECT name FROM presets
       WHERE guild_id = ? AND (? = '' OR instr(name_key, ?) > 0)
       ORDER BY name_key LIMIT ?`,
    )
    .bind(guildId, key, key, limit)
    .all();
  return results.map((r) => r.name);
}

/** Insert or fully replace a preset (callers merge with the existing row first). */
export async function savePreset(db, p, nowSec) {
  await db
    .prepare(
      `INSERT INTO presets
         (guild_id, name, name_key, channel_id, location, timezone, default_time, reminder_minutes,
          repeat, role_id, created_by, created_at, updated_at, duration_min, guest_team_key, calendar, gcal_meet)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, name_key) DO UPDATE SET
         name = excluded.name, channel_id = excluded.channel_id, location = excluded.location,
         timezone = excluded.timezone, default_time = excluded.default_time,
         reminder_minutes = excluded.reminder_minutes, repeat = excluded.repeat,
         role_id = excluded.role_id, updated_at = excluded.updated_at,
         duration_min = excluded.duration_min, guest_team_key = excluded.guest_team_key,
         calendar = excluded.calendar, gcal_meet = excluded.gcal_meet`,
    )
    .bind(
      p.guild_id,
      p.name,
      p.name_key,
      p.channel_id ?? null,
      p.location ?? null,
      p.timezone ?? null,
      p.default_time ?? null,
      p.reminder_minutes,
      p.repeat,
      p.role_id ?? null,
      p.created_by,
      nowSec,
      nowSec,
      p.duration_min ?? null,
      p.guest_team_key || null,
      p.calendar === 0 || p.calendar === false ? 0 : 1,
      p.gcal_meet === 0 || p.gcal_meet === false ? 0 : 1,
    )
    .run();
}

export async function deletePreset(db, id) {
  await db.prepare('DELETE FROM presets WHERE id = ?').bind(id).run();
}

// ---------- jobs ----------

/**
 * Replaces a meeting's pending jobs with the right ones for its current times.
 * Already-sent jobs are kept, and UNIQUE(meeting_id, kind, fire_at) stops them being re-created,
 * so editing a meeting never re-sends a reminder that already went out.
 */
export async function replaceJobs(db, meeting, nowSec) {
  const stmts = [db.prepare("DELETE FROM jobs WHERE meeting_id = ? AND status = 'pending'").bind(meeting.id)];
  const insert = (kind, fireAt) =>
    db
      .prepare('INSERT OR IGNORE INTO jobs (meeting_id, kind, fire_at, run_after) VALUES (?, ?, ?, ?)')
      .bind(meeting.id, kind, fireAt, fireAt);

  const reminderAt = meeting.start_at - meeting.reminder_minutes * 60;
  let reminderScheduled = false;
  if (meeting.reminder_minutes > 0 && reminderAt > nowSec) {
    stmts.push(insert('reminder', reminderAt));
    reminderScheduled = true;
  }
  stmts.push(insert('start', meeting.start_at));
  await db.batch(stmts);
  return { reminderScheduled };
}

/**
 * Atomically claims up to `limit` due jobs. A job is due if it is pending and run_after has
 * passed, or it was claimed by a worker that died (lease expired). One UPDATE ... RETURNING
 * statement, so two overlapping cron runs can never claim the same job.
 */
export async function claimDueJobs(db, nowSec, limit, leaseSec = 120) {
  const { results } = await db
    .prepare(
      `UPDATE jobs SET status = 'sending', attempts = attempts + 1, lease_until = ?
       WHERE id IN (
         SELECT id FROM jobs
         WHERE (status = 'pending' AND run_after <= ?) OR (status = 'sending' AND lease_until <= ?)
         ORDER BY fire_at LIMIT ?
       )
       RETURNING id, meeting_id, kind, fire_at, attempts, last_error`,
    )
    .bind(nowSec + leaseSec, nowSec, nowSec, limit)
    .all();
  return results;
}

export async function finishJob(db, jobId, status, error = null) {
  await db
    .prepare('UPDATE jobs SET status = ?, last_error = ?, lease_until = NULL WHERE id = ?')
    .bind(status, error, jobId)
    .run();
}

export async function retryJobLater(db, jobId, runAfter, error) {
  await db
    .prepare("UPDATE jobs SET status = 'pending', run_after = ?, last_error = ?, lease_until = NULL WHERE id = ?")
    .bind(runAfter, error, jobId)
    .run();
}

/** Housekeeping: drop finished meetings and old job rows after 30 days. */
export async function pruneOld(db, nowSec) {
  const cutoff = nowSec - 30 * 86400;
  await db.batch([
    db.prepare("DELETE FROM jobs WHERE status IN ('sent', 'skipped', 'failed') AND fire_at < ?").bind(cutoff),
    db
      .prepare("DELETE FROM meetings WHERE status IN ('cancelled', 'done') AND updated_at < ? AND gcal_dirty = 0")
      .bind(cutoff),
    db
      .prepare(
        `UPDATE meetings SET gcal_followup_app_id = NULL, gcal_followup_token = NULL, gcal_followup_expires = NULL
         WHERE gcal_followup_token IS NOT NULL AND gcal_followup_expires <= ?`,
      )
      .bind(nowSec),
  ]);
}


// ---------- Google Calendar: accounts ----------

export async function getCalendarAccount(db, userId) {
  return (await db.prepare('SELECT * FROM calendar_accounts WHERE user_id = ?').bind(userId).first()) ?? null;
}

export async function saveCalendarAccount(db, userId, scriptUrl, accountEmail, nowSec) {
  await db
    .prepare(
      `INSERT INTO calendar_accounts (user_id, script_url, account_email, connected_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET script_url = excluded.script_url,
         account_email = excluded.account_email, connected_at = excluded.connected_at`,
    )
    .bind(userId, scriptUrl, accountEmail ?? null, nowSec)
    .run();
}

export async function deleteCalendarAccount(db, userId) {
  await db.prepare('DELETE FROM calendar_accounts WHERE user_id = ?').bind(userId).run();
}

/**
 * Disconnecting stops syncing: the owner's upcoming synced meetings keep their Google events but are
 * flagged so /upcoming-meetings shows why they no longer sync. Returns how many were affected.
 */
export async function flagMeetingsOwnerDisconnected(db, userId) {
  const res = await db
    .prepare(
      `UPDATE meetings SET gcal_dirty = 0, gcal_error = 'calendar disconnected by its owner'
       WHERE gcal_owner_id = ? AND gcal_event_id IS NOT NULL AND status = 'active'`,
    )
    .bind(userId)
    .run();
  return res.meta.changes ?? 0;
}

export async function countSyncedMeetings(db, userId) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS synced, SUM(CASE WHEN gcal_error IS NOT NULL THEN 1 ELSE 0 END) AS failed
       FROM meetings WHERE gcal_owner_id = ? AND gcal_event_id IS NOT NULL AND status = 'active'`,
    )
    .bind(userId)
    .first();
  return { synced: row?.synced ?? 0, failed: row?.failed ?? 0 };
}

// ---------- Google Calendar: guest teams ----------

export async function getTeam(db, guildId, name) {
  return (
    (await db.prepare('SELECT * FROM guest_teams WHERE guild_id = ? AND team_key = ?').bind(guildId, nameKey(name)).first()) ??
    null
  );
}

/** Teams in a server, optionally only those owned by one user, optionally filtered by a name fragment. */
export async function listTeams(db, guildId, { ownerId = null, query = '', limit = 25 } = {}) {
  const key = nameKey(query ?? '');
  const { results } = await db
    .prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM guests g WHERE g.guild_id = t.guild_id AND g.team_key = t.team_key) AS guest_count
       FROM guest_teams t
       WHERE t.guild_id = ? AND (? IS NULL OR t.owner_id = ?) AND (? = '' OR instr(t.team_key, ?) > 0)
       ORDER BY t.team_key LIMIT ?`,
    )
    .bind(guildId, ownerId, ownerId, key, key, limit)
    .all();
  return results;
}

export async function createTeam(db, guildId, name, ownerId, nowSec) {
  await db
    .prepare('INSERT INTO guest_teams (guild_id, team_key, name, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(guildId, nameKey(name), normalizeName(name), ownerId, nowSec)
    .run();
}

export async function listGuests(db, guildId, teamKey) {
  const { results } = await db
    .prepare('SELECT email FROM guests WHERE guild_id = ? AND team_key = ? ORDER BY email')
    .bind(guildId, teamKey)
    .all();
  return results.map((r) => r.email);
}

/** Adds many addresses in ONE statement (json_each keeps it to a single bound parameter). */
export async function addGuests(db, guildId, teamKey, emails) {
  if (!emails.length) return;
  await db
    .prepare('INSERT OR IGNORE INTO guests (guild_id, team_key, email) SELECT ?, ?, value FROM json_each(?)')
    .bind(guildId, teamKey, JSON.stringify(emails))
    .run();
}

/** Removes many addresses in ONE statement. */
export async function removeGuests(db, guildId, teamKey, emails) {
  if (!emails.length) return;
  await db
    .prepare('DELETE FROM guests WHERE guild_id = ? AND team_key = ? AND email IN (SELECT value FROM json_each(?))')
    .bind(guildId, teamKey, JSON.stringify(emails))
    .run();
}

export async function deleteTeam(db, guildId, teamKey) {
  await db.batch([
    db.prepare('DELETE FROM guests WHERE guild_id = ? AND team_key = ?').bind(guildId, teamKey),
    db.prepare('DELETE FROM guest_teams WHERE guild_id = ? AND team_key = ?').bind(guildId, teamKey),
  ]);
}

// ---------- Google Calendar: sync queue ----------

/**
 * Marks a meeting as needing a calendar sync. The version goes up every time, so a sync that was
 * already in flight cannot clear a change made while it was running (see finishSync).
 * `followup` ({ appId, token, expires }) lets the sync send the organizer a private message later.
 */
export async function markMeetingDirty(db, id, followup = null) {
  await db
    .prepare(
      `UPDATE meetings SET gcal_dirty = 1, gcal_version = gcal_version + 1, gcal_attempts = 0,
         gcal_run_after = 0, gcal_error = NULL,
         gcal_followup_app_id = COALESCE(?, gcal_followup_app_id),
         gcal_followup_token = COALESCE(?, gcal_followup_token),
         gcal_followup_expires = COALESCE(?, gcal_followup_expires)
       WHERE id = ?`,
    )
    .bind(followup?.appId ?? null, followup?.token ?? null, followup?.expires ?? null, id)
    .run();
}

/**
 * Marks a team's upcoming active synced meetings dirty (team membership changed or the team was deleted).
 * With clearTeam the meetings also forget the team. Returns how many meetings were affected.
 */
export async function markTeamMeetingsDirty(db, guildId, teamKey, nowSec, { clearTeam = false } = {}) {
  const res = await db
    .prepare(
      `UPDATE meetings SET gcal_dirty = 1, gcal_version = gcal_version + 1, gcal_attempts = 0,
         gcal_run_after = 0, gcal_error = NULL,
         guest_team_key = CASE WHEN ? = 1 THEN NULL ELSE guest_team_key END
       WHERE guild_id = ? AND guest_team_key = ? AND status = 'active' AND start_at > ?
         AND gcal_event_id IS NOT NULL AND gcal_owner_id IS NOT NULL`,
    )
    .bind(clearTeam ? 1 : 0, guildId, teamKey, nowSec)
    .run();
  return res.meta.changes ?? 0;
}

/** Claims up to `limit` dirty meetings that are due, leasing them so overlapping cron runs skip them. */
export async function claimDirtyMeetings(db, nowSec, limit, leaseSec = 120) {
  const { results } = await db
    .prepare(
      `UPDATE meetings SET gcal_run_after = ?
       WHERE id IN (
         SELECT id FROM meetings WHERE gcal_dirty = 1 AND gcal_run_after <= ? ORDER BY gcal_run_after, id LIMIT ?
       )
       RETURNING *`,
    )
    .bind(nowSec + leaseSec, nowSec, limit)
    .all();
  return results;
}

/**
 * Records the end of a sync. The dirty flag is only cleared if the version is unchanged since the
 * claim, so an update made while the call to Google was in flight is synced on the next run.
 * `error` null clears any previous error. `created` / `meetLink` are only written when given.
 */
export async function finishSync(db, id, version, { error = null, created = null, meetLink = null } = {}) {
  await db
    .prepare(
      `UPDATE meetings SET
         gcal_dirty = CASE WHEN gcal_version = ? THEN 0 ELSE 1 END,
         gcal_attempts = 0, gcal_run_after = 0, gcal_error = ?,
         gcal_created = COALESCE(?, gcal_created),
         meet_link = COALESCE(?, meet_link)
       WHERE id = ?`,
    )
    .bind(version, error, created === null ? null : created ? 1 : 0, meetLink || null, id)
    .run();
}

/** A failed attempt that will be retried later. */
export async function retrySyncLater(db, id, runAfter, error) {
  await db
    .prepare('UPDATE meetings SET gcal_attempts = gcal_attempts + 1, gcal_run_after = ?, gcal_error = ? WHERE id = ?')
    .bind(runAfter, error, id)
    .run();
}

export async function clearFollowup(db, id) {
  await db
    .prepare(
      `UPDATE meetings SET gcal_followup_app_id = NULL, gcal_followup_token = NULL, gcal_followup_expires = NULL
       WHERE id = ?`,
    )
    .bind(id)
    .run();
}
