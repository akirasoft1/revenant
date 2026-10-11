# Voice Sidecar Manifests

These manifests support `discord-article-bot-voice`, the Python gRPC sidecar
that hosts a Gemini Live voice session per active Discord voice channel (see
`docs/superpowers/specs/2026-08-06-discord-voice-live-design.md`).

## Why a separate sidecar (not folded into the agent sidecar)

The agent sidecar (`discord-article-bot-agent`) is a single-replica
`Recreate` Deployment — its sandbox-orchestration concurrency state lives
in-process, so it must never scale and can drop connections during a
redeploy without losing anything long-lived. The voice sidecar holds
long-lived, real-time gRPC streams (audio in/out, Gemini Live session state)
for as long as the bot is in a voice channel; a `Recreate` rollout would drop
every active call. It ships as its own `RollingUpdate`, horizontally
scalable Deployment instead.

## `dynatrace.com/inject` — not disabled here

The Kata sandbox pods (`k8s/sandbox/`) disable OneAgent injection because
ephemeral guests don't release PID 1 cleanly under it, ballooning per-call
wall clock. That doesn't apply here: this is a long-lived,
observability-first service, same posture as `discord-article-bot-agent`
(whose deployed manifest also does not set the annotation). Injection stays
enabled so OneAgent and this pod's own OTLP spans both reach Dynatrace.

## Files

| File | Purpose |
|---|---|
| `voice-deployment.yaml` | Sidecar Deployment (`RollingUpdate`, scalable). Bump `.image` to a git short-SHA at deploy time. `VOICE_LIVE_MODEL` is set to `gemini-3.8-live` with `GOOGLE_CLOUD_LOCATION=us-central1` (the model serves only in `us-central1` on this project; the agent sidecar stays on `global`); override via env only if the model changes. `SC_KNOWLEDGE_ENABLED` (default `"false"`) + `SC_KNOWLEDGE_URL` attach the sc-knowledge Star Citizen tools to Live as function declarations; flip to true only after sc-knowledge is deployed. `VOICE_CONTROL_TOOLS_ENABLED` (default `"true"` when unset) declares the local `end_conversation`/`go_quiet` voice-control tools to Live (independent of the SC tools); set `"false"` to stop declaring them — the bot's phrase backstop (`VOICE_CONTROL_COMMANDS_ENABLED`, bot env) still works without them. |
| `voice-service.yaml` | ClusterIP Service exposing the sidecar's gRPC port (50051). |
| `voice-networkpolicy.yaml` | Egress: kube-dns, GEAP/Vertex AI (`aiplatform.googleapis.com`, public 443 minus RFC1918), Dynatrace OTLP (4317/4318), sc-knowledge pods (`app: sc-knowledge`, TCP 8080 -- in-cluster RFC1918, so the public-443 rule would not cover it). Ingress only from the bot pod on 50051. |

## Apply order

**Apply from the deployed overlay, NOT from this directory.** The manifests here are
tracked templates: `voice-deployment.yaml` is pinned to the literal placeholder
`REPLACE_WITH_SHA`, which does not exist on Docker Hub. `kubectl apply -f k8s/voice/`
therefore rewrites the live deployment's image to a broken tag (stalling the rollout in
`ImagePullBackOff`) and reverts the deployed Service and NetworkPolicy to their placeholder
forms. See "Real values live in the gitignored deployed overlay" below.

```bash
# Full apply (first install, or when Service/NetworkPolicy change):
kubectl apply -f k8s/overlays/deployed/voice-deployment.yaml \
              -f k8s/overlays/deployed/voice-service.yaml \
              -f k8s/overlays/deployed/voice-networkpolicy.yaml \
              -n discord-article-bot

# Image-only update (the usual case):
kubectl set image deployment/discord-article-bot-voice \
  voice=mvilliger/discord-article-bot-voice:<git-short-sha> -n discord-article-bot

kubectl rollout status deployment/discord-article-bot-voice -n discord-article-bot --timeout=120s
kubectl logs deployment/discord-article-bot-voice -n discord-article-bot | tail -20
# expect: "voice sidecar listening on 0.0.0.0:50051"
```

