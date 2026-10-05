from __future__ import annotations

import pytest


def _reset_test_runtime_state() -> None:
    from app.core.config import reset_settings_cache
    from app.db.session import reset_db_runtime
    from app.services.app_settings import reset_settings_read_cache
    from app.services.bundle_state import set_bundle
    from app.services.mibs_service import _invalidate_source_cache
    from app.services.runtime import reset_runtime_service
    from app.services.state_store import reset_state_store

    reset_settings_cache()
    reset_settings_read_cache()
    reset_db_runtime()
    reset_runtime_service()
    reset_state_store()
    _invalidate_source_cache()
    set_bundle(None)


@pytest.fixture()
def isolated_db(monkeypatch, tmp_path):
    from app.core.config import get_settings
    from app.db.migrations import upgrade_database
    from app.db.session import create_session_factory, get_engine

    data_dir = tmp_path / "test-data"
    db_path = data_dir / "trishul.sqlite3"

    monkeypatch.setenv("TRISHUL_DATA_DIR", str(data_dir))
    monkeypatch.delenv("DATABASE_URL", raising=False)

    _reset_test_runtime_state()

    settings = get_settings()
    upgrade_database()

    yield {
        "settings": settings,
        "db_path": db_path,
        "database_url": settings.database_url,
        "engine": get_engine(),
        "session_factory": create_session_factory(),
    }

    _reset_test_runtime_state()
