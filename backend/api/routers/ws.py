"""
api/routers/ws.py
~~~~~~~~~~~~~~~~~
WebSocket endpoint for real-time server-push.

Protocol
--------
Client connects:  ws://host/api/ws?token=<session_token>
On connect:       server sends {type: "full_state", ...} immediately
Client keepalive: client sends text "ping" every 30s
Server response:  server replies text "pong"

Server-push message types
--------------------------
{"type": "full_state",                   -- sent once on connect
 "simulator": {...},                      -- enriched: includes uptime_seconds, requests, last_activity
 "traps": {...},                          -- includes uptime_seconds
 "stats": {...},
 "mibs": {loaded, failed, total, traps_available}}

{"type": "status",                       -- sent on any lifecycle change
 "simulator": {...},                      -- enriched
 "traps": {...}}                          -- includes uptime_seconds

{"type": "trap",                         -- sent when a new trap arrives
 "trap": {timestamp, source, trap_type, varbinds, resolved}}

{"type": "simulator_log",                -- sent on live simulator activity
 "entry": {time, level, message, request_type, oid_count, ...}}

{"type": "stats",                        -- sent after any stats write
 "data": {simulator:{...}, traps:{...}, walker:{...}, mibs:{...}}}

{"type": "mibs",                         -- sent after any MIB mutation
 "mibs": {loaded, failed, total, traps_available}}
"""

import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from core.ws_manager import manager
from core.security import validate_session_token
from core import stats_store

router = APIRouter(tags=["WebSocket"])
logger = logging.getLogger(__name__)


async def _build_full_state() -> dict:
    """Assemble a full_state payload from live service status + persisted stats."""
    from api.routers.simulator import _enrich_sim_status
    from services.trap_manager import trap_manager
    from services.mib_service import get_mib_service

    sim_status  = _enrich_sim_status()
    trap_status = trap_manager.get_status()
    stats       = stats_store.load()

    mibs_summary = {"loaded": 0, "failed": 0, "total": 0, "traps_available": 0}

    # Enrich MIB stats with live counts (same as GET /api/stats/)
    try:
        mib_status = get_mib_service().get_status()
        stats["mibs"]["loaded_mibs"] = mib_status.get("loaded", 0)
        stats["mibs"]["failed_mibs"] = mib_status.get("failed", 0)
        stats["mibs"]["total_mibs"]  = mib_status.get("loaded", 0) + mib_status.get("failed", 0)
        mibs_list = mib_status.get("mibs", []) or []
        mibs_summary = {
            "loaded":          mib_status.get("loaded", 0),
            "failed":          mib_status.get("failed", 0),
            "total":           mib_status.get("loaded", 0) + mib_status.get("failed", 0),
            "traps_available": sum(m.get("traps", 0) for m in mibs_list),
        }
    except Exception:
        pass

    return {
        "type":      "full_state",
        "simulator": sim_status,
        "traps":     trap_status,
        "stats":     stats,
        "mibs":      mibs_summary,
    }


def _build_status_payload() -> dict:
    """Assemble a status payload (lightweight — no stats)."""
    from api.routers.simulator import _enrich_sim_status
    from services.trap_manager import trap_manager
    return {
        "type":      "status",
        "simulator": _enrich_sim_status(),
        "traps":     trap_manager.get_status(),
    }


@router.websocket("/api/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    WebSocket endpoint. Authentication via ?token= query parameter.
    The token must match an active session (same as X-Auth-Token header
    used by REST endpoints).
    """
    token = websocket.query_params.get("token")
    valid, _username, reason = validate_session_token(token)
    if not valid:
        # Close with 4001 = policy violation (auth failure)
        await websocket.close(code=4001, reason=reason or "Unauthorized")
        logger.warning("[WS] rejected unauthenticated connection")
        return

    await manager.connect(websocket, token)
    try:
        # Send full current state immediately so client doesn't need to
        # make any REST calls on page load.
        full_state = await _build_full_state()
        await manager.send_to(websocket, full_state)

        # Main loop — only purpose is to handle ping/pong keepalive.
        # All pushes to client happen via manager.broadcast() from other
        # routers/services when state changes.
        while True:
            data = await websocket.receive_text()
            valid, _username, reason = validate_session_token(token)
            if not valid:
                await websocket.close(code=4001, reason=reason or "Unauthorized")
                manager.disconnect(websocket)
                break
            if data == "ping":
                await websocket.send_text("pong")

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"[WS] unexpected error: {e}")
        manager.disconnect(websocket)
