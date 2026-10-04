FROM node:22-bookworm-slim AS mailbox
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# Inside the container the mailbox must listen on every interface; compose decides who can reach the published port.
ENV BIND=0.0.0.0 \
    ALLOW_PUBLIC_BIND=1 \
    PORT=8787 \
    DATA_DIR=/data/mailbox \
    AGENTS_FILE=/config/agents.json
RUN mkdir -p /data/mailbox && chown -R node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "src/index.ts"]

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build

FROM node:22-bookworm-slim AS adapter
WORKDIR /app
ENV NODE_ENV=production \
    ADAPTER_DATA_DIR=/data \
    ADAPTER_BIND=0.0.0.0 \
    ADAPTER_CONTAINER=1 \
    ADAPTER_PORT=8788
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /data
EXPOSE 8788
CMD ["node", "dist/adapter-main.js"]
