"""
api/routers/simulator.py
~~~~~~~~~~~~~~~~~~~~~~~~
Simulator lifecycle endpoints + custom data management.
Stats are persisted to stats.json via stats_store.
WebSocket clients are notified on every lifecycle change.

Fixes:
  BUG-8  : restart() preserves saved port/community (via sim_manager)
  BUG-12 : single restart code path
  Part-B : _restart_simulator_with_stats() shared helper
  Phase-9: broadcast status + stats after start/stop/restart
  Phase-10: GET /status now returns uptime_seconds (int), requests and
            last_activity surfaced from stats_store so frontend metrics
            panel is fully populated
  Phase-11: _enrich_sim_status() extracted so ws.py can import it without
            duplicating the enrichment logic (fixes WS ImportError crash)
"""

import os
import json
import logging
import time
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from services.sim_manager import SimulatorManager
from core.config import settings
from core import stats_store

router = APIRouter(prefix="/simulator", tags=["Simulator"])
logger = logging.getLogger(__name__)


class SimConfig(BaseModel):
    port: Optional[int] = None
    community: Optional[str] = None


_sim_start_time: Optional[datetime] = None


def set_sim_start_time() -> None:
    """Seed _sim_start_time to now. Called by lifespan auto-start and tests."""
    global _sim_start_time
    _sim_start_time = datetime.now(timezone.utc)


def _record_stop_stats() -> None:
    """Accumulate elapsed run time and increment stop_count atomically."""
    global _sim_start_time
    elapsed = 0
    if _sim_start_time:
        elapsed = int((datetime.now(timezone.utc) - _sim_start_time).total_seconds())
        _sim_start_time = None
    s = stats_store.load()
    stats_store.update_module("simulator", {
        "stop_count":            s["simulator"]["stop_count"] + 1,
        "simulator_run_seconds": s["simulator"]["simulator_run_seconds"] + elapsed,
    })


def _enrich_sim_status() -> dict:
    """
    Return SimulatorManager.status() enriched with uptime_seconds and
    persisted stats counters (requests, last_activity).

    Extracted from the GET /status endpoint so that ws.py can import and
    call it directly without duplicating the enrichment logic.
    Both GET /simulator/status and the WS full_state / status payloads
    go through this single function.
    """
    status = SimulatorManager.status()
    if status.get("running") and _sim_start_time:
        delta = datetime.now(timezone.utc) - _sim_start_time
        status["uptime_seconds"] = int(delta.total_seconds())
    else:
        status["uptime_seconds"] = None
    s = stats_store.load()
    status["requests"]      = s["simulator"]["snmp_requests_served"]
    status["last_activity"] = s["simulator"].get("last_request_at")
    return status


async def _broadcast_status() -> None:
    """Push current simulator+trap status to all WS clients."""
    try:
        from core.ws_manager import manager
        from services.trap_manager import trap_manager
        await manager.broadcast({
            "type":      "status",
            "simulator": _enrich_sim_status(),
            "traps":     trap_manager.get_status(),
        })
    except Exception as e:
        logger.debug(f"[WS] broadcast_status failed: {e}")


async def _broadcast_stats() -> None:
    """Push current stats snapshot to all WS clients."""
    try:
        from core.ws_manager import manager
        await manager.broadcast({
            "type": "stats",
            "data": stats_store.load(),
        })
    except Exception as e:
        logger.debug(f"[WS] broadcast_stats failed: {e}")


def _restart_simulator_with_stats() -> dict:
    """
    Shared restart helper. Used by:
      - POST /simulator/restart
      - POST /simulator/data  (conditional restart)
      - POST /mibs/reload     (conditional restart)
    Ensures _sim_start_time and restart_count are always updated
    regardless of which code path triggers the restart.
    Note: WS broadcast is done by the caller (async context required).
    """
    _record_stop_stats()
    time.sleep(0.5)
    result = SimulatorManager.restart()
    if result.get("status") == "failed":
        return result
    if result.get("status") == "started":
        set_sim_start_time()
        stats_store.increment("simulator", "restart_count")
    return result


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/status")
def get_status():
    return _enrich_sim_status()


@router.post("/start")
async def start_simulator(config: SimConfig = None):
    global _sim_start_time
    p = config.port      if config else None
    c = config.community if config else None

    current = SimulatorManager.status()
    if current.get("running"):
        return {
            "status":    "already_running",
            "message":   "Simulator is already running",
            "pid":       current.get("pid"),
            "port":      current.get("port"),
            "community": current.get("community"),
        }

    result = SimulatorManager.start(port=p, community=c)
    if result.get("status") == "failed":
        raise HTTPException(status_code=500, detail=result.get("error", "Simulator failed to start"))
    if result.get("status") == "started":
        set_sim_start_time()
        stats_store.increment("simulator", "start_count")
        await _broadcast_status()
        await _broadcast_stats()
        return {
            "status":    "started",
            "message":   "Simulator started successfully",
            "pid":       result.get("pid"),
            "port":      result.get("port"),
            "community": result.get("community"),
        }
    return result


@router.post("/stop")
async def stop_simulator():
    result = SimulatorManager.stop()
    if result.get("status") == "stopped":
        _record_stop_stats()
        await _broadcast_status()
        await _broadcast_stats()
        return {"status": "stopped", "message": "Simulator stopped successfully"}
    return result


@router.post("/restart")
async def restart_simulator():
    result = _restart_simulator_with_stats()
    await _broadcast_status()
    await _broadcast_stats()
    if result.get("status") == "failed":
        raise HTTPException(status_code=500, detail=result.get("error", "Simulator failed to restart"))
    if result.get("status") == "started":
        return {
            "status":    "restarted",
            "message":   "Simulator restarted successfully",
            "pid":       result.get("pid"),
            "port":      result.get("port"),
            "community": result.get("community"),
        }
    return result


@router.get("/data")
def get_custom_data():
    try:
        if not settings.CUSTOM_DATA_FILE.exists():
            return {}
        with open(settings.CUSTOM_DATA_FILE, 'r') as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to load custom data: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/data")
async def update_custom_data(data: dict):
    """Save custom OID data. If simulator is running, restart it with stats tracking."""
    try:
        os.makedirs(settings.CUSTOM_DATA_FILE.parent, exist_ok=True)
        with open(settings.CUSTOM_DATA_FILE, 'w') as f:
            json.dump(data, f, indent=2)

        if SimulatorManager.status().get("running"):
            _restart_simulator_with_stats()
            await _broadcast_status()
            await _broadcast_stats()
            msg = "Data saved and simulator restarted"
        else:
            msg = "Data saved (simulator is currently stopped)"

        logger.info(f"Custom data updated: {len(data)} entries")
        return {"status": "saved", "message": msg}
    except Exception as e:
        logger.error(f"Failed to save custom data: {e}")
        raise HTTPException(status_code=500, detail=str(e))
