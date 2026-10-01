from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

from fastapi import WebSocket

from app.core.config import Settings, get_settings
from app.services.session import SessionService

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class ManagedConnection:
    websocket: WebSocket
    token: str


class WebSocketManager:
    def __init__(self) -> None:
        self._connections: list[ManagedConnection] = []

    async def connect(self, websocket: WebSocket, *, token: str) -> None:
        await websocket.accept()
        self._connections.append(ManagedConnection(websocket=websocket, token=token))
        logger.debug("WebSocket client connected; active=%d", len(self._connections))

    def disconnect(self, websocket: WebSocket) -> None:
        remaining = [item for item in self._connections if item.websocket is not websocket]
        if len(remaining) != len(self._connections):
            self._connections = remaining
            logger.debug("WebSocket client disconnected; active=%d", len(self._connections))

    async def send_to(self, websocket: WebSocket, payload: dict[str, Any]) -> None:
        try:
            await websocket.send_json(payload)
        except Exception:
            self.disconnect(websocket)

    async def broadcast(
        self,
        payload: dict[str, Any],
        *,
        settings: Settings | None = None,
    ) -> None:
        if not self._connections:
            return

        session_service = SessionService(settings or get_settings())
        dead: list[ManagedConnection] = []
        for connection in list(self._connections):
            valid, _username, _reason = session_service.validate_token(connection.token, touch=False)
            if not valid:
                dead.append(connection)
                continue
            try:
                await connection.websocket.send_json(payload)
            except Exception:
                dead.append(connection)

        for connection in dead:
            await self._close_connection(connection, reason="Unauthorized")

    async def close_sessions_for_token(self, token: str, *, reason: str = "Logged out") -> None:
        targets = [item for item in list(self._connections) if item.token == token]
        for connection in targets:
            await self._close_connection(connection, reason=reason)

    async def _close_connection(
        self,
        connection: ManagedConnection,
        *,
        reason: str,
        code: int = 4001,
    ) -> None:
        try:
            await connection.websocket.close(code=code, reason=reason)
        except Exception:
            pass
        self.disconnect(connection.websocket)


ws_manager = WebSocketManager()


_MIB_SOURCE_EXTENSIONS = {".mib", ".txt", ".my"}


def _count_source_files() -> int:
    """Count uploaded MIB source files without scanning module contents."""
    try:
        from app.core.config import get_settings
        upload_dir = get_settings().data_dir / "mibs"
        if not upload_dir.exists():
            return 0
        return sum(
            1 for p in upload_dir.rglob("*")
            if p.is_file() and p.suffix.lower() in _MIB_SOURCE_EXTENSIONS
        )
    except Exception:
        return 0


def _mib_summary_from_bundle() -> dict[str, int]:
    from app.services.bundle_state import get_bundle
    bundle = get_bundle()
    source_files = _count_source_files()
    if bundle is None:
        return {"loaded": 0, "failed": 0, "total": 0, "traps_available": 0, "source_files": source_files}
    module_count = len(bundle.modules)
    traps_total = sum(len(mod.notifications) for mod in bundle.modules.values())
    return {
        "loaded": module_count,
        "failed": 0,
        "total": module_count,
        "traps_available": traps_total,
        "source_files": source_files,
    }


async def build_full_state(settings: Settings | None = None) -> dict[str, Any]:
    from app.services import simulator_service, traps_service, stats_service
    from app.services.history import EventHistoryService
    from app.services.runtime import get_runtime_service
    from app.services.state_store import get_state_store
    runtime_settings = settings or get_settings()
    state = get_state_store()
    rt = get_runtime_service()
    return {
        "type": "full_state",
        "simulator": await simulator_service.get_status(state=state, runtime_service=rt),
        "traps": await traps_service.get_status(state=state, runtime_service=rt),
        "stats": await stats_service.get_stats(
            state=state,
            history_service=EventHistoryService(runtime_settings),
            runtime_service=rt,
        ),
        "mibs": _mib_summary_from_bundle(),
    }


async def broadcast_full_state(settings: Settings | None = None) -> None:
    runtime_settings = settings or get_settings()
    await ws_manager.broadcast(await build_full_state(runtime_settings), settings=runtime_settings)


async def broadcast_status(settings: Settings | None = None) -> None:
    from app.services import simulator_service, traps_service
    from app.services.runtime import get_runtime_service
    from app.services.state_store import get_state_store
    runtime_settings = settings or get_settings()
    state = get_state_store()
    rt = get_runtime_service()
    await ws_manager.broadcast(
        {
            "type": "status",
            "simulator": await simulator_service.get_status(state=state, runtime_service=rt),
            "traps": await traps_service.get_status(state=state, runtime_service=rt),
        },
        settings=runtime_settings,
    )


async def broadcast_stats(settings: Settings | None = None) -> None:
    from app.services import stats_service
    from app.services.history import EventHistoryService
    from app.services.runtime import get_runtime_service
    from app.services.state_store import get_state_store
    runtime_settings = settings or get_settings()
    await ws_manager.broadcast(
        {
            "type": "stats",
            "stats": await stats_service.get_stats(
                state=get_state_store(),
                history_service=EventHistoryService(runtime_settings),
                runtime_service=get_runtime_service(),
            ),
        },
        settings=runtime_settings,
    )


async def broadcast_mibs(settings: Settings | None = None) -> None:
    runtime_settings = settings or get_settings()
    await ws_manager.broadcast(
        {
            "type": "mibs",
            "mibs": _mib_summary_from_bundle(),
        },
        settings=runtime_settings,
    )


async def broadcast_trap_event(
    trap: dict[str, Any],
    *,
    settings: Settings | None = None,
) -> None:
    runtime_settings = settings or get_settings()
    await ws_manager.broadcast(
        {
            "type": "trap",
            "trap": trap,
        },
        settings=runtime_settings,
    )


async def broadcast_simulator_log(
    entry: dict[str, Any],
    *,
    settings: Settings | None = None,
) -> None:
    runtime_settings = settings or get_settings()
    await ws_manager.broadcast(
        {
            "type": "simulator_log",
            "entry": entry,
        },
        settings=runtime_settings,
    )


def _schedule(coro: Any, *, label: str) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        try:
            coro.close()
        except Exception:
            pass
        return

    task = loop.create_task(coro)

    def _log_failure(done_task: asyncio.Task[Any]) -> None:
        try:
            done_task.result()
        except Exception:
            logger.exception("Realtime %s task failed", label)

    task.add_done_callback(_log_failure)


def schedule_stats_broadcast(settings: Settings | None = None) -> None:
    _schedule(broadcast_stats(settings=settings), label="stats")


def schedule_simulator_log_broadcast(
    entry: dict[str, Any],
    *,
    settings: Settings | None = None,
) -> None:
    _schedule(broadcast_simulator_log(entry, settings=settings), label="simulator_log")
