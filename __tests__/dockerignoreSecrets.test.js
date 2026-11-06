// Docker ignore patterns are ROOT-ANCHORED (unlike .gitignore): `*-key.json`
// only matches a key at the context root. In Aug 2026 that let
// agent-sidecar/genai-sa-key.json ride the bot's `COPY . .` into PUBLIC Docker
// Hub images, and the leaked Vertex key was abused in Nov 2026. Every build
// context must exclude secret files at ANY depth with `**/` patterns.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const CONTEXTS = [
  '.dockerignore',
  'agent-sidecar/.dockerignore',
  'voice-sidecar/.dockerignore',
  'sc-knowledge/.dockerignore',
  'hangar-service/Dockerfile.dockerignore',
];

const REQUIRED = [
  '**/.env*',
  '**/*key*.json',
  '**/*.pem',
  '**/*.key',
  '**/credentials*.json',
  '**/*service_account*',
];

function patterns(file) {
  return fs
    .readFileSync(path.join(ROOT, file), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

describe('Docker build contexts exclude secrets at any depth', () => {
  test.each(CONTEXTS)('%s carries every **/ secret pattern', (file) => {
    const p = patterns(file);
    for (const req of REQUIRED) {
      expect(p).toContain(req);
    }
  });

  test.each(CONTEXTS)('%s never re-includes a secret pattern', (file) => {
    const negated = patterns(file).filter((l) => l.startsWith('!'));
    for (const n of negated) {
      expect(n).not.toMatch(/key.*\.json|\.pem$|credentials|service_account/i);
      // .env.example is the one allowed .env re-include
      if (/\.env/.test(n)) expect(n).toBe('!.env.example');
    }
  });
});
