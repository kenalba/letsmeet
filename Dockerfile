# syntax=docker/dockerfile:1

# Build stage: full dev deps for the client bundles (esbuild, tailwind), then pruned.
# Pinned by digest, not tag: a tag can silently become a different image. Dependabot's
# docker updater (.github/dependabot.yml) proposes the bump when 22-slim moves on.
FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS build
WORKDIR /app
# better-sqlite3 compiles from source when no prebuilt binary matches; the toolchain
# stays in this stage only — the runtime stage copies the already-built node_modules.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY lexicons ./lexicons
# The tracked static files (icons); public/assets is excluded by .dockerignore and
# written by the build below.
COPY public ./public
COPY src ./src
# public/assets is gitignored build output; baking it here is what makes the image
# self-contained (see docs/deploy.md "Before you build").
RUN npm run build:client && npm prune --omit=dev

# Runtime: prod deps only. tsx is a real dependency — it is the production loader
# (`src/index.ts` runs as TypeScript; there is no emitted dist/).
FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/public ./public
# tsconfig.json is a RUNTIME file here: tsx reads its `jsx` settings to transpile the
# pages' JSX with the automatic runtime. Without it, every SSR render throws
# "React is not defined".
COPY package.json tsconfig.json ./
COPY lexicons ./lexicons
COPY src ./src
# The one stateful path: compose mounts a host volume here. Owned by the unprivileged
# user the process runs as — the host-side directory needs the matching uid (1000).
RUN mkdir /data && chown node:node /data
ENV DB_PATH=/data/letsmeet.db
USER node
EXPOSE 8787
# tsx directly, not via npx: npx is three processes and a cache write in front of the
# server, and the compose file's `init: true` wants the server to be the signal target.
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
