FROM node:24-alpine AS base
WORKDIR /app
RUN corepack enable pnpm

# ─── Dependencies ───────────────────────────────────────────────────────────
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY lib/api-spec/package.json ./lib/api-spec/
COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/db/package.json ./lib/db/
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/watchtower-app/package.json ./artifacts/watchtower-app/
RUN pnpm install --frozen-lockfile

# ─── Build API server ────────────────────────────────────────────────────────
FROM deps AS api-build
COPY tsconfig.base.json ./
COPY lib/ ./lib/
COPY artifacts/api-server/ ./artifacts/api-server/
RUN pnpm --filter @workspace/api-server run build

# ─── Build frontend ──────────────────────────────────────────────────────────
FROM deps AS frontend-build
COPY tsconfig.base.json ./
COPY lib/ ./lib/
COPY artifacts/watchtower-app/ ./artifacts/watchtower-app/
ENV BASE_PATH=/
ENV PORT=3001
RUN pnpm --filter @workspace/watchtower-app run build

# ─── Production image ────────────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app
RUN corepack enable pnpm

# Copy built API server.
# IMPORTANT: keep the dist at the SAME path it was built at
# (/app/artifacts/api-server/dist). esbuild-plugin-pino bakes ABSOLUTE paths to
# its worker files (thread-stream-worker.mjs, pino-*.mjs) based on the build-time
# output dir, so the bundle must run from that exact location or it fails at
# startup with "Cannot find module .../thread-stream-worker.mjs".
COPY --from=api-build /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=api-build /app/artifacts/api-server/package.json ./artifacts/api-server/

# Copy built frontend static files
COPY --from=frontend-build /app/artifacts/watchtower-app/dist/public ./public

# Install a minimal static file server + production deps
RUN npm install -g serve

# Copy and install production entrypoint
COPY umbrel/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000
CMD ["/entrypoint.sh"]
