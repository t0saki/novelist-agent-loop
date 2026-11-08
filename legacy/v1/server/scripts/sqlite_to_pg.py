"""一次性把 SQLite 数据整体迁移到 Postgres。

用法：
    python scripts/sqlite_to_pg.py <sqlite_url> <pg_url>
例：
    python scripts/sqlite_to_pg.py \\
        sqlite:////data/novelist.db \\
        postgresql+psycopg://novelist:pass@postgres:5432/novelist

会在目标库 create_all 后，按外键安全顺序整表复制，并把 Postgres 的自增序列
重置到各表 max(id)，之后新插入不会撞已迁移的 id。幂等性：仅用于空目标库。
"""
from __future__ import annotations

import sys

from sqlalchemy import create_engine, insert, select, text
from sqlalchemy.orm import Session

from app.db.models import (
    Base,
    Chapter,
    Image,
    Job,
    LlmProfile,
    Novel,
    NovelEmbedding,
    ReaderPassword,
    ReadingProgress,
    Setting,
    Theme,
    UsageLedger,
)

# 外键安全的复制顺序（父表在前）
ORDER = [
    Setting, LlmProfile, Theme, ReaderPassword,
    Novel, Chapter, Job, UsageLedger, NovelEmbedding, Image, ReadingProgress,
]


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    src_url, dst_url = sys.argv[1], sys.argv[2]
    src = create_engine(
        src_url,
        connect_args={"check_same_thread": False} if src_url.startswith("sqlite") else {},
    )
    dst = create_engine(dst_url)
    Base.metadata.create_all(dst)

    with Session(src) as ss, dst.begin() as dc:
        for model in ORDER:
            rows = ss.execute(select(model)).scalars().all()
            if not rows:
                print(f"  {model.__tablename__}: 0")
                continue
            payload = [
                {c.name: getattr(r, c.name) for c in model.__table__.columns}
                for r in rows
            ]
            dc.execute(insert(model.__table__), payload)
            print(f"  {model.__tablename__}: {len(payload)}")

    # 重置 Postgres 自增序列
    if dst_url.startswith("postgresql"):
        with dst.connect() as c:
            for model in ORDER:
                t = model.__tablename__
                if "id" not in model.__table__.columns:
                    continue
                try:
                    c.execute(text(
                        f"SELECT setval(pg_get_serial_sequence('{t}', 'id'), "
                        f"COALESCE((SELECT MAX(id) FROM {t}), 1), true)"
                    ))
                    c.commit()
                except Exception as e:  # noqa: BLE001
                    print(f"  [seq skip] {t}: {e}")
    print("迁移完成")


if __name__ == "__main__":
    main()
