"""FastAPI 应用入口：lifespan 内初始化 DB、播种默认、启动调度器。"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api import admin, auth, reader
from app.core.config import get_settings
from app.db.database import init_db, session_scope
from app.db.seed import ensure_admin, seed_defaults

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("novelist")

_WEB_DIST = Path(__file__).resolve().parent.parent.parent / "web" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    init_db()
    with session_scope() as session:
        seed_defaults(session)
        ensure_admin(session)
    scheduler_task = None
    if settings.scheduler_enabled:
        from app.scheduler.scheduler import scheduler
        scheduler_task = asyncio.create_task(scheduler.run_forever())
        app.state.scheduler = scheduler
    logger.info("应用启动完成（mock_llm=%s, scheduler=%s）", settings.mock_llm, settings.scheduler_enabled)
    try:
        yield
    finally:
        if scheduler_task is not None:
            from app.scheduler.scheduler import scheduler
            await scheduler.stop()
            try:
                await asyncio.wait_for(scheduler_task, timeout=60)
            except asyncio.TimeoutError:
                logger.warning("调度器停机超时")


app = FastAPI(title="Novelist Agent Loop", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 单机部署；如需收紧可改为具体来源
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(reader.router)
app.include_router(admin.router)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


# ---------- 前端静态资源（构建后）----------

if _WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=_WEB_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        if full_path.startswith("api/"):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        candidate = _WEB_DIST / full_path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_WEB_DIST / "index.html")
else:
    @app.get("/")
    def root() -> dict:
        return {"detail": "前端尚未构建（web/dist 不存在）。开发期请单独跑 Vite。"}
