"""
core/ws_manager.py
~~~~~~~~~~~~~~~~~~
WebSocket connection manager + UDP loopback listener.

Architecture
------------
FastAPI runs in the main process (async event loop).
Worker subprocesses (trap_receiver.py, snmp_simulator.py) cannot call
manager.broadcast() directly because they run in a separate process with
no shared memory.

Solution: UDP loopback side-channel.
  Worker  ──UDP datagram──►  127.0.0.1:WS_INTERNAL_PORT
  asyncio listener in main process reads it and calls manager.broadcast()

This gives sub-millisecond latency with zero shared-memory coupling.
"""

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Optional
from fastapi import WebSocket
from core.security import validate_session_token

logger = logging.getLogger(__name__)


@dataclass
class ManagedConnection:
    websocket: WebSocket
    token: str


class ConnectionManager:
    """Registry of active WebSocket connections."""

    def __init__(self):
        self.active: list[ManagedConnection] = []

    async def connect(self, websocket: WebSocket, token: str) -> None:
        await websocket.accept()
        self.active.append(ManagedConnection(websocket=websocket, token=token))
        logger.info(f"[WS] client connected — total={len(self.active)}")

    def disconnect(self, websocket: WebSocket) -> None:
        self.active = [ctx for ctx in self.active if ctx.websocket is not websocket]
        logger.info(f"[WS] client disconnected — total={len(self.active)}")

    def _find_connection(self, websocket: WebSocket) -> Optional[ManagedConnection]:
        for connection in self.active:
            if connection.websocket is websocket:
                return connection
        return None

    async def _close_connection(self, connection: ManagedConnection, code: int = 4001, reason: str = "Unauthorized") -> None:
        try:
            await asyncio.wait_for(connection.websocket.close(code=code, reason=reason), timeout=0.5)
        except Exception:
            pass
        self.disconnect(connection.websocket)

    async def _ensure_connection_is_authorized(self, connection: ManagedConnection) -> bool:
        valid, _username, reason = validate_session_token(connection.token)
        if valid:
            return True
        await self._close_connection(connection, code=4001, reason=reason or "Unauthorized")
        return False

    async def broadcast(self, payload: dict) -> None:
        """Send payload to all connected clients. Silently remove dead connections."""
        if not self.active:
            return
        dead: list[ManagedConnection] = []
        for connection in list(self.active):
            if not await self._ensure_connection_is_authorized(connection):
                continue
            try:
                await connection.websocket.send_json(payload)
            except Exception:
                dead.append(connection)
        for connection in dead:
            self.disconnect(connection.websocket)

    async def send_to(self, websocket: WebSocket, payload: dict) -> None:
        """Send payload to a single connection."""
        connection = self._find_connection(websocket)
        if connection and not await self._ensure_connection_is_authorized(connection):
            return
        try:
            await websocket.send_json(payload)
        except Exception:
            self.disconnect(websocket)

    async def close_sessions_for_token(self, token: str, reason: str = "Logged out") -> None:
        targets = [connection for connection in list(self.active) if connection.token == token]
        for connection in targets:
            await self._close_connection(connection, code=4001, reason=reason)


# Module-level singleton used by all routers
manager = ConnectionManager()


# ---------------------------------------------------------------------------
# UDP loopback listener — receives datagrams from worker subprocesses
# ---------------------------------------------------------------------------

class _UDPListenerProtocol(asyncio.DatagramProtocol):
    """asyncio UDP protocol that parses datagrams and calls manager.broadcast()."""

    def __init__(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop

    def datagram_received(self, data: bytes, addr) -> None:
        try:
            payload = json.loads(data.decode("utf-8"))
            # Schedule broadcast on the event loop (this callback may be sync)
            asyncio.ensure_future(manager.broadcast(payload))
        except Exception as e:
            logger.warning(f"[WS-UDP] bad datagram from {addr}: {e}")

    def error_received(self, exc: Exception) -> None:
        logger.error(f"[WS-UDP] error: {exc}")


_udp_transport: Optional[asyncio.BaseTransport] = None


async def start_udp_listener(port: int) -> None:
    """
    Start the asyncio UDP listener on 127.0.0.1:<port>.
    Called once from main.py lifespan startup.
    """
    global _udp_transport
    loop = asyncio.get_event_loop()
    transport, _ = await loop.create_datagram_endpoint(
        lambda: _UDPListenerProtocol(loop),
        local_addr=("127.0.0.1", port)
    )
    _udp_transport = transport
    logger.info(f"[WS-UDP] listener started on 127.0.0.1:{port}")


async def stop_udp_listener() -> None:
    global _udp_transport
    if _udp_transport:
        _udp_transport.close()
        _udp_transport = None
        logger.info("[WS-UDP] listener stopped")
