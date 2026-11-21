# TypeScript migration assessment (Node bot)

Assessment only, written 2026-11-14. Nothing has been converted yet. Scope: the Node
bot (`bot.js`, `services/`, `commands/`, `handlers/`, `utils/`, `config/`,
`personalities/`, `scripts/`, `logger.js`, `tracing*.js`, `__tests__/`).
`hangar-editor/` is already TypeScript (Vite + tsc + Vitest) and the Python
sidecars are out of scope.

## Current state (as of v2.27.0)

- About 26.5k lines of app JS outside tests. The largest files are
  `services/VoiceService.js` (1.6k lines), `services/ChatService.js` (1.6k),
  `services/MongoService.js` (1.5k) and `bot.js` (1.3k). There are 81 test files,
  about 22k more lines.
- All CommonJS (`require`/`module.exports`). There is no tsconfig, no ESLint and
  no build step; the app runs as `node bot.js`.
- About 540 `@param` JSDoc tags give a head start on types.
- Library types: discord.js, openai, @google/genai, mongodb, mem0ai, rss-parser,
  prism-media, tiktoken and @discordjs/opus ship their own. `sodium-native` has
  none, but it is only a transitive voice dependency.

## Decisions

1. **Stay on CommonJS. Do not move to ESM as part of this.**
   - `bot.js` relies on `require('./tracing')` running before every other module.
     ESM loads all imports before any module code runs, so tracing would no
     longer run first.
   - The OTel auto-instrumentations and `@traceloop/instrumentation-openai` patch
     `require`. Under ESM they need an `--import` loader hook, or the LLM spans
     silently disappear from Dynatrace (the same failure the openai 6.x pin in
     `AGENTS.md` guards against).
   - Every `jest.mock(...)` (46 test files, mostly `logger`) would need rewriting
     to `jest.unstable_mockModule` plus dynamic imports.

   TS compiled with `"module": "commonjs"` keeps today's behaviour exactly.
2. **Compile with tsc to `dist/`; do not run `.ts` directly.** Node 24 can strip
   types natively, but it has limits (no enums or parameter properties, and it
   is picky about extensions with `require`). With tsc, Node and Jest behave the
   way they do today.

## What would break

- **Paths that assume the source tree.** Once code runs from `dist/`, each needs
  its assets copied into `dist/` or paths resolved from the repo root:
  - `bot.js` builds the `AgentClient`/`VoiceClient` `protoPath` with
    `path.join(__dirname, 'proto', ...)`.
  - `personalities/index.js` scans its own directory (`__dirname`) with
    `readdirSync` and loads every file ending in `.js`.
  - Personality `.txt` prompts and the wake-word ONNX models are read from disk.
- **gRPC has no types.** `@grpc/proto-loader` loads `proto/agent.proto` and
  `proto/voice.proto` at runtime. Its bundled `proto-loader-gen-types` can
  generate typed clients. Worth doing: these clients connect the bot to both
  sidecars.
- **Jest** needs `ts-jest` or `@swc/jest` and `moduleFileExtensions` that include
  `ts`. Mock paths have no extension, so they keep working. At least 6 tests
  refer to source files by their `.js` name or read source from disk and need
  updating: `regression.chatSlashThenReply`, `services/Mem0Service`,
  `scripts/genTestVoices`, `services/ChatService.buildTurnContext`,
  `services/voice/wakeword.integration`, `commands/ObserveCommand`.
- **Dockerfile:**
  - The builder runs `npm ci --omit=dev`, so it needs devDependencies to run
    `tsc`, then prunes them.
  - The runtime stage's `COPY . .` becomes a copy of `dist/` plus the assets
    above.
  - `CMD` becomes `node dist/bot.js`.
  - Re-run the scratch-build check that the `**/` secret and game-data ignore
    patterns still hold (`__tests__/dockerignoreSecrets.test.js` pins them).
- **Ops scripts.** The docs say to run `node scripts/registerCommands.js`,
  `seed-member-identities.js`, `migrate-mem0-v3-payload.js` and others from the
  bot pod. Either keep `scripts/` as JS, or update every doc reference to the
  `dist/` path. A wrong `registerCommands` run is dangerous: without
  `HANGAR_API_URL` it silently drops `/hangar`.

## Where most of the effort goes

- **MongoDB document types.** The shapes of `channel_messages`,
  `member_identities`, `recall_ledger`, `voice_profiles`, `sandbox_executions`,
  `ab_comparisons` and the rest are only implied by how the code uses them.
  Writing interfaces for them is the hardest and most useful part:
  `buildTurnContext` and `utils/channelMessageRecorder.js` depend on that exact
  document shape. This is the biggest unknown in the estimate.
- **`config/config.js`.** About 500 lines of `process.env` reads. Turning it into
  one typed object, ideally validated with zod, would catch env-name typos at
  startup (the `IMAGEGEN_*` versus `IMAGEN_*` kind of mistake).
- **Service constructors** that take many injected services. `strict` pays off
  most here.

## Suggested order

1. Add `tsconfig` (`allowJs`, `checkJs: false`, `strict: false`,
   `module: commonjs`, `outDir: dist`), the Jest transform and the Docker build
   stage. Ship that with no `.ts` files, to prove the build, tracing order and
   asset paths work. Deploy and confirm LLM spans still reach Dynatrace.
2. Convert the leaf modules: `utils/`, `logger`, `tracing*`, `config`.
3. Generate the gRPC types, then convert `AgentClient`, `VoiceClient` and
   `HangarClient`.
4. Add Mongo document types and convert `MongoService`.
5. Convert the other services, then `commands/`, then `handlers/`, then `bot.js`.
6. Turn on `strict` one directory at a time.
7. Convert the tests, then the scripts, last.
8. Update `AGENTS.md`, the files in `docs/agents/`, the per-directory `AGENTS.md`
   files and `docs/voice.md` / `docs/hangar.md`. They refer to many files by
   their `.js` path.

## Rough estimate

Step 1 is about a day. The full conversion is a few weeks of part-time work. The
Mongo document types are the biggest unknown.
