# Feddrick CMS (Strapi)
# Multi-stage: install, build admin panel, run.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
# A JavaScript Strapi project writes the built admin panel to ./build (TypeScript projects use ./dist).
COPY --from=build /app/build ./build
COPY package.json ./
COPY config ./config
COPY database ./database
COPY public ./public
COPY src ./src
COPY favicon.png ./

# Media persist in a volume on /app/public (not /app/public/uploads): Strapi's data transfer/import renames uploads
# to a backup folder next to it, which needs public/ writable and uploads/ to be a plain directory, not a mount point.
RUN mkdir -p /app/public/uploads && chown -R node:node /app/public
VOLUME ["/app/public"]

USER node
EXPOSE 1337

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:1337/_health || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["npm", "run", "start"]
