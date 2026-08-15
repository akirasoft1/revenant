// commands/slash/ChatCommand.js
// Slash command for chatting with the bot using channel voice personality

const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const BaseSlashCommand = require('../base/BaseSlashCommand');
const TextUtils = require('../../utils/textUtils');
const logger = require('../../logger');

class ChatSlashCommand extends BaseSlashCommand {
  constructor(chatService) {
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

    // Send response with images if any, handling long messages
    if (imageAttachments.length > 0) {
      await this.sendLongResponse(interaction, response);
      await interaction.followUp({ files: imageAttachments });
    } else {
      await this.sendLongResponse(interaction, response);
    }
  }
}

module.exports = ChatSlashCommand;
