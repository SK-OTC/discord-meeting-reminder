# Meeting-time bot

Discord slash commands that post meeting times (as Discord timestamps, so everyone sees their own timezone) and send automatic reminders. Runs on **Cloudflare Workers + D1**: no server, no credit card.

```
/set-timezone  timezone:America/Chicago          (once per person)

/new-meeting  name:Team Sync  date:2026-11-20  time:3pm
                      [channel] [location] [reminder:2h] [timezone] [repeat:weekly] [ping:@role ping_2 ... ping_5]
/update-meeting  name:Team Sync  [new_name] [date] [time] [channel] [location] [reminder] [timezone] [repeat] [ping]
/cancel-meeting  name:Team Sync
/upcoming-meetings

/add-update-preset  name:Team Sync  [time:3pm] [channel] [location] [reminder] [timezone] [repeat] [ping]
/meeting-presets
/delete-preset name:Team Sync
```

**Presets and reuse.** Save a meeting's settings once with `/add-update-preset`, then run `/new-meeting name:Team Sync date:2026-11-27`: when `name` matches a saved preset, its settings (time, location, reminder, pings, duration, team, channel, repeat) are reused, and anything you add (a different `time`, `location`, `reminder`, and so on) applies to that one meeting only. If there is no preset with that name, `create` reuses the latest past meeting with that name, at the same local time. The private confirmation always says when saved settings were used; add `reuse:false` to ignore them and start from scratch. A brand-new name needs a `time`, as before. Running `/add-update-preset` on an existing name changes only the options you pass (`time:none` or `location:none` clears them).

## What it does

| Moment | Message |
|---|---|
| Command run | Announcement with the time in each reader's timezone, plus how it was interpreted (for example "Entered as Fri, Nov 20, 3:00 PM (America/Chicago)") |
| Before the start (default 15 min; `2h`, `1h30min`, `15min`; a plain number means hours; `0` = off) | "⏰ Team Sync starts in 15 minutes", pinging the optional role |
| Start time | "🚀 Team Sync is starting now!" |

Behaviour worth knowing:

- **Timezones.** Discord never tells a bot a user's timezone, so each person runs `/set-timezone` once, or passes `timezone` on a command. Daylight-saving edge cases are handled: a time that does not exist (spring forward) is rejected, and one that happens twice (fall back) uses the first occurrence and says so.
- **Date input.** `YYYY-MM-DD`, `today`, or `tomorrow`. Time: `15:00` or `3pm`.
- **Update.** Only the options you pass change. `time` alone keeps the date, `date` alone keeps the time. `location: none` clears the location. Reminders already sent are never re-sent after an edit. A `timezone`-only update keeps the same instant and changes how weekly repeats are anchored.
- **Weekly repeat** keeps the same local wall-clock time across daylight-saving changes.
- **Permissions.** Anyone can create. Only the creator, or someone with Manage Server or Administrator, can update or cancel.
- **Accuracy.** Cloudflare cron runs once a minute, so messages go out within about a minute of their time.
- **Outages.** A message that is more than 10 minutes late is **skipped**, not sent, so nobody gets a misleading "starts in 5 minutes" an hour after the fact. Failed sends retry with backoff (about 1, 2 and 4 minutes); permanent errors such as missing channel permissions show up as a ⚠️ line in `/upcoming-meetings`. A worker that crashes mid-send is retried after 2 minutes, so the worst case is a duplicate message, never a silent miss.

## Google Calendar and Meet (optional)

When a meeting organizer schedules a meeting, the bot can also create a Google Calendar event **in that meeting organizer's own Google calendar**, with a Google Meet link, and Google emails the invite to a guest team. `update` changes the same event and `cancel` deletes it (guests get Google's update and cancellation emails), together with the Discord meeting and its reminders.

```
/calendar connect url:<your Apps Script web app URL>      (once per meeting organizer; /calendar disconnect, /calendar status)
/add-team team:Design emails:a@gmail.com, b@gmail.com   (commas, semicolons or spaces; creates the team, you own it)
/remove-team-member, /show-teams, /delete-team
/new-meeting ... [duration:90min] [team:Design | team:none] [calendar:false] [meet:false] [reuse:false]
```

