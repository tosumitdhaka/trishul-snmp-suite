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


def test_trap_routes_delegate_to_service_layer_and_manage_history(isolated_db, monkeypatch):
    from app.api.routes import traps as traps_module

    token = _login_token()
    settings = isolated_db["settings"]
    state = object()
    runtime = object()
    captured: dict[str, object] = {}
    broadcasts: list[object] = []

    monkeypatch.setattr(traps_module, "_ctx", lambda: (settings, state, runtime))
    monkeypatch.setattr(traps_module, "get_state_store", lambda: state)

    async def fake_get_status(*, state, runtime_service):
        captured["status"] = (state, runtime_service)
        return {"running": True, "port": 2162, "community": "public", "resolve_mibs": True}

    async def fake_start_listener(*, port, community, resolve_mibs, settings, state, runtime_service):
        captured["start"] = (port, community, resolve_mibs, settings, state, runtime_service)
        return {"status": "started"}

    async def fake_stop_listener(*, settings, state, runtime_service):
        captured["stop"] = (settings, state, runtime_service)
        return {"status": "stopped"}

    async def fake_send_trap(*, target, port, community, oid, varbinds, settings, runtime_service):
        captured["send"] = (target, port, community, oid, varbinds, settings, runtime_service)
        return {"status": "sent"}

    async def fake_send_inform(*, target, port, community, oid, varbinds, settings, runtime_service):
        captured["inform"] = (target, port, community, oid, varbinds, settings, runtime_service)
        return {
            "status": "sent",
            "operation": "inform",
            "target": target,
            "port": port,
            "request_id": 42,
            "response": {"request_id": 42, "error_status": "noError", "error_status_code": 0, "error_index": 0, "varbinds": []},
        }

    async def fake_replay_event(*, event_id, host, port, community, timeout, retries, settings, runtime_service):
        captured["replay"] = (event_id, host, port, community, timeout, retries, settings, runtime_service)
        return {"operation": "inform", "replayed_from_event_id": event_id, "target": {"host": host or "127.0.0.1", "port": port or 2162}}

    async def fake_decode_payload(*, payload, encoding, source_host, source_port, settings, runtime_service):
        captured["decode"] = (payload, encoding, source_host, source_port, settings, runtime_service)
        return {"active_bundle": None, "event": {"pdu_type": "snmpv2-trap", "notification_name": "IF-MIB::linkDown"}}

    def fake_list_events(*, state, history_service, limit=100, offset=0):
        captured["list"] = (state, history_service, limit, offset)
        return {"data": [], "count": 0, "total": 0, "limit": limit, "offset": offset}

    def fake_clear_events(*, history_service):
        captured["clear"] = history_service
        return {"status": "cleared"}

    def fake_delete_event(*, history_service, event_id):
        captured["delete"] = (history_service, event_id)
        return {"status": "deleted", "id": event_id}

    async def fake_broadcast_stats(*, settings):
        broadcasts.append(settings)

    monkeypatch.setattr(traps_module.traps_service, "get_status", fake_get_status)
    monkeypatch.setattr(traps_module.traps_service, "start_listener", fake_start_listener)
    monkeypatch.setattr(traps_module.traps_service, "stop_listener", fake_stop_listener)
    monkeypatch.setattr(traps_module.traps_service, "send_trap", fake_send_trap)
    monkeypatch.setattr(traps_module.traps_service, "send_inform", fake_send_inform)
    monkeypatch.setattr(traps_module.traps_service, "replay_event", fake_replay_event)
    monkeypatch.setattr(traps_module.traps_service, "decode_payload", fake_decode_payload)
    monkeypatch.setattr(traps_module.traps_service, "list_events", fake_list_events)
    monkeypatch.setattr(traps_module.traps_service, "clear_events", fake_clear_events)
    monkeypatch.setattr(traps_module.traps_service, "delete_event", fake_delete_event)
    monkeypatch.setattr(traps_module, "EventHistoryService", lambda runtime_settings: ("history", runtime_settings))
    monkeypatch.setattr(traps_module, "broadcast_stats", fake_broadcast_stats)

    status = asyncio.run(traps_module.get_trap_status(x_auth_token=token))
    assert status["running"] is True
    assert captured["status"] == (state, runtime)

    started = asyncio.run(
        traps_module.start_trap_listener(
            traps_module.TrapListenerBody(port=2162, community="public", resolve_mibs=True),
            x_auth_token=token,
        )
    )
    assert started == {"status": "started"}
    assert captured["start"] == (2162, "public", True, settings, state, runtime)

    stopped = asyncio.run(traps_module.stop_trap_listener(x_auth_token=token))
    assert stopped == {"status": "stopped"}
    assert captured["stop"] == (settings, state, runtime)

    sent = asyncio.run(
        traps_module.send_trap(
            traps_module.TrapSendBody(
                target="127.0.0.1",
                port=2162,
                community="public",
                oid="1.3.6.1.6.3.1.1.5.3",
                varbinds=[
                    traps_module.TrapVarBindBody(
                        oid="1.3.6.1.2.1.1.3.0",
                        type="TimeTicks",
                        value=321,
                    )
                ],
            ),
            x_auth_token=token,
        )
    )
    assert sent == {"status": "sent"}
    assert captured["send"] == (
        "127.0.0.1",
        2162,
        "public",
        "1.3.6.1.6.3.1.1.5.3",
        [{"oid": "1.3.6.1.2.1.1.3.0", "type": "TimeTicks", "value": 321}],
        settings,
        runtime,
    )

    listed = traps_module.list_traps(limit=100, offset=0, x_auth_token=token)
    assert listed == {"data": [], "count": 0, "total": 0, "limit": 100, "offset": 0}
    assert captured["list"] == (state, ("history", settings), 100, 0)

    paged = traps_module.list_traps(limit=50, offset=100, x_auth_token=token)
    assert paged["limit"] == 50
    assert paged["offset"] == 100
    assert captured["list"] == (state, ("history", settings), 50, 100)

    informed = asyncio.run(
        traps_module.send_inform_route(
            traps_module.TrapSendBody(
                target="127.0.0.1",
                port=2162,
                community="public",
                oid="1.3.6.1.6.3.1.1.5.3",
                varbinds=[
                    traps_module.TrapVarBindBody(
                        oid="1.3.6.1.2.1.1.3.0",
                        type="TimeTicks",
                        value=321,
                    )
                ],
            ),
            x_auth_token=token,
        )
    )
    assert informed["status"] == "sent"
    assert informed["operation"] == "inform"
    assert informed["request_id"] == 42
    assert informed["response"]["error_status_code"] == 0
    assert captured["inform"] == (
        "127.0.0.1",
        2162,
        "public",
        "1.3.6.1.6.3.1.1.5.3",
        [{"oid": "1.3.6.1.2.1.1.3.0", "type": "TimeTicks", "value": 321}],
        settings,
        runtime,
    )

    replayed = asyncio.run(
        traps_module.replay_trap_event(
            7,
            traps_module.TrapReplayBody(host="203.0.113.20", port=1162, community="lab"),
            x_auth_token=token,
        )
    )
    assert replayed["replayed_from_event_id"] == 7
    assert captured["replay"] == (7, "203.0.113.20", 1162, "lab", None, None, settings, runtime)

    decoded = asyncio.run(
        traps_module.decode_trap_payload(
            traps_module.TrapDecodeBody(
                payload="300b02010004067075626c6963",
                encoding="hex",
                source_host="192.0.2.10",
                source_port=1162,
            ),
            x_auth_token=token,
        )
    )
    assert decoded["event"]["notification_name"] == "IF-MIB::linkDown"
    assert captured["decode"] == (
        "300b02010004067075626c6963",
        "hex",
        "192.0.2.10",
        1162,
        settings,
        runtime,
    )

    cleared = asyncio.run(traps_module.clear_traps(x_auth_token=token))
    assert cleared == {"status": "cleared"}
    assert captured["clear"] == ("history", settings)

    deleted = asyncio.run(traps_module.delete_trap_event(9, x_auth_token=token))
    assert deleted == {"status": "deleted", "id": 9}
    assert captured["delete"] == (("history", settings), 9)
    assert broadcasts == [settings, settings]


