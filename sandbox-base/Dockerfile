# sandbox-base/Dockerfile
FROM debian:13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      nodejs npm \
      golang \
      build-essential \
      curl wget jq git ripgrep \
      nmap dnsutils netcat-openbsd \
      ca-certificates zstd \
    && rm -rf /var/lib/apt/lists/*

# .NET 8 SDK
RUN curl -fsSL https://packages.microsoft.com/config/debian/13/packages-microsoft-prod.deb \
      -o /tmp/ms.deb \
    && dpkg -i /tmp/ms.deb \
    && apt-get update \
    && apt-get install -y dotnet-sdk-8.0 \
    && rm /tmp/ms.deb && rm -rf /var/lib/apt/lists/*

# Rust — installed system-wide, NOT under /root: the sandbox runs as uid 65534
# and /root is mode 700, so a /root/.cargo toolchain was on PATH but every
# `rustc` failed with "Permission denied" (the executor's "rust" language never
# worked). Toolchain is world-readable; runtime state (CARGO_HOME registry etc.)
# is unused by the executor's single-file `rustc` path.
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path \
    && chmod -R a+rX /usr/local/rustup /usr/local/cargo
ENV PATH="/usr/local/cargo/bin:${PATH}"

# Ollama (no models prebaked — too big; user pulls at exec time)
RUN curl -fsSL https://ollama.com/install.sh | sh

COPY executor.py /usr/local/bin/executor
RUN chmod +x /usr/local/bin/executor

# Pre-create writable dirs that are owned by nobody (uid 65534)
# These will be overlaid by emptyDir tmpfs at pod runtime, but having them
# pre-created with right ownership makes local docker-run testing work.
RUN mkdir -p /tmp /work && chown 65534:65534 /tmp /work

# uid 65534's passwd home is /nonexistent and the pod root FS is read-only
# (job_template.py: readOnlyRootFilesystem, only /tmp + /work are writable
# emptyDirs), so without these `go run` died on "mkdir /nonexistent" (build
# cache) and `dotnet new` on its first-run sentinel — the "go" and "csharp"
# executor languages never worked. Point every per-user cache at /tmp.
ENV HOME=/tmp \
    GOCACHE=/tmp/go-build GOPATH=/tmp/go \
    DOTNET_CLI_HOME=/tmp DOTNET_NOLOGO=1 DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1

USER 65534
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/executor"]
