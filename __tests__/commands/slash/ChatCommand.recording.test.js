// __tests__/commands/slash/ChatCommand.recording.test.js
// /chat must record BOTH sides of the exchange into channel_messages, exactly
// like the @mention path does. A slash interaction is not a channel message,
// so messageCreate never sees the prompt; before this fix a /chat Q&A was
// invisible to every later turn's history (ChatService.buildTurnContext reads
// ONLY channel_messages), which is how a reply follow-up lost its context.
jest.mock('../../../logger', () => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() }));
jest.mock('../../../personalities', () => ({
  get: jest.fn(() => ({ id: 'channel-voice', name: 'Channel Voice', emoji: '🗣️' })),
  list: jest.fn(() => []),
}));
jest.mock('../../../services/LocalLlmService', () => ({ checkUncensoredAccess: jest.fn() }));

const logger = require('../../../logger');
const ChatSlashCommand = require('../../../commands/slash/ChatCommand');

const PROMPT = 'what would be the best place to mine high quality Aluminum in star citizen?';

describe('ChatSlashCommand - channel_messages recording', () => {
  let events;
  let mongoService;
  let chatService;
  let interaction;
  let speakerNames;
  let command;
  let sentReply;

  beforeEach(() => {
    jest.clearAllMocks();
    events = [];
    mongoService = {
      recordChannelMessage: jest.fn(async (doc) => { events.push(['record', doc]); }),
    };
    chatService = {
      chat: jest.fn(async () => {
        events.push(['chat']);
        return { success: true, message: 'Aaron Halo, mostly.', executionSummary: { executionIds: [] } };
      }),
    };
    speakerNames = { resolve: jest.fn(() => 'Mike') };
    sentReply = { id: 'bot-reply-1' };
    interaction = {
      id: 'interaction-1',
      user: { id: 'user-1', username: 'inc1067', tag: 'inc1067' },
      member: { nickname: 'mikey' },
      channel: { id: 'chan-1' },
      guild: { id: 'guild-1' },
      options: {
        getString: jest.fn(() => PROMPT),
        getAttachment: jest.fn(() => null),
      },
      editReply: jest.fn(async () => sentReply),
      followUp: jest.fn(async () => ({ id: 'followup-x' })),
      deferred: true,
      replied: false,
    };
    command = new ChatSlashCommand(chatService, {
      mongoService,
      speakerNames,
      getBotUser: () => ({ id: 'bot-id', username: 'RevenantBot' }),
    });
  });

  const recorded = () => events.filter((e) => e[0] === 'record').map((e) => e[1]);

  test('records the prompt (non-bot) BEFORE chat and the reply (isBot) AFTER', async () => {
    await command.execute(interaction, {});

    expect(events.map((e) => (e[0] === 'record' ? (e[1].isBot ? 'bot' : 'user') : 'chat')))
      .toEqual(['user', 'chat', 'bot']);

    const [userDoc, botDoc] = recorded();
    expect(userDoc).toEqual(expect.objectContaining({
      messageId: 'interaction-1',
      channelId: 'chan-1',
      guildId: 'guild-1',
      authorId: 'user-1',
      authorName: 'Mike',
      content: PROMPT,
    }));
    expect(userDoc.isBot).toBeUndefined();
    expect(userDoc.timestamp).toBeInstanceOf(Date);
    expect(speakerNames.resolve).toHaveBeenCalledWith(interaction.user, interaction.member);

    // The raw model output, not the Discord payload ("**Prompt:** ..." header,
    // fallback banner, <url> wrapping) — same rule as the mention path.
    expect(botDoc).toEqual(expect.objectContaining({
      messageId: 'bot-reply-1',
      channelId: 'chan-1',
      guildId: 'guild-1',
      authorId: 'bot-id',
      authorName: 'RevenantBot',
      content: 'Aaron Halo, mostly.',
      isBot: true,
    }));
    expect(botDoc.executionIds).toBeUndefined();
  });

  test('the chat call itself is unchanged (no duplicate current turn is injected by /chat)', async () => {
    await command.execute(interaction, {});
    expect(chatService.chat).toHaveBeenCalledWith('channel-voice', PROMPT, interaction.user, 'chan-1', 'guild-1', null);
  });

  test('carries sandbox executionIds on the bot row', async () => {
    chatService.chat.mockResolvedValueOnce({
      success: true, message: 'ran it', executionSummary: { executionIds: ['e1', 'e2'] },
    });
    await command.execute(interaction, {});
    expect(recorded()[1].executionIds).toEqual(['e1', 'e2']);
  });

  test('a long reply is recorded against the LAST sent message (same as the mention path)', async () => {
    chatService.chat.mockResolvedValueOnce({ success: true, message: 'x'.repeat(4500) });
    interaction.followUp = jest.fn()
      .mockResolvedValueOnce({ id: 'chunk-2' })
      .mockResolvedValueOnce({ id: 'chunk-3' });
    await command.execute(interaction, {});
    const botDoc = recorded().find((d) => d.isBot);
    expect(botDoc.messageId).toBe('chunk-3');
    expect(botDoc.content).toBe('x'.repeat(4500));
  });

  test('recording failures never break the command', async () => {
    mongoService.recordChannelMessage = jest.fn().mockRejectedValue(new Error('mongo down'));
    await expect(command.execute(interaction, {})).resolves.toBeUndefined();
    expect(chatService.chat).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('mongo down'), expect.any(Object));
  });

  test('a failed chat still records the prompt but no bot row', async () => {
    chatService.chat.mockResolvedValueOnce({ success: false, error: 'nope' });
    await command.execute(interaction, {});
    expect(recorded().map((d) => !!d.isBot)).toEqual([false]);
  });

  test('outside a guild the prompt is not recorded (mirrors the messageCreate gate)', async () => {
    interaction.guild = null;
    await command.execute(interaction, {});
    expect(recorded().filter((d) => !d.isBot)).toHaveLength(0);
  });

  test('without a mongoService nothing is recorded and the command still works', async () => {
    command = new ChatSlashCommand(chatService);
    await command.execute(interaction, {});
    expect(mongoService.recordChannelMessage).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalled();
  });

  test('an invalid attachment is rejected before anything is recorded', async () => {
    interaction.options.getAttachment = jest.fn(() => ({ contentType: 'application/pdf', url: 'u' }));
    await command.execute(interaction, {});
    expect(mongoService.recordChannelMessage).not.toHaveBeenCalled();
    expect(chatService.chat).not.toHaveBeenCalled();
  });
});
