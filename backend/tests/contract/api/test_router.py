from __future__ import annotations

import pytest

pytestmark = pytest.mark.contract


def test_create_app_registers_current_api_routes(isolated_db):
    from app.main import create_app

    del isolated_db

    route_paths = {
        route.path for route in create_app().routes if route.path.startswith("/api")
    }
    assert {
        "/api/meta",
        "/api/health",
        "/api/settings/login",
        "/api/settings/app",
        "/api/stats",
        "/api/simulator/status",
        "/api/simulator/logs",
        "/api/walk/execute",
        "/api/traps/send",
        "/api/mibs/status",
        "/api/mibs/export",
        "/api/mibs/delete-batch",
        "/api/mibs/browse/modules",
        "/api/healthz/ui",
        "/api/ws",
    } <= route_paths

    assert {path.split("/", 3)[2] for path in route_paths} == {
        "meta",
        "health",
        "settings",
        "stats",
        "simulator",
        "walk",
        "traps",
        "mibs",
        "bundles",
        "healthz",
        "ws",
    }
    assert {
        path for path in route_paths if path.startswith("/api/healthz/")
    } == {"/api/healthz/ui"}
