# Multi-stage build.
# @discordjs/voice ^0.19.0 requires Node >=22.12. Debian bookworm (glibc), NOT
# Alpine (musl): onnxruntime-node (openWakeWord wake-word engine) ships glibc-only
# prebuilt binaries and fails to load on musl.
#
# The native voice deps (@discordjs/opus) compile from source when no prebuilt
# binary matches the Node ABI, so the builder stage uses the full `node:22` image
# (includes python3/make/g++ via buildpack-deps). The runtime stage is `node:22-slim`
# — same bookworm glibc, so the compiled .node addons and onnxruntime's .so are
# ABI/glibc-compatible — kept lean by copying only the built node_modules.

# ---- builder: has the toolchain to compile native modules ----
# Pin BOTH stages to the SAME Debian codename (trixie) so the builder and runtime
# glibc match. Trixie (glibc >=2.39) is required at runtime because some deps ship
# prebuilt binaries built against glibc 2.38 (e.g. sqlite3 via node-pre-gyp) that
# crash on bookworm-slim's 2.36 ("GLIBC_2.38 not found"). trixie full =
# buildpack-deps (python3/make/g++ to compile @discordjs/opus); trixie-slim runtime
# = matching glibc, kept lean by copying only the built node_modules.
FROM node:22-trixie AS builder
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --only=production
# Prune onnxruntime-node's unused GPU execution providers (~252 MB): the bot runs
# wake-word inference CPU-only, but the package bundles a ~251 MB CUDA provider and
# a TensorRT shim. Removing them keeps the CPU provider (in libonnxruntime.so) and
# the binding loadable; only the mel/embedding/wake models run here.
RUN rm -f node_modules/onnxruntime-node/bin/napi-v*/linux/*/libonnxruntime_providers_cuda.so \
          node_modules/onnxruntime-node/bin/napi-v*/linux/*/libonnxruntime_providers_tensorrt.so

# ---- runtime: slim (trixie, glibc matches the builder) ----
FROM node:22-trixie-slim
WORKDIR /usr/src/app
# App code first (node_modules is .dockerignore'd, so this won't clobber the copy below).
COPY . .
# Compiled + pruned dependencies from the builder.
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Change ownership to node user (uid 1000) for security
RUN chown -R node:node /usr/src/app

# Switch to non-root user
USER node

CMD [ "node", "bot.js" ]
