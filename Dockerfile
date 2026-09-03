# Multi-stage Dockerfile for LateDev Router

# --- builder ---
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY tsconfig.json tsconfig.build.json vite.config.ts tailwind.config.cjs postcss.config.cjs ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile --config.dangerouslyAllowAllBuilds
RUN pnpm run build
RUN pnpm prune --prod
# Copy migrations into dist for container runtime (migrations ở project root)
COPY migrations ./dist/migrations

# --- runtime ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV LATEDEV_APP_VERSION=${APP_VERSION}
RUN addgroup -S latedev && adduser -S latedev -G latedev
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh && \
    mkdir -p /data && \
    chown -R latedev:latedev /app /data
USER latedev
ENV LATEDEV_DATA_DIR=/data
ENV LATEDEV_HOST=0.0.0.0
ENV LATEDEV_PORT=8787
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+ (process.env.LATEDEV_PORT||8787) +'/health', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/cli.js"]
