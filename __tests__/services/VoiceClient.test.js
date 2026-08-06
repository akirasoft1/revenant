jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const path = require('path');
const VoiceClient = require('../../services/VoiceClient');

const PROTO = path.join(__dirname, '..', '..', 'proto', 'voice.proto');

function makeClient() {
  return new VoiceClient({ address: '127.0.0.1:0', protoPath: PROTO });
}

describe('VoiceClient', () => {
  test('isHealthy false before any successful health check', () => {
    const c = makeClient();
    c._lastHealthyAt = 0;
    expect(c.isHealthy()).toBe(false);
    c.close();
  });

  test('converse maps server events to emitter events', (done) => {
    const c = makeClient();
    // Fake the underlying bidi call.
    const { EventEmitter } = require('events');
    const fakeCall = new EventEmitter();
    fakeCall.write = jest.fn();
    fakeCall.end = jest.fn();
    c._stub = { Converse: () => fakeCall, Health: (r, o, cb) => cb(null, { healthy: true }) };

    const session = c.converse();
    const seen = {};
    session.on('outputTranscript', (t) => { seen.out = t; });
    session.on('audio', (b) => { seen.audio = b; });
    session.on('turnComplete', () => {
      expect(seen.out).toBe('hi');
      expect(Buffer.isBuffer(seen.audio)).toBe(true);
      c.close(); done();
    });

    session.sendStart({ userId: 'u' });
    expect(fakeCall.write).toHaveBeenCalled();
    fakeCall.emit('data', { output_transcript: { text: 'hi' }, event: 'output_transcript' });
    fakeCall.emit('data', { audio: { pcm: Buffer.from([1, 2]) }, event: 'audio' });
    fakeCall.emit('data', { turn_complete: {}, event: 'turn_complete' });
  });
});
