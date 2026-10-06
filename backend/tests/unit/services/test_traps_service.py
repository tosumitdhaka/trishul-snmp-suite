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
        self.replay_calls: list[dict[str, object]] = []
        self.decode_calls: list[dict[str, object]] = []

    async def get_state(self) -> dict[str, object]:
        return {"notifications": {"listener": dict(self.listener)}}

    async def start_listener(self, **kwargs) -> None:
        self.start_calls.append(kwargs)

    async def stop_listener(self) -> None:
        self.stop_calls += 1

    async def send_trap(self, **kwargs) -> None:
        self.send_calls.append(kwargs)

    async def send_inform(self, **kwargs) -> dict[str, object]:
        self.send_calls.append(kwargs)
        return {
            "request_id": 42,
            "response": {
                "request_id": 42,
                "error_status": "noError",
                "error_status_code": 0,
                "error_index": 0,
                "varbinds": [],
            },
        }

    async def replay_notification_event(self, **kwargs) -> dict[str, object]:
        self.replay_calls.append(kwargs)
        return {"operation": "trap", "target": {"host": kwargs.get("host"), "port": kwargs.get("port")}}

    async def decode_notification_payload(self, **kwargs) -> dict[str, object]:
        self.decode_calls.append(kwargs)
        return {"active_bundle": None, "event": {"pdu_type": "snmpv2-trap"}}


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


def test_varbind_to_runtime_rejects_bad_numeric_values_instead_of_coercing_to_zero():
    from app.services.traps_service import TrapsError, _varbind_to_runtime

    bad_values = [
        {"oid": "1.3.6.1.2.1.1.7.0", "type": "Integer", "value": "abc"},
        {"oid": "1.3.6.1.2.1.1.7.0", "type": "Integer", "value": None},
        {"oid": "1.3.6.1.2.1.1.7.0", "type": "Integer", "value": ""},
        {"oid": "1.3.6.1.2.1.1.7.0", "type": "Integer", "value": 3.7},
        {"oid": "1.3.6.1.2.1.2.1.0", "type": "Counter", "value": "nope"},
        {"oid": "1.3.6.1.2.1.2.1.0", "type": "Gauge", "value": None},
        {"oid": "1.3.6.1.2.1.2.1.0", "type": "TimeTicks", "value": "3.7"},
        {"oid": "1.3.6.1.2.1.31.1.1.1.6.1", "type": "Counter64", "value": "12x"},
    ]
    for index, item in enumerate(bad_values, 1):
        with pytest.raises(TrapsError, match="is not a valid"):
            _varbind_to_runtime(item, index=index)

    # Integral floats remain acceptable (no fractional truncation occurs).
    ok = _varbind_to_runtime(
        {"oid": "1.3.6.1.2.1.1.7.0", "type": "Integer", "value": 3.0},
        index=9,
    )
    assert ok["value"] == {"type": "integer", "value": 3}


def test_send_trap_rejects_non_member_enum_values(isolated_db):
    from app.services import traps_service
    from app.services.traps_service import TrapsError

    _activate_trap_bundle(isolated_db)
    settings = isolated_db["settings"]
    runtime = _TrapRuntimeStub()

    # ifAdminStatus is an INTEGER enum (up=1, down=2, testing=3); 5 is not a member.
    with pytest.raises(TrapsError, match="not a member of the declared enum"):
        asyncio.run(
            traps_service.send_trap(
                target="127.0.0.1",
                port=2162,
                community="public",
                oid="IF-MIB::linkDown",
                varbinds=[
                    {"oid": "1.3.6.1.2.1.2.2.1.7.1", "type": "Integer", "value": 5},
                ],
                settings=settings,
                runtime_service=runtime,
            )
        )
    assert runtime.send_calls == []

    # The same non-member value with a SYMBOLIC target is also rejected now
    # that enum membership resolves symbolic targets (TRP-05 parity).
    with pytest.raises(TrapsError, match="not a member of the declared enum"):
        asyncio.run(
            traps_service.send_trap(
                target="127.0.0.1",
                port=2162,
                community="public",
                oid="IF-MIB::linkDown",
                varbinds=[
                    {"oid": "IF-MIB::ifAdminStatus", "type": "Integer", "value": 5},
                ],
                settings=settings,
                runtime_service=runtime,
            )
        )
    assert runtime.send_calls == []

    # A member value (down=2) passes through to the runtime.
    asyncio.run(
        traps_service.send_trap(
            target="127.0.0.1",
            port=2162,
            community="public",
            oid="IF-MIB::linkDown",
            varbinds=[
                {"oid": "1.3.6.1.2.1.2.2.1.7.1", "type": "Integer", "value": 2},
            ],
            settings=settings,
            runtime_service=runtime,
        )
    )
    assert runtime.send_calls[0]["varbinds"][0]["value"] == {"type": "integer", "value": 2}


