# Eagleye production image (R0-09 artifact).
# STATUS: artifact only — never built or run against production as of 2026-09-17.
#
# Multi-stage: the deps stage installs node_modules (with native build tools for
# better-sqlite3 in case no prebuilt binary matches); the runtime stage stays
# slim and runs as the non-root "node" user.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm ci --legacy-peer-deps

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /data /app/logs \
 && chown -R node:node /app /data
USER node
ENV EAGLEYE_DB_PATH=/data/eagleye.db
EXPOSE 3019 3020 3021
# Liveness = any HTTP response from the process (auth errors still prove it serves).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.EAGLEYE_HEALTH_PORT||3019;fetch('http://127.0.0.1:'+p+'/api/health').then(()=>process.exit(0)).catch(()=>process.exit(1))"
CMD ["node", "server.js", "3019"]
