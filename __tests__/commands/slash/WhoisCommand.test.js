const WhoisSlashCommand = require('../../../commands/slash/WhoisCommand');

function fakeInteraction({ sub = 'show', userId = 'u1', target = null, name, alias } = {}) {
  return {
    user: { id: userId, tag: 'u#1' },
    member: { id: userId },
    deferred: false, replied: false,
    options: {
      getSubcommand: () => sub,
      getUser: jest.fn(() => target),
      getMember: jest.fn(() => (target ? { id: target.id } : null)),
      getString: jest.fn((n) => (n === 'name' ? name : n === 'alias' ? alias : null)),
    },
    reply: jest.fn().mockResolvedValue({}),
    editReply: jest.fn().mockResolvedValue({}),
    followUp: jest.fn().mockResolvedValue({}),
  };
}
const ctx = { config: { discord: { adminUserIds: ['admin1'] } } };
const text = (i) => (i.reply.mock.calls[0] || i.editReply.mock.calls[0])[0];

describe('/whois', () => {
  let identity, speakerNames, cmd;
  beforeEach(() => {
    identity = {
      isLoaded: jest.fn(() => true),
      get: jest.fn(() => null),
      setAddressName: jest.fn().mockResolvedValue({ ok: true, record: { discordId: 'u1', addressName: 'Akira', aliases: [] } }),
      addAlias: jest.fn().mockResolvedValue({ ok: true, record: { discordId: 'u1', addressName: 'Akira', aliases: ['Aki'] } }),
      removeAlias: jest.fn().mockResolvedValue({ ok: true, record: { discordId: 'u1', addressName: 'Akira', aliases: [] } }),
    };
    speakerNames = { resolve: jest.fn(() => 'inc') };
    cmd = new WhoisSlashCommand(identity, speakerNames);
  });

  test('metadata and ephemeral', () => {
    expect(cmd.name).toBe('whois');
    expect(cmd.ephemeral).toBe(true);
  });

  test('show for self with record', async () => {
    identity.get.mockReturnValue({ discordId: 'u1', addressName: 'Akira', aliases: ['Aki', 'Phal'] });
    const i = fakeInteraction({ sub: 'show' });
    await cmd.execute(i, ctx);
    expect(identity.get).toHaveBeenCalledWith('u1');
    const t = text(i).content;
    expect(t).toContain('Akira');
    expect(t).toContain('Aki');
    expect(t).toContain('Phal');
    expect(i.reply.mock.calls[0][0].ephemeral).toBe(true);
  });

  test('show for member without record names current resolved name', async () => {
    const i = fakeInteraction({ sub: 'show' });
    await cmd.execute(i, ctx);
    const t = text(i).content;
    expect(t).toMatch(/no identity/i);
    expect(t).toContain('inc');
  });

  test('show for another member needs no admin', async () => {
    const i = fakeInteraction({ sub: 'show', target: { id: 'u2' } });
    await cmd.execute(i, ctx);
    expect(identity.get).toHaveBeenCalledWith('u2');
  });

  test('show with empty cache says storage unavailable', async () => {
    identity.isLoaded.mockReturnValue(false);
    const i = fakeInteraction({ sub: 'show' });
    await cmd.execute(i, ctx);
    expect(text(i).content).toMatch(/unavailable/i);
  });

  test('address sets own name; does not gate on isLoaded', async () => {
    identity.isLoaded.mockReturnValue(false);
    const i = fakeInteraction({ sub: 'address', name: 'Akira' });
    await cmd.execute(i, ctx);
    expect(identity.setAddressName).toHaveBeenCalledWith('u1', 'Akira', 'u1');
    expect(text(i).content).toContain('Akira');
  });

  test('non-admin editing someone else is refused', async () => {
    const i = fakeInteraction({ sub: 'alias-add', alias: 'Aki', target: { id: 'u2' } });
    await cmd.execute(i, ctx);
    expect(identity.addAlias).not.toHaveBeenCalled();
    expect(text(i).content).toMatch(/admin/i);
  });

  test('admin can edit someone else', async () => {
    const i = fakeInteraction({ sub: 'alias-add', alias: 'Aki', userId: 'admin1', target: { id: 'u2' } });
    await cmd.execute(i, ctx);
    expect(identity.addAlias).toHaveBeenCalledWith('u2', 'Aki', 'admin1');
  });

  test('target equal to self is treated as self', async () => {
    const i = fakeInteraction({ sub: 'address', name: 'X1', target: { id: 'u1' } });
    await cmd.execute(i, ctx);
    expect(identity.setAddressName).toHaveBeenCalledWith('u1', 'X1', 'u1');
  });

  test('alias-remove', async () => {
    const i = fakeInteraction({ sub: 'alias-remove', alias: 'Aki' });
    await cmd.execute(i, ctx);
    expect(identity.removeAlias).toHaveBeenCalledWith('u1', 'Aki', 'u1');
  });

  test('taken names the holder', async () => {
    identity.addAlias.mockResolvedValue({ ok: false, reason: 'taken', holderId: 'u9' });
    const i = fakeInteraction({ sub: 'alias-add', alias: 'Bob' });
    await cmd.execute(i, ctx);
    expect(text(i).content).toBe('‘Bob’ is already used by <@u9>.');
  });

  test.each([
    ['invalid', /shortened to 24/],
    ['too_many', /10/],
    ['unavailable', /Identity storage is unavailable right now\./],
  ])('reason %s', async (reason, re) => {
    identity.addAlias.mockResolvedValue({ ok: false, reason });
    const i = fakeInteraction({ sub: 'alias-add', alias: 'Bob' });
    await cmd.execute(i, ctx);
    expect(text(i).content).toMatch(re);
  });

  test('remove not_found', async () => {
    identity.removeAlias.mockResolvedValue({ ok: false, reason: 'not_found' });
    const i = fakeInteraction({ sub: 'alias-remove', alias: 'Zed' });
    await cmd.execute(i, ctx);
    expect(text(i).content).toContain('‘Zed’ isn\'t one of');
  });

  test('unchanged add is reported', async () => {
    identity.addAlias.mockResolvedValue({ ok: true, unchanged: true, name: 'aki', record: { discordId: 'u1', addressName: 'A', aliases: ['Aki'] } });
    const i = fakeInteraction({ sub: 'alias-add', alias: 'aki' });
    await cmd.execute(i, ctx);
    expect(text(i).content).toMatch(/already/i);
  });

  test('replies show the stored name, not raw input', async () => {
    identity.setAddressName.mockResolvedValue({ ok: true, name: 'Akira', record: { discordId: 'u1', addressName: 'Akira', aliases: [] } });
    let i = fakeInteraction({ sub: 'address', name: '😀 Akira 😀' });
    await cmd.execute(i, ctx);
    expect(text(i).content).toContain('Akira.');
    expect(text(i).content).not.toContain('😀');
    identity.addAlias.mockResolvedValue({ ok: true, name: 'Aki', record: { discordId: 'u1', addressName: 'Akira', aliases: ['Aki'] } });
    i = fakeInteraction({ sub: 'alias-add', alias: '**Aki**' });
    await cmd.execute(i, ctx);
    expect(text(i).content).toContain('‘Aki’');
    expect(text(i).content).not.toContain('**');
  });

  test('thrown service errors are logged in full and reported unavailable', async () => {
    const logger = require('../../../logger');
    const spy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    identity.addAlias.mockRejectedValue(new Error('boom'));
    const i = fakeInteraction({ sub: 'alias-add', alias: 'Bob' });
    await cmd.execute(i, ctx);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('/whois alias-add failed for target u1: Error: boom'));
    expect(text(i).content).toMatch(/unavailable/i);
    spy.mockRestore();
  });

  test('service missing degrades to unavailable', async () => {
    const c = new WhoisSlashCommand(null, null);
    const i = fakeInteraction({ sub: 'address', name: 'A1' });
    await c.execute(i, ctx);
    expect(text(i).content).toMatch(/unavailable/i);
  });
});