def test_send_trap_accepts_symbolic_oid_varbind_values(isolated_db):
    """P-2: symbolic OID varbind values (MODULE::symbol) must pass through to
    the runtime, which resolves them against the active bundle. The old
    pre-validation rejected any value without a dot arc."""
    from app.services import traps_service

    _activate_trap_bundle(isolated_db)
    settings = isolated_db["settings"]
    runtime = _TrapRuntimeStub()

    asyncio.run(
        traps_service.send_trap(
            target="127.0.0.1",
            port=2162,
            community="public",
            oid="IF-MIB::linkDown",
            varbinds=[
                {"oid": "SNMPv2-MIB::snmpTrapOID.0", "type": "OID", "value": "IF-MIB::linkDown"},
            ],
            settings=settings,
            runtime_service=runtime,
        )
    )
    call = runtime.send_calls[0]
    assert call["notification"] == "1.3.6.1.6.3.1.1.5.3"
    # The runtime resolves the symbolic value; the service hands it through.
    assert call["varbinds"][0]["value"] == {"type": "object-identifier", "value": "IF-MIB::linkDown"}

    # Dotted numerics still pass through unchanged.
    asyncio.run(
        traps_service.send_trap(
            target="127.0.0.1",
            port=2162,
            community="public",
            oid="IF-MIB::linkDown",
            varbinds=[
                {"oid": "SNMPv2-MIB::snmpTrapOID.0", "type": "OID", "value": "1.3.6.1.6.3.1.1.5.3"},
            ],
            settings=settings,
            runtime_service=runtime,
        )
    )
    assert runtime.send_calls[1]["varbinds"][0]["value"] == {
        "type": "object-identifier",
        "value": "1.3.6.1.6.3.1.1.5.3",
    }


def test_varbind_to_runtime_rejects_empty_object_identifier_values():
    from app.services.traps_service import TrapsError, _varbind_to_runtime

    with pytest.raises(TrapsError, match="non-empty"):
        _varbind_to_runtime(
            {"oid": "1.3.6.1.2.1.1.3.0", "type": "OID", "value": ""},
            index=1,
        )
    with pytest.raises(TrapsError, match="non-empty"):
        _varbind_to_runtime(
            {"oid": "1.3.6.1.2.1.1.3.0", "type": "OID", "value": None},
            index=2,
        )


def test_send_trap_resolves_enum_labels_for_integer_varbinds(isolated_db):
    """P-3: integer varbinds typed with an enum label ("up") resolve to the
    node's declared number (1); unknown labels 400 with a clear message; plain
    integers and strict TRP-04 behavior for non-enum nodes are unchanged."""
    from app.services import traps_service
    from app.services.traps_service import TrapsError

    _activate_trap_bundle(isolated_db)
    settings = isolated_db["settings"]
    runtime = _TrapRuntimeStub()

    # "up" on IF-MIB::ifAdminStatus (up=1) sends as integer 1 — both for a
    # symbolic varbind target (the picker form) and a numeric target.
    asyncio.run(
        traps_service.send_trap(
            target="127.0.0.1",
            port=2162,
            community="public",
            oid="IF-MIB::linkDown",
            varbinds=[
                {"oid": "IF-MIB::ifAdminStatus", "type": "Integer", "value": "up"},
            ],
            settings=settings,
            runtime_service=runtime,
        )
    )
    assert runtime.send_calls[0]["varbinds"][0]["value"] == {"type": "integer", "value": 1}

    asyncio.run(
        traps_service.send_trap(
            target="127.0.0.1",
            port=2162,
            community="public",
            oid="IF-MIB::linkDown",
            varbinds=[
                {"oid": "1.3.6.1.2.1.2.2.1.7.1", "type": "Integer", "value": "down"},
            ],
            settings=settings,
            runtime_service=runtime,
        )
    )
    assert runtime.send_calls[1]["varbinds"][0]["value"] == {"type": "integer", "value": 2}

    # Unknown label on an enum node -> clear rejection.
    with pytest.raises(TrapsError, match="'sideways' is not a member of the declared enum"):
        asyncio.run(
            traps_service.send_trap(
                target="127.0.0.1",
                port=2162,
                community="public",
                oid="IF-MIB::linkDown",
                varbinds=[
                    {"oid": "IF-MIB::ifAdminStatus", "type": "Integer", "value": "sideways"},
                ],
                settings=settings,
                runtime_service=runtime,
            )
        )
    assert len(runtime.send_calls) == 2

    # Plain integers still work (member value "testing" = 3).
    asyncio.run(
        traps_service.send_trap(
            target="127.0.0.1",
            port=2162,
            community="public",
            oid="IF-MIB::linkDown",
            varbinds=[
                {"oid": "1.3.6.1.2.1.2.2.1.7.1", "type": "Integer", "value": 3},
            ],
            settings=settings,
            runtime_service=runtime,
        )
    )
    assert runtime.send_calls[2]["varbinds"][0]["value"] == {"type": "integer", "value": 3}

    # TRP-04: a non-numeric value on a NON-enum node is still rejected.
    with pytest.raises(TrapsError, match="is not a valid Counter64"):
        asyncio.run(
            traps_service.send_trap(
                target="127.0.0.1",
                port=2162,
                community="public",
                oid="IF-MIB::linkDown",
                varbinds=[
                    {"oid": "1.3.6.1.2.1.31.1.1.1.6.1", "type": "Counter64", "value": "abc"},
                ],
                settings=settings,
                runtime_service=runtime,
            )
        )
    assert len(runtime.send_calls) == 3


