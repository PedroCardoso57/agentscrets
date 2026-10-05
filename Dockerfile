# Escritório 24h num VPS — o jeito mais fácil é o docker-compose.yml (veja o README).
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV HOST=0.0.0.0 PORTA=8787 DADOS_DIR=/app/dados NODE_ENV=production
EXPOSE 8787
RUN mkdir -p /app/dados && chown node:node /app/dados
VOLUME /app/dados
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/saude || exit 1
CMD ["node", "servidor.js"]
