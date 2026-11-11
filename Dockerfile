# syntax=docker/dockerfile:1
# AgentBridge server + dashboard. The Claude Code hook runs on the host, not here.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/telephony/package.json packages/telephony/
COPY packages/discord/package.json packages/discord/
COPY packages/claude-code/package.json packages/claude-code/
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24-slim
ENV NODE_ENV=production \
    AGENTBRIDGE_HOST=0.0.0.0 \
    AGENTBRIDGE_PORT=4317 \
    AGENTBRIDGE_DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4317/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/dist/main.js"]
