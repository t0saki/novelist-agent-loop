"""全局配置：从环境变量 / .env 读取，主要是启动期常量。

运行期可变配置（限流、预算、模型 profile、题材等）存 DB 的 settings 表，
不放这里。这里只放部署级、启动即固定的东西。
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="NOVELIST_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # 数据目录：SQLite、封面、插图、EPUB 都放这里（Docker volume 挂载点）
    data_dir: Path = Field(default=Path("../data"))

    # 首次启动时用于初始化管理员密码；之后以 DB 中 hash 为准。
    # 留空则首启生成随机密码并打印到日志。
    admin_password: str = Field(default="")

    # 会话签名密钥；留空则用 data_dir 下持久化的随机密钥。
    session_secret: str = Field(default="")

    # 会话有效期（小时）
    session_ttl_hours: int = Field(default=24 * 30)

    # Mock LLM 模式：不调用真实模型，用脚本化假 LLM。用于测试与零成本演练。
    mock_llm: bool = Field(default=False)

    # 调度器是否随应用启动（测试 / CI 时可关）
    scheduler_enabled: bool = Field(default=True)

    # 调度器轮询间隔（秒）
    scheduler_tick_seconds: int = Field(default=20)

    # HTTP 请求超时（秒），LLM 单次调用
    llm_timeout_seconds: int = Field(default=600)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "novelist.db"

    @property
    def covers_dir(self) -> Path:
        return self.data_dir / "covers"

    @property
    def illustrations_dir(self) -> Path:
        return self.data_dir / "illustrations"

    @property
    def epub_dir(self) -> Path:
        return self.data_dir / "epub"

    @property
    def secret_file(self) -> Path:
        return self.data_dir / ".session_secret"

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.covers_dir, self.illustrations_dir, self.epub_dir):
            d.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.ensure_dirs()
    return s
