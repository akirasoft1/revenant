const path = require('path');
const protoLoader = require('@grpc/proto-loader');
const grpc = require('@grpc/grpc-js');

test('voice.proto loads and exposes the Voice service', () => {
  const def = protoLoader.loadSync(path.join(__dirname, '..', '..', 'proto', 'voice.proto'), {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(def).discordbot.voice;
  expect(typeof proto.Voice).toBe('function');
  expect(proto.Voice.service.Converse).toBeDefined();
  expect(proto.Voice.service.Converse.requestStream).toBe(true);
  expect(proto.Voice.service.Converse.responseStream).toBe(true);
});
