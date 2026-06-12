# syntax=docker/dockerfile:1
#
# Multi-stage build for skeptic-cli.
# Build context is the `cli/` directory.
#
# Stage 1 bundles the CLI with tsup. Stage 2 runs the bundle on the official
# Playwright image whose baked-in browsers match the installed Playwright
# version (1.59.1) — no version drift between client and browsers.

# ---------------------------------------------------------------------------
# Stage 1: build the JS bundle
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Skip the agent-skill postinstall during image builds, and don't let the
# Playwright npm postinstall download browsers (the build needs neither).
ENV CI=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install dependencies first for layer caching. `scripts/` must exist before
# `npm ci` so the `postinstall` hook (node ./scripts/install-agent-skills.mjs)
# can load — `CI=true` makes that script no-op immediately.
COPY package.json package-lock.json ./
COPY scripts/ ./scripts/
RUN npm ci

# Now copy everything tsup needs, each before the build that consumes it:
# tsconfig.json + tsup.config.ts (config), bin/ + src/ (entry points),
# templates/ (copied into dist/ by tsup's onSuccess hook).
COPY tsconfig.json tsup.config.ts ./
COPY bin/ ./bin/
COPY src/ ./src/
COPY templates/ ./templates/
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: runtime on the matching Playwright image
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.59.1-noble
WORKDIR /app

# Browsers are already baked into this image (PLAYWRIGHT_BROWSERS_PATH is set by
# the base image); skip re-downloading and skip the skill postinstall.
ENV NODE_ENV=production \
    CI=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install production dependencies only (playwright, playwright-core, tsx,
# typescript, etc.). `scripts/` is present so the `postinstall` hook can load
# and no-op under CI=true.
COPY package.json package-lock.json ./
COPY scripts/ ./scripts/
RUN npm ci --omit=dev && npm cache clean --force

# The bundle. bin/launcher.mjs resolves ../dist/skeptic.mjs, but the entrypoint
# loads it directly for one less indirection.
COPY --from=builder /app/dist ./dist
COPY bin/launcher.mjs ./bin/launcher.mjs

ENTRYPOINT ["node", "dist/skeptic.mjs"]
CMD ["--help"]
