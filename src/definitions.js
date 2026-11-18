// Slash command definitions, shared by the registration script and the tests.
// Discord requires every required option to come before the optional ones.

const T = { SUB_COMMAND: 1, STRING: 3, INTEGER: 4, BOOLEAN: 5, CHANNEL: 7, ROLE: 8 };
const CHANNEL_TYPES = [0, 2, 5]; // text, voice (its text chat), announcement

const opt = (type, name, description, extra = {}) => ({ type, name, description, ...extra });

const scheduleOptions = {
  channel: opt(T.CHANNEL, 'channel', 'Where reminders are posted (default: this channel)', {
    channel_types: CHANNEL_TYPES,
  }),
  location: opt(T.STRING, 'location', 'Voice channel, link, or place (on update: "none" clears it)', {
    max_length: 200,
  }),
  reminder: opt(T.STRING, 'reminder', 'How long before to remind: 2h, 1h30min, 15min (plain number = hours, 0 = none)', {
    max_length: 20,
  }),
  timezone: opt(T.STRING, 'timezone', 'Timezone for the date/time you typed (default: your /set-timezone)', {
    autocomplete: true,
  }),
  duration: opt(T.STRING, 'duration', 'How long the meeting is: 1h, 90min, 1h30min (15 min to 2 h, default 1 h)', {
    max_length: 20,
  }),
  team: opt(T.STRING, 'team', 'Guest team to invite to the Google Calendar event, or "none"', { autocomplete: true }),
  calendar: opt(T.BOOLEAN, 'calendar', 'Add this meeting to your Google Calendar (default: yes, if connected)'),
  meet: opt(T.BOOLEAN, 'meet', 'Create a Google Meet link for the calendar event (default: yes)'),
  repeat: opt(T.STRING, 'repeat', 'Repeat weekly at the same local time?', {
    choices: [
      { name: 'No (one-off)', value: 'none' },
      { name: 'Weekly', value: 'weekly' },
    ],
  }),
  ping: opt(T.ROLE, 'ping', 'Role to mention in the reminder and start messages'),
};

// Discord's role picker takes one role per option, so extra roles get their own options.
// Passing any of these replaces the whole set of roles to ping.
export const PING_OPTION_NAMES = ['ping', 'ping_2', 'ping_3', 'ping_4', 'ping_5'];
const pingOptions = PING_OPTION_NAMES.map((name, i) =>
  i === 0 ? scheduleOptions.ping : opt(T.ROLE, name, 'Another role to mention in the reminder and start messages'),
);

// Every command is top-level, so each shows up on its own in Discord's slash menu.
// Only /calendar still has subcommands (connect, disconnect, status).
const guestEmails = opt(T.STRING, 'emails', 'One or many email addresses, separated by commas, semicolons or spaces', {
  required: true,
  max_length: 6000,
});
const teamRequired = opt(T.STRING, 'team', 'Team name', { required: true, max_length: 50, autocomplete: true });

