"""测试夹具：隔离的临时 data 目录 + mock LLM。"""
import os
import tempfile

os.environ.setdefault("NOVELIST_DATA_DIR", tempfile.mkdtemp(prefix="novelist-test-"))
os.environ["NOVELIST_MOCK_LLM"] = "true"
os.environ["NOVELIST_SCHEDULER_ENABLED"] = "false"

import pytest  # noqa: E402

from app.db.database import init_db, session_scope  # noqa: E402
from app.db.seed import seed_defaults  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _db():
    init_db()
    with session_scope() as s:
        seed_defaults(s)
    yield