def test_clear_events_purges_fts_rows(isolated_db):
    from app.services import traps_service
    from app.services.history import EventHistoryService
    from sqlalchemy import text

    history = EventHistoryService(isolated_db["settings"])

    history.record_event(
        direction="received",
        pdu_type="trap",
        notification_oid="1.3.6.1.6.3.1.1.5.3",
        notification_name="IF-MIB::linkDown",
        event={"varbinds": [{"oid": "1.3.6.1.2.1.1.3.0", "value": 321}]},
    )
    history.record_event(
        direction="sent",
        pdu_type="trap",
        event={"varbinds": []},
    )

    traps_service.clear_events(history_service=history)

    with isolated_db["session_factory"]() as session:
        received_fts = session.execute(
            text("SELECT COUNT(*) FROM notification_event_search WHERE direction = 'received'")
        ).scalar()
        sent_fts = session.execute(
            text("SELECT COUNT(*) FROM notification_event_search WHERE direction = 'sent'")
        ).scalar()

    assert received_fts == 0
    assert sent_fts == 1

    # The orphaned row must no longer be findable through FTS search.
    listed = history.list_events(direction="received", q="linkDown")
    assert listed["total"] == 0


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
    assert listed["total"] == 1
    assert listed["limit"] == 5
    assert listed["offset"] == 0
    assert listed["data"][0]["source"] == "127.0.0.1"
    assert listed["data"][0]["trap_type"] == "1.3.6.1.6.3.1.1.5.3"
    assert listed["data"][0]["resolve_mibs"] is False
    assert listed["data"][0]["resolved"] is False
    assert listed["data"][0]["varbinds"][0]["name"] == "1.3.6.1.2.1.1.3.0"

    snapshot = traps_service.get_trap_event_snapshot(item, state=state, history_service=history)
    assert snapshot["id"] == 5
    assert snapshot["time_str"] == "2026-05-13 06:06:00"  # RCV-06: full date + time
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


def test_send_trap_log_redacts_community_string(isolated_db, monkeypatch):
    from app.services import traps_service

    _activate_trap_bundle(isolated_db)
    settings = isolated_db["settings"]
    runtime = _TrapRuntimeStub()

    logged_messages: list[str] = []

    def fake_emit(message, *, level="INFO", logger_name=None, settings=None):
        logged_messages.append(str(message))

    monkeypatch.setattr(traps_service, "emit_backend_log", fake_emit)

    asyncio.run(
        traps_service.send_trap(
            target="127.0.0.1",
            port=2162,
            community="super-secret",
            oid="IF-MIB::linkDown",
            varbinds=[],
            settings=settings,
            runtime_service=runtime,
        )
    )
    send_log = next(line for line in logged_messages if line.startswith("Trap sent to"))
    assert "super-secret" not in send_log
    assert "community=***" in send_log


