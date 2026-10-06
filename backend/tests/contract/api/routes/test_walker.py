from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

pytestmark = pytest.mark.contract


def _login_token() -> str:
    from app.api.routes import settings as settings_module

    return settings_module.login(
        settings_module.LoginBody(username="admin", password="admin123")
    )["token"]


def test_walk_route_delegates_request_flags_and_returns_service_payload(isolated_db, monkeypatch):
    import app.services.runtime as runtime_module
    from app.api.routes import walker as walker_module

    token = _login_token()
    runtime = object()
    calls: list[dict[str, object]] = []

    async def fake_execute(**kwargs):
        calls.append(kwargs)
        if kwargs["parse"]:
            return {
                "mode": "parsed",
                "count": 1,
                "data": [{"symbolic": "SNMPv2-MIB::sysName.0"}],
            }
        return {
            "mode": "raw",
            "json_format": kwargs["json_format"],
            "data": ["1.3.6.1.2.1.1.5.0 = demo-agent"],
        }

    monkeypatch.setattr(runtime_module, "get_runtime_service", lambda: runtime)
    monkeypatch.setattr(walker_module.walker_service, "execute", fake_execute)

    async def fake_broadcast_stats(*, settings):
        del settings
        return None

    # R-2: the route broadcasts stats after a successful walk; stub it so the
    # raw runtime double is not queried for stats.
    monkeypatch.setattr(walker_module, "broadcast_stats", fake_broadcast_stats)

    parsed = asyncio.run(
        walker_module.execute_walk(
            walker_module.WalkBody(
                target="127.0.0.1",
                port=1161,
                community="public",
                oid="1.3.6.1.2.1.1",
                parse=True,
                use_mibs=True,
            ),
            x_auth_token=token,
        )
    )
    assert parsed["mode"] == "parsed"
    assert parsed["count"] == 1
    assert parsed["data"][0]["symbolic"] == "SNMPv2-MIB::sysName.0"

    raw = asyncio.run(
        walker_module.execute_walk(
            walker_module.WalkBody(
                target="127.0.0.1",
                port=1161,
                community="public",
                oid="SNMPv2-MIB::sysName",
                parse=False,
                use_mibs=False,
                json_format="grouped",
            ),
            x_auth_token=token,
        )
    )
    assert raw == {
        "mode": "raw",
        "json_format": "grouped",
        "data": ["1.3.6.1.2.1.1.5.0 = demo-agent"],
    }

    assert calls[0]["target"] == "127.0.0.1"
    assert calls[0]["parse"] is True
    assert calls[0]["use_mibs"] is True
    assert calls[0]["json_format"] == "flat"
    assert calls[0]["runtime_service"] is runtime
    assert calls[1]["oid"] == "SNMPv2-MIB::sysName"
    assert calls[1]["parse"] is False
    assert calls[1]["use_mibs"] is False
    assert calls[1]["json_format"] == "grouped"
    assert calls[1]["settings"] == isolated_db["settings"]


def test_walk_route_requires_auth_and_translates_service_errors(isolated_db, monkeypatch):
    import app.services.runtime as runtime_module
    from app.api.routes import walker as walker_module
    from app.services.walker_service import WalkerError

    del isolated_db

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            walker_module.execute_walk(
                walker_module.WalkBody(
                    target="127.0.0.1",
                    port=1161,
                    community="public",
                    oid="1.3.6.1.2.1.1",
                ),
                x_auth_token=None,
            )
        )
    assert excinfo.value.status_code == 401

    async def fail_execute(**kwargs):
        del kwargs
        raise WalkerError("walk failed")

    monkeypatch.setattr(runtime_module, "get_runtime_service", lambda: object())
    monkeypatch.setattr(walker_module.walker_service, "execute", fail_execute)

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            walker_module.execute_walk(
                walker_module.WalkBody(
                    target="127.0.0.1",
                    port=1161,
                    community="public",
                    oid="1.3.6.1.2.1.1",
                ),
                x_auth_token=_login_token(),
            )
        )
    assert excinfo.value.status_code == 400
    assert excinfo.value.detail == "walk failed"


