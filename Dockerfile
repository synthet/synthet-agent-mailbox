FROM node:22-bookworm-slim
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
