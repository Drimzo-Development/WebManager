# Privileged management agent: the ONLY component that talks to the Docker daemon.
# Build context: repository root.
FROM node:26.13.0-alpine3.24

# npm/corepack are not needed at runtime (and carry their own dependency CVEs), so they are removed
RUN apk upgrade --no-cache && apk add --no-cache docker-cli \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* \
 && mkdir -p /app /var/log/wm

WORKDIR /app
COPY agent/package.json ./package.json
COPY agent/src ./src
RUN chmod -R a+rX /app

ENV NODE_ENV=production DOCKER_CONFIG=/tmp/.docker
EXPOSE 9000
HEALTHCHECK --interval=15s --timeout=8s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:9000/healthz || exit 1
# Runs as root inside the container on purpose: it needs the Docker socket and has to chown site
# directories and drop to per-site uids. Capabilities are reduced in docker-compose.yml.
CMD ["node", "src/server.js"]
