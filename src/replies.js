// Small helpers shared by the command handlers.
import { MessageFlags, ResponseType } from './discord.js';

export const reply = (content, { ephemeral = false, allowedMentions = { parse: [] } } = {}) => ({
  type: ResponseType.MESSAGE,
  data: { content, flags: ephemeral ? MessageFlags.EPHEMERAL : 0, allowed_mentions: allowedMentions },
});

/** An error only the person who ran the command sees. Always say what went wrong and why. */
export const fail = (content) => reply(content, { ephemeral: true });

export const optionMap = (options = []) => Object.fromEntries(options.map((o) => [o.name, o.value]));

const PERM_ADMINISTRATOR = 0x8n;
const PERM_MANAGE_GUILD = 0x20n;

export function hasManagePerms(interaction) {
  try {
    const perms = BigInt(interaction.member?.permissions ?? '0');
    return (perms & PERM_ADMINISTRATOR) !== 0n || (perms & PERM_MANAGE_GUILD) !== 0n;
  } catch {
    return false;
  }
}

/** The owner, or someone with Manage Server / Administrator. */
export function canManageOwner(interaction, ownerId, userId) {
  return ownerId === userId || hasManagePerms(interaction);
}
