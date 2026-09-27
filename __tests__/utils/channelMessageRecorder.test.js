// __tests__/utils/channelMessageRecorder.test.js
// Shared channel_messages recording helpers used by BOTH the messageCreate
// recorder / @mention reply path (bot.js) and the /chat slash command, so the
// two entry points write the same doc shape.
jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const logger = require('../../logger');
const {
  resolveAuthorName,
  buildUserMessageDoc,
  recordUserMessage,
  recordBotReply,
} = require('../../utils/channelMessageRecorder');

beforeEach(() => jest.clearAllMocks());

describe('resolveAuthorName', () => {
  test('prefers the SpeakerNames-resolved name', () => {
    const speakerNames = { resolve: jest.fn(() => 'Mike') };
    const member = { nickname: 'mikey' };
    expect(resolveAuthorName(speakerNames, { id: 'u1', username: 'inc1067' }, member)).toBe('Mike');
    expect(speakerNames.resolve).toHaveBeenCalledWith({ id: 'u1', username: 'inc1067' }, member);
  });

  test('falls back to the raw username when unresolved or no resolver', () => {
    expect(resolveAuthorName({ resolve: () => null }, { id: 'u1', username: 'inc1067' }, null)).toBe('inc1067');
    expect(resolveAuthorName(null, { id: 'u1', username: 'inc1067' }, null)).toBe('inc1067');
  });

  test('a throwing resolver degrades to username and logs at warn', () => {
    const speakerNames = { resolve: () => { throw new Error('boom'); } };
    expect(resolveAuthorName(speakerNames, { id: 'u1', username: 'inc1067' }, null)).toBe('inc1067');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Speaker-name resolution failed for u1: boom'));
  });
});

describe('buildUserMessageDoc', () => {
  test('matches the messageCreate recorder doc shape exactly', () => {
    const doc = buildUserMessageDoc({
      speakerNames: { resolve: () => 'Mike' },
      messageId: 'm1', channelId: 'c1', guildId: 'g1',
      user: { id: 'u1', username: 'inc1067' }, member: null,
      content: 'hello',
    });
    expect(Object.keys(doc).sort()).toEqual(
      ['authorId', 'authorName', 'channelId', 'content', 'guildId', 'messageId', 'timestamp'].sort()
    );
    expect(doc).toEqual(expect.objectContaining({
      messageId: 'm1', channelId: 'c1', guildId: 'g1', authorId: 'u1', authorName: 'Mike', content: 'hello',
    }));
    expect(doc.timestamp).toBeInstanceOf(Date);
    expect(doc.isBot).toBeUndefined();
  });
});

describe('recordUserMessage', () => {
  const base = {
    messageId: 'i1', channelId: 'c1', guildId: 'g1',
    user: { id: 'u1', username: 'alice' }, member: null, content: 'q?',
  };

  test('writes one non-bot row', async () => {
    const mongoService = { recordChannelMessage: jest.fn().mockResolvedValue(undefined) };
    await expect(recordUserMessage({ ...base, mongoService })).resolves.toBe(true);
    expect(mongoService.recordChannelMessage).toHaveBeenCalledTimes(1);
    expect(mongoService.recordChannelMessage.mock.calls[0][0]).toEqual(expect.objectContaining({
      messageId: 'i1', authorId: 'u1', authorName: 'alice', content: 'q?',
    }));
  });

  test('mirrors the messageCreate gate: no guild -> no write', async () => {
    const mongoService = { recordChannelMessage: jest.fn() };
    await expect(recordUserMessage({ ...base, guildId: null, mongoService })).resolves.toBe(false);
    expect(mongoService.recordChannelMessage).not.toHaveBeenCalled();
  });

  test('no mongoService -> no-op', async () => {
    await expect(recordUserMessage({ ...base, mongoService: null })).resolves.toBe(false);
  });

  test('a write failure never throws and is logged at warn with the error', async () => {
    const err = new Error('mongo down');
    const mongoService = { recordChannelMessage: jest.fn().mockRejectedValue(err) };
    await expect(recordUserMessage({ ...base, mongoService })).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('mongo down'),
      expect.objectContaining({ stack: err.stack })
    );
  });
});

describe('recordBotReply', () => {
  const botUser = { id: 'bot-1', username: 'RevenantBot' };

  test('writes an isBot row keyed by the sent reply id', async () => {
    const mongoService = { recordChannelMessage: jest.fn().mockResolvedValue(undefined) };
    await recordBotReply({
      mongoService, botUser, reply: { id: 'r1' }, content: 'answer', channelId: 'c1', guildId: 'g1',
    });
    const doc = mongoService.recordChannelMessage.mock.calls[0][0];
    expect(doc).toEqual(expect.objectContaining({
      messageId: 'r1', channelId: 'c1', guildId: 'g1', authorId: 'bot-1', authorName: 'RevenantBot',
      content: 'answer', isBot: true,
    }));
    expect(doc.timestamp).toBeInstanceOf(Date);
    expect(doc.executionIds).toBeUndefined();
  });

  test('carries executionIds when present', async () => {
    const mongoService = { recordChannelMessage: jest.fn().mockResolvedValue(undefined) };
    await recordBotReply({
      mongoService, botUser, reply: { id: 'r1' }, content: 'x', channelId: 'c1', guildId: 'g1', executionIds: ['e1'],
    });
    expect(mongoService.recordChannelMessage.mock.calls[0][0].executionIds).toEqual(['e1']);
  });

  test('no reply id or no mongoService -> no-op; failures never throw', async () => {
    const mongoService = { recordChannelMessage: jest.fn().mockRejectedValue(new Error('down')) };
    await recordBotReply({ mongoService, botUser, reply: null, content: 'x', channelId: 'c1' });
    expect(mongoService.recordChannelMessage).not.toHaveBeenCalled();
    await expect(recordBotReply({ mongoService: null, botUser, reply: { id: 'r' }, content: 'x' })).resolves.toBeUndefined();
    await expect(recordBotReply({ mongoService, botUser, reply: { id: 'r' }, content: 'x', channelId: 'c1' })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to record bot reply r: down'), expect.any(Object));
  });

  test('falls back to "bot" when the client user is not ready', async () => {
    const mongoService = { recordChannelMessage: jest.fn().mockResolvedValue(undefined) };
    await recordBotReply({ mongoService, botUser: null, reply: { id: 'r1' }, content: 'x', channelId: 'c1' });
    expect(mongoService.recordChannelMessage.mock.calls[0][0]).toEqual(expect.objectContaining({
      authorId: null, authorName: 'bot', guildId: null,
    }));
  });
});
