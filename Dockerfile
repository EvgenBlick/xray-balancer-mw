FROM node:24-alpine

WORKDIR /app

# Копируем только код — config.json монтируется через volume
COPY server.js .
COPY package.json .
COPY lib ./lib
RUN mkdir -p /app/runtime && chown -R node:node /app/runtime

# Не-root пользователь
USER node

EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD sh -c 'wget -qO- "http://localhost:${PORT:-4100}/health" || exit 1'

CMD ["node", "server.js"]
