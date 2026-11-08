# Novelist 2.0 镜像（linux/amd64 + linux/arm64）。只由 GitHub Actions 构建（.github/workflows/docker-publish.yml），不要在部署机上 docker build。
# harness CLI 不打进镜像：装在 /data/harness（持久卷），由 UI 或 `novelist harness install` 安装。

# ---------- 构建 ----------
FROM node:24-bookworm-slim AS build
WORKDIR /repo
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@10
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json biome.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages ./packages
COPY apps ./apps
RUN pnpm -r build \
 && pnpm --filter @novelist/server deploy --prod --legacy /out/server \
 && cp -r apps/web/dist /out/web

# ---------- 运行时 ----------
FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep bubblewrap tini ca-certificates util-linux curl tar gzip \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 novelist \
 && useradd -u 10001 -g 10001 -d /data -s /bin/bash -M novelist \
 && mkdir -p /data /app \
 && chown 10001:10001 /data
WORKDIR /app
COPY --from=build /out/server /app/server
COPY --from=build /out/web /app/web
ENV NODE_ENV=production \
    NOVELIST_DATA_DIR=/data \
    NOVELIST_WEB_DIST=/app/web \
    HOME=/data
VOLUME /data
EXPOSE 8000
USER 10001:10001
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NOVELIST_LISTEN_PORT||8000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["tini", "--", "node", "/app/server/dist/cli.js"]
CMD ["serve"]
