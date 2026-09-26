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

# Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

# Ollama (no models prebaked — too big; user pulls at exec time)
RUN curl -fsSL https://ollama.com/install.sh | sh

COPY executor.py /usr/local/bin/executor
RUN chmod +x /usr/local/bin/executor

# Pre-create writable dirs that are owned by nobody (uid 65534)
# These will be overlaid by emptyDir tmpfs at pod runtime, but having them
# pre-created with right ownership makes local docker-run testing work.
RUN mkdir -p /tmp /work && chown 65534:65534 /tmp /work

USER 65534
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/executor"]
