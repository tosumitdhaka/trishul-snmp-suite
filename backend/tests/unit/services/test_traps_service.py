from __future__ import annotations

import asyncio

import pytest

pytestmark = pytest.mark.unit


class _TrapRuntimeStub:
    def __init__(self, *, listener: dict[str, object] | None = None) -> None:
        self.listener = listener or {
            "running": False,
            "port": None,
            "communities": [],
        }
        self.start_calls: list[dict[str, object]] = []
        self.stop_calls = 0
        self.send_calls: list[dict[str, object]] = []

    async def get_state(self) -> dict[str, object]:
        return {"notifications": {"listener": dict(self.listener)}}

    async def start_listener(self, **kwargs) -> None:
        self.start_calls.append(kwargs)

    async def stop_listener(self) -> None:
        self.stop_calls += 1

    async def send_trap(self, **kwargs) -> None:
        self.send_calls.append(kwargs)


def _activate_trap_bundle(isolated_db):
    from app.services.bundle_state import get_bundle
    from app.services.bundles import BundleCompileRequest, BundleService

    settings = isolated_db["settings"]
    BundleService(settings).compile_bundle(
        BundleCompileRequest(mib_names=["IF-MIB", "SNMPv2-MIB"], activate=True)
    )

    bundle = get_bundle()
    assert bundle is not None
    return bundle


def test_varbind_to_runtime_maps_supported_types():
    from app.services.traps_service import _varbind_to_runtime

    result = _varbind_to_runtime(
        {"oid": "1.3.6.1.2.1.1.3.0", "type": "TimeTicks", "value": 321},
        index=1,
    )
    assert result == {
        "target": "1.3.6.1.2.1.1.3.0",
        "value": {"type": "timeticks", "value": 321},
    }

    result_int = _varbind_to_runtime(
        {"oid": "1.3.6.1.2.1.1.7.0", "type": "Integer", "value": 5},
        index=2,
    )
    assert result_int["value"]["type"] == "integer"
    assert result_int["value"]["value"] == 5

    result_str = _varbind_to_runtime(
        {"oid": "1.3.6.1.2.1.1.1.0", "type": "String", "value": "hello"},
        index=3,
    )
    assert result_str["value"]["type"] == "octet-string"
    assert result_str["value"]["value"] == "hello"

    result_bool = _varbind_to_runtime(
        {"oid": "1.3.6.1.2.1.1.7.0", "type": "Integer", "value": True},
        index=4,
    )
    assert result_bool["value"] == {"type": "integer", "value": 1}

    result_counter64 = _varbind_to_runtime(
        {"oid": "1.3.6.1.2.1.31.1.1.1.6.1", "type": "Counter64", "value": "999"},
        index=5,
    )
    assert result_counter64["value"] == {"type": "counter64", "value": 999}

    result_ip = _varbind_to_runtime(
        {"oid": ".1.3.6.1.2.1.4.20.1.1.127.0.0.1", "type": "IpAddress", "value": "127.0.0.1"},
        index=6,
    )
    assert result_ip == {
        "target": "1.3.6.1.2.1.4.20.1.1.127.0.0.1",
        "value": {"type": "ip-address", "value": "127.0.0.1"},
    }


def test_varbind_to_runtime_rejects_short_object_identifier_values():
    from app.services.traps_service import TrapsError, _varbind_to_runtime

    with pytest.raises(TrapsError, match="VarBind 1 value"):
        _varbind_to_runtime(
            {"oid": "1.3.6.1.2.1.1.3.0", "type": "OID", "value": "1"},
            index=1,
        )


def test_format_trap_event_accepts_runtime_event_payload(isolated_db):
    from app.services.bundle_state import get_bundle
    from app.services.traps_service import _format_trap_event

    payload = _format_trap_event(
        {
            "event_id": 7,
            "recorded_at": "2026-05-13T06:06:00+00:00",
            "source_address": {"host": "127.0.0.1", "port": 51589},
            "notification_oid": "1.3.6.1.6.3.1.1.5.3",
            "notification_name": "IF-MIB::linkDown",
            "resolve_mibs": True,
            "pdu_type": "snmpv2-trap",
            "varbinds": [
                {
                    "oid": "1.3.6.1.2.1.1.3.0",
                    "symbolic": "SNMPv2-MIB::sysUpTime.0",
                    "value": {"type": "timeticks", "value": 321},
                }
            ],
        },
        resolve_mibs=True,
        bundle=get_bundle(),
    )

    assert payload["id"] == 7
    assert payload["source"] == "127.0.0.1:51589"
    assert payload["trap_type"] == "linkDown"
    assert payload["resolve_mibs"] is True
    assert payload["varbinds"][0]["name"] == "SNMPv2-MIB::sysUpTime.0"


