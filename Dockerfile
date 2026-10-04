# Fair Drop: single-service image (Next.js app + in-process scheduler). See DEPLOY.md.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev && npm install --no-save tsx

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /app /app
EXPOSE 3000
# Migrations are idempotent (schema_migrations table), so running them on every boot is safe.
CMD ["sh", "-c", "node node_modules/tsx/dist/cli.mjs scripts/migrate.ts && node server.mjs"]