def test_send_inform_delegates_to_runtime_and_returns_ack(isolated_db):
    from app.services import traps_service

    _activate_trap_bundle(isolated_db)
    settings = isolated_db["settings"]
    runtime = _TrapRuntimeStub()

    result = asyncio.run(
        traps_service.send_inform(
            target="127.0.0.1",
            port=2162,
            community="public",
            oid="IF-MIB::linkDown",
            varbinds=[
                {"oid": "1.3.6.1.2.1.1.3.0", "type": "TimeTicks", "value": "321"},
                {"oid": "1.3.6.1.2.1.31.1.1.1.6.1", "type": "Counter64", "value": "999"},
            ],
            settings=settings,
            runtime_service=runtime,
        )
    )
    assert result["status"] == "sent"
    assert result["operation"] == "inform"
    assert result["target"] == "127.0.0.1"
    assert result["port"] == 2162

    call = runtime.send_calls[0]
    assert call["notification"] == "1.3.6.1.6.3.1.1.5.3"
    assert call["varbinds"][0]["value"] == {"type": "timeticks", "value": 321}
    assert call["varbinds"][1]["value"] == {"type": "counter64", "value": 999}


def test_send_inform_translates_runtime_ack_failure(isolated_db):
    from app.services import traps_service
    from app.services.runtime import RuntimeServiceError
    from app.services.traps_service import TrapsError

    _activate_trap_bundle(isolated_db)

    class _NoAckRuntime(_TrapRuntimeStub):
        async def send_inform(self, **kwargs) -> None:
            del kwargs
            raise RuntimeServiceError("No acknowledgement received from 127.0.0.1:2162 (timeout)")

    with pytest.raises(TrapsError, match="acknowledgement"):
        asyncio.run(
            traps_service.send_inform(
                target="127.0.0.1",
                port=2162,
                community="public",
                oid="IF-MIB::linkDown",
                varbinds=[],
                settings=isolated_db["settings"],
                runtime_service=_NoAckRuntime(),
            )
        )


def test_replay_event_defaults_host_to_source_for_received_traps(isolated_db):
    from app.services import traps_service
    from app.services.history import EventHistoryService

    history = EventHistoryService(isolated_db["settings"])
    stored = history.record_event(
        direction="received",
        pdu_type="snmpv2-trap",
        community="lab",
        source_host="192.0.2.44",
        source_port=40162,
        notification_oid="1.3.6.1.6.3.1.1.5.3",
        notification_name="IF-MIB::linkDown",
        event={"varbinds": [], "community": "lab", "pdu_type": "snmpv2-trap"},
    )
    runtime = _TrapRuntimeStub()

    result = asyncio.run(
        traps_service.replay_event(
            event_id=stored["event_id"],
            host=None,
            port=None,
            community=None,
            timeout=None,
            retries=None,
            settings=isolated_db["settings"],
            runtime_service=runtime,
        )
    )
    assert result["operation"] == "trap"
    # Received events have no stored target; the replay defaults to the source
    # host so the event can be sent back to where it came from (TRP-07).
    assert runtime.replay_calls[0]["host"] == "192.0.2.44"
    assert runtime.replay_calls[0]["port"] is None
    assert runtime.replay_calls[0]["community"] is None


def test_replay_event_passes_overrides_and_rejects_missing_events(isolated_db):
    from app.services import traps_service
    from app.services.traps_service import TrapsError

    runtime = _TrapRuntimeStub()
    asyncio.run(
        traps_service.replay_event(
            event_id=1,
            host="203.0.113.20",
            port=1162,
            community="lab",
            timeout=3.0,
            retries=2,
            settings=isolated_db["settings"],
            runtime_service=runtime,
        )
    )
    assert runtime.replay_calls[0]["host"] == "203.0.113.20"
    assert runtime.replay_calls[0]["port"] == 1162
    assert runtime.replay_calls[0]["community"] == "lab"
    assert runtime.replay_calls[0]["timeout"] == 3.0
    assert runtime.replay_calls[0]["retries"] == 2

    # No stored event and no override: the replay cannot pick a target.
    with pytest.raises(TrapsError, match="does not exist"):
        asyncio.run(
            traps_service.replay_event(
                event_id=999999,
                host=None,
                port=None,
                community=None,
                timeout=None,
                retries=None,
                settings=isolated_db["settings"],
                runtime_service=_TrapRuntimeStub(),
            )
        )


