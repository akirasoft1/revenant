jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const path = require('path');
const { EventEmitter } = require('events');
const VoiceClient = require('../../services/VoiceClient');

const PROTO = path.join(__dirname, '..', '..', 'proto', 'voice.proto');

function makeClient() {
  return new VoiceClient({ address: '127.0.0.1:0', protoPath: PROTO });
}

// Monkey-patches the RPC methods on the client's real _stub in place (matching
// the AgentClient.test.js pattern), rather than replacing _stub wholesale, so
// that close() still reaches the genuine gRPC channel created in the
// constructor.
function stubConverse(c, fakeCall) {
  c._stub.Converse = () => fakeCall;
  c._stub.Health = (r, o, cb) => cb(null, { healthy: true });
}

function makeFakeCall() {
  const fakeCall = new EventEmitter();
  fakeCall.write = jest.fn();
  fakeCall.end = jest.fn();
  return fakeCall;
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
    const fakeCall = makeFakeCall();
    stubConverse(c, fakeCall);

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

  test('sendStart maps camelCase fields to snake_case with defaults', () => {
    const c = makeClient();
    const fakeCall = makeFakeCall();
    stubConverse(c, fakeCall);

    const session = c.converse();
    session.sendStart({
      userId: 'u', channelId: 'c', recallContext: 'past', voiceName: 'Kore',
    });

    expect(fakeCall.write).toHaveBeenCalledWith({
      session_start: {
        user_id: 'u',
        user_tag: '',
        channel_id: 'c',
        guild_id: '',
        system_prompt: '',
        recall_context: 'past',
        voice_name: 'Kore',
      },
    });
    c.close();
  });

  test('inputTranscript, interrupted, and error server events map correctly', () => {
    const c = makeClient();
    const fakeCall = makeFakeCall();
    stubConverse(c, fakeCall);

    const session = c.converse();
    const seen = {};
    session.on('inputTranscript', (t) => { seen.in = t; });
    session.on('interrupted', () => { seen.interrupted = true; });
    session.on('error', (e) => { seen.error = e; });

    fakeCall.emit('data', { input_transcript: { text: 'hello' }, event: 'input_transcript' });
    fakeCall.emit('data', { interrupted: {}, event: 'interrupted' });
    fakeCall.emit('data', { error: { message: 'boom' }, event: 'error' });

    expect(seen.in).toBe('hello');
    expect(seen.interrupted).toBe(true);
    expect(seen.error).toBeInstanceOf(Error);
    expect(seen.error.message).toBe('boom');
    c.close();
  });

  test('call-level error and end are forwarded to the session', () => {
    const c = makeClient();
    const fakeCall = makeFakeCall();
    stubConverse(c, fakeCall);

    const session = c.converse();
    const seen = {};
    session.on('error', (e) => { seen.error = e; });
    session.on('end', () => { seen.ended = true; });

    const callErr = new Error('call blew up');
    fakeCall.emit('error', callErr);
    fakeCall.emit('end');

    expect(seen.error).toBe(callErr);
    expect(seen.ended).toBe(true);
    c.close();
  });

  test('sendAudio writes an audio chunk and end() sends session_end then closes the call', () => {
    const c = makeClient();
    const fakeCall = makeFakeCall();
    stubConverse(c, fakeCall);

    const session = c.converse();
    const buf = Buffer.from([9, 8, 7]);
    session.sendAudio(buf);
    expect(fakeCall.write).toHaveBeenCalledWith({ audio: { pcm: buf } });

    session.end();
    expect(fakeCall.write).toHaveBeenCalledWith({ session_end: {} });
    expect(fakeCall.end).toHaveBeenCalled();
    c.close();
  });
});
