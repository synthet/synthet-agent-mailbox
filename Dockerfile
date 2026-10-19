FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    AGENT_MAIL_HOME=/data/agent-mail \
    DASHBOARD_BIND=0.0.0.0 \
    DASHBOARD_CONTAINER=1 \
    DASHBOARD_PORT=8788
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 8788
CMD ["node", "dist/peer-dashboard-main.js"]
