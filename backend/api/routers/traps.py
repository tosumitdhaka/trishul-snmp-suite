"""
api/routers/traps.py
~~~~~~~~~~~~~~~~~~~~
SNMP trap send + receiver management endpoints.

Bug fixes:
  BUG-17 : SnmpEngine() created as module-level singleton instead of per-request
  Phase-11: broadcast stats after each successful trap send so the dashboard
            trishul:ws:stats listener gets a live counter update instead of
            waiting for the next WS reconnect / REST poll
"""

import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List
from pysnmp.hlapi.v3arch.asyncio import *
from pysnmp.proto.rfc1902 import *
from services.trap_manager import trap_manager
from core import stats_store

router = APIRouter(prefix="/traps", tags=["Traps"])
logger = logging.getLogger(__name__)

# BUG-17: singleton SnmpEngine — creating one per request leaks resources
_snmp_engine = SnmpEngine()


class TrapVarbind(BaseModel):
    oid: str
    type: str = "String"
    value: str


class TrapSendRequest(BaseModel):
    target: str
    port: int = 162
    community: str = "public"
    oid: str
    varbinds: List[TrapVarbind] = []


class TrapStartRequest(BaseModel):
    port: int = 1162
    community: str = "public"
    resolve_mibs: bool = True


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


@router.post("/send")
async def send_trap(req: TrapSendRequest):
    """Send SNMP trap. OID MUST be numeric."""
    try:
        logger.info(f"Sending trap OID={req.oid} to {req.target}:{req.port}")

        if "::" in req.oid:
            raise HTTPException(
                status_code=400,
                detail="Trap OID must be numeric. Frontend should resolve symbolic names first."
            )

        trap_oid      = ObjectIdentity(req.oid)
        notification  = NotificationType(trap_oid)

        for vb in req.varbinds:
            if "::" in vb.oid:
                raise HTTPException(
                    status_code=400,
                    detail=f"VarBind OID must be numeric: {vb.oid}"
                )
            if vb.type == "Integer":     val = Integer32(int(vb.value))
            elif vb.type == "Counter":   val = Counter32(int(vb.value))
            elif vb.type == "Gauge":     val = Gauge32(int(vb.value))
            elif vb.type == "OID":       val = ObjectIdentifier(str(vb.value))
            elif vb.type == "IpAddress": val = IpAddress(str(vb.value))
            elif vb.type == "TimeTicks": val = TimeTicks(int(vb.value))
            else:                        val = OctetString(str(vb.value))
            notification.add_varbinds(ObjectType(ObjectIdentity(vb.oid), val))

        target = await UdpTransportTarget.create((req.target, req.port))

        errorIndication, errorStatus, errorIndex, varBinds = await send_notification(
            _snmp_engine,                          # BUG-17: reuse singleton
            CommunityData(req.community, mpModel=1),
            target,
            ContextData(),
            'trap',
            notification
        )

        if errorIndication:
            raise HTTPException(status_code=500, detail=f"SNMP Error: {str(errorIndication)}")
        if errorStatus:
            raise HTTPException(status_code=500, detail=f"SNMP Error: {errorStatus.prettyPrint()}")

        stats_store.increment("traps", "traps_sent_total")
        await _broadcast_stats()   # live counter update to dashboard
        logger.info("Trap sent successfully")
        return {"status": "sent", "target": req.target, "port": req.port}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Trap send failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error: {str(e)}")


@router.get("/status")
def get_status():
    return trap_manager.get_status()


@router.post("/start")
def start_receiver(req: TrapStartRequest):
    result = trap_manager.start(req.port, req.community, req.resolve_mibs)
    if result.get("status") == "failed":
        raise HTTPException(status_code=500, detail=result.get("error", "Trap receiver failed to start"))
    return result


@router.post("/stop")
def stop_receiver():
    return trap_manager.stop()


@router.get("/")
def get_received_traps(limit: int = 50):
    return {"data": trap_manager.get_traps(limit)}


@router.delete("/")
def clear_traps():
    trap_manager.clear_traps()
    return {"status": "cleared"}
