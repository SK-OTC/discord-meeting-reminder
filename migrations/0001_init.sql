-- Per-user timezone (Discord does not expose a user's timezone to bots).
CREATE TABLE users (
  user_id    TEXT PRIMARY KEY,
  timezone   TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per meeting. start_at is the NEXT occurrence, in unix seconds (UTC).
CREATE TABLE meetings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id         TEXT NOT NULL,
  name             TEXT NOT NULL,
  name_key         TEXT NOT NULL,            -- lowercased, whitespace-collapsed name
  channel_id       TEXT NOT NULL,            -- where reminders are posted
  location         TEXT,
  timezone         TEXT NOT NULL,            -- IANA zone; weekly repeats keep this wall-clock time
  start_at         INTEGER NOT NULL,
  reminder_minutes INTEGER NOT NULL DEFAULT 15,
  repeat           TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'weekly')),
  role_id          TEXT,
  created_by       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'done')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- Names are unique per server among active meetings only.
CREATE UNIQUE INDEX meetings_guild_name_active
  ON meetings (guild_id, name_key) WHERE status = 'active';

-- Scheduled messages, polled once a minute by the cron trigger.
CREATE TABLE jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id  INTEGER NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('reminder', 'start')),
  fire_at     INTEGER NOT NULL,              -- intended send time (unix seconds)
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  run_after   INTEGER NOT NULL,              -- earliest time to try (moves forward on retry)
  lease_until INTEGER,                       -- set while 'sending'; expired lease = crashed worker
  last_error  TEXT,
  UNIQUE (meeting_id, kind, fire_at)
);

CREATE INDEX jobs_due ON jobs (status, run_after);