def test_trap_send_route_rejects_invalid_object_identifier_values(isolated_db, monkeypatch):
    from app.api.routes import traps as traps_module

    monkeypatch.setattr(
        traps_module,
        "_ctx",
        lambda: (isolated_db["settings"], object(), object()),
    )

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            traps_module.send_trap(
                traps_module.TrapSendBody(
                    target="127.0.0.1",
                    port=2162,
                    community="public",
                    oid="1.3.6.1.6.3.1.1.5.3",
                    varbinds=[
                        traps_module.TrapVarBindBody(
                            oid="1.3.6.1.2.1.1.3.0",
                            type="OID",
                            value="1",
                        )
                    ],
                ),
                x_auth_token=_login_token(),
            )
        )

    assert excinfo.value.status_code == 400
    assert "VarBind 1 value" in excinfo.value.detail


def test_trap_routes_require_auth_and_update_resolve_mibs(isolated_db, monkeypatch):
    from app.api.routes import traps as traps_module
    from app.services.state_store import _TRAP_RESOLVE_MIBS_KEY, get_state_store

    broadcasts: list[object] = []

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(traps_module.get_trap_status(x_auth_token=None))
    assert excinfo.value.status_code == 401

    monkeypatch.setattr(
        traps_module,
        "_ctx",
        lambda: (isolated_db["settings"], get_state_store(), object()),
    )
    async def fake_broadcast_status(*, settings):
        broadcasts.append(settings)

    monkeypatch.setattr(traps_module, "broadcast_status", fake_broadcast_status)

    payload = asyncio.run(
        traps_module.set_resolve_mibs(
            traps_module.TrapResolveMibsBody(resolve_mibs=False),
            x_auth_token=_login_token(),
        )
    )
    assert payload == {"resolve_mibs": False}
    assert get_state_store().snapshot()[_TRAP_RESOLVE_MIBS_KEY] is False
    assert broadcasts == [isolated_db["settings"]]


