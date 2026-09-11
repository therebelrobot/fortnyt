# syntax=docker/dockerfile:1

# Build stage runs on the build machine's own architecture ($BUILDPLATFORM): its output is
# plain JavaScript + static files, identical for every target, so arm64 images never have to
# run npm or Vite under QEMU emulation.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# Runtime: Node and two build outputs. No node_modules — the server is one bundled file.
FROM node:24-alpine
LABEL org.opencontainers.image.source="https://github.com/therebelrobot/fortnyt" \
      org.opencontainers.image.description="Self-hosted pay-period budget with SimpleFIN transaction assessment" \
      org.opencontainers.image.licenses="Unlicense"
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    STATIC_DIR=/app/public \
    PORT=8080 \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=build /src/dist/server.mjs ./server.mjs
COPY --from=build /src/dist/public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
