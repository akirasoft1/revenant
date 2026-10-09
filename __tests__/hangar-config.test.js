// __tests__/hangar-config.test.js
describe('hangar config', () => {
  beforeEach(() => { jest.resetModules(); });
  afterEach(() => {
    delete process.env.HANGAR_API_URL;
    delete process.env.HANGAR_SA_KEY_PATH;
  });

  it('is off by default with the standard key path', () => {
    delete process.env.HANGAR_API_URL;
    delete process.env.HANGAR_SA_KEY_PATH;
    const config = require('../config/config');
    expect(config.hangar.apiUrl).toBe('');
    expect(config.hangar.saKeyPath).toBe('/var/secrets/hangar/key.json');
  });

  it('reads HANGAR_API_URL and HANGAR_SA_KEY_PATH', () => {
    process.env.HANGAR_API_URL = 'https://hangar-service-hvmf2jpuca-uc.a.run.app';
    process.env.HANGAR_SA_KEY_PATH = '/tmp/k.json';
    const config = require('../config/config');
    expect(config.hangar.apiUrl).toBe('https://hangar-service-hvmf2jpuca-uc.a.run.app');
    expect(config.hangar.saKeyPath).toBe('/tmp/k.json');
  });

  it('exports HangarSlashCommand from the slash index', () => {
    const { HangarSlashCommand } = require('../commands/slash');
    expect(new HangarSlashCommand(null).name).toBe('hangar');
  });
});
