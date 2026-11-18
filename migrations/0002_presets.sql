-- Saved meeting settings that can be scheduled again with /meeting-time schedule.
CREATE TABLE presets (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id         TEXT NOT NULL,
  name             TEXT NOT NULL,
  name_key         TEXT NOT NULL,            -- lowercased, whitespace-collapsed name
  channel_id       TEXT,                     -- NULL = the channel the command is run in
  location         TEXT,
  timezone         TEXT,                     -- NULL = the person's saved timezone
  default_time     TEXT,                     -- local "HH:MM", NULL = time must be given each time
  reminder_minutes INTEGER NOT NULL DEFAULT 15,
  repeat           TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'weekly')),
  role_id          TEXT,
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (guild_id, name_key)
);
