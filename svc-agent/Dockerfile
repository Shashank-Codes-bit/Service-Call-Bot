# syntax=docker/dockerfile:1

# Both installs skip lifecycle scripts. better-sqlite3 carries a binding.gyp,
# so npm runs an implicit `node-gyp rebuild` for it, and node-gyp needs Python,
# which the slim image does not have — the install fails. Nothing is lost by
# skipping it: better-sqlite3 loads the linux-x64 binary it ships in
# prebuilds/, and esbuild (the only other script) finds its platform binary
# through its optional dependency.

# Stage 1 — the portal. Needs vite, react and tailwind, none of which ship.
FROM node:22.17.0-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY vite.config.ts tsconfig.json ./
COPY src ./src
RUN npm run build:web

# Stage 2 — runtime: production dependencies, the TypeScript that tsx runs
# directly, and the built portal. No compiler needed.
FROM node:22.17.0-slim
# config.ts pins the process to the centre's timezone; tzdata is the backstop
# in case the ICU bundled with Node ever cannot resolve it.
RUN apt-get update && apt-get install -y --no-install-recommends tzdata && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY --from=web /app/dist/dealer ./dist/dealer
EXPOSE 8080
# The binary, not `npm run serve`: npm does not pass SIGTERM on, so every
# deploy would end the old machine with a kill instead of a clean stop.
CMD ["node_modules/.bin/tsx", "src/dealer/server.ts"]
