-- Google Calendar sync (through a per-user Apps Script bridge) and guest teams.

-- ---------- meetings ----------
ALTER TABLE meetings ADD COLUMN duration_min INTEGER NOT NULL DEFAULT 60;
ALTER TABLE meetings ADD COLUMN guest_team_key TEXT;               -- empty/NULL = no guests
ALTER TABLE meetings ADD COLUMN gcal_owner_id TEXT;                -- Discord user whose Google calendar holds the event; NULL = not synced
ALTER TABLE meetings ADD COLUMN gcal_event_id TEXT;                -- created and saved BEFORE the first Google call (makes retries safe)
ALTER TABLE meetings ADD COLUMN gcal_created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meetings ADD COLUMN gcal_dirty INTEGER NOT NULL DEFAULT 0;      -- 1 = the calendar needs syncing
ALTER TABLE meetings ADD COLUMN gcal_version INTEGER NOT NULL DEFAULT 0;    -- bumped every time the meeting is marked dirty
ALTER TABLE meetings ADD COLUMN gcal_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meetings ADD COLUMN gcal_run_after INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meetings ADD COLUMN gcal_error TEXT;
ALTER TABLE meetings ADD COLUMN meet_link TEXT;
-- Interaction details so a private follow-up can be sent later (valid 15 minutes). Cleared once used.
ALTER TABLE meetings ADD COLUMN gcal_followup_app_id TEXT;
ALTER TABLE meetings ADD COLUMN gcal_followup_token TEXT;
ALTER TABLE meetings ADD COLUMN gcal_followup_expires INTEGER;

CREATE INDEX meetings_gcal_pending ON meetings (gcal_run_after) WHERE gcal_dirty = 1;

-- ---------- presets ----------
ALTER TABLE presets ADD COLUMN duration_min INTEGER;               -- NULL = default (60)
ALTER TABLE presets ADD COLUMN guest_team_key TEXT;                -- empty/NULL = no guests (not a foreign key on purpose)
ALTER TABLE presets ADD COLUMN calendar INTEGER NOT NULL DEFAULT 1;

-- ---------- accounts and teams ----------
CREATE TABLE calendar_accounts (
  user_id       TEXT PRIMARY KEY,
  script_url    TEXT NOT NULL,
  account_email TEXT,
  connected_at  INTEGER NOT NULL
);

CREATE TABLE guest_teams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL,
  team_key   TEXT NOT NULL,              -- lowercased, whitespace-collapsed name
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (guild_id, team_key)
);

CREATE TABLE guests (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  team_key TEXT NOT NULL,
  email    TEXT NOT NULL,                -- lowercased
  UNIQUE (guild_id, team_key, email)
);
