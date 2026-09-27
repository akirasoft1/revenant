// commands/base/BaseSlashCommand.js
// Base class for all Discord slash commands

const logger = require('../../logger');

/**
 * Base class for slash commands providing common functionality
 * All slash commands should extend this class
 */
class BaseSlashCommand {
  /**
   * @param {Object} options - Command options
   * @param {SlashCommandBuilder} options.data - The slash command builder instance
   * @param {number} [options.cooldown=0] - Cooldown in seconds between command uses per user
   * @param {boolean} [options.adminOnly=false] - Whether command requires admin permissions
   * @param {boolean} [options.deferReply=false] - Whether to automatically defer reply
   * @param {boolean} [options.ephemeral=false] - Whether responses should be ephemeral by default
   */
  constructor(options) {
    if (!options.data) {
      throw new Error('Slash command must have a data property with SlashCommandBuilder');
    }

    this.data = options.data;
    this.cooldown = options.cooldown || 0;
    this.adminOnly = options.adminOnly || false;
    this.deferReply = options.deferReply || false;
    this.ephemeral = options.ephemeral || false;

    // Cooldown tracking: Map of `userId` -> timestamp
    this.cooldowns = new Map();
  }

  /**
   * Get the command name
   * @returns {string}
   */
  get name() {
    return this.data.name;
  }

  /**
   * Execute the slash command - must be implemented by subclasses
   * @param {CommandInteraction} interaction - The interaction object
   * @param {Object} context - Additional context (config, services, etc.)
   * @returns {Promise<void>}
   */
  async execute(interaction, context) {
    throw new Error(`Execute method must be implemented for command: ${this.name}`);
  }

  /**
   * Check if user is on cooldown
   * @param {string} userId - The user ID to check
   * @returns {number|false} - Remaining seconds or false if not on cooldown
   */
  checkCooldown(userId) {
    if (this.cooldown <= 0) return false;

    const now = Date.now();
    const cooldownEnd = this.cooldowns.get(userId);

    if (cooldownEnd && now < cooldownEnd) {
      return Math.ceil((cooldownEnd - now) / 1000);
    }

    return false;
  }

  /**
   * Set cooldown for a user
   * @param {string} userId - The user ID
   */
  setCooldown(userId) {
    if (this.cooldown > 0) {
      this.cooldowns.set(userId, Date.now() + (this.cooldown * 1000));
    }
  }

  /**
   * Defer the reply if not already deferred/replied
   * Use this for commands that take more than 3 seconds
   * @param {CommandInteraction} interaction
   * @param {boolean} [ephemeral=false] - Whether the deferred reply should be ephemeral
   */
  async deferIfNeeded(interaction, ephemeral = false) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: ephemeral || this.ephemeral });
    }
  }

  /**
   * Send a reply, handling the deferred state appropriately
   * @param {CommandInteraction} interaction
   * @param {string|Object} content - The content to send
   * @returns {Promise<Object>} The sent message as resolved by discord.js
   */
  async sendReply(interaction, content) {
    const options = typeof content === 'string' ? { content } : content;

    if (interaction.deferred) {
      return interaction.editReply(options);
    } else if (interaction.replied) {
      return interaction.followUp(options);
    } else {
      return interaction.reply(options);
    }
  }

  /**
   * Send a long response, splitting into multiple messages if needed
   * @param {CommandInteraction} interaction
   * @param {string} content - The content to send
   * @param {number} [maxLength=2000] - Maximum length per message
   * @returns {Promise<Object|undefined>} The LAST message sent (what the
   *   discord.js reply/editReply/followUp resolved to), for callers that
   *   persist the reply (e.g. /chat's channel_messages record)
   */
  async sendLongResponse(interaction, content, maxLength = 2000) {
    const chunks = this.splitMessage(content, maxLength);

    if (chunks.length === 0) {
      await this.sendReply(interaction, 'No content to display.');
      return;
    }

    // Send first chunk as reply/editReply
    let last = await this.sendReply(interaction, chunks[0]);

    // Send remaining chunks as follow-ups
    for (let i = 1; i < chunks.length; i++) {
      last = await interaction.followUp(chunks[i]);
    }
    return last;
  }

  /**
   * Split a message into chunks at sensible break points
   * @param {string} text - Text to split
   * @param {number} maxLength - Maximum length per chunk
   * @returns {string[]} Array of chunks
   */
  splitMessage(text, maxLength = 2000) {
    if (!text || text.length === 0) return [];
    if (text.length <= maxLength) return [text];

    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Find a good break point (prefer newlines, then spaces)
      let breakPoint = remaining.lastIndexOf('\n', maxLength);
      if (breakPoint === -1 || breakPoint < maxLength / 2) {
        breakPoint = remaining.lastIndexOf(' ', maxLength);
      }
      if (breakPoint === -1 || breakPoint < maxLength / 2) {
        breakPoint = maxLength;
      }

      chunks.push(remaining.substring(0, breakPoint));
      remaining = remaining.substring(breakPoint).trim();
    }

    return chunks;
  }

  /**
   * Send an error response (ephemeral by default)
   * @param {CommandInteraction} interaction
   * @param {string} message - Error message
   */
  async sendError(interaction, message) {
    const content = `Error: ${message}`;

    try {
      if (interaction.deferred) {
        await interaction.editReply({ content, ephemeral: true });
      } else if (interaction.replied) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    } catch (error) {
      logger.error(`Failed to send error response: ${error.message}`);
    }
  }

  /**
   * Check if user is a bot admin
   * @param {string} userId - The user ID
   * @param {Object} config - The bot config
   * @returns {boolean}
   */
  isAdmin(userId, config) {
    return config.discord.adminUserIds.includes(userId);
  }

  /**
   * Log command execution
   * @param {CommandInteraction} interaction
   * @param {string} [details=''] - Additional details to log
   */
  logExecution(interaction, details = '') {
    const userTag = interaction.user.tag || interaction.user.username;
    const guildName = interaction.guild?.name || 'DM';
    const channelName = interaction.channel?.name || 'unknown';

    logger.info(
      `Slash command /${this.name} executed by ${userTag} in ${guildName}#${channelName}${details ? `: ${details}` : ''}`
    );
  }
}

module.exports = BaseSlashCommand;
