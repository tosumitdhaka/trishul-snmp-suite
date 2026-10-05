from __future__ import annotations

import pytest

from app.services.app_settings import validate_remote_sources

pytestmark = pytest.mark.unit


def test_validate_remote_sources_accepts_http_https_templates_and_strips():
    normalized, error = validate_remote_sources(
        [
            "  https://example.invalid/mibs/@mib@  ",
            "http://other.invalid/@mib@.mib",
            "   ",
            "",
        ]
    )
    assert error is None
    assert normalized == [
        "https://example.invalid/mibs/@mib@",
        "http://other.invalid/@mib@.mib",
    ]


def test_validate_remote_sources_rejects_entry_missing_placeholder():
    normalized, error = validate_remote_sources(
        ["https://example.invalid/mibs/IF-MIB"]
    )
    assert normalized == []
    assert error is not None
    assert "@mib@" in error


def test_validate_remote_sources_rejects_non_http_schemes_and_bare_paths():
    for bad_entry in (
        "ftp://example.invalid/mibs/@mib@",
        "file:///tmp/mibs/@mib@",
        "/abs/path/@mib@",
    ):
        normalized, error = validate_remote_sources([bad_entry])
        assert normalized == []
        assert error is not None
        assert "http(s)" in error


def test_validate_remote_sources_empty_list_is_valid():
    normalized, error = validate_remote_sources([])
    assert normalized == []
    assert error is None


def test_settings_read_cache_serves_values_and_invalidates_on_update(isolated_db):
    del isolated_db

    from app.models import AppSetting
    from app.services.app_settings import AppSettingsService

    service = AppSettingsService()
    assert service.get_int("session_timeout_seconds") == 3600  # default, cache miss

    # A write that bypasses update_settings is invisible to the cached read.
    with service.session_factory() as session:
        session.add(AppSetting(key="session_timeout_seconds", value_json=4200))
        session.commit()
    assert service.get_int("session_timeout_seconds") == 3600  # served from cache

    # update_settings invalidates the cache, so the fresh value is served.
    service.update_settings({"session_timeout_seconds": 4800})
    assert service.get_int("session_timeout_seconds") == 4800


def test_settings_read_cache_is_shared_across_service_instances(isolated_db):
    del isolated_db

    from app.models import AppSetting
    from app.services.app_settings import AppSettingsService

    # Every request builds a fresh service; the cache is keyed by database URL.
    first = AppSettingsService()
    assert first.get_int("session_timeout_seconds") == 3600

    with first.session_factory() as session:
        session.add(AppSetting(key="session_timeout_seconds", value_json=4200))
        session.commit()

    # A second fresh instance reads the same cached snapshot, not the DB row.
    second = AppSettingsService()
    assert second.get_int("session_timeout_seconds") == 3600