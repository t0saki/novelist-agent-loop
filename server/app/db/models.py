"""SQLAlchemy 2.0 数据模型。

设计说明：
- 大块半结构化数据（设定集、大纲、场景中间态、质量债务）用 JSON 列存，
  避免过度拆表；需要独立查询的实体（章节、任务、用量、题材）才单独建表。
- 所有时间 UTC。JSON 列在 SQLite 上以 TEXT 落库，由 SQLAlchemy 自动 (de)serialize。
"""
from __future__ import annotations

import enum
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


# ---------- 枚举（用字符串存，方便前端与迁移） ----------

class NovelStatus(str, enum.Enum):
    planning = "planning"      # 已立项，尚未开写（选题/构思/设定/大纲阶段）
    writing = "writing"        # 逐章生成中（连载中）
    completed = "completed"    # 全书完成
    failed = "failed"          # 阶段级重试耗尽
    archived = "archived"      # 管理员下架


class ChapterStatus(str, enum.Enum):
    pending = "pending"
    writing = "writing"
    reviewing = "reviewing"
    done = "done"


class JobType(str, enum.Enum):
    generate = "generate"      # 主流水线（选题→成书）
    cover = "cover"            # 封面/插图流水线


class JobStatus(str, enum.Enum):
    queued = "queued"
    running = "running"
    paused = "paused"          # 因预算/配额暂停，待恢复
    done = "done"
    failed = "failed"


class ProfileKind(str, enum.Enum):
    chat = "chat"
    image = "image"
    embedding = "embedding"


# ---------- 表 ----------

class Setting(Base):
    """运行期可变配置的 KV 存储。value 存任意 JSON。"""
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class LlmProfile(Base):
    """一个模型端点配置（chat / image / embedding 通用）。

    流水线阶段 -> profile 的映射存 settings['stage_profiles']，支持 fallback 链。
    """
    __tablename__ = "llm_profiles"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    kind: Mapped[str] = mapped_column(String(16), default=ProfileKind.chat.value)
    base_url: Mapped[str] = mapped_column(String(512), default="https://api.openai.com/v1")
    api_key: Mapped[str] = mapped_column(String(512), default="")
    model: Mapped[str] = mapped_column(String(128), default="")
    temperature: Mapped[float] = mapped_column(Float, default=0.9)
    max_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 每百万 token 成本（美元/或任意货币单位），用于估算。prompt/completion 分开。
    price_prompt_per_mtok: Mapped[float] = mapped_column(Float, default=0.0)
    price_completion_per_mtok: Mapped[float] = mapped_column(Float, default=0.0)
    supports_tools: Mapped[bool] = mapped_column(Boolean, default=True)
    extra: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # 额外请求参数
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Theme(Base):
    """管理员可编辑的题材 / 关键词。选题阶段按 weight 加权抽样。"""
    __tablename__ = "themes"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    keywords: Mapped[list[str]] = mapped_column(JSON, default=list)
    style_prompt: Mapped[str] = mapped_column(Text, default="")
    length_hint: Mapped[str] = mapped_column(String(64), default="")  # 篇幅参考文字提示
    min_chapters: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 兜底下限
    weight: Mapped[float] = mapped_column(Float, default=1.0)
    nsfw: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Novel(Base):
    __tablename__ = "novels"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(256), default="未命名")
    status: Mapped[str] = mapped_column(String(16), default=NovelStatus.planning.value, index=True)
    theme_id: Mapped[int | None] = mapped_column(ForeignKey("themes.id"), nullable=True)
    theme_name: Mapped[str] = mapped_column(String(128), default="")
    language: Mapped[str] = mapped_column(String(16), default="zh")
    nsfw: Mapped[bool] = mapped_column(Boolean, default=False)

    premise: Mapped[str] = mapped_column(Text, default="")
    synopsis: Mapped[str] = mapped_column(Text, default="")
    tone: Mapped[str] = mapped_column(String(256), default="")
    target_audience: Mapped[str] = mapped_column(String(256), default="")

    # 篇幅结构（构思阶段固化，之后作为硬约束）
    planned_chapters: Mapped[int] = mapped_column(Integer, default=1)
    target_chapter_words: Mapped[int] = mapped_column(Integer, default=3000)
    volumes: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)

    # 半结构化大块
    bible: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    outline: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    rolling_summary: Mapped[str] = mapped_column(Text, default="")
    quality_debt: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)

    word_count: Mapped[int] = mapped_column(Integer, default=0)
    cover_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    illustration_density: Mapped[str | None] = mapped_column(String(32), nullable=True)  # None=用全局

    tokens_total: Mapped[int] = mapped_column(Integer, default=0)
    cost_total: Mapped[float] = mapped_column(Float, default=0.0)

    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    chapters: Mapped[list["Chapter"]] = relationship(
        back_populates="novel", cascade="all, delete-orphan", order_by="Chapter.index"
    )


