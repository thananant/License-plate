# Debian-based image: better-sqlite3 and sharp ship prebuilt binaries for
# glibc/linux-x64, so no compiler toolchain is needed at build time.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
# No VOLUME / HEALTHCHECK here: Railway rejects both at validation time and
# provides them via its own volume UI and railway.json healthcheckPath.
# Docker Compose mounts /data via docker-compose.yml.
CMD ["node", "src/server.js"]
