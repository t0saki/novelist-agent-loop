# ---------- 前端构建 ----------
FROM node:22-alpine AS web
WORKDIR /web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# ---------- 运行时 ----------
FROM python:3.12-slim AS runtime
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app/server
# 先装依赖（利用层缓存）
COPY server/pyproject.toml ./
RUN uv sync --no-dev

# 拷入后端源码与前端产物
COPY server/ ./
COPY --from=web /web/dist /app/web/dist

ENV PATH="/app/server/.venv/bin:$PATH" \
    PYTHONPATH="/app/server" \
    PYTHONUNBUFFERED=1 \
    NOVELIST_DATA_DIR=/data

VOLUME /data
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health').status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
