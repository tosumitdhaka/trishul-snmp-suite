from datetime import datetime, timedelta, timezone

import pytest


class FakeWebSocket:
    def __init__(self):
        self.accepted = False
        self.sent_payloads = []
        self.closed = False
        self.close_code = None
        self.close_reason = None

    async def accept(self):
        self.accepted = True

    async def send_json(self, payload):
        self.sent_payloads.append(payload)

    async def close(self, code=1000, reason=""):
        self.closed = True
        self.close_code = code
        self.close_reason = reason


@pytest.mark.asyncio
async def test_websocket_disconnects_after_logout(auth_token):
    from core.security import logout_user
    from core.ws_manager import manager

    manager.active.clear()
    websocket = FakeWebSocket()
    await manager.connect(websocket, auth_token)

    logout_user(auth_token)
    await manager.broadcast({"type": "stats", "data": {}})

    assert websocket.accepted is True
    assert websocket.closed is True
    assert websocket.close_code == 4001


@pytest.mark.asyncio
async def test_websocket_disconnects_after_session_expiry(auth_token, isolated_settings):
    from core.security import ACTIVE_SESSIONS
    from core.ws_manager import manager

    manager.active.clear()
    websocket = FakeWebSocket()
    await manager.connect(websocket, auth_token)

    username, _issued_at = ACTIVE_SESSIONS[auth_token]
    ACTIVE_SESSIONS[auth_token] = (
        username,
        datetime.now(timezone.utc) - timedelta(seconds=isolated_settings.SESSION_TIMEOUT + 5),
    )

    await manager.send_to(websocket, {"type": "status"})

    assert websocket.closed is True
    assert websocket.close_code == 4001
