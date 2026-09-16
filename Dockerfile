# syntax=docker/dockerfile:1

# Energie Agent Browser — single self-contained image:
#   Fastify API (tsx) + built React SPA + agent-browser's own Chromium.
#
# Build:  docker build -t energie-agent-browser .
# Run:    docker run -p 3011:3011 -v eab-data:/app/data energie-agent-browser
#         (or use the provided docker-compose.yml)
#
# Notes:
# - Full bookworm (not -slim) on purpose: node-pty compiles from source and
#   needs python3/make/g++, which this image already ships.
# - The server executes TypeScript at runtime via tsx (see apps/server
#   "start" script), so devDependencies are required in the final image —
#   this is intentionally a single-stage build.
# - `agent-browser install --with-deps` downloads agent-browser's Chromium
#   AND apt-installs the system libraries it needs (that's the --with-deps
#   part; it requires root, which the build runs as).
# - Chromium's container flags (--no-sandbox, --disable-dev-shm-usage) are
#   added automatically by the app in BROWSER_MODE=local (see
#   apps/server/src/config.ts localBrowserArgs()).

FROM node:22-bookworm

# ffmpeg: scenario video recording muxes CDP screencast frames to .webm
# (config.ffmpegPath defaults to "ffmpeg" on PATH).
# sudo: `agent-browser install --with-deps` invokes `sudo apt-get` verbatim,
# even when already running as root — without the sudo binary it fails with
# "No such file or directory (os error 2)".
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg sudo \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first so this layer caches across source-only changes.
# npm workspaces need every workspace manifest present for `npm ci`.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

RUN npm ci

# Download agent-browser's Chromium + its system dependencies (apt). Done
# right after npm ci so it also stays cached across source changes.
RUN npx agent-browser install --with-deps

# Now the actual source.
COPY . .

# Build the SPA; the server serves apps/web/dist itself when it exists.
RUN npm run build --workspace @eab/web

# Container defaults — all overridable at `docker run -e ...` time.
# BROWSER_MODE=local: use the Chromium installed above instead of a remote
# browserless instance (set BROWSER_MODE=browserless + BROWSERLESS_URL/TOKEN
# to switch back).
ENV NODE_ENV=production \
    BROWSER_MODE=local \
    PORT=3011 \
    DATA_DIR=/app/data \
    WEB_ORIGIN=http://localhost:3011

# SQLite DB, screenshots, recordings, logs — mount a volume here.
VOLUME /app/data

EXPOSE 3011

# Migrations run automatically at server boot (apps/server/src/index.ts).
CMD ["npm", "run", "start"]
