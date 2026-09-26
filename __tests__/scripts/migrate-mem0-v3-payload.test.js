// __tests__/scripts/migrate-mem0-v3-payload.test.js
const { legacyEntityPatch, migrateCollection } = require('../../scripts/migrate-mem0-v3-payload');

describe('legacyEntityPatch', () => {
  it('maps mem0ai v2 camelCase entity keys to v3 snake_case', () => {
    expect(legacyEntityPatch({ userId: 'u1', agentId: 'a1', runId: 'r1', data: 'x' }))
      .toEqual({ user_id: 'u1', agent_id: 'a1', run_id: 'r1' });
  });

  it('only includes keys that are present', () => {
    expect(legacyEntityPatch({ userId: 'channel:1', data: 'x' })).toEqual({ user_id: 'channel:1' });
  });

  it('returns null when the point is already migrated', () => {
    expect(legacyEntityPatch({ userId: 'u1', user_id: 'u1' })).toBeNull();
  });

  it('never overwrites an existing snake_case key with a different legacy value', () => {
    expect(legacyEntityPatch({ userId: 'u1', user_id: 'u1', agentId: 'a1' })).toEqual({ agent_id: 'a1' });
  });

  it('returns null for points with no legacy entity keys (v3-written)', () => {
    expect(legacyEntityPatch({ user_id: 'u1', data: 'x' })).toBeNull();
    expect(legacyEntityPatch({})).toBeNull();
    expect(legacyEntityPatch(null)).toBeNull();
  });
});

describe('migrateCollection', () => {
  function fakeClient(pages) {
    let call = 0;
    return {
      scroll: jest.fn(async () => pages[call++]),
      setPayload: jest.fn(async () => ({})),
    };
  }

  const pages = [
    {
      points: [
        { id: 'p1', payload: { userId: 'u1', agentId: 'a1', data: 'likes vim' } },
        { id: 'p2', payload: { user_id: 'u2', data: 'already v3' } },
      ],
      next_page_offset: 'p3',
    },
    {
      points: [{ id: 'p3', payload: { userId: 'channel:9', agentId: 'shared_channel', runId: '9' } }],
      next_page_offset: null,
    },
  ];

  it('dry run counts but does not write', async () => {
    const client = fakeClient(pages);
    const stats = await migrateCollection(client, 'discord_memories', { apply: false });
    expect(stats).toEqual({ scanned: 3, needsMigration: 2, migrated: 0 });
    expect(client.setPayload).not.toHaveBeenCalled();
  });

  it('apply sets the snake_case keys on each legacy point (legacy keys are kept for rollback)', async () => {
    const client = fakeClient(pages);
    const stats = await migrateCollection(client, 'discord_memories', { apply: true });
    expect(stats).toEqual({ scanned: 3, needsMigration: 2, migrated: 2 });
    expect(client.setPayload).toHaveBeenCalledWith('discord_memories', {
      payload: { user_id: 'u1', agent_id: 'a1' }, points: ['p1'], wait: true,
    });
    expect(client.setPayload).toHaveBeenCalledWith('discord_memories', {
      payload: { user_id: 'channel:9', agent_id: 'shared_channel', run_id: '9' }, points: ['p3'], wait: true,
    });
    expect(client.scroll).toHaveBeenLastCalledWith('discord_memories', expect.objectContaining({ offset: 'p3' }));
  });
});
