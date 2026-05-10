# ---------- Frontend bundle stage ----------
# Bundles the SPA with webpack, producing a static dist/ tree containing
# index.html + content-hashed JS/CSS bundles + sourcemaps.
FROM node:22-slim AS frontend-build

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --silent

COPY frontend ./
RUN npm run build


# ---------- Runtime stage ----------
FROM node:22-slim AS base

ENV NODE_ENV=production

ARG COMPOSE_VERSION=v2.29.7

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates tini \
 && ARCH="$(dpkg --print-architecture)" \
 && case "$ARCH" in \
      amd64)  COMPOSE_ARCH=x86_64  ;; \
      arm64)  COMPOSE_ARCH=aarch64 ;; \
      armhf)  COMPOSE_ARCH=armv7   ;; \
      *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${COMPOSE_ARCH}" \
      -o /usr/local/bin/docker-compose \
 && chmod +x /usr/local/bin/docker-compose \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend-node/package.json backend-node/package-lock.json* /app/backend-node/
RUN cd /app/backend-node && npm install --omit=dev --silent

COPY backend-node /app/backend-node

# Pull in only the built bundle from the frontend stage — no node_modules
# from frontend/, no Tailwind / webpack / xterm sources in the runtime image.
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

RUN mkdir -p /data/stacks

ENV STATIC_DIR=/app/frontend/dist \
    DATA_DIR=/data \
    STACKS_DIR=/data/stacks \
    REGISTRIES_FILE=/data/registries.json \
    COMPOSE_BIN=docker-compose \
    EXEC_DEFAULT_SHELL=/bin/sh \
    BROWSER_IMAGE=python:3-alpine \
    ADMIN_USER=admin \
    ADMIN_PASSWORD=admin \
    ALLOW_DESTRUCTIVE=true \
    PORT=8000 \
    HOST=0.0.0.0

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/backend-node/src/index.js"]
