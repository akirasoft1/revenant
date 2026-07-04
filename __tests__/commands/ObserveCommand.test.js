// __tests__/commands/ObserveCommand.test.js
const ObserveCommand = require('../../commands/slash/ObserveCommand');

function makeInteraction(sub, opts) {
  return {
    options: {
      getSubcommand: () => sub,
      getString: (n) => opts[n],
    },
    user: { id: 'admin1', tag: 'admin#1' },
    deferReply: jest.fn().mockResolvedValue(),
    editReply: jest.fn().mockResolvedValue(),
    replied: false,
    deferred: true,
  };
}

describe('ObserveCommand', () => {
  it('is admin-only', () => {
    const cmd = new ObserveCommand({});
    expect(cmd.adminOnly).toBe(true);
  });

  it('ask subcommand calls adminObserve and replies with the answer', async () => {
    const agentClient = { adminObserve: jest.fn().mockResolvedValue({ answerText: '2 errors', dqlUsed: '', error: '' }) };
    const cmd = new ObserveCommand(agentClient);
    const interaction = makeInteraction('ask', { question: 'errors?' });
    await cmd.execute(interaction, { config: {} });
    expect(agentClient.adminObserve).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin1', question: 'errors?' }),
    );
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('2 errors'));
  });

  it('dql subcommand calls runDql and formats rows', async () => {
    const agentClient = { runDql: jest.fn().mockResolvedValue({ rowsJson: '[{"c":1}]', columns: '["c"]', error: '' }) };
    const cmd = new ObserveCommand(agentClient);
    const interaction = makeInteraction('dql', { query: 'fetch spans | limit 1' });
    await cmd.execute(interaction, { config: {} });
    expect(agentClient.runDql).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'fetch spans | limit 1' }),
    );
    expect(interaction.editReply).toHaveBeenCalled();
  });

  it('surfaces backend error text', async () => {
    const agentClient = { adminObserve: jest.fn().mockResolvedValue({ answerText: '', dqlUsed: '', error: 'backend down' }) };
    const cmd = new ObserveCommand(agentClient);
    const interaction = makeInteraction('ask', { question: 'x' });
    await cmd.execute(interaction, { config: {} });
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
  });

  it('degrades gracefully when the agent sidecar is disabled (null agentClient)', async () => {
    // AGENT_ENABLED=false leaves bot.js's this.agentClient as null (see bot.js
    // constructor around line 181/193). Calling agentClient.adminObserve on
    // null throws a TypeError; execute() must catch it and reply with the
    // "unavailable" message instead of throwing an unhandled error.
    const cmd = new ObserveCommand(null);
    const interaction = makeInteraction('ask', { question: 'errors?' });
    await expect(cmd.execute(interaction, { config: {} })).resolves.toBeUndefined();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
  });
});
