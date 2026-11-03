# syntax=docker/dockerfile:1

# ---- dependencies (production only) -----------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime ----------------------------------------------------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S app && adduser -S app -G app

COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json ./
COPY --chown=app:app src ./src

USER app
EXPOSE 3000

# Exec form: node is PID 1 and receives SIGTERM directly, so the graceful
# shutdown handler in src/index.js runs on `docker stop`.
CMD ["node", "src/index.js"]
