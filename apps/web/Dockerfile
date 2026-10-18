# Build from the repository root: docker build -f apps/web/Dockerfile -t mediapack-web:local .
FROM node:22-alpine AS build
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@12.11.2
WORKDIR /repo/apps/mediapack
COPY apps/mediapack/package.json apps/mediapack/package-lock.json ./
RUN npm ci
WORKDIR /repo/apps/web
COPY apps/web/package.json apps/web/pnpm-lock.yaml apps/web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/mediapack/src /repo/apps/mediapack/src
COPY apps/web /repo/apps/web
RUN pnpm build

FROM node:22-alpine
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=ghcr.io/blaxel-ai/sandbox:latest /sandbox-api /usr/local/bin/sandbox-api
COPY --chmod=755 apps/web/start-host.sh /usr/local/bin/mediapack-host
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["/usr/local/bin/mediapack-host"]
