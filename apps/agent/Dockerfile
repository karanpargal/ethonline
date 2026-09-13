# AutoCFO agent service (Hono API + x402 seller). Deploy with a volume mounted
# at /data and DATABASE_PATH=/data/autocfo.db.
FROM node:22-bookworm-slim AS base
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/agent/package.json apps/agent/
RUN pnpm install --frozen-lockfile --filter @autocfo/agent --filter @autocfo/shared

COPY packages/shared packages/shared
COPY apps/agent apps/agent

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/autocfo.db
ENV ALLOW_ENV_ORG=false
EXPOSE 3001

# Push the schema against the (possibly fresh) volume DB, then start.
CMD ["sh", "-c", "cd packages/shared && DATABASE_PATH=$DATABASE_PATH npx drizzle-kit push --force && cd ../../apps/agent && npx tsx src/index.ts"]