def test_format_trap_event_varbinds_carry_raw_values_with_enum_metadata(isolated_db):
    from app.services.bundle_state import get_bundle
    from app.services.traps_service import _format_trap_event

    _activate_trap_bundle(isolated_db)

    base_event = {
        "event_id": 11,
        "recorded_at": "2026-05-13T06:06:00+00:00",
        "source_address": {"host": "127.0.0.1", "port": 51589},
        "notification_oid": "1.3.6.1.6.3.1.1.5.3",
        "pdu_type": "snmpv2-trap",
        "varbinds": [
            {
                "oid": "1.3.6.1.2.1.2.2.1.7.1",
                "symbolic": "IF-MIB::ifAdminStatus.1",
                "value": {"type": "integer", "display": "1", "value": 1},
                "display_value": "up(1)",
                "enum_label": "up",
                "units": None,
            }
        ],
    }

    resolved = _format_trap_event(
        {**base_event, "resolve_mibs": True},
        resolve_mibs=True,
        bundle=get_bundle(),
    )
    row = resolved["varbinds"][0]
    assert row["name"] == "IF-MIB::ifAdminStatus.1"
    assert row["value"] == "1"
    assert row["display_value"] == "up(1)"
    assert row["enum_label"] == "up"
    assert row["units"] is None

    raw = _format_trap_event(
        {**base_event, "resolve_mibs": False},
        resolve_mibs=False,
        bundle=get_bundle(),
    )
    raw_row = raw["varbinds"][0]
    assert raw_row["name"] == "1.3.6.1.2.1.2.2.1.7.1"
    assert raw_row["value"] == "1"
    assert raw_row["display_value"] == "up(1)"
    assert raw_row["enum_label"] == "up"
    assert raw_row["units"] is None


def test_listener_status_start_stop_and_send_trap_cover_service_flow(isolated_db, monkeypatch):
    from app.services import traps_service
    from app.services.state_store import (
        StateStore,
        _LISTENER_COMMUNITY_KEY,
        _LISTENER_PORT_KEY,
        _LISTENER_STARTED_AT_KEY,
        _TRAP_RESOLVE_MIBS_KEY,
    )

    settings = isolated_db["settings"]
    state = StateStore(isolated_db["session_factory"])
    runtime = _TrapRuntimeStub()
    broadcasts: list[object] = []

    state.set_value(_LISTENER_PORT_KEY, 3162)
    state.set_value(_LISTENER_COMMUNITY_KEY, "private")
    state.set_value(_TRAP_RESOLVE_MIBS_KEY, False)

    status = asyncio.run(traps_service.get_status(state=state, runtime_service=runtime))
    assert status == {
        "running": False,
        "port": 3162,
        "community": "private",
        "resolve_mibs": False,
        "uptime_seconds": None,
    }

    async def fake_broadcast_status(*, settings):
        broadcasts.append(settings)

    monkeypatch.setattr(traps_service, "broadcast_status", fake_broadcast_status)

    started = asyncio.run(
        traps_service.start_listener(
            port=2162,
            community="public",
            resolve_mibs=True,
            settings=settings,
            state=state,
            runtime_service=runtime,
        )
    )
    assert started == {"status": "started"}
    assert runtime.start_calls == [{"host": "0.0.0.0", "port": 2162, "communities": ["public"]}]
    assert state.snapshot()[_LISTENER_PORT_KEY] == 2162
    assert state.snapshot()[_LISTENER_COMMUNITY_KEY] == "public"
    assert state.snapshot()[_TRAP_RESOLVE_MIBS_KEY] is True
    assert state.snapshot()[_LISTENER_STARTED_AT_KEY] is not None

    _activate_trap_bundle(isolated_db)
    sent = asyncio.run(
        traps_service.send_trap(
            target="127.0.0.1",
            port=2162,
            community="public",
            oid="IF-MIB::linkDown",
            varbinds=[
                {"oid": "1.3.6.1.2.1.1.3.0", "type": "TimeTicks", "value": "321"},
                {"oid": "1.3.6.1.2.1.2.2.1.7.1", "type": "Integer", "value": True},
            ],
            settings=settings,
            runtime_service=runtime,
        )
    )
    assert sent == {"status": "sent", "target": "127.0.0.1", "port": 2162}
    assert runtime.send_calls[0]["notification"] == "1.3.6.1.6.3.1.1.5.3"
    assert runtime.send_calls[0]["varbinds"][1]["value"] == {"type": "integer", "value": 1}

    stopped = asyncio.run(
        traps_service.stop_listener(
            settings=settings,
            state=state,
            runtime_service=runtime,
        )
    )
    assert stopped == {"status": "stopped"}
    assert runtime.stop_calls == 1
    assert state.snapshot()[_LISTENER_STARTED_AT_KEY] is None
    assert broadcasts == [settings, settings]


