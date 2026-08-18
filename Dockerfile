# ---- Builder stage: compile native modules (e.g. better-sqlite3) ----
FROM node:22-slim AS builder

WORKDIR /app

# Build toolchain for node-gyp so native modules compile reliably even when
# no matching prebuilt binary is available for the target platform/libc.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# ---- Runtime stage: lean image without build tools ----
FROM node:22-slim

WORKDIR /app

# Copy the already-compiled dependencies from the builder. Both stages share
# the same base image and architecture, so native binaries are compatible.
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./

COPY src/ ./src/
COPY views/ ./views/

RUN mkdir -p /app/data

ENV PORT=3000
ENV TZ=America/Puerto_Rico

EXPOSE 3000

CMD ["node", "src/index.js"]
