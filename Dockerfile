# Escritório 24h em qualquer servidor com Docker:
#   docker build -t agentscrets .
#   docker run -d --name escritorio --restart unless-stopped -p 8787:8787 \
#     -e ESCRITORIO_SENHA=troque-esta-senha -v escritorio-dados:/app/dados agentscrets
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV HOST=0.0.0.0 PORTA=8787 DADOS_DIR=/app/dados NODE_ENV=production
EXPOSE 8787
RUN mkdir -p /app/dados && chown node:node /app/dados
VOLUME /app/dados
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/saude || exit 1
CMD ["node", "servidor.js"]
