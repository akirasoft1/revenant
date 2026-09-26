# sandbox-base

Container image used by the agent-sidecar to spawn ephemeral execution pods.

## Build

```bash
docker build -t mvilliger/sandbox-base:$(git rev-parse --short HEAD) .
docker tag  mvilliger/sandbox-base:$(git rev-parse --short HEAD) mvilliger/sandbox-base:latest
docker push mvilliger/sandbox-base:$(git rev-parse --short HEAD)
docker push mvilliger/sandbox-base:latest
```

## Local smoke test

```bash
echo '{"language":"python","code":"print(2+2)"}' \
  | docker run --rm -i mvilliger/sandbox-base:latest
```

Expected: `4`, exit 0.

```bash
echo '{"language":"bash","code":"curl -s https://example.com | head -1"}' \
  | docker run --rm -i mvilliger/sandbox-base:latest
```

Expected: HTML doctype line, exit 0.

## Image contents

Base: `debian:13-slim` (trixie; moved from Debian 12 on 2026-09-26).

- python3, node 20, go, rust stable, .NET 8 SDK
- build-essential, git, jq, ripgrep
- nmap, dig, nc
- ollama (binary only; pull models at runtime via `ollama pull <model>`)

The image is ~8Gi. Pulled once per K8s node and cached. Plan node-pull time accordingly on first deployment.

## Security properties

- Runs as uid 65534 (nobody). Every language runner genuinely works as that user under a read-only root with tmpfs `/tmp` and `/work`: rust is installed under `/usr/local` (it used to live under unreadable `/root`), and `HOME` plus the go/dotnet caches point at `/tmp` (nobody's home is `/nonexistent`). Before 2026-09-26 rust, go and csharp silently failed as uid 65534. .NET 8 SDK reaches EOL in November 2026 — move to .NET 10 LTS separately.
- No shell-escape pre-baked configuration. The `executor` is the only entrypoint.
- Image is consumed only by sandbox K8s pods that disable SA token automount,
  drop all capabilities, run with `readOnlyRootFilesystem: true`, and select
  `runtimeClassName: kata-qemu` (each pod lands in its own tiny VM).
