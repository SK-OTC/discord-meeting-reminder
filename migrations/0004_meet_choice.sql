-- Whether the Google Calendar event should get a Google Meet link (the default is yes).
ALTER TABLE meetings ADD COLUMN gcal_meet INTEGER NOT NULL DEFAULT 1;
ALTER TABLE presets ADD COLUMN gcal_meet INTEGER NOT NULL DEFAULT 1;
