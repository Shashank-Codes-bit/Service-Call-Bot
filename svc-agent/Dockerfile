# syntax=docker/dockerfile:1

# Stage 1 — the portal. Needs vite, react and tailwind, none of which ship.
FROM node:22.17.0-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY vite.config.ts tsconfig.json ./
COPY src ./src
RUN npm run build:web

# Stage 2 — runtime: production dependencies, the TypeScript that tsx runs
# directly, and the built portal. No compiler: better-sqlite3 ships a
# linux-x64 prebuild and has no install script.
FROM node:22.17.0-slim
# config.ts pins the process to the centre's timezone; tzdata is the backstop
# in case the ICU bundled with Node ever cannot resolve it.
RUN apt-get update && apt-get install -y --no-install-recommends tzdata && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY --from=web /app/dist/dealer ./dist/dealer
EXPOSE 8080
# The binary, not `npm run serve`: npm does not pass SIGTERM on, so every
# deploy would end the old machine with a kill instead of a clean stop.
CMD ["node_modules/.bin/tsx", "src/dealer/server.ts"]
