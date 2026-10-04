FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build

FROM node:22-bookworm-slim
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
