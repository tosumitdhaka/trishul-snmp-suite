from __future__ import annotations

import asyncio

import pytest

pytestmark = pytest.mark.unit


def test_websocket_manager_handles_disconnects_invalid_tokens_and_send_failures(
    isolated_db,
    monkeypatch,
):
    from app.services import realtime

    class DummyWebSocket:
        def __init__(self, *, fail_send: bool = False, fail_close: bool = False) -> None:
            self.fail_send = fail_send
            self.fail_close = fail_close
            self.accepted = False
            self.sent_json: list[dict[str, object]] = []
            self.closed: list[tuple[int, str]] = []

        async def accept(self) -> None:
            self.accepted = True

        async def send_json(self, payload: dict[str, object]) -> None:
            if self.fail_send:
                raise RuntimeError("send failed")
            self.sent_json.append(payload)

        async def close(self, code: int = 4001, reason: str = "") -> None:
            self.closed.append((code, reason))
            if self.fail_close:
                raise RuntimeError("close failed")

    class StubSessionService:
        def __init__(self, _settings=None) -> None:
            pass

        def validate_token(self, token, *, touch=False):
            del touch
            if token == "good":
                return True, "admin", None
            return False, None, "Session expired"

    monkeypatch.setattr(realtime, "SessionService", StubSessionService)

    manager = realtime.WebSocketManager()
    good = DummyWebSocket()
    invalid = DummyWebSocket()
    direct_fail = DummyWebSocket(fail_send=True)
    broadcast_fail = DummyWebSocket(fail_send=True)
    close_fail = DummyWebSocket(fail_close=True)

    async def exercise() -> None:
        await manager.connect(good, token="good")
        await manager.connect(invalid, token="invalid")
        await manager.connect(direct_fail, token="good")
        await manager.send_to(direct_fail, {"type": "direct"})
        await manager.connect(broadcast_fail, token="good")
        await manager.connect(close_fail, token="good")
        await manager.broadcast({"type": "status"}, settings=isolated_db["settings"])
        await manager.close_sessions_for_token("good", reason="Logged out")

    asyncio.run(exercise())

    assert good.accepted is True
    assert invalid.accepted is True
    assert direct_fail.accepted is True
    assert broadcast_fail.accepted is True
    assert close_fail.accepted is True

    assert direct_fail.sent_json == []
    assert direct_fail.closed == []
    assert invalid.closed == [(4001, "Unauthorized")]
    assert broadcast_fail.closed == [(4001, "Unauthorized")]
    assert close_fail.closed == [(4001, "Logged out")]
    assert good.sent_json == [{"type": "status"}]
    assert good.closed == [(4001, "Logged out")]
    assert manager._connections == []


def test_realtime_builders_and_broadcast_wrappers_emit_expected_payloads(
    isolated_db,
    monkeypatch,
):
    from app.services import realtime

    captured: list[tuple[dict[str, object], object]] = []

    async def capture(payload, *, settings=None):
        captured.append((payload, settings))

    class StubRuntime:
        async def get_state(self):
            return {
                "responder": {
                    "running": True,
                    "port": 1061,
                    "communities": ["public"],
                    "configured_object_count": 0,
                    "request_count": 9,
                    "last_activity": None,
                },
                "notifications": {"listener": {"running": False, "port": 1162, "communities": ["public"]}},
                "active_bundle": None,
            }

        async def list_events(self, **kwargs):
            return {"total": 0, "items": []}

    import app.services.runtime as runtime_module
    from app.services import bundle_state as bundle_state_module

    monkeypatch.setattr(runtime_module, "get_runtime_service", lambda: StubRuntime())

    class StubBundle:
        @property
        def modules(self):
            class FakeModule:
                notifications = [1, 2, 3]
                objects = []

            class FakeModuleTwo:
                notifications = [1, 2, 3, 4]
                objects = []

            return {"IF-MIB": FakeModule(), "SNMPv2-MIB": FakeModuleTwo()}

    monkeypatch.setattr(bundle_state_module, "_bundle", StubBundle())
    monkeypatch.setattr(realtime.ws_manager, "broadcast", capture)

    payload = asyncio.run(realtime.build_full_state(isolated_db["settings"]))
    assert payload["type"] == "full_state"
    assert payload["simulator"]["running"] is True
    assert payload["simulator"]["port"] == 1061
    assert payload["traps"]["running"] is False
    assert payload["traps"]["port"] == 1162
    assert payload["mibs"]["traps_available"] == 7
    assert "stats" in payload

    async def exercise() -> None:
        await realtime.broadcast_full_state(settings=isolated_db["settings"])
        await realtime.broadcast_status(settings=isolated_db["settings"])
        await realtime.broadcast_stats(settings=isolated_db["settings"])
        await realtime.broadcast_mibs(settings=isolated_db["settings"])
        await realtime.broadcast_trap_event({"id": 8, "name": "linkDown"}, settings=isolated_db["settings"])
        await realtime.broadcast_simulator_log({"message": "GETBULK"}, settings=isolated_db["settings"])

    asyncio.run(exercise())

    assert [payload["type"] for payload, _settings in captured] == [
        "full_state",
        "status",
        "stats",
        "mibs",
        "trap",
        "simulator_log",
    ]
    assert captured[0][0]["mibs"]["traps_available"] == 7
    assert captured[1][0]["simulator"]["running"] is True
    assert "walker" in captured[2][0]["stats"]
    assert captured[3][0]["mibs"]["total"] == 2
    assert captured[4][0]["trap"]["name"] == "linkDown"
    assert captured[5][0]["entry"]["message"] == "GETBULK"
    assert all(settings is isolated_db["settings"] for _payload, settings in captured)


def test_realtime_schedule_closes_without_loop_and_logs_failed_tasks(monkeypatch):
    from app.services import realtime

    class Closable:
        def __init__(self) -> None:
            self.closed = False

        def close(self) -> None:
            self.closed = True

    closable = Closable()
    realtime._schedule(closable, label="no_loop")
    assert closable.closed is True

    messages: list[str] = []

    def fake_exception(message: str, *args) -> None:
        rendered = message % args if args else message
        messages.append(rendered)

    monkeypatch.setattr(realtime.logger, "exception", fake_exception)

    async def boom() -> None:
        raise RuntimeError("boom")

    async def exercise() -> None:
        realtime._schedule(boom(), label="demo")
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    asyncio.run(exercise())
    assert messages == ["Realtime demo task failed"]


def test_realtime_schedule_tolerates_close_failures_and_wrapper_helpers(monkeypatch):
    from app.services import realtime

    class BrokenClosable:
        def close(self) -> None:
            raise RuntimeError("close failed")

    realtime._schedule(BrokenClosable(), label="broken_close")

    captured: list[tuple[str, object]] = []

    def fake_schedule(coro, *, label: str) -> None:
        captured.append((label, coro))
        coro.close()

    monkeypatch.setattr(realtime, "_schedule", fake_schedule)

    marker = object()
    realtime.schedule_stats_broadcast(settings=marker)
    realtime.schedule_simulator_log_broadcast({"message": "demo"}, settings=marker)

    assert [label for label, _coro in captured] == ["stats", "simulator_log"]
    assert all(coro.cr_frame is None for _label, coro in captured)
