jest.mock('../../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const HangarSlashCommand = require('../../../commands/slash/HangarCommand');

const SELF = '111';
const OTHER = '222';
const ADMIN = '900';
const ctx = { config: { discord: { adminUserIds: [ADMIN] } } };
const UNAVAILABLE = 'Hangar service is unavailable right now.';

function fakeInteraction({ sub = 'list', userId = SELF, target = null, strings = {} } = {}) {
  const i = {
    user: { id: userId, tag: 'u#1' },
    deferred: false, replied: false,
    options: {
      getSubcommand: () => sub,
      getUser: jest.fn((n) => (n === 'member' ? target : null)),
      getString: jest.fn((n) => (n in strings ? strings[n] : null)),
    },
    reply: jest.fn().mockResolvedValue({}),
    editReply: jest.fn().mockResolvedValue({}),
    followUp: jest.fn().mockResolvedValue({}),
    deferReply: jest.fn(async () => { i.deferred = true; }),
  };
  return i;
}
const lastReply = (i) => {
  const calls = [...i.reply.mock.calls, ...i.editReply.mock.calls];
  return calls[calls.length - 1][0];
};
const replyText = (i) => {
  const r = lastReply(i);
  return typeof r === 'string' ? r : r.content;
};

function ship(over = {}) {
  return {
    shipId: 's1', vehicleUuid: 'v1', vehicleName: 'Vanguard Harbinger', nickname: null,
    fitted: {}, loadout: [], loadoutError: null, ...over,
  };
}

function fakeClient() {
  return {
    isEnabled: jest.fn(() => true),
    getHangar: jest.fn().mockResolvedValue({ ok: true, data: { member: SELF, ships: [] } }),
    addShip: jest.fn().mockResolvedValue({ ok: true, data: { ship: ship({ nickname: 'Betty' }) } }),
    renameShip: jest.fn().mockResolvedValue({ ok: true, data: { ship: ship({ nickname: 'New' }) } }),
    removeShip: jest.fn().mockResolvedValue({ ok: true, data: { deleted: true, shipId: 's1' } }),
    searchVehicles: jest.fn().mockResolvedValue({ ok: true, data: { vehicles: [] } }),
  };
}

describe('/hangar', () => {
  let client, cmd;
  beforeEach(() => {
    client = fakeClient();
    cmd = new HangarSlashCommand(client);
  });

  test('metadata: name, ephemeral, subcommands and options', () => {
    expect(cmd.name).toBe('hangar');
    expect(cmd.ephemeral).toBe(true);
    const json = cmd.data.toJSON();
    const subs = Object.fromEntries(json.options.map((o) => [o.name, o.options.map((x) => ({ name: x.name, required: !!x.required, autocomplete: !!x.autocomplete }))]));
    expect(subs.list).toEqual([{ name: 'member', required: false, autocomplete: false }]);
    expect(subs.add).toEqual([
      { name: 'ship', required: true, autocomplete: true },
      { name: 'nickname', required: false, autocomplete: false },
      { name: 'member', required: false, autocomplete: false },
    ]);
    expect(subs.rename).toEqual([
      { name: 'ship', required: true, autocomplete: true },
      { name: 'nickname', required: true, autocomplete: false },
      { name: 'member', required: false, autocomplete: false },
    ]);
    expect(subs.remove).toEqual([
      { name: 'ship', required: true, autocomplete: true },
      { name: 'member', required: false, autocomplete: false },
    ]);
  });

  describe('list', () => {
    test('empty hangar for self', async () => {
      const i = fakeInteraction();
      await cmd.execute(i, ctx);
      expect(client.getHangar).toHaveBeenCalledWith(SELF);
      expect(replyText(i)).toMatch(/no ships/i);
      expect(replyText(i)).toContain('/hangar add');
      expect(lastReply(i).ephemeral).toBe(true);
    });

    test('defers (ephemeral) before calling the service', async () => {
      const i = fakeInteraction();
      client.getHangar.mockImplementation(async () => {
        expect(i.deferReply).toHaveBeenCalledWith({ ephemeral: true });
        return { ok: true, data: { ships: [] } };
      });
      await cmd.execute(i, ctx);
      expect(i.editReply).toHaveBeenCalled();
    });

    test('renders nickname, model, stock vs fitted items', async () => {
      client.getHangar.mockResolvedValue({ ok: true, data: { ships: [
        ship({ shipId: 's1', nickname: 'Betty', vehicleName: 'Vanguard Harbinger' }),
        ship({ shipId: 's2', nickname: null, vehicleName: 'Constellation Taurus',
          fitted: { hardpoint_quantum_drive: { itemUuid: 'q', itemName: 'Hemera' }, hardpoint_shield_generator: { itemUuid: 'h', itemName: 'FR-76' } } }),
      ] } });
      const i = fakeInteraction();
      await cmd.execute(i, ctx);
      const t = replyText(i);
      expect(t).toContain('Betty');
      expect(t).toContain('Vanguard Harbinger');
      expect(t).toContain('Constellation Taurus');
      expect(t).toMatch(/stock/i);
      expect(t).toContain('Hemera');
      expect(t).toContain('FR-76');
      expect(t).toMatch(/2 ships/);
    });

    test('a ship with many fitted items collapses to a count', async () => {
      const fitted = {};
      for (let n = 0; n < 20; n++) fitted[`slot_${n}`] = { itemUuid: `i${n}`, itemName: `Some Long Component Name ${n}` };
      client.getHangar.mockResolvedValue({ ok: true, data: { ships: [ship({ fitted })] } });
      const i = fakeInteraction();
      await cmd.execute(i, ctx);
      expect(replyText(i)).toMatch(/20 changes from stock/);
      expect(replyText(i)).not.toContain('Some Long Component Name 19');
    });

    test('a per-ship loadout error is noted', async () => {
      client.getHangar.mockResolvedValue({ ok: true, data: { ships: [ship({ loadout: null, loadoutError: 'unavailable' })] } });
      const i = fakeInteraction();
      await cmd.execute(i, ctx);
      expect(replyText(i)).toMatch(/loadout unavailable/i);
    });

    test('stays within the Discord 2000-char limit with many ships', async () => {
      const ships = [];
      for (let n = 0; n < 120; n++) ships.push(ship({ shipId: `s${n}`, nickname: `Ship number ${n} with a long nickname`, vehicleName: 'Anvil Carrack Expedition' }));
      client.getHangar.mockResolvedValue({ ok: true, data: { ships } });
      const i = fakeInteraction();
      await cmd.execute(i, ctx);
      const t = replyText(i);
      expect(t.length).toBeLessThanOrEqual(2000);
      expect(t).toMatch(/and \d+ more/);
      expect(i.followUp).not.toHaveBeenCalled();
    });

    test("anyone may list another member's hangar (reads are not admin-gated)", async () => {
      const i = fakeInteraction({ target: { id: OTHER } });
      client.getHangar.mockResolvedValue({ ok: true, data: { ships: [ship()] } });
      await cmd.execute(i, ctx);
      expect(client.getHangar).toHaveBeenCalledWith(OTHER);
      expect(replyText(i)).toContain(`<@${OTHER}>`);
    });

    test('unavailable', async () => {
      client.getHangar.mockResolvedValue({ ok: false, error: 'unavailable', message: 'x' });
      const i = fakeInteraction();
      await cmd.execute(i, ctx);
      expect(replyText(i)).toBe(UNAVAILABLE);
    });
  });

  test('no client / disabled client -> unavailable', async () => {
    const i = fakeInteraction();
    await new HangarSlashCommand(null).execute(i, ctx);
    expect(replyText(i)).toBe(UNAVAILABLE);
    client.isEnabled.mockReturnValue(false);
    const i2 = fakeInteraction();
    await cmd.execute(i2, ctx);
    expect(replyText(i2)).toBe(UNAVAILABLE);
    expect(client.getHangar).not.toHaveBeenCalled();
  });

  describe('add', () => {
    test('self: sends vehicle + nickname with acting member = invoker', async () => {
      const i = fakeInteraction({ sub: 'add', strings: { ship: 'v1', nickname: 'Betty' } });
      await cmd.execute(i, ctx);
      expect(client.addShip).toHaveBeenCalledWith(SELF, { vehicle: 'v1', nickname: 'Betty' }, SELF);
      expect(replyText(i)).toContain('Vanguard Harbinger');
      expect(replyText(i)).toContain('Betty');
      expect(replyText(i)).toMatch(/your hangar/i);
    });

    test('nickname omitted -> null', async () => {
      const i = fakeInteraction({ sub: 'add', strings: { ship: 'Harbinger' } });
      await cmd.execute(i, ctx);
      expect(client.addShip).toHaveBeenCalledWith(SELF, { vehicle: 'Harbinger', nickname: null }, SELF);
    });

    test('other member as non-admin is refused without calling the service', async () => {
      const i = fakeInteraction({ sub: 'add', target: { id: OTHER }, strings: { ship: 'v1' } });
      await cmd.execute(i, ctx);
      expect(client.addShip).not.toHaveBeenCalled();
      expect(replyText(i)).toMatch(/admin/i);
      expect(lastReply(i).ephemeral).toBe(true);
    });

    test('other member as admin: target path, acting member = the admin', async () => {
      const i = fakeInteraction({ sub: 'add', userId: ADMIN, target: { id: OTHER }, strings: { ship: 'v1' } });
      await cmd.execute(i, ctx);
      expect(client.addShip).toHaveBeenCalledWith(OTHER, { vehicle: 'v1', nickname: null }, ADMIN);
      expect(replyText(i)).toContain(`<@${OTHER}>`);
    });

    test('explicitly naming yourself is not an "other member"', async () => {
      const i = fakeInteraction({ sub: 'add', target: { id: SELF }, strings: { ship: 'v1' } });
      await cmd.execute(i, ctx);
      expect(client.addShip).toHaveBeenCalledWith(SELF, expect.any(Object), SELF);
    });

    test('ambiguous -> lists candidate labels', async () => {
      client.addShip.mockResolvedValue({ ok: false, error: 'ambiguous', message: 'm', candidates: [
        { uuid: 'a', name: 'Constellation Taurus', label: 'Constellation Taurus' },
        { uuid: 'b', name: 'Constellation Andromeda', label: 'Constellation Andromeda' },
        { uuid: 'c', name: 'Mercury', label: 'Mercury (mercury-star-runner)' },
      ] });
      const i = fakeInteraction({ sub: 'add', strings: { ship: 'connie' } });
      await cmd.execute(i, ctx);
      const t = replyText(i);
      expect(t).toContain('connie');
      expect(t).toContain('Constellation Taurus');
      expect(t).toContain('Constellation Andromeda');
      expect(t).toContain('Mercury (mercury-star-runner)');
    });

    test('not found', async () => {
      client.addShip.mockResolvedValue({ ok: false, error: 'not_found', message: 'm' });
      const i = fakeInteraction({ sub: 'add', strings: { ship: 'Nonsense' } });
      await cmd.execute(i, ctx);
      expect(replyText(i)).toMatch(/no ship matches/i);
      expect(replyText(i)).toContain('Nonsense');
    });

    test('service-side forbidden is reported', async () => {
      client.addShip.mockResolvedValue({ ok: false, error: 'forbidden', message: 'm' });
      const i = fakeInteraction({ sub: 'add', userId: ADMIN, target: { id: OTHER }, strings: { ship: 'v1' } });
      await cmd.execute(i, ctx);
      expect(replyText(i)).toMatch(/not allowed|admin/i);
    });

    test('unavailable / unauthenticated -> unavailable message', async () => {
      for (const error of ['unavailable', 'unauthenticated']) {
        client.addShip.mockResolvedValue({ ok: false, error, message: 'm' });
        const i = fakeInteraction({ sub: 'add', strings: { ship: 'v1' } });
        await cmd.execute(i, ctx);
        expect(replyText(i)).toBe(UNAVAILABLE);
      }
    });

    test('invalid_request shows the service message', async () => {
      client.addShip.mockResolvedValue({ ok: false, error: 'invalid_request', message: 'nickname: at most 64 characters' });
      const i = fakeInteraction({ sub: 'add', strings: { ship: 'v1', nickname: 'x' } });
      await cmd.execute(i, ctx);
      expect(replyText(i)).toContain('nickname: at most 64 characters');
    });
  });

  describe('rename', () => {
    beforeEach(() => {
      client.getHangar.mockResolvedValue({ ok: true, data: { ships: [
        ship({ shipId: 's1', nickname: 'Betty', vehicleName: 'Vanguard Harbinger' }),
        ship({ shipId: 's2', nickname: null, vehicleName: 'Constellation Taurus' }),
      ] } });
    });

    test('by shipId (autocomplete value), acting member = invoker', async () => {
      client.renameShip.mockResolvedValue({ ok: true, data: { ship: ship({ shipId: 's2', vehicleName: 'Constellation Taurus', nickname: 'Big Connie' }) } });
      const i = fakeInteraction({ sub: 'rename', strings: { ship: 's2', nickname: 'Big Connie' } });
      await cmd.execute(i, ctx);
      expect(client.renameShip).toHaveBeenCalledWith(SELF, 's2', 'Big Connie', SELF);
      expect(replyText(i)).toContain('Constellation Taurus');
      expect(replyText(i)).toContain('Big Connie');
    });

    test('free text matching a nickname or model resolves to the ship', async () => {
      const i = fakeInteraction({ sub: 'rename', strings: { ship: 'betty', nickname: 'Bets' } });
      await cmd.execute(i, ctx);
      expect(client.renameShip).toHaveBeenCalledWith(SELF, 's1', 'Bets', SELF);
      const i2 = fakeInteraction({ sub: 'rename', strings: { ship: 'constellation taurus', nickname: 'C' } });
      await cmd.execute(i2, ctx);
      expect(client.renameShip).toHaveBeenLastCalledWith(SELF, 's2', 'C', SELF);
    });

    test('free text matching several ships lists them', async () => {
      client.getHangar.mockResolvedValue({ ok: true, data: { ships: [
        ship({ shipId: 's1', nickname: 'A', vehicleName: 'Vanguard Harbinger' }),
        ship({ shipId: 's2', nickname: 'B', vehicleName: 'Vanguard Harbinger' }),
      ] } });
      const i = fakeInteraction({ sub: 'rename', strings: { ship: 'vanguard harbinger', nickname: 'C' } });
      await cmd.execute(i, ctx);
      expect(client.renameShip).not.toHaveBeenCalled();
      expect(replyText(i)).toContain('A');
      expect(replyText(i)).toContain('B');
      expect(replyText(i)).toMatch(/several/i);
    });

    test('unknown ship', async () => {
      const i = fakeInteraction({ sub: 'rename', strings: { ship: 'Polaris', nickname: 'C' } });
      await cmd.execute(i, ctx);
      expect(client.renameShip).not.toHaveBeenCalled();
      expect(replyText(i)).toMatch(/no ship/i);
      expect(replyText(i)).toContain('Polaris');
    });

    test('other member as non-admin is refused before any call', async () => {
      const i = fakeInteraction({ sub: 'rename', target: { id: OTHER }, strings: { ship: 's1', nickname: 'X' } });
      await cmd.execute(i, ctx);
      expect(client.getHangar).not.toHaveBeenCalled();
      expect(client.renameShip).not.toHaveBeenCalled();
      expect(replyText(i)).toMatch(/admin/i);
    });

    test('admin renames for another member', async () => {
      const i = fakeInteraction({ sub: 'rename', userId: ADMIN, target: { id: OTHER }, strings: { ship: 's1', nickname: 'X' } });
      await cmd.execute(i, ctx);
      expect(client.getHangar).toHaveBeenCalledWith(OTHER);
      expect(client.renameShip).toHaveBeenCalledWith(OTHER, 's1', 'X', ADMIN);
    });

    test('hangar lookup unavailable', async () => {
      client.getHangar.mockResolvedValue({ ok: false, error: 'unavailable', message: 'm' });
      const i = fakeInteraction({ sub: 'rename', strings: { ship: 's1', nickname: 'X' } });
      await cmd.execute(i, ctx);
      expect(replyText(i)).toBe(UNAVAILABLE);
    });

    test('write not_found (ship deleted meanwhile)', async () => {
      client.renameShip.mockResolvedValue({ ok: false, error: 'not_found', message: 'm' });
      const i = fakeInteraction({ sub: 'rename', strings: { ship: 's1', nickname: 'X' } });
      await cmd.execute(i, ctx);
      expect(replyText(i)).toMatch(/no longer/i);
    });
  });

  describe('remove', () => {
    beforeEach(() => {
      client.getHangar.mockResolvedValue({ ok: true, data: { ships: [ship({ shipId: 's1', nickname: 'Betty' })] } });
    });

    test('self, acting member = invoker', async () => {
      const i = fakeInteraction({ sub: 'remove', strings: { ship: 's1' } });
      await cmd.execute(i, ctx);
      expect(client.removeShip).toHaveBeenCalledWith(SELF, 's1', SELF);
      expect(replyText(i)).toMatch(/removed/i);
      expect(replyText(i)).toContain('Betty');
    });

    test('other member as non-admin is refused', async () => {
      const i = fakeInteraction({ sub: 'remove', target: { id: OTHER }, strings: { ship: 's1' } });
      await cmd.execute(i, ctx);
      expect(client.removeShip).not.toHaveBeenCalled();
      expect(replyText(i)).toMatch(/admin/i);
    });

    test('admin removes for another member', async () => {
      const i = fakeInteraction({ sub: 'remove', userId: ADMIN, target: { id: OTHER }, strings: { ship: 's1' } });
      await cmd.execute(i, ctx);
      expect(client.removeShip).toHaveBeenCalledWith(OTHER, 's1', ADMIN);
    });

    test('unavailable on write', async () => {
      client.removeShip.mockResolvedValue({ ok: false, error: 'unavailable', message: 'm' });
      const i = fakeInteraction({ sub: 'remove', strings: { ship: 's1' } });
      await cmd.execute(i, ctx);
      expect(replyText(i)).toBe(UNAVAILABLE);
    });
  });

  test('an unexpected throw from the client still replies unavailable', async () => {
    client.getHangar.mockRejectedValue(new Error('boom'));
    const i = fakeInteraction();
    await cmd.execute(i, ctx);
    expect(replyText(i)).toBe(UNAVAILABLE);
  });

  describe('autocomplete', () => {
    function acInteraction({ sub = 'add', focused = 'ship', value = '', userId = SELF, member } = {}) {
      return {
        user: { id: userId },
        options: {
          getSubcommand: () => sub,
          getFocused: jest.fn(() => ({ name: focused, value })),
          get: jest.fn((n) => (n === 'member' && member ? { name: 'member', value: member } : null)),
        },
        respond: jest.fn().mockResolvedValue(undefined),
      };
    }

    test('add: catalog search -> name/uuid choices, capped at 25, bounded timeout', async () => {
      const vehicles = [];
      for (let n = 0; n < 30; n++) vehicles.push({ uuid: `u${n}`, name: `Ship ${n}`, manufacturer: 'Anvil Aerospace' });
      client.searchVehicles.mockResolvedValue({ ok: true, data: { vehicles } });
      const i = acInteraction({ value: 'shi' });
      await cmd.autocomplete(i, ctx);
      expect(client.searchVehicles).toHaveBeenCalledWith('shi', expect.objectContaining({ limit: 25 }));
      const opts = client.searchVehicles.mock.calls[0][1];
      expect(opts.timeoutMs).toBeGreaterThan(0);
      expect(opts.timeoutMs).toBeLessThan(3000);
      const choices = i.respond.mock.calls[0][0];
      expect(choices).toHaveLength(25);
      expect(choices[0]).toEqual({ name: 'Ship 0 (Anvil Aerospace)', value: 'u0' });
    });

    test('choice names and values are clamped to 100 chars', async () => {
      client.searchVehicles.mockResolvedValue({ ok: true, data: { vehicles: [{ uuid: 'u'.repeat(150), name: 'N'.repeat(150) }] } });
      const i = acInteraction();
      await cmd.autocomplete(i, ctx);
      const [c] = i.respond.mock.calls[0][0];
      expect(c.name.length).toBeLessThanOrEqual(100);
      expect(c.value.length).toBeLessThanOrEqual(100);
    });

    test('add: error -> []', async () => {
      client.searchVehicles.mockResolvedValue({ ok: false, error: 'unavailable', message: 'm' });
      const i = acInteraction();
      await cmd.autocomplete(i, ctx);
      expect(i.respond).toHaveBeenCalledWith([]);
    });

    test('add: a throw -> []', async () => {
      client.searchVehicles.mockRejectedValue(new Error('boom'));
      const i = acInteraction();
      await cmd.autocomplete(i, ctx);
      expect(i.respond).toHaveBeenCalledWith([]);
    });

    test('rename/remove: choices from the invoker hangar (value=shipId, name=nickname + model), filtered', async () => {
      client.getHangar.mockResolvedValue({ ok: true, data: { ships: [
        ship({ shipId: 's1', nickname: 'Betty', vehicleName: 'Vanguard Harbinger' }),
        ship({ shipId: 's2', nickname: null, vehicleName: 'Constellation Taurus' }),
      ] } });
      const i = acInteraction({ sub: 'remove', value: '' });
      await cmd.autocomplete(i, ctx);
      expect(client.getHangar).toHaveBeenCalledWith(SELF, expect.objectContaining({ timeoutMs: expect.any(Number) }));
      expect(i.respond.mock.calls[0][0]).toEqual([
        { name: 'Betty (Vanguard Harbinger)', value: 's1' },
        { name: 'Constellation Taurus', value: 's2' },
      ]);
      const i2 = acInteraction({ sub: 'rename', value: 'conste' });
      await cmd.autocomplete(i2, ctx);
      expect(i2.respond.mock.calls[0][0]).toEqual([{ name: 'Constellation Taurus', value: 's2' }]);
    });

    test("rename/remove: uses the target member's hangar when member is set", async () => {
      client.getHangar.mockResolvedValue({ ok: true, data: { ships: [] } });
      const i = acInteraction({ sub: 'rename', member: OTHER, userId: ADMIN });
      await cmd.autocomplete(i, ctx);
      expect(client.getHangar).toHaveBeenCalledWith(OTHER, expect.any(Object));
    });

    test('rename/remove: error -> []', async () => {
      client.getHangar.mockResolvedValue({ ok: false, error: 'unavailable', message: 'm' });
      const i = acInteraction({ sub: 'remove' });
      await cmd.autocomplete(i, ctx);
      expect(i.respond).toHaveBeenCalledWith([]);
    });

    test('unrelated focused option or no client -> []', async () => {
      const i = acInteraction({ focused: 'nickname' });
      await cmd.autocomplete(i, ctx);
      expect(i.respond).toHaveBeenCalledWith([]);
      const i2 = acInteraction();
      await new HangarSlashCommand(null).autocomplete(i2, ctx);
      expect(i2.respond).toHaveBeenCalledWith([]);
    });

    test('a failing respond (expired interaction) does not throw', async () => {
      const i = acInteraction();
      i.respond.mockRejectedValue(new Error('Unknown interaction'));
      await expect(cmd.autocomplete(i, ctx)).resolves.toBeUndefined();
    });
  });
});
