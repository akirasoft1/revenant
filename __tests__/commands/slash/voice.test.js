// __tests__/commands/slash/voice.test.js
const VoiceSlashCommand = require('../../../commands/slash/voice');

function fakeInteraction({ inChannel = true, sub = 'join', channelId = 'c1' } = {}) {
  return {
    user: { id: 'u1', tag: 'u#1' },
    guildId: 'g1',
    member: { voice: { channel: inChannel ? { id: channelId, guild: { id: 'g1', voiceAdapterCreator: {} } } : null } },
    options: { getSubcommand: () => sub },
    deferred: false, replied: false,
    reply: jest.fn().mockResolvedValue({}), editReply: jest.fn().mockResolvedValue({}),
    followUp: jest.fn().mockResolvedValue({}),
  };
}

describe('/voice', () => {
  let voiceService, command;
  beforeEach(() => {
    // The service reports what actually happened; these mocks mirror the real
    // return shapes (a bare `true`/undefined is what the false-success bug was).
    voiceService = {
      isEnabled: jest.fn(() => true),
      join: jest.fn().mockResolvedValue({ joined: true, channelId: 'c1' }),
      leave: jest.fn().mockResolvedValue(),
      listen: jest.fn().mockResolvedValue({ listening: true, channelId: 'c1' }),
      wakeWord: jest.fn(() => 'hey jarvis'),
      maxSessionSeconds: jest.fn(() => 600),
    };
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
  // --- audit group 2a: the command must say what actually happened ----------

  test('join when already connected to the SAME channel does not claim a fresh join', async () => {
    voiceService.join.mockResolvedValue({ joined: false, reason: 'already-connected', channelId: 'c1' });
    const i = fakeInteraction({ inChannel: true, sub: 'join' });
    await command.execute(i, {});
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Already in <#c1>') }));
    expect(i.reply).not.toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Joined') }));
  });

  test('join while sitting in a DIFFERENT channel reports the refusal and names that channel', async () => {
    voiceService.join.mockResolvedValue({ joined: false, reason: 'already-connected', channelId: 'c9' });
    const i = fakeInteraction({ inChannel: true, sub: 'join', channelId: 'c1' });
    await command.execute(i, {});
    const content = i.reply.mock.calls[0][0].content;
    expect(content).toContain("Couldn't join");
    expect(content).toContain('<#c9>');          // where the bot ACTUALLY is
    expect(content).not.toContain('Joined <#c1>');
  });

  test('listen reports a refusal when a session is already active', async () => {
    voiceService.listen.mockResolvedValue({ listening: false, reason: 'already-active' });
    const i = fakeInteraction({ inChannel: true, sub: 'listen' });
    await command.execute(i, adminCtx);
    const content = i.reply.mock.calls[0][0].content;
    expect(content).toContain("Couldn't start listening");
    expect(content).not.toContain('no wake word needed');
  });

  test('listen reports a refusal when the bot is in another channel', async () => {
    voiceService.listen.mockResolvedValue({ listening: false, reason: 'other-channel', channelId: 'c9' });
    const i = fakeInteraction({ inChannel: true, sub: 'listen' });
    await command.execute(i, adminCtx);
    const content = i.reply.mock.calls[0][0].content;
    expect(content).toContain("Couldn't start listening");
    expect(content).toContain('<#c9>');
  });

  test('listen reports a failure when no session opened (unhealthy sidecar)', async () => {
    voiceService.listen.mockResolvedValue({ listening: false, reason: 'session-failed', joined: false });
    const i = fakeInteraction({ inChannel: true, sub: 'listen' });
    await command.execute(i, adminCtx);
    const content = i.reply.mock.calls[0][0].content;
    expect(content).toContain("Couldn't start listening");
    expect(content).not.toContain('no wake word needed');
    expect(content).not.toContain('I did join');   // it didn't
  });

  // The other half of the truth: when listen() had to join first and only the
  // SESSION failed, the bot is now sitting in the admin's voice channel with a
  // live wake word. A flat "couldn't start listening" is the same false report
  // as the one this block fixes, pointed the other way.
  test('listen that joined but failed to open a session says the bot IS in the channel', async () => {
    voiceService.listen.mockResolvedValue({ listening: false, reason: 'session-failed', joined: true });
    const i = fakeInteraction({ inChannel: true, sub: 'listen' });
    await command.execute(i, adminCtx);
    const content = i.reply.mock.calls[0][0].content;
    expect(content).toContain("Couldn't start listening");
    expect(content).toContain('I did join <#c1>');
    expect(content).toContain('wake word still works');
    expect(content).toContain('/voice leave');
  });

  // 2.5: "until /voice leave" is a promise VOICE_MAX_SESSION_SECONDS breaks
  // ~10 minutes in, so the reply has to name the cap.
  test('a successful listen tells the admin about the session cap, not just /voice leave', async () => {
    const i = fakeInteraction({ inChannel: true, sub: 'listen' });
    await command.execute(i, adminCtx);
    const content = i.reply.mock.calls[0][0].content;
    expect(content).toContain('no wake word needed');
    expect(content).toContain('/voice leave');
    expect(content).toContain('10-minute');
  });

  // Math.round(90 / 60) is 2. Quoting a 90-second cap as "2-minute" overstates
  // the one number in this reply whose whole job is to stop the bot promising
  // more time than it has.
  test('a cap that is not a whole number of minutes is not rounded UP', async () => {
    voiceService.maxSessionSeconds.mockReturnValue(90);
    const i = fakeInteraction({ inChannel: true, sub: 'listen' });
    await command.execute(i, adminCtx);
    const content = i.reply.mock.calls[0][0].content;
    expect(content).toContain('1-minute 30-second');
    expect(content).not.toContain('2-minute');
  });

  test('a sub-minute cap is quoted in seconds', async () => {
    voiceService.maxSessionSeconds.mockReturnValue(45);
    const i = fakeInteraction({ inChannel: true, sub: 'listen' });
    await command.execute(i, adminCtx);
    expect(i.reply.mock.calls[0][0].content).toContain('45-second');
  });

  test('an uncapped session (maxSessionSeconds 0) keeps the plain wording', async () => {
    voiceService.maxSessionSeconds.mockReturnValue(0);
    const i = fakeInteraction({ inChannel: true, sub: 'listen' });
    await command.execute(i, adminCtx);
    const content = i.reply.mock.calls[0][0].content;
    expect(content).toContain('/voice leave');
    expect(content).not.toContain('cap');
  });

  test('leave that throws reports the failure instead of "Left the voice channel"', async () => {
    voiceService.leave.mockRejectedValue(new Error('destroy boom'));
    const i = fakeInteraction({ sub: 'leave' });
    await command.execute(i, {});
    const content = i.reply.mock.calls[0][0].content;
    expect(content).toContain('destroy boom');
    expect(content).not.toContain('Left the voice channel');
  });
});
