# @discordjs/voice ^0.19.0 requires Node >=22.12; Alpine's node:22-alpine line satisfies this.
FROM node:22-alpine

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
