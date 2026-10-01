# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22-alpine

# ---- deps: production dependencies only ----
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:${NODE_VERSION} AS runtime
# No package managers at runtime: the service starts with plain `node`, and npm, yarn and corepack
# bundle their own dependencies (with CVEs the service never uses).
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
ENV NODE_ENV=production \
    PORT=3001
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# The official image ships an unprivileged "node" user (uid 1000).
USER node
EXPOSE 3001

# Readiness endpoint (checks MongoDB). Uses Node's built-in fetch, so no curl/wget in the image.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
