from __future__ import annotations

from unittest.mock import MagicMock

import pytest

pytestmark = pytest.mark.unit


@pytest.mark.asyncio
async def test_get_stats_prefers_runtime_configured_object_count(isolated_db, monkeypatch):
    import app.services.runtime as runtime_module
    from app.services import stats_service
    from app.services.history import EventHistoryService
    from app.services.state_store import StateStore

    class StubRuntime:
        async def get_state(self):
            return {
                "responder": {
                    "running": False,
                    "configured_object_count": 5,
                    "request_count": 7,
                },
                "notifications": {
                    "listener": {"running": False},
                },
                "active_bundle": None,
            }

    monkeypatch.setattr(runtime_module, "_runtime_service", StubRuntime(), raising=False)
    monkeypatch.setattr(runtime_module, "get_runtime_service", lambda: StubRuntime())

    stats = await stats_service.get_stats(
        state=StateStore(isolated_db["session_factory"]),
        history_service=EventHistoryService(isolated_db["settings"]),
        runtime_service=StubRuntime(),
    )

    assert stats["simulator"]["oids_loaded"] == 5
    assert stats["simulator"]["snmp_requests_served"] == 7
    assert stats["mibs"]["upload_count"] == 0
    assert "walker" in stats
    assert "mibs" in stats
    assert "runtime" not in stats


@pytest.mark.asyncio
async def test_get_stats_falls_back_to_active_bundle_object_count(isolated_db):
    from app.services import stats_service
    from app.services.bundle_state import set_bundle
    from app.services.history import EventHistoryService
    from app.services.state_store import StateStore

    class StubRuntime:
        async def get_state(self):
            return {
                "responder": {
                    "running": False,
                    "configured_object_count": None,
                    "request_count": 0,
                },
                "notifications": {
                    "listener": {"running": False},
                },
                "active_bundle": None,
            }

    mock_bundle = MagicMock()
    mock_module = MagicMock()
    mock_module.objects = {"obj1": None, "obj2": None, "obj3": None}
    mock_bundle.modules = {"TEST-MIB": mock_module}
    set_bundle(mock_bundle)

    stats = await stats_service.get_stats(
        state=StateStore(isolated_db["session_factory"]),
        history_service=EventHistoryService(isolated_db["settings"]),
        runtime_service=StubRuntime(),
    )

    assert stats["simulator"]["oids_loaded"] == 3
    assert stats["simulator"]["snmp_requests_served"] == 0


@pytest.mark.asyncio
async def test_get_stats_counts_uploaded_mib_sources(isolated_db):
    from app.services import stats_service
    from app.services.history import EventHistoryService
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    upload_dir = settings.data_dir / "mibs" / "common"
    upload_dir.mkdir(parents=True, exist_ok=True)
    (upload_dir / "TEST-UPLOAD-MIB.mib").write_text(
        "TEST-UPLOAD-MIB DEFINITIONS ::= BEGIN\n"
        "testUpload OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 99999 101 }\n"
        "END\n"
    )

    class StubRuntime:
        async def get_state(self):
            return {
                "responder": {
                    "running": False,
                    "configured_object_count": 0,
                    "request_count": 0,
                },
                "notifications": {
                    "listener": {"running": False},
                },
                "active_bundle": None,
            }

    stats = await stats_service.get_stats(
        state=StateStore(isolated_db["session_factory"]),
        history_service=EventHistoryService(settings),
        runtime_service=StubRuntime(),
        settings=settings,
    )

    assert stats["mibs"]["upload_count"] == 1


@pytest.mark.asyncio
async def test_reset_stats_clears_runtime_and_history(isolated_db):
    from app.services import stats_service
    from app.services.state_store import (
        StateStore,
        _MIB_RELOAD_COUNT_KEY,
        _WALK_OIDS_RETURNED_KEY,
        _WALKS_EXECUTED_KEY,
    )

    state = StateStore(isolated_db["session_factory"])
    state.increment_counter(_WALKS_EXECUTED_KEY, 3)
    state.increment_counter(_WALK_OIDS_RETURNED_KEY, 7)
    state.increment_counter(_MIB_RELOAD_COUNT_KEY, 2)

    class StubRuntime:
        def __init__(self) -> None:
            self.reset_calls = 0

        async def reset_responder_counters(self):
            self.reset_calls += 1
            return {"status": "reset"}

    class StubHistory:
        def __init__(self) -> None:
            self.clear_calls = 0

        def clear_events(self):
            self.clear_calls += 1
            return {"status": "cleared", "deleted": 4}

    runtime_service = StubRuntime()
    history_service = StubHistory()

    result = await stats_service.reset_stats(
        state=state,
        history_service=history_service,
        runtime_service=runtime_service,
    )

    assert result == {"status": "reset"}
    assert state.counter(_WALKS_EXECUTED_KEY) == 0
    assert state.counter(_WALK_OIDS_RETURNED_KEY) == 0
    assert state.counter(_MIB_RELOAD_COUNT_KEY) == 0
    assert runtime_service.reset_calls == 1
    assert history_service.clear_calls == 1


@pytest.mark.asyncio
async def test_reset_stats_clears_recorded_received_events(isolated_db):
    """Reset Stats must empty the event store the traps page polls (RCV-03).

    The traps page treats GET /api/traps/ as authoritative; after a stats
    reset it must find zero received events, otherwise its cached copy would
    disagree with the DB and deleted traps would resurrect on the next poll.
    """
    from app.services import stats_service
    from app.services.history import EventHistoryService
    from app.services.state_store import StateStore

    history = EventHistoryService(isolated_db["settings"])
    history.record_event(direction="received", pdu_type="trap", event={"varbinds": []})
    history.record_event(direction="received", pdu_type="trap", event={"varbinds": []})

    assert history.list_events(direction="received", limit=10)["total"] == 2

    class StubRuntime:
        async def reset_responder_counters(self):
            return {"status": "reset"}

    result = await stats_service.reset_stats(
        state=StateStore(isolated_db["session_factory"]),
        history_service=history,
        runtime_service=StubRuntime(),
    )

    assert result == {"status": "reset"}
    assert history.list_events(direction="received", limit=10)["total"] == 0
