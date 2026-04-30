# syntax=docker/dockerfile:1.7

# ---------- stage 1: build TS host ----------
FROM node:20-bookworm-slim AS ts-build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN --mount=type=cache,target=/root/.npm npm install
COPY src ./src
RUN npx tsc

# ---------- stage 2: runtime ----------
FROM node:20-bookworm-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    DATA_DIR=/data

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 ca-certificates curl tini libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Install relayer-cli (Twilight inverse-perp CLI). install.sh may write to
# either ~/.cargo/bin or ~/.local/bin depending on env; we copy from both.
RUN curl -sSfL https://raw.githubusercontent.com/twilight-project/nyks-wallet/main/install.sh | sh \
    && ( cp "$HOME/.cargo/bin/relayer-cli" /usr/local/bin/ 2>/dev/null \
      || cp "$HOME/.local/bin/relayer-cli" /usr/local/bin/ 2>/dev/null \
      || echo "WARN: relayer-cli install path unknown; check container after build" )

WORKDIR /app
COPY package.json ./
RUN --mount=type=cache,target=/root/.npm npm install --omit=dev
COPY --from=ts-build /app/dist ./dist
COPY skills ./skills
COPY python ./python

VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
