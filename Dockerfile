# Pathshala — same commit as the cPanel zip, packaged for a VPS/Kubernetes.
# Build: docker build -t pathshala .   Run: see docker-compose.yml (Postgres + app).
FROM node:22-alpine AS build
RUN corepack disable && npm i -g pnpm@12.3.4
WORKDIR /src
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc turbo.json tsconfig.base.json .env.example ./
COPY apps ./apps
COPY packages ./packages
COPY db ./db
COPY docs/AUTOMATION.md ./docs/AUTOMATION.md
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN node scripts/build-release.mjs --no-zip --out /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production APP_ENV=production PORT=3000 APP_ROOT=/srv/pathshala
WORKDIR /srv/pathshala
COPY --from=build /out/ ./
RUN rm -f install.php index.php && mkdir -p uploads storage && chown -R node:node /srv/pathshala
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=5 CMD wget -qO- http://127.0.0.1:3000/_health || exit 1
CMD ["node", "app/server.js"]
