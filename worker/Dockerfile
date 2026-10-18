# Build from worker/: docker build -t mediapack-worker:local worker
FROM node:22-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache ffmpeg ca-certificates
COPY --from=ghcr.io/blaxel-ai/sandbox:latest /sandbox-api /usr/local/bin/sandbox-api
WORKDIR /app
COPY --from=build --chown=node:node /build/package.json /build/package-lock.json ./
COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/dist ./dist
USER node
ENV BL_SANDBOX_USER_ENABLED=true
EXPOSE 8080
# Process/file APIs are required by the Blaxel launcher, which starts node dist/run.js.
CMD ["/usr/local/bin/sandbox-api"]