def test_list_snapshot_and_clear_events_cover_history_paths(isolated_db):
    from app.models import NotificationEvent
    from app.services import traps_service
    from app.services.state_store import StateStore, _TRAP_RESOLVE_MIBS_KEY
    from sqlalchemy import select

    settings = isolated_db["settings"]
    session_factory = isolated_db["session_factory"]
    state = StateStore(session_factory)
    state.set_value(_TRAP_RESOLVE_MIBS_KEY, True)
    _activate_trap_bundle(isolated_db)

    item = {
        "id": 5,
        "recorded_at": "2026-05-13T06:06:00Z",
        "notification_oid": "1.3.6.1.6.3.1.1.5.3",
        "resolve_mibs": False,
        "event": {
            "source_address": {"host": "127.0.0.1"},
            "resolve_mibs": False,
            "varbinds": [
                {
                    "oid": "1.3.6.1.2.1.1.3.0",
                    "symbolic": "SNMPv2-MIB::sysUpTime.0",
                    "display_value": "321",
                }
            ],
        },
    }

    class _HistoryList:
        def __init__(self, session_factory) -> None:
            self.session_factory = session_factory

        def list_events(self, *, direction: str, limit: int, offset: int) -> dict[str, object]:
            assert direction == "received"
            assert limit == 5
            assert offset == 0
            return {"items": [item]}

    history = _HistoryList(session_factory)
    listed = traps_service.list_events(state=state, history_service=history, limit=5)
    assert listed["count"] == 1
    assert listed["data"][0]["source"] == "127.0.0.1"
    assert listed["data"][0]["trap_type"] == "1.3.6.1.6.3.1.1.5.3"
    assert listed["data"][0]["resolve_mibs"] is False
    assert listed["data"][0]["resolved"] is False
    assert listed["data"][0]["varbinds"][0]["name"] == "1.3.6.1.2.1.1.3.0"

    snapshot = traps_service.get_trap_event_snapshot(item, state=state, history_service=history)
    assert snapshot["id"] == 5
    assert snapshot["time_str"] == "06:06:00"
    assert snapshot["resolve_mibs"] is False

    with session_factory() as session:
        session.add(
            NotificationEvent(
                direction="received",
                pdu_type="trap",
                event_json={"id": 1},
            )
        )
        session.add(
            NotificationEvent(
                direction="sent",
                pdu_type="trap",
                event_json={"id": 2},
            )
        )
        session.commit()

    cleared = traps_service.clear_events(history_service=history)
    assert cleared == {"status": "cleared"}

    with session_factory() as session:
        rows = session.scalars(select(NotificationEvent).order_by(NotificationEvent.id)).all()
    assert [row.direction for row in rows] == ["sent"]


def test_traps_service_translates_runtime_errors(isolated_db):
    from app.services import traps_service
    from app.services.runtime import RuntimeServiceError
    from app.services.state_store import StateStore
    from app.services.traps_service import TrapsError

    settings = isolated_db["settings"]
    state = StateStore(isolated_db["session_factory"])

    class _FailingTrapRuntime(_TrapRuntimeStub):
        async def start_listener(self, **kwargs) -> None:
            del kwargs
            raise RuntimeServiceError("start failed")

        async def stop_listener(self) -> None:
            raise RuntimeServiceError("stop failed")

        async def send_trap(self, **kwargs) -> None:
            del kwargs
            raise RuntimeServiceError("send failed")

    with pytest.raises(TrapsError, match="start failed"):
        asyncio.run(
            traps_service.start_listener(
                port=2162,
                community="public",
                resolve_mibs=True,
                settings=settings,
                state=state,
                runtime_service=_FailingTrapRuntime(),
            )
        )

    with pytest.raises(TrapsError, match="stop failed"):
        asyncio.run(
            traps_service.stop_listener(
                settings=settings,
                state=state,
                runtime_service=_FailingTrapRuntime(),
            )
        )

    with pytest.raises(TrapsError, match="send failed"):
        asyncio.run(
            traps_service.send_trap(
                target="127.0.0.1",
                port=2162,
                community="public",
                oid="1.3.6.1.6.3.1.1.5.3",
                varbinds=[],
                settings=settings,
                runtime_service=_FailingTrapRuntime(),
            )
        )