## Real values live in the gitignored deployed overlay

The image tag is tracked as a placeholder:

- `image: mvilliger/discord-article-bot-voice:REPLACE_WITH_SHA`

Substitute the real git short-SHA in the working copy under
`k8s/overlays/deployed/` (gitignored, contains real secrets) before applying —
never commit the resolved SHA here.

`VOICE_LIVE_MODEL` is set to `gemini-3.8-live` (since 2026-10-10; it was
`gemini-live-2.5-flash` before). On project `revenant-discord-bot-2` that model
serves **only in `us-central1`** (404 in `global`, `us-east4`, `europe-west4`),
so this Deployment sets `GOOGLE_CLOUD_LOCATION=us-central1` -- unlike the agent
sidecar, which stays on `global`. Changing the model means changing the
location with it. A 2026-10-10 smoke spike chose it over 2.5-flash: no
`[SPEAKER: ...]` marker leaks, no spoken citation brackets, reliable
`end_conversation`, one `sc_*` call per question. Both are non-secret, so
they're baked in here.

## No new secrets

Both `agent-genai-sa` (mounted at `/var/secrets/genai/key.json` for GEAP
ADC) and `agent-sa` (`serviceAccountName`) are reused verbatim from the
agent sidecar. Nothing new to create in the cluster for this Deployment.

## Required modifications to existing manifests

Two small additions to the bot's own manifests (working copies in the
gitignored `k8s/overlays/deployed/`; diffs reproduced here for
traceability — same pattern as `k8s/sandbox/README.md`).

### `configmap.yaml` (bot)

Add to the bot's ConfigMap:

```yaml
VOICE_ENABLED: "true"
VOICE_GRPC_ADDR: "discord-article-bot-voice.discord-article-bot.svc.cluster.local:50051"
```

Wake-word detection uses **openWakeWord** — keyless and fully offline. No secret
is required. The pretrained ONNX models are vendored under `models/openwakeword/`
and baked into the bot image (`COPY . .`; `models/` is not in `.dockerignore`),
so there is nothing to mount. Optional overrides: `VOICE_WAKE_WORD` (label,
default `hey jarvis`), `VOICE_WAKE_MODEL` / `VOICE_MEL_MODEL` /
`VOICE_EMBEDDING_MODEL` (model paths), `VOICE_WAKE_THRESHOLD` (default `0.5`).
Available pretrained phrases: hey jarvis, alexa, hey mycroft, hey rhasspy.

> **Bot image base:** the bot `Dockerfile` must be `node:22-slim` (Debian/glibc),
> NOT `node:22-alpine` — `onnxruntime-node` ships glibc-only prebuilt binaries and
> will not load on musl/Alpine.

### `networkpolicy.yaml` (bot)

Append an egress rule allowing the bot to reach the voice sidecar's gRPC
port (mirrors the existing "bot -> agent sidecar" rule):

```yaml
    # Allow bot -> voice sidecar gRPC
    - to:
        - podSelector:
            matchLabels:
              app: discord-article-bot-voice
      ports:
        - protocol: TCP
          port: 50051
```

## Build and push

```bash
SHA=$(git rev-parse --short HEAD)
docker build -f voice-sidecar/Dockerfile -t mvilliger/discord-article-bot-voice:$SHA voice-sidecar/
docker push mvilliger/discord-article-bot-voice:$SHA
```

## Smoke test

After deploying both the voice sidecar and the bot (with `VOICE_ENABLED=true`)
and running `node scripts/registerCommands.js`:

1. In Discord: `/voice join`
2. Say "hey jarvis, what's 2 + 2" — expect a spoken reply.
3. Run `/tldr` and confirm the voice exchange appears as a transcript.
