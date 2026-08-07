# @discordjs/voice ^0.19.0 requires Node >=22.12 (node:22-slim satisfies this).
# NOTE: Debian slim (glibc), NOT Alpine (musl): onnxruntime-node (openWakeWord
# wake-word engine) ships glibc-only prebuilt binaries and fails to load on musl.
FROM node:22-slim

WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY . .

# Change ownership to node user (uid 1000) for security
RUN chown -R node:node /usr/src/app

# Switch to non-root user
USER node

CMD [ "node", "bot.js" ]