def test_delete_event_removes_single_received_trap_and_fts_row(isolated_db):
    from app.models import NotificationEvent
    from app.services import traps_service
    from app.services.history import EventHistoryService
    from app.services.traps_service import TrapsError
    from sqlalchemy import select, text

    history = EventHistoryService(isolated_db["settings"])
    received = history.record_event(
        direction="received",
        pdu_type="trap",
        notification_oid="1.3.6.1.6.3.1.1.5.3",
        notification_name="IF-MIB::linkDown",
        event={"varbinds": []},
    )
    sent = history.record_event(
        direction="sent",
        pdu_type="trap",
        event={"varbinds": []},
    )
    received_id = received["event_id"]

    deleted = traps_service.delete_event(history_service=history, event_id=received_id)
    assert deleted == {"status": "deleted", "id": received_id}

    with isolated_db["session_factory"]() as session:
        rows = session.scalars(select(NotificationEvent).order_by(NotificationEvent.id)).all()
        fts_rows = session.execute(
            text("SELECT COUNT(*) FROM notification_event_search WHERE event_id = :event_id"),
            {"event_id": str(received_id)},
        ).scalar()
    assert [row.id for row in rows] == [sent["event_id"]]
    assert fts_rows == 0

    # Sent events are not deletable through the per-trap path.
    with pytest.raises(TrapsError, match="not a received trap"):
        traps_service.delete_event(history_service=history, event_id=sent["event_id"])

    with pytest.raises(TrapsError, match="not a received trap"):
        traps_service.delete_event(history_service=history, event_id=999999)


def test_list_events_redacts_community_in_payload(isolated_db):
    """RCV-15: GET /api/traps list payloads carry a mask, never the community."""
    import json

    from app.services import traps_service
    from app.services.state_store import StateStore, _TRAP_RESOLVE_MIBS_KEY
    from app.services.traps_service import _COMMUNITY_MASK

    settings = isolated_db["settings"]
    state = StateStore(isolated_db["session_factory"])
    state.set_value(_TRAP_RESOLVE_MIBS_KEY, True)

    item = {
        "id": 21,
        "recorded_at": "2026-05-13T06:06:00Z",
        "notification_oid": "1.3.6.1.6.3.1.1.5.3",
        "resolve_mibs": False,
        "community": "top-secret",
        "event": {"varbinds": [], "community": "top-secret"},
    }

    class _HistoryList:
        def __init__(self, session_factory) -> None:
            self.session_factory = session_factory

        def list_events(self, *, direction: str, limit: int, offset: int) -> dict[str, object]:
            return {"items": [item], "total": 1}

    listed = traps_service.list_events(
        state=state, history_service=_HistoryList(isolated_db["session_factory"]), limit=100
    )
    assert listed["data"][0]["community"] == _COMMUNITY_MASK
    serialized = json.dumps(listed, ensure_ascii=False)
    assert "top-secret" not in serialized
    assert _COMMUNITY_MASK in serialized


def test_format_trap_event_redacts_community_and_keeps_full_timestamp(isolated_db):
    """RCV-15 + RCV-06: masked community, dated time_str, precise timestamp."""
    from app.services.bundle_state import get_bundle
    from app.services.traps_service import _COMMUNITY_MASK, _format_trap_event

    payload = _format_trap_event(
        {
            "event_id": 13,
            "recorded_at": "2026-05-13T06:06:00+00:00",
            "source_address": {"host": "127.0.0.1", "port": 51589},
            "notification_oid": "1.3.6.1.6.3.1.1.5.3",
            "notification_name": "IF-MIB::linkDown",
            "community": "lab-secret",
            "event": {"varbinds": [], "community": "lab-secret"},
        },
        resolve_mibs=True,
        bundle=get_bundle(),
    )

    assert payload["community"] == _COMMUNITY_MASK
    assert "lab-secret" not in str(payload)
    assert payload["time_str"] == "2026-05-13 06:06:00"
    assert payload["timestamp"] == "2026-05-13T06:06:00+00:00"

    no_community = _format_trap_event(
        {"event_id": 14, "event": {"varbinds": []}},
        resolve_mibs=False,
        bundle=get_bundle(),
    )
    assert no_community["community"] is None


def test_decode_payload_translates_runtime_errors(isolated_db):
    from app.services import traps_service
    from app.services.runtime import RuntimeServiceError
    from app.services.traps_service import TrapsError

    class _BadDecodeRuntime(_TrapRuntimeStub):
        async def decode_notification_payload(self, **kwargs) -> None:
            del kwargs
            raise RuntimeServiceError("Hex-encoded byte values must contain valid hexadecimal text")

    with pytest.raises(TrapsError, match="hexadecimal"):
        asyncio.run(
            traps_service.decode_payload(
                payload="not-hex",
                encoding="hex",
                source_host=None,
                source_port=None,
                settings=isolated_db["settings"],
                runtime_service=_BadDecodeRuntime(),
            )
        )