class Chapter(Base):
    __tablename__ = "chapters"
    __table_args__ = (UniqueConstraint("novel_id", "index", name="uq_chapter_idx"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    novel_id: Mapped[int] = mapped_column(ForeignKey("novels.id"), index=True)
    index: Mapped[int] = mapped_column(Integer)  # 1-based
    title: Mapped[str] = mapped_column(String(256), default="")
    blueprint: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # 细纲：场景列表等
    scenes: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)  # 已生成场景（检查点）
    content: Mapped[str] = mapped_column(Text, default="")
    word_count: Mapped[int] = mapped_column(Integer, default=0)
    summary: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default=ChapterStatus.pending.value)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    novel: Mapped["Novel"] = relationship(back_populates="chapters")


class Job(Base):
    """流水线任务。检查点存 checkpoint，进程重启后从 stage + checkpoint 续跑。"""
    __tablename__ = "jobs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    novel_id: Mapped[int | None] = mapped_column(ForeignKey("novels.id"), nullable=True, index=True)
    type: Mapped[str] = mapped_column(String(16), default=JobType.generate.value)
    stage: Mapped[str] = mapped_column(String(32), default="ideation")
    status: Mapped[str] = mapped_column(String(16), default=JobStatus.queued.value, index=True)
    priority: Mapped[int] = mapped_column(Integer, default=0)  # 高者先跑（续写 > 新书）
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    checkpoint: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    progress: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # 展示用：当前章/总章等
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class UsageLedger(Base):
    __tablename__ = "usage_ledger"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    novel_id: Mapped[int | None] = mapped_column(ForeignKey("novels.id"), nullable=True, index=True)
    chapter_id: Mapped[int | None] = mapped_column(ForeignKey("chapters.id"), nullable=True)
    stage: Mapped[str] = mapped_column(String(32), default="")
    profile_id: Mapped[int | None] = mapped_column(ForeignKey("llm_profiles.id"), nullable=True)
    model: Mapped[str] = mapped_column(String(128), default="")
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class ReaderPassword(Base):
    __tablename__ = "reader_passwords"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    label: Mapped[str] = mapped_column(String(128), default="reader")
    password_hash: Mapped[str] = mapped_column(String(256))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class NovelEmbedding(Base):
    """premise/大纲向量，用于重复题材探测。向量以 JSON 数组存，Python 侧算余弦。"""
    __tablename__ = "novel_embeddings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    novel_id: Mapped[int] = mapped_column(ForeignKey("novels.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16), default="premise")
    text: Mapped[str] = mapped_column(Text, default="")
    vector: Mapped[list[float]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Image(Base):
    __tablename__ = "images"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    novel_id: Mapped[int] = mapped_column(ForeignKey("novels.id"), index=True)
    chapter_id: Mapped[int | None] = mapped_column(ForeignKey("chapters.id"), nullable=True)
    kind: Mapped[str] = mapped_column(String(16), default="cover")  # cover / illustration
    path: Mapped[str] = mapped_column(String(512))
    prompt: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ReadingProgress(Base):
    __tablename__ = "reading_progress"
    __table_args__ = (UniqueConstraint("reader_id", "novel_id", name="uq_progress"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    reader_id: Mapped[str] = mapped_column(String(64), index=True)  # 只读密码身份
    novel_id: Mapped[int] = mapped_column(ForeignKey("novels.id"), index=True)
    chapter_index: Mapped[int] = mapped_column(Integer, default=1)
    scroll: Mapped[float] = mapped_column(Float, default=0.0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
