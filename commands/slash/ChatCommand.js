// commands/slash/ChatCommand.js
// Slash command for chatting with the bot using channel voice personality

const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const BaseSlashCommand = require('../base/BaseSlashCommand');
const TextUtils = require('../../utils/textUtils');
const logger = require('../../logger');
const { recordUserMessage, recordBotReply } = require('../../utils/channelMessageRecorder');

class ChatSlashCommand extends BaseSlashCommand {
  /**
   * @param {Object} chatService
   * @param {Object} [recording] - channel_messages recording deps. /chat is a
   *   slash interaction, not a channel message, so bot.js's messageCreate
   *   recorder never sees it; without these the exchange is invisible to every
   *   later turn's history (ChatService.buildTurnContext reads ONLY
   *   channel_messages).
   * @param {Object|null} [recording.mongoService]
   * @param {Object|null} [recording.speakerNames] - services/SpeakerNames resolver
   * @param {Function} [recording.getBotUser] - () => client.user (lazy: set after login)
   */
  constructor(chatService, { mongoService = null, speakerNames = null, getBotUser = () => null } = {}) {
    super({
      data: new SlashCommandBuilder()
        .setName('chat')
        .setDescription('Chat with the bot')
        .addStringOption(option =>
          option.setName('message')
            .setDescription('Your message')
            .setRequired(true)
            .setMaxLength(2000))
        .addAttachmentOption(option =>
          option.setName('image')
            .setDescription('Optional image to include in the conversation')
            .setRequired(false)),
      deferReply: true,
      cooldown: 0
    });

    this.chatService = chatService;
    this.mongoService = mongoService;
    this.speakerNames = speakerNames;
    this.getBotUser = getBotUser;
  }

  async execute(interaction, context) {
    const personalityId = 'channel-voice';
    const userMessage = interaction.options.getString('message');
    const attachment = interaction.options.getAttachment('image');
    const channelId = interaction.channel.id;
    const guildId = interaction.guild?.id || null;

    this.logExecution(interaction, `message="${userMessage.substring(0, 50)}"`);

    // Get image URL if attachment provided
    let imageUrl = null;
    if (attachment) {
      const validImageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
      if (validImageTypes.includes(attachment.contentType)) {
        imageUrl = attachment.url;
      } else {
        await this.sendError(interaction, 'Please attach a valid image file (PNG, JPEG, GIF, or WebP).');
        return;
      }
    }

    // Record the prompt as a user turn BEFORE chat, exactly like the
    // messageCreate recorder does for @mentions, so ordering in
    // channel_messages is prompt -> reply. Awaited (unlike messageCreate's
    // fire-and-forget) so the row has landed by the time buildTurnContext
    // reads history: its _dropDuplicatedCurrentTurn then removes this trailing
    // row deterministically, so the current turn reaches the model once (as
    // userMessage), not twice. Never throws.
    await recordUserMessage({
      mongoService: this.mongoService,
      speakerNames: this.speakerNames,
      messageId: interaction.id,
      channelId,
      guildId,
      user: interaction.user,
      member: interaction.member || null,
      content: userMessage,
    });

    // Call chat service with channel-voice personality
    const result = await this.chatService.chat(
      personalityId,
      userMessage,
      interaction.user,
      channelId,
      guildId,
      imageUrl
    );

    if (!result.success) {
      // Handle specific error reasons with helpful messages (without "Error: " prefix)
      if (result.reason === 'expired' || result.reason === 'message_limit' || result.reason === 'token_limit') {
        await this.sendReply(interaction, {
          content: result.error
        });
        return;
      }
      await this.sendError(interaction, result.error);
      return;
    }

    // A degraded reply says so here too. This surface used to render
    // `result.message` and ignore `result.fallback` entirely, so a /chat user
    // got a substitute model (or a reply with no memory and no channel
    // personality) with no notice at all — while the same degradation was
    // announced in mention chat.
    const response = TextUtils.wrapUrls(
      `${TextUtils.fallbackNotice(result.fallback)}**Prompt:** ${userMessage}\n\n${result.message}`
    );

    // Convert any generated images to Discord attachments
    const imageAttachments = [];
    if (result.images && result.images.length > 0) {
      for (let i = 0; i < result.images.length; i++) {
        const img = result.images[i];
        try {
          const buffer = Buffer.from(img.base64, 'base64');
          const attachment = new AttachmentBuilder(buffer, {
            name: `generated_image_${i + 1}.png`
          });
          imageAttachments.push(attachment);
          logger.info(`Prepared image attachment: generated_image_${i + 1}.png`);
        } catch (error) {
          logger.error(`Failed to create image attachment: ${error.message}`);
        }
      }
    }

    // Send response with images if any, handling long messages. Keep the last
    // text message sent so the reply can be persisted against it (same rule as
    // the mention path's `lastReply`).
    const lastReply = await this.sendLongResponse(interaction, response);
    if (imageAttachments.length > 0) {
      await interaction.followUp({ files: imageAttachments });
    }

    // Persist the reply as an assistant turn — the RAW model output, not the
    // Discord payload (no "**Prompt:**" header, fallback banner or <url>
    // wrapping) — with any sandbox executionIds for reaction reveal. Never throws.
    await recordBotReply({
      mongoService: this.mongoService,
      botUser: this.getBotUser(),
      reply: lastReply,
      content: result.message,
      channelId,
      guildId,
      executionIds: result.executionSummary?.executionIds || [],
    });
  }
}

module.exports = ChatSlashCommand;
