// Registers the slash commands with Discord. Run from your own machine:
//   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run register
// Set DISCORD_GUILD_ID to register for a single server (updates appear instantly).
// It replaces the full command list, so re-run it whenever src/definitions.js changes.
import { COMMANDS } from '../src/definitions.js';

const { DISCORD_APPLICATION_ID: appId, DISCORD_BOT_TOKEN: token, DISCORD_GUILD_ID: guildId } = process.env;
if (!appId || !token) {
  console.error('Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN (see .dev.vars.example).');
  process.exit(1);
}

const base = process.env.DISCORD_API_BASE ?? 'https://discord.com/api/v10';
const url = guildId
  ? `${base}/applications/${appId}/guilds/${guildId}/commands`
  : `${base}/applications/${appId}/commands`;

const res = await fetch(url, {
  method: 'PUT',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(COMMANDS),
});

if (!res.ok) {
  console.error(`Registration failed: HTTP ${res.status}\n${await res.text()}`);
  process.exit(1);
}
const registered = await res.json();
console.log(`Registered ${registered.length} commands ${guildId ? `for server ${guildId}` : 'globally'}:`);
for (const c of registered) console.log(`  /${c.name}`);
