# Standalone build of the rendezvous service. It has no workspace deps (only
# `ws`), so it builds without the rest of the monorepo. Build context = this
# package dir (packages/rendezvous).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
# Default signaling port (behind the reverse proxy for TLS).
EXPOSE 8787
CMD ["node", "dist/index.js"]