def test_walk_route_validates_and_passes_timeout_and_retries(isolated_db, monkeypatch):
    # WLK-10: WalkBody carries timeout_ms (500-10000, default 2000) and
    # retries (0-5, default 1); valid values pass through to the service,
    # out-of-bounds values are rejected at the request model.
    import asyncio as _asyncio

    import app.services.runtime as runtime_module
    import pydantic
    from app.api.routes import walker as walker_module

    del isolated_db
    token = _login_token()
    calls: list[dict[str, object]] = []

    async def fake_execute(**kwargs):
        calls.append(kwargs)
        return {"mode": "raw", "count": 0, "data": []}

    monkeypatch.setattr(runtime_module, "get_runtime_service", lambda: object())
    monkeypatch.setattr(walker_module.walker_service, "execute", fake_execute)

    async def fake_broadcast_stats(*, settings):
        del settings
        return None

    monkeypatch.setattr(walker_module, "broadcast_stats", fake_broadcast_stats)

    _asyncio.run(
        walker_module.execute_walk(
            walker_module.WalkBody(
                target="127.0.0.1",
                port=1161,
                community="public",
                oid="1.3.6.1.2.1.1",
            ),
            x_auth_token=token,
        )
    )
    assert calls[0]["timeout_ms"] == 2000
    assert calls[0]["retries"] == 1

    _asyncio.run(
        walker_module.execute_walk(
            walker_module.WalkBody(
                target="127.0.0.1",
                port=1161,
                community="public",
                oid="1.3.6.1.2.1.1",
                timeout_ms=5000,
                retries=4,
            ),
            x_auth_token=token,
        )
    )
    assert calls[1]["timeout_ms"] == 5000
    assert calls[1]["retries"] == 4

    base = {
        "target": "127.0.0.1",
        "port": 1161,
        "community": "public",
        "oid": "1.3.6.1.2.1.1",
    }
    for overrides in (
        {"timeout_ms": 100},
        {"timeout_ms": 10001},
        {"retries": -1},
        {"retries": 6},
    ):
        with pytest.raises(pydantic.ValidationError):
            walker_module.WalkBody(**{**base, **overrides})


def test_walk_route_broadcasts_stats_after_successful_execute(isolated_db, monkeypatch):
    # R-2: successful walk executions must push fresh stats over WS so the
    # dashboard walk cards update without a page re-entry.
    import app.services.runtime as runtime_module
    from app.api.routes import walker as walker_module
    from app.services.walker_service import WalkerError

    del isolated_db
    token = _login_token()
    broadcasts: list[object] = []

    async def fake_execute(**kwargs):
        del kwargs
        return {"mode": "raw", "count": 0, "data": []}

    async def fake_broadcast_stats(*, settings):
        broadcasts.append(settings)
        return None

    monkeypatch.setattr(runtime_module, "get_runtime_service", lambda: object())
    monkeypatch.setattr(walker_module.walker_service, "execute", fake_execute)
    monkeypatch.setattr(walker_module, "broadcast_stats", fake_broadcast_stats)

    result = asyncio.run(
        walker_module.execute_walk(
            walker_module.WalkBody(
                target="127.0.0.1",
                port=1161,
                community="public",
                oid="1.3.6.1.2.1.1",
            ),
            x_auth_token=token,
        )
    )
    assert result == {"mode": "raw", "count": 0, "data": []}
    assert len(broadcasts) == 1

    # A failed walk must not broadcast (nothing to refresh).
    async def fail_execute(**kwargs):
        del kwargs
        raise WalkerError("walk failed")

    monkeypatch.setattr(walker_module.walker_service, "execute", fail_execute)
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            walker_module.execute_walk(
                walker_module.WalkBody(
                    target="127.0.0.1",
                    port=1161,
                    community="public",
                    oid="1.3.6.1.2.1.1",
                ),
                x_auth_token=token,
            )
        )
    assert excinfo.value.status_code == 400
    assert len(broadcasts) == 1
