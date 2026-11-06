# Job worker. No Docker access: it only talks to the database and the agent API.
# Build context: repository root.
FROM node:24.22.2-alpine3.24

WORKDIR /app
COPY workers/package.json workers/package-lock.json ./
RUN apk upgrade --no-cache \
 && npm ci --omit=dev --ignore-scripts && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-*
COPY workers/src ./src
COPY workers/healthcheck.js ./healthcheck.js
COPY public/assets/logo.png ./assets/logo.png

ENV NODE_ENV=production
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node /app/healthcheck.js
CMD ["node", "src/index.js"]
