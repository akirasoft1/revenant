# @discordjs/voice ^0.19.0 requires Node >=22.12 (node:22-slim satisfies this).
# NOTE: Debian slim (glibc), NOT Alpine (musl): onnxruntime-node (openWakeWord
# wake-word engine) ships glibc-only prebuilt binaries and fails to load on musl.
FROM node:22-slim

WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Prune onnxruntime-node's unused GPU execution providers (~252 MB): the bot runs
# wake-word inference CPU-only, but the package bundles a ~251 MB CUDA provider
# and a TensorRT shim. Removing them keeps the CPU provider (in libonnxruntime.so)
# and the binding loadable; only the mel/embedding/wake models run here.
RUN rm -f node_modules/onnxruntime-node/bin/napi-v*/linux/*/libonnxruntime_providers_cuda.so \
          node_modules/onnxruntime-node/bin/napi-v*/linux/*/libonnxruntime_providers_tensorrt.so

# Copy application code
COPY . .

# Change ownership to node user (uid 1000) for security
RUN chown -R node:node /usr/src/app

# Switch to non-root user
USER node

CMD [ "node", "bot.js" ]
