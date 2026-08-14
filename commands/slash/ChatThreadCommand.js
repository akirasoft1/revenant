// commands/slash/ChatThreadCommand.js
// Slash command for starting thread-based chat conversations

const { SlashCommandBuilder, ChannelType, AttachmentBuilder } = require('discord.js');
const BaseSlashCommand = require('../base/BaseSlashCommand');
const TextUtils = require('../../utils/textUtils');
const logger = require('../../logger');

class ChatThreadSlashCommand extends BaseSlashCommand {
  constructor(chatService) {
    super({
      data: new SlashCommandBuilder()
        .setName('chatthread')
        .setDescription('Start a dedicated thread for an extended conversation')
        .addStringOption(option =>
          option.setName('message')
            .setDescription('Your opening message')
            .setRequired(true)
            .setMaxLength(2000)),
      deferReply: true,
      cooldown: 10 // Slightly higher cooldown to prevent thread spam
    });

    this.chatService = chatService;
    // Track active chat threads: threadId -> { personalityId, userId, channelId }
    this.activeThreads = new Map();
  }

  async execute(interaction, context) {
    const personalityId = 'channel-voice';
    const userMessage = interaction.options.getString('message');
    const channelId = interaction.channel.id;
    const guildId = interaction.guild?.id || null;

    this.logExecution(interaction, `creating thread`);

    // Create thread for conversation
    let thread;
    try {
      const threadName = `💬 Chat: ${userMessage.substring(0, 90)}`;
      thread = await interaction.channel.threads.create({
        name: threadName.substring(0, 100), // Thread names max 100 chars
        autoArchiveDuration: 60, // Archive after 1 hour of inactivity
        type: ChannelType.PrivateThread,
        reason: `Chat thread started by ${interaction.user.tag}`
      });

      // Add the user to the thread
      await thread.members.add(interaction.user.id);
    } catch (error) {
      logger.error(`Failed to create chat thread: ${error.message}`);
      await this.sendError(interaction, 'Failed to create conversation thread. I may lack permission to create threads in this channel.');
      return;
    }

    // Store thread mapping
    this.activeThreads.set(thread.id, {
      personalityId,
      userId: interaction.user.id,
      channelId,
      guildId,
      createdAt: new Date()
    });

    // Reply to the original interaction
    await this.sendReply(interaction, {
      content: `Started a conversation in ${thread}!\n\nJust type your messages in the thread - no commands needed.`,
      ephemeral: false
    });

    // Get the initial response
    const result = await this.chatService.chat(
      personalityId,
      userMessage,
      interaction.user,
      thread.id, // Use thread ID as channel ID for conversation tracking
      guildId
    );

    if (!result.success) {
      // Handle specific error reasons with helpful messages (without "Error: " prefix)
      if (result.reason === 'expired' || result.reason === 'message_limit' || result.reason === 'token_limit') {
        await thread.send(result.error);
      } else {
        await thread.send(`Error: ${result.error}`);
      }
      return;
    }

    // Send the response in the thread, announcing a degraded reply the same
    // way mention chat does (this surface used to ignore result.fallback).
    const response = TextUtils.wrapUrls(
      `${TextUtils.fallbackNotice(result.fallback)}${result.message}`
    );

    // Split long messages
    const chunks = this.splitMessage(response, 2000);
    for (const chunk of chunks) {
      await thread.send(chunk);
    }

    // Send any generated images
    await this._sendGeneratedImages(thread, result.images);
  }

  /**
   * Convert base64 images to Discord attachments and send them
   * @param {TextChannel|ThreadChannel} channel - Channel to send images to
   * @param {Array<{id: string, base64: string}>} images - Generated images
   * @private
   */
  async _sendGeneratedImages(channel, images) {
    if (!images || images.length === 0) {
      return;
    }

    const imageAttachments = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      try {
        const buffer = Buffer.from(img.base64, 'base64');
        const attachment = new AttachmentBuilder(buffer, {
          name: `generated_image_${i + 1}.png`
        });
        imageAttachments.push(attachment);
        logger.info(`Prepared image attachment for thread: generated_image_${i + 1}.png`);
      } catch (error) {
        logger.error(`Failed to create image attachment: ${error.message}`);
      }
    }

    if (imageAttachments.length > 0) {
      await channel.send({ files: imageAttachments });
    }
  }

  /**
   * Check if a thread is an active chat thread
   * @param {string} threadId
   * @returns {Object|null} Thread info or null
   */
  getThreadInfo(threadId) {
    return this.activeThreads.get(threadId) || null;
  }

  /**
   * Handle a message in a chat thread (called from bot.js messageCreate)
   * @param {Message} message
   * @returns {boolean} True if handled
   */
  async handleThreadMessage(message) {
    const threadInfo = this.activeThreads.get(message.channel.id);
    if (!threadInfo) {
      return false;
    }

    // Don't respond to bot messages
    if (message.author.bot) {
      return false;
    }

    // Show typing indicator
    await message.channel.sendTyping();

    const result = await this.chatService.chat(
      threadInfo.personalityId,
      message.content,
      message.author,
      message.channel.id,
      threadInfo.guildId
    );

    if (!result.success) {
      // Handle specific error reasons with helpful messages (without "Error: " prefix)
      const errorContent = (result.reason === 'expired' || result.reason === 'message_limit' || result.reason === 'token_limit')
        ? result.error
        : `Error: ${result.error}`;
      await message.reply({
        content: errorContent,
        allowedMentions: { repliedUser: false }
      });
      return true;
    }

    const response = TextUtils.wrapUrls(
      `${TextUtils.fallbackNotice(result.fallback)}${result.message}`
    );

    // Split long messages
    const chunks = this.splitMessage(response, 2000);
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        await message.reply({
          content: chunks[i],
          allowedMentions: { repliedUser: false }
        });
      } else {
        await message.channel.send(chunks[i]);
      }
    }

    // Send any generated images
    await this._sendGeneratedImages(message.channel, result.images);

    return true;
  }

  /**
   * Clean up old thread mappings (called periodically)
   * Removes threads older than 24 hours
   */
  cleanupOldThreads() {
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);

    for (const [threadId, info] of this.activeThreads) {
      if (info.createdAt.getTime() < oneDayAgo) {
        this.activeThreads.delete(threadId);
      }
    }
  }
}

module.exports = ChatThreadSlashCommand;
