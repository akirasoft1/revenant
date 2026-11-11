# Voice (discord-article-bot-voice sidecar)

Moved verbatim from the root `AGENTS.md` on 2026-11-11 so that file stays under the 24 KB per-file limit some agents enforce. Claude Code imports this file through the root `CLAUDE.md`; other agents should read it before changing voice code on either side.

## Voice (discord-article-bot-voice sidecar)

When `VOICE_ENABLED=true`, `/voice join` puts the bot in a Discord voice channel and routes audio through a **second, separate** Python gRPC sidecar — `discord-article-bot-voice` — that hosts one Gemini Live session per active voice channel. It is a distinct Deployment from the agent sandbox sidecar (`discord-article-bot-agent`): they solve different problems and have opposite scaling needs.

**New-sidecar rationale (RollingUpdate/scalable vs. the agent sidecar's Recreate/do-not-scale):** the agent sidecar keeps sandbox-orchestration concurrency state in-process, so it must stay single-replica `Recreate` and never scale. The voice sidecar instead holds long-lived, real-time gRPC audio streams for as long as the bot sits in a voice channel — a `Recreate` rollout would drop every live call. It ships as its own `RollingUpdate`, horizontally scalable Deployment (`k8s/voice/voice-deployment.yaml`) for exactly that reason.

**Where the detail lives (moved out of this file 2026-10-12 — read the matching file BEFORE changing that area):**
- `docs/voice.md` — the bot side (`services/VoiceService.js`, `services/voice/`, `commands/slash/voice.js`): wake word, VAD, turn rhythm, floor control, pre-roll, session-open recovery, `/voice` commands, speaker-name resolution, Phase 4 deferral, voice control commands, tunables, the deploy checklist and the real-model smoke tests. **Nothing auto-loads it for `services/VoiceService.js`.**
- `voice-sidecar/AGENTS.md` — the sidecar side: GEAP backend, Live model, session resumption and compression, grounding logs, speaker markers, hangar edit plumbing.

**Rules to know without opening them (short form; the reasons are in the files above):**
- **Live model: `gemini-3.8-live`, which serves ONLY in `us-central1` on this project** — the voice sidecar sets `GOOGLE_CLOUD_LOCATION=us-central1` while the agent sidecar stays on `global`. Changing `VOICE_LIVE_MODEL` means re-checking the location and re-running `scripts/smoke-voice-sc.js`, `smoke-voice-control.js` and `smoke-voice-identity.js`.
- **3.8-live follows prompts literally.** The persona note must NOT say "never mention that you receive it" about the `[SPEAKER: …]` marker (the model then refuses to say who is speaking); a test in `__tests__/services/VoiceService.test.js` pins the wording.
- **Deploy from `k8s/overlays/deployed/` only. Do NOT run `kubectl apply -f k8s/voice/`:** the tracked manifest is pinned to the placeholder tag `REPLACE_WITH_SHA`, so the rollout stalls in `ImagePullBackOff` and the Service and NetworkPolicy revert to placeholders. Full checklist: `docs/voice.md`.
- **The voice sidecar loads sc-knowledge tool declarations once at startup** — restart it after adding or changing an `sc_*` tool.
- **Phase 4 deferral is off** (`VOICE_DEFERRAL_ENABLED` default false). It needs `VOICE_ALLOW_BARGE_IN=true`, and the 700 ms default threshold sits below the ~768 ms VAD-hangover noise floor — read `docs/voice.md` "Turn deferral" before measuring or enabling it. Spec: `docs/superpowers/specs/2026-08-14-voice-phase4-deferral-design.md`.
- **Voice control commands** ("that's all", "go quiet for ten minutes", `/voice resume`): a pending command executes only after the spoken confirmation has played, never on the bare `turnComplete` of the tool-call turn. Spec: `docs/superpowers/specs/2026-09-27-voice-control-commands-design.md`.
- **`VOICE_MAX_SESSION_SECONDS` (default 600) is a hard cap** that ends every session, including `/voice listen`, regardless of resumption.
- **Stale audio is never replayed:** frames that arrive during a reconnect are dropped, and `g.pending` is bounded drop-NEWEST (the pre-roll is drop-oldest; the difference is deliberate).

**Bot image base — Debian slim (glibc), NOT Alpine:** `@discordjs/voice` ^0.19.0 requires Node ≥22.12. The repo-root `Dockerfile` uses Node 24 LTS on Debian — `node:24-trixie` (build stage) / `node:24-trixie-slim` (runtime) — NOT Alpine (musl): `onnxruntime-node` (the openWakeWord engine) ships glibc-only prebuilt binaries (`libc.so.6`/`libm.so.6`, GLIBC_* symbol versions) with no musl variant, so it fails to load on Alpine. The same applies to the other native modules in the image: `@discordjs/opus`, `sodium-native`, and `better-sqlite3` (mem0ai v3 loads it on import even with history disabled). Any manual/local run of the bot needs Node ≥22.12.0 on glibc.

**Manifests:** `k8s/voice/` (tracked) — see its README for the apply order, the required bot ConfigMap/Secret/NetworkPolicy edits, and the build/push command.