export const COMMANDS = [
  {
    name: 'new-meeting',
    description: 'Schedule a meeting, or schedule a saved preset / past meeting again',
    contexts: [0], // servers only
    options: [
      opt(T.STRING, 'name', 'Meeting name (pick a saved preset or past meeting to reuse its settings)', {
        required: true,
        max_length: 80,
        autocomplete: true,
      }),
      opt(T.STRING, 'date', 'YYYY-MM-DD, "today", or "tomorrow"', { required: true }),
      opt(T.STRING, 'time', 'Start time, e.g. 15:00 or 3pm (default: the saved time of a reused preset)'),
      scheduleOptions.channel,
      scheduleOptions.location,
      scheduleOptions.reminder,
      scheduleOptions.timezone,
      scheduleOptions.repeat,
      ...pingOptions,
      scheduleOptions.duration,
      scheduleOptions.team,
      scheduleOptions.calendar,
      scheduleOptions.meet,
      opt(T.BOOLEAN, 'reuse', 'Reuse the settings of a saved preset or past meeting with this name (default: yes)'),
    ],
  },
  {
    name: 'update-meeting',
    description: 'Change an existing meeting',
    contexts: [0],
    options: [
      opt(T.STRING, 'name', 'Which meeting', { required: true, autocomplete: true }),
      opt(T.STRING, 'new_name', 'Rename it', { max_length: 80 }),
      opt(T.STRING, 'date', 'New date: YYYY-MM-DD, "today", or "tomorrow"'),
      opt(T.STRING, 'time', 'New time, e.g. 15:00 or 3pm'),
      scheduleOptions.channel,
      scheduleOptions.location,
      scheduleOptions.reminder,
      scheduleOptions.timezone,
      scheduleOptions.repeat,
      ...pingOptions,
      scheduleOptions.duration,
      scheduleOptions.team,
      scheduleOptions.calendar,
      scheduleOptions.meet,
    ],
  },
  {
    name: 'cancel-meeting',
    description: 'Cancel a meeting and its reminders',
    contexts: [0],
    options: [opt(T.STRING, 'name', 'Which meeting', { required: true, autocomplete: true })],
  },
  {
    name: 'upcoming-meetings',
    description: 'Show upcoming meetings in this server',
    contexts: [0],
  },
  {
    name: 'add-update-preset',
    description: 'Save meeting settings to reuse later (or edit a saved preset)',
    contexts: [0],
    options: [
      opt(T.STRING, 'name', 'Preset name', { required: true, max_length: 80, autocomplete: true }),
      opt(T.STRING, 'time', 'Usual start time, e.g. 15:00 or 3pm ("none" clears it)'),
      scheduleOptions.channel,
      scheduleOptions.location,
      scheduleOptions.reminder,
      scheduleOptions.timezone,
      scheduleOptions.repeat,
      ...pingOptions,
      scheduleOptions.duration,
      scheduleOptions.team,
      scheduleOptions.calendar,
      scheduleOptions.meet,
    ],
  },
  {
    name: 'meeting-presets',
    description: 'Show the saved meeting presets in this server',
    contexts: [0],
  },
  {
    name: 'delete-preset',
    description: 'Delete a saved preset',
    contexts: [0],
    options: [opt(T.STRING, 'name', 'Which preset', { required: true, autocomplete: true })],
  },
  {
    name: 'add-team',
    description: 'Add email addresses to a guest team (creates the team the first time)',
    contexts: [0],
    options: [teamRequired, guestEmails],
  },
  {
    name: 'remove-team-member',
    description: 'Remove email addresses from a guest team',
    contexts: [0],
    options: [teamRequired, guestEmails],
  },
  {
    name: 'show-teams',
    description: 'Show your guest teams, or the addresses on one team',
    contexts: [0],
    options: [opt(T.STRING, 'team', 'Team name (leave out to list your teams)', { max_length: 50, autocomplete: true })],
  },
  {
    name: 'delete-team',
    description: 'Delete a guest team and its addresses',
    contexts: [0],
    options: [teamRequired],
  },
  {
    name: 'calendar',
    description: 'Connect your Google Calendar so meetings you schedule are added to it',
    contexts: [0],
    options: [
      opt(T.SUB_COMMAND, 'connect', 'Connect your Google Calendar bridge', {
        options: [opt(T.STRING, 'url', 'Your Apps Script web app URL (ends in /exec)', { required: true, max_length: 300 })],
      }),
      opt(T.SUB_COMMAND, 'disconnect', 'Disconnect your Google Calendar'),
      opt(T.SUB_COMMAND, 'status', 'Show whether your Google Calendar is connected'),
    ],
  },
  {
    name: 'set-timezone',
    description: 'Set your timezone for meeting times you type',
    contexts: [0],
    options: [opt(T.STRING, 'timezone', 'e.g. America/Chicago, Europe/London, Asia/Karachi', { required: true, autocomplete: true })],
  },
];
