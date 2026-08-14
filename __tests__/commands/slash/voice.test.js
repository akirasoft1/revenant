// __tests__/commands/slash/voice.test.js
const VoiceSlashCommand = require('../../../commands/slash/voice');

function fakeInteraction({ inChannel = true, sub = 'join' } = {}) {
  return {
    user: { id: 'u1', tag: 'u#1' },
    guildId: 'g1',
    member: { voice: { channel: inChannel ? { id: 'c1', guild: { id: 'g1', voiceAdapterCreator: {} } } : null } },
    options: { getSubcommand: () => sub },
    deferred: false, replied: false,
    reply: jest.fn().mockResolvedValue({}), editReply: jest.fn().mockResolvedValue({}),
    followUp: jest.fn().mockResolvedValue({}),
  };
}

describe('/voice', () => {
  let voiceService, command;
  beforeEach(() => {
    voiceService = { isEnabled: jest.fn(() => true), join: jest.fn().mockResolvedValue(), leave: jest.fn().mockResolvedValue(),
      listen: jest.fn().mockResolvedValue(true), wakeWord: jest.fn(() => 'hey jarvis') };
    command = new VoiceSlashCommand(voiceService);
  });

  test('disabled feature short-circuits', async () => {
    voiceService.isEnabled.mockReturnValue(false);
    const i = fakeInteraction();
    await command.execute(i, {});
    expect(voiceService.join).not.toHaveBeenCalled();
  });

  test('join with caller in a channel joins it', async () => {
    const i = fakeInteraction({ inChannel: true, sub: 'join' });
    await command.execute(i, {});
    expect(voiceService.join).toHaveBeenCalledWith(
      expect.objectContaining({ channel: i.member.voice.channel, guildId: 'g1' })
    );
  });

  test('join with caller not in a channel errors, does not join', async () => {
    const i = fakeInteraction({ inChannel: false, sub: 'join' });
    await command.execute(i, {});
    expect(voiceService.join).not.toHaveBeenCalled();
  });

  test('leave calls leave', async () => {
    const i = fakeInteraction({ sub: 'leave' });
    await command.execute(i, {});
    expect(voiceService.leave).toHaveBeenCalledWith('g1');
  });

  test('metadata', () => {
    expect(command.data.name).toBe('voice');
  });

  // --- /voice listen admin override ----------------------------------------
  const adminCtx = { config: { discord: { adminUserIds: ['u1'] } } };

  test('listen: non-admin is rejected and does not start listening', async () => {
    const i = fakeInteraction({ inChannel: true, sub: 'listen' });
    await command.execute(i, { config: { discord: { adminUserIds: ['someone-else'] } } });
    expect(voiceService.listen).not.toHaveBeenCalled();
  });

  test('listen: admin in a channel starts continuous listen', async () => {
    const i = fakeInteraction({ inChannel: true, sub: 'listen' });
    await command.execute(i, adminCtx);
    expect(voiceService.listen).toHaveBeenCalledWith(
      expect.objectContaining({ channel: i.member.voice.channel, guildId: 'g1', userId: 'u1' })
    );
  });

  test('listen: admin not in a channel errors, does not start listening', async () => {
    const i = fakeInteraction({ inChannel: false, sub: 'listen' });
    await command.execute(i, adminCtx);
    expect(voiceService.listen).not.toHaveBeenCalled();
  });

  // --- join-latency fix: /voice must auto-defer -----------------------------
  // Root cause of "The application did not respond": a cold-cache /voice join
  // triggers a slow ONNX wake-word model load that saturates the CPU limit
  // and blows Discord's 3s interaction-ack window. SlashCommandHandler
  // auto-defers before execute() when `command.deferReply` is true.
  test('declares deferReply + ephemeral so the handler auto-defers within the 3s ack window', () => {
    expect(command.deferReply).toBe(true);
    expect(command.ephemeral).toBe(true);
  });

  test('when the interaction is already deferred, replies use editReply (not reply)', async () => {
    const i = fakeInteraction({ inChannel: true, sub: 'join' });
    i.deferred = true;
    await command.execute(i, {});
    expect(i.editReply).toHaveBeenCalled();
    expect(i.reply).not.toHaveBeenCalled();
  });

  test('leave also replies via editReply when the interaction is already deferred', async () => {
    const i = fakeInteraction({ sub: 'leave' });
    i.deferred = true;
    await command.execute(i, {});
    expect(voiceService.leave).toHaveBeenCalledWith('g1');
    expect(i.editReply).toHaveBeenCalled();
    expect(i.reply).not.toHaveBeenCalled();
  });

  test('join error also replies via editReply when the interaction is already deferred', async () => {
    voiceService.join.mockRejectedValue(new Error('boom'));
    const i = fakeInteraction({ inChannel: true, sub: 'join' });
    i.deferred = true;
    await command.execute(i, {});
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('boom') }));
    expect(i.reply).not.toHaveBeenCalled();
  });
});