- **Setup.** Each meeting organizer deploys their own copy of `Code.gs` as an Apps Script web app (steps in `GOOGLE_CALENDAR.md`, Part A). The admin runs `npx wrangler secret put BRIDGE_SECRET` and shares the value with each meeting organizer, who stores it as the script property `BOT_SECRET`. Without `BRIDGE_SECRET` the feature is off and nothing else changes.
- **Who sees what.** The channel only gets the Meet link. Account names, guest counts, email addresses and every error go to the organizer privately. Teams are private to their owner (and Manage Server).
- **Google Meet** is on by default. Add `meet:false` for an event with no Meet link (guests are still invited). Google can't add or remove a Meet link once the event exists, so the choice can't be changed later on a meeting that is already on the calendar.
- **Duration** uses the same format as `reminder` (a plain number is hours, `min` for minutes): 15 minutes to 2 hours, default 1 hour.
- **When something fails.** The bot retries (about 1, 2 and 4 minutes), then tells the organizer the exact reason privately and posts only "Calendar sync failed for <name>. The organizer has been told." in the channel. The reason also shows in `/upcoming-meetings`.
- **Presets** also remember duration, team and the calendar on/off choice. A team is only used if the person scheduling owns it (or has Manage Server); otherwise the meeting is scheduled without guests and the private reply says so. The event always goes on the calendar of whoever runs `schedule`.
- **Limits.** `repeat` cannot be changed on a meeting that is on a Google Calendar (cancel and recreate). To remove the Google event, cancel the meeting. Changes made in Google are not seen by the bot.

## Setup (about 15 minutes, no card)

You need Node 20+ and a free Cloudflare account (email signup).

1. **Discord application.** Go to https://discord.com/developers/applications and create an application. Copy the **Application ID** and **Public Key** (General Information). On the **Bot** tab, create the bot and copy its **token**.
2. **Install.**
   ```bash
   npm install
   npx wrangler login
   ```
3. **Database.**
   ```bash
   npx wrangler d1 create meeting-bot
   ```
   Paste the printed `database_id` into `wrangler.toml`, then:
   ```bash
   npm run db:migrate:remote
   ```
4. **Secrets.**
   ```bash
   npx wrangler secret put DISCORD_PUBLIC_KEY
   npx wrangler secret put DISCORD_BOT_TOKEN
   ```
5. **Deploy.**
   ```bash
   npm run deploy
   ```
   Note the `https://meeting-time-bot.<your-subdomain>.workers.dev` URL it prints.
6. **Connect Discord to the Worker.** In the Developer Portal, General Information, set **Interactions Endpoint URL** to that URL and save. Discord sends a signed test request, and saving only succeeds if the Worker verifies it.
7. **Register the commands** (from your own machine):
   ```bash
   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run register
   ```
   Add `DISCORD_GUILD_ID=<server id>` to register for one server only, which appears instantly while testing.
8. **Invite the bot** (replace `APP_ID`):
   `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot%20applications.commands&permissions=3072`
   (permissions 3072 = View Channel + Send Messages). To ping roles that are not "mentionable", also grant **Mention @everyone, @here and All Roles**.
9. In your server, run `/set-timezone`, then `/new-meeting`.

The bot must be able to **view and send in the channel where reminders go**. If it cannot, the failure appears in `/upcoming-meetings`.

## Develop and test

```bash
npm test          # 49 unit tests against a real SQLite engine (no network)
npm run smoke     # end-to-end on the real Workers runtime with a local D1 and a mock Discord API
npm run dev       # local worker (copy .dev.vars.example to .dev.vars first)
```

`npm run smoke` signs requests like Discord does, runs the commands, fast-forwards a meeting, fires the cron trigger, and checks the message reaches the mock Discord API.

## Layout

```
src/index.js       Worker entry: interactions endpoint + cron trigger
src/commands.js    slash command handlers (create/update/cancel/list/set-timezone, autocomplete)
src/scheduler.js   reminder delivery: claim, send, retry, skip stale, roll weekly meetings forward
src/store.js       all SQL (D1)
src/time.js        timezone/DST-safe parsing and conversion
src/discord.js     signature verification + REST client
src/messages.js    message text
src/definitions.js command definitions (used by scripts/register-commands.mjs)
migrations/        D1 schema
```

## Limits and notes

- Cloudflare's free-plan limits (requests per day, queries per invocation, cron triggers) change; check the current numbers on Cloudflare's pricing and limits pages. The scheduler handles 5 messages per run and the rest on the next minute, which is plenty for a team.
- This bot only does scheduling and reminders. Call recording is a separate piece.
