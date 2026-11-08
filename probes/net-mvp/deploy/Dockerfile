# Build from the repository root:
#   docker build -f probes/net-mvp/deploy/Dockerfile -t blur-net-mvp .
#
# The image contains only the dependency-free room service. It does not include
# game data, upstream/, _work/ or the e1-drive probe.
FROM node:22-alpine

ENV NODE_ENV=production \
    NET_MVP_HOST=0.0.0.0 \
    NET_MVP_PORT=8810 \
    NET_MVP_STATE_FILE=/data/rooms.json \
    NET_MVP_TRUST_PROXY=1

WORKDIR /app
COPY probes/net-mvp /app/probes/net-mvp
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8810
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8810/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "probes/net-mvp/server.mjs"]
