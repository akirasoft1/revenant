// commands/slash/HelpCommand.js
// Slash command for help and command listing

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const BaseSlashCommand = require('../base/BaseSlashCommand');
const logger = require('../../logger');

class HelpSlashCommand extends BaseSlashCommand {
  constructor() {
    super({
      data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show available commands and how to use them')
        .addStringOption(option =>
          option.setName('command')
            .setDescription('Get detailed help for a specific command')
            .setRequired(false)),
      cooldown: 5
    });
  }

  async execute(interaction, context) {
    const specificCommand = interaction.options.getString('command');

    this.logExecution(interaction, specificCommand ? `command=${specificCommand}` : 'general');

    if (specificCommand) {
      await this.showCommandHelp(interaction, specificCommand, context);
    } else {
      await this.showGeneralHelp(interaction, context);
    }
  }

  async showGeneralHelp(interaction, context) {
    const embed = new EmbedBuilder()
      .setTitle('Discord Article Bot - Commands')
      .setDescription('All commands use Discord slash commands. Type `/` to see available commands.')
      .setColor(0x5865F2);

    // Chat commands
    embed.addFields({
      name: 'Chat',
      value: [
        '`/chat` - Chat with the bot',
        '`/chatthread` - Start a dedicated conversation thread',
        '`/chatlist` - View your resumable conversations',
        '`/chatresume` - Resume an expired conversation',
        '`/chatreset` - Reset conversation history (admin)',
        '`/tldr` - Get a DM summary of what you missed',
        '`/stats` - Show top token consumers'
      ].join('\n'),
      inline: false
    });

    // Summarization
    embed.addFields({
      name: 'Summarization',
      value: [
        '`/summarize` - Summarize an article from a URL',
        '`/resummarize` - Force re-summarize an article'
      ].join('\n'),
      inline: false
    });

    // Media generation
    embed.addFields({
      name: 'Media Generation',
      value: [
        '`/imagine` - Generate an image from text',
        '`/videogen` - Generate a video from text/images',
        '`/musicgen` - Generate music from text (Lyria 3.5)'
      ].join('\n'),
      inline: false
    });

    // Memory
    embed.addFields({
      name: 'Memory',
      value: [
        '`/memories` - View what I remember about you',
        '`/remember` - Tell me something to remember',
        '`/forget` - Delete a memory or all memories'
      ].join('\n'),
      inline: false
    });

    // IRC History
    embed.addFields({
      name: 'IRC History',
      value: [
        '`/recall` - Search IRC history',
        '`/history` - View IRC history for a user',
        '`/throwback` - Random "on this day" IRC memory'
      ].join('\n'),
      inline: false
    });

    // Utility
    embed.addFields({
      name: 'Utility',
      value: [
        '`/help` - Show this help message',
        '`/context` - View channel conversation context',
        '`/channeltrack` - Manage channel tracking (admin)'
      ].join('\n'),
      inline: false
    });

    embed.setFooter({
      text: 'Tip: You can still reply to bot messages to continue conversations!'
    });

    await interaction.reply({ embeds: [embed] });
  }

  async showCommandHelp(interaction, commandName, context) {
    const helpTexts = {
      chat: {
        title: '/chat',
        description: 'Chat with the bot',
        usage: '/chat message:<your message> [image:<file>]',
        details: 'Start a conversation with the bot. You can attach an image to include in the conversation.'
      },
      chatthread: {
        title: '/chatthread',
        description: 'Start a dedicated thread for extended conversations',
        usage: '/chatthread message:<your message>',
        details: 'Creates a private thread for an ongoing conversation. All messages in the thread are automatically directed to the bot - no commands needed.'
      },
      summarize: {
        title: '/summarize',
        description: 'Summarize an article',
        usage: '/summarize url:<article url> [style:<style>]',
        details: 'Fetches and summarizes the article at the given URL. Available styles: default, pirate, shakespeare, genz, academic.'
      },
      imagine: {
        title: '/imagine',
        description: 'Generate an image',
        usage: '/imagine prompt:<description> [ratio:<aspect>] [reference:<image>]',
        details: 'Uses AI to generate an image from your text description. You can specify an aspect ratio and optionally provide a reference image.'
      },
      musicgen: {
        title: '/musicgen',
        description: 'Generate music',
        usage: '/musicgen prompt:<description> [lyrics:<text>] [negative_prompt:<text>] [image1:<file>] [image2:<file>] [image3:<file>]',
        details: 'Generates multi-minute music with Google Lyria 3.5. Lyrics support [Verse]/[Chorus]/[Bridge] tags. Negative prompts are composed into the prompt text. Up to 3 reference images can influence the result. Generation takes 1-3 minutes.'
      },
      videogen: {
        title: '/videogen',
        description: 'Generate a video',
        usage: '/videogen prompt:<description> [duration:<seconds>] [ratio:<aspect>] [first_frame:<image>] [last_frame:<image>]',
        details: 'Generates a short video from a text description with optional starting/ending frames for morphing.'
      },
      recall: {
        title: '/recall',
        description: 'Search IRC history',
        usage: '/recall query:<search terms> [my_messages:true] [year:<year>]',
        details: 'Performs semantic search through historical IRC logs. Filter to your own messages or specific years.'
      },
      memories: {
        title: '/memories',
        description: 'View stored memories',
        usage: '/memories',
        details: 'Shows what the bot remembers about you from past conversations. Memory IDs are shown for deletion.'
      }
    };

    const help = helpTexts[commandName.toLowerCase()];

    if (!help) {
      await interaction.reply({
        content: `No help available for "${commandName}". Use \`/help\` to see all commands.`,
        ephemeral: true
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(help.title)
      .setDescription(help.description)
      .setColor(0x5865F2)
      .addFields(
        { name: 'Usage', value: `\`${help.usage}\``, inline: false },
        { name: 'Details', value: help.details, inline: false }
      );

    await interaction.reply({ embeds: [embed] });
  }
}

module.exports = HelpSlashCommand;