def test_inform_route_translates_ack_failure_to_http_error(isolated_db, monkeypatch):
    from app.api.routes import traps as traps_module
    from app.services.traps_service import TrapsError

    monkeypatch.setattr(
        traps_module,
        "_ctx",
        lambda: (isolated_db["settings"], object(), object()),
    )

    async def fail_inform(**kwargs):
        del kwargs
        raise TrapsError("No acknowledgement received from 127.0.0.1:2162 (timeout)")

    monkeypatch.setattr(traps_module.traps_service, "send_inform", fail_inform)

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            traps_module.send_inform_route(
                traps_module.TrapSendBody(
                    target="127.0.0.1",
                    port=2162,
                    community="public",
                    oid="1.3.6.1.6.3.1.1.5.3",
                    varbinds=[],
                ),
                x_auth_token=_login_token(),
            )
        )
    assert excinfo.value.status_code == 400
    assert "acknowledgement" in excinfo.value.detail


def test_replay_decode_delete_routes_translate_service_errors(isolated_db, monkeypatch):
    from app.api.routes import traps as traps_module
    from app.services.traps_service import TrapsError

    monkeypatch.setattr(
        traps_module,
        "_ctx",
        lambda: (isolated_db["settings"], object(), object()),
    )
    token = _login_token()

    async def fail_replay(**kwargs):
        del kwargs
        raise TrapsError("Stored notification event cannot be replayed")

    async def fail_decode(**kwargs):
        del kwargs
        raise TrapsError("Hex-encoded byte values must contain valid hexadecimal text")

    def fail_delete(**kwargs):
        del kwargs
        raise TrapsError("Notification event 404 is not a received trap.")

    monkeypatch.setattr(traps_module.traps_service, "replay_event", fail_replay)
    monkeypatch.setattr(traps_module.traps_service, "decode_payload", fail_decode)
    monkeypatch.setattr(traps_module.traps_service, "delete_event", fail_delete)

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            traps_module.replay_trap_event(
                3,
                traps_module.TrapReplayBody(),
                x_auth_token=token,
            )
        )
    assert excinfo.value.status_code == 400
    assert "cannot be replayed" in excinfo.value.detail

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            traps_module.decode_trap_payload(
                traps_module.TrapDecodeBody(payload="not-hex"),
                x_auth_token=token,
            )
        )
    assert excinfo.value.status_code == 400
    assert "hexadecimal" in excinfo.value.detail

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(traps_module.delete_trap_event(404, x_auth_token=token))
    assert excinfo.value.status_code == 400
    assert "404" in excinfo.value.detail


def test_list_traps_declares_bounded_pagination_contract(isolated_db, monkeypatch):
    from app.api.routes import traps as traps_module

    del isolated_db

    import inspect

    from annotated_types import Ge, Le

    signature = inspect.signature(traps_module.list_traps)
    limit = signature.parameters["limit"].default
    offset = signature.parameters["offset"].default

    # Bounds are enforced by FastAPI's Query validation at the HTTP layer
    # (RCV-05): cap at 200, no negative offsets.
    assert limit.default == 100
    assert any(isinstance(m, Ge) and m.ge == 1 for m in limit.metadata)
    assert any(isinstance(m, Le) and m.le == 200 for m in limit.metadata)
    assert offset.default == 0
    assert any(isinstance(m, Ge) and m.ge == 0 for m in offset.metadata)
