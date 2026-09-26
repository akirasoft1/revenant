// commands/slash/MusicgenCommand.js
// Slash command for AI music generation via Lyria (default lyria-3.5)

const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const BaseSlashCommand = require('../base/BaseSlashCommand');
const logger = require('../../logger');

const VALID_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB per image

class MusicgenSlashCommand extends BaseSlashCommand {
  constructor(lyriaService) {
    super({
      data: new SlashCommandBuilder()
        .setName('musicgen')
        .setDescription('Generate music with Lyria 3.5')
        .addStringOption((o) => o.setName('prompt').setDescription('What to generate').setRequired(true).setMaxLength(6000))
        .addStringOption((o) => o.setName('lyrics').setDescription('Custom lyrics. Supports [Verse] / [Chorus] / [Bridge] tags').setRequired(false).setMaxLength(6000))
        .addStringOption((o) => o.setName('negative_prompt').setDescription('Things to avoid (e.g. "no vocals", "no drums")').setRequired(false).setMaxLength(6000))
        .addAttachmentOption((o) => o.setName('image1').setDescription('Reference image 1').setRequired(false))
        .addAttachmentOption((o) => o.setName('image2').setDescription('Reference image 2').setRequired(false))
        .addAttachmentOption((o) => o.setName('image3').setDescription('Reference image 3').setRequired(false)),
      deferReply: true,
      cooldown: 60
    });

    this.lyriaService = lyriaService;
  }

  async execute(interaction) {
    if (!this.lyriaService || !this.lyriaService.isEnabled()) {
      await this.sendError(interaction, 'Music generation is not enabled on this bot.');
      return;
    }

    const prompt = interaction.options.getString('prompt');
    const lyrics = interaction.options.getString('lyrics') || undefined;
    const negativePrompt = interaction.options.getString('negative_prompt') || undefined;

    const imageOpts = ['image1', 'image2', 'image3']
      .map((n) => interaction.options.getAttachment(n))
      .filter(Boolean);

    for (const img of imageOpts) {
      if (!VALID_IMAGE_TYPES.includes(img.contentType)) {
        await this.sendError(interaction, 'Reference images must be PNG, JPEG, GIF, or WebP.');
        return;
      }
      if (typeof img.size === 'number' && img.size > MAX_IMAGE_BYTES) {
        await this.sendError(interaction, `Reference image too large (max ${MAX_IMAGE_BYTES / 1024 / 1024} MB).`);
        return;
      }
    }

    this.logExecution(interaction, `prompt="${prompt.substring(0, 50)}...", lyrics=${lyrics ? 'yes' : 'no'}, images=${imageOpts.length}`);

    await interaction.editReply({
      content: `Generating music... This may take 1–3 minutes.\n**Prompt:** ${prompt}`
    });

    const result = await this.lyriaService.generateMusic(
      prompt,
      {
        lyrics,
        negativePrompt,
        imageUrls: imageOpts.map((a) => a.url)
      },
      { id: interaction.user.id, tag: interaction.user.tag }
    );

    if (!result.success) {
      await this.sendError(interaction, result.error || 'Failed to generate music.');
      return;
    }

    if (!result.buffer) {
      await this.sendError(interaction, 'Music generation completed but no audio data was returned.');
      return;
    }

    const ext = (result.mimeType || '').includes('wav') ? 'wav' : 'mp3';
    const attachment = new AttachmentBuilder(result.buffer, {
      name: `generated-music-${Date.now()}.${ext}`,
      description: prompt.substring(0, 100)
    });

    const replyPayload = { content: `**Prompt:** ${prompt}`, files: [attachment] };
    if (result.generatedLyrics) {
      const truncated = result.generatedLyrics.length > 4000
        ? result.generatedLyrics.slice(0, 3997) + '...'
        : result.generatedLyrics;
      replyPayload.embeds = [new EmbedBuilder().setTitle('Generated lyrics / structure').setDescription(truncated)];
    }

    await interaction.editReply(replyPayload);
  }
}

module.exports = MusicgenSlashCommand;
