FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3210 QR_DATA_DIR=/app/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/dist ./dist
COPY scripts/export-driver.ts scripts/snowluma-start.ts ./scripts/
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3210
CMD ["node", "--experimental-strip-types", "apps/server/src/main.ts"]
