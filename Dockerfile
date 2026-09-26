# Multi-stage build on Node 24 (current Active LTS).
# @discordjs/voice ^0.19 requires Node >=22.12; openai 6 / @google-cloud/storage 8
# require >=22. Debian (glibc), NOT Alpine (musl): onnxruntime-node (openWakeWord
# wake-word engine) ships glibc-only prebuilt binaries and fails to load on musl.
#
# Native modules: @discordjs/opus, sodium-native, onnxruntime-node and
# better-sqlite3 (a hard dependency of mem0ai 3 -- `require('mem0ai/oss')` loads
# it at import time even with history disabled). Each uses a prebuilt binary when
# one matches the Node ABI and compiles from source otherwise, so the builder
# stage uses the full `node:24-trixie` image (python3/make/g++ via
# buildpack-deps). The runtime stage is `node:24-trixie-slim` -- same Node ABI and
# glibc, so the built .node addons and onnxruntime's .so load unchanged -- kept
# lean by copying only the built node_modules.

# ---- builder: has the toolchain to compile native modules ----
# Pin BOTH stages to the SAME Debian codename (trixie) so the builder and runtime
# glibc match. Trixie (glibc >=2.39) is required at runtime because some deps ship
# prebuilt binaries built against glibc 2.38 that crash on bookworm-slim's 2.36
# ("GLIBC_2.38 not found").
FROM node:24-trixie AS builder
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev
# Prune onnxruntime-node's unused GPU execution providers (~252 MB): the bot runs
# wake-word inference CPU-only, but the package bundles a ~251 MB CUDA provider and
# a TensorRT shim. Removing them keeps the CPU provider (in libonnxruntime.so) and
# the binding loadable; only the mel/embedding/wake models run here.
RUN rm -f node_modules/onnxruntime-node/bin/napi-v*/linux/*/libonnxruntime_providers_cuda.so \
          node_modules/onnxruntime-node/bin/napi-v*/linux/*/libonnxruntime_providers_tensorrt.so

# ---- runtime: slim (trixie, glibc matches the builder) ----
FROM node:24-trixie-slim
WORKDIR /usr/src/app
# onnxruntime-node >=1.30 attempts HTTPS telemetry uploads on first session create
# (and logs a warning here, since slim has no CA bundle). Opt out.
ENV ORT_DISABLE_TELEMETRY=1
# App code first (node_modules is .dockerignore'd, so this won't clobber the copy below).
COPY . .
# Compiled + pruned dependencies from the builder.
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Change ownership to node user (uid 1000) for security
RUN chown -R node:node /usr/src/app

# Switch to non-root user
USER node

CMD [ "node", "bot.js" ]
