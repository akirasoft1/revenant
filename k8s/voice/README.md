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
| `voice-deployment.yaml` | Sidecar Deployment (`RollingUpdate`, scalable). Bump `.image` to a git short-SHA and `VOICE_LIVE_MODEL` to the Task-1-probe-validated model at deploy time. |
| `voice-service.yaml` | ClusterIP Service exposing the sidecar's gRPC port (50051). |
| `voice-networkpolicy.yaml` | Egress: kube-dns, GEAP/Vertex AI (`aiplatform.googleapis.com`, public 443 minus RFC1918), Dynatrace OTLP (4317/4318). Ingress only from the bot pod on 50051. |

## Apply order

```bash
kubectl apply -f k8s/voice/ -n discord-article-bot
kubectl rollout status deployment/discord-article-bot-voice -n discord-article-bot --timeout=120s
kubectl logs deployment/discord-article-bot-voice -n discord-article-bot | tail -20
# expect: "voice sidecar listening on 0.0.0.0:50051"
```

## Real values live in the gitignored deployed overlay

The manifests here are tracked with placeholders:

- `image: mvilliger/discord-article-bot-voice:REPLACE_WITH_SHA`
- `VOICE_LIVE_MODEL: REPLACE_WITH_VALIDATED_MODEL`

Substitute the real git short-SHA and the model ID confirmed by the Task 1
GEAP pre-flight probe in the working copy under `k8s/overlays/deployed/`
(gitignored, contains real secrets) before applying — never commit the
resolved values here.

## No new secrets

Both `agent-genai-sa` (mounted at `/var/secrets/genai/key.json` for GEAP
ADC) and `agent-sa` (`serviceAccountName`) are reused verbatim from the
agent sidecar. Nothing new to create in the cluster for this Deployment.

## Required modifications to existing manifests

Two small additions to the bot's own manifests (working copies in the
gitignored `k8s/overlays/deployed/`; diffs reproduced here for
traceability — same pattern as `k8s/sandbox/README.md`).

### `configmap.yaml` / secrets (bot)

Add to the bot's ConfigMap (or Secret, for the Picovoice key):

```yaml
VOICE_ENABLED: "true"
VOICE_GRPC_ADDR: "discord-article-bot-voice.discord-article-bot.svc.cluster.local:50051"
```

```yaml
# discord-article-bot-secrets
PICOVOICE_ACCESS_KEY: "<key from Picovoice console>"
```

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

After deploying both the voice sidecar and the bot (with `VOICE_ENABLED=true`
and `PICOVOICE_ACCESS_KEY` set) and running `node scripts/registerCommands.js`:

1. In Discord: `/voice join`
2. Say "computer, what's 2 + 2" — expect a spoken reply.
3. Run `/tldr` and confirm the voice exchange appears as a transcript.
