const path = require('path');

jest.mock('../../logger', () => ({
  warn: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}));

const AgentClient = require('../../services/AgentClient');

describe('AgentClient', () => {
  let client;

  afterEach(() => {
    if (client) {
      client.close();
      client = null;
    }
  });

  it('reports unhealthy when sidecar unreachable', async () => {
    client = new AgentClient({
      address: '127.0.0.1:65535',
      protoPath: path.join(__dirname, '..', '..', 'proto', 'agent.proto'),
      healthIntervalMs: 50,
      unhealthyThresholdMs: 100,
      healthDeadlineMs: 50,
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(client.isHealthy()).toBe(false);
  });

  it('chat() rejects when unhealthy', async () => {
    client = new AgentClient({
      address: '127.0.0.1:65535',
      protoPath: path.join(__dirname, '..', '..', 'proto', 'agent.proto'),
      healthIntervalMs: 50,
      unhealthyThresholdMs: 100,
      healthDeadlineMs: 50,
    });
    await new Promise((r) => setTimeout(r, 250));
    await expect(
      client.chat({
        userId: 'u',
        userTag: 'u#0',
        channelId: 'c',
        guildId: 'g',
        interactionId: 'i',
        userMessage: 'hi',
        imageUrl: '',
      }),
    ).rejects.toThrow(/sidecar unhealthy/);
  });
});

function makeClient() {
  const client = new AgentClient({
    address: 'localhost:1',
    protoPath: path.join(__dirname, '../../proto/agent.proto'),
  });
  client._lastHealthyAt = Date.now(); // force healthy
  return client;
}

describe('AgentClient.adminObserve', () => {
  it('maps snake_case response to camelCase', async () => {
    const client = makeClient();
    client._stub.Observe = (req, opts, cb) =>
      cb(null, { answer_text: '2 errors', dql_used: 'fetch spans', error: '' });
    const res = await client.adminObserve({ userId: 'u1', userTag: 't#1', question: 'errors?' });
    expect(res).toEqual({ answerText: '2 errors', dqlUsed: 'fetch spans', error: '' });
    client.close();
  });

  it('rejects when unhealthy', async () => {
    const client = makeClient();
    client._lastHealthyAt = 0;
    await expect(client.adminObserve({ userId: 'u1', question: 'x' })).rejects.toThrow('unhealthy');
    client.close();
  });
});

describe('AgentClient.runDql', () => {
  it('maps rows_json/columns', async () => {
    const client = makeClient();
    client._stub.RunDql = (req, opts, cb) =>
      cb(null, { rows_json: '[{"c":1}]', columns: '["c"]', error: '' });
    const res = await client.runDql({ userId: 'u1', query: 'fetch spans | limit 1' });
    expect(res).toEqual({ rowsJson: '[{"c":1}]', columns: '["c"]', error: '' });
    client.close();
  });
});
