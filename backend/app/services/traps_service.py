"""Trap listener, send, and history service."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.core.config import Settings
from app.core.logging import emit_backend_log
from app.services.state_store import (
    StateStore,
    _LISTENER_COMMUNITY_KEY,
    _LISTENER_PORT_KEY,
    _LISTENER_STARTED_AT_KEY,
    _TRAP_RESOLVE_MIBS_KEY,
)
from app.services.realtime import broadcast_status


class TrapsError(RuntimeError):
    pass


def _log(message: str, settings: Settings, *, level: str = "INFO") -> None:
    emit_backend_log(message, level=level, logger_name="app.operations", settings=settings)


async def get_status(*, state: StateStore, runtime_service) -> dict[str, Any]:
    runtime_state = await runtime_service.get_state()
    listener = runtime_state["notifications"]["listener"]
    communities = listener.get("communities") or []
    snap = state.snapshot()
    saved_port = state.coerce_port(snap.get(_LISTENER_PORT_KEY), default=1162)
    saved_community = state.coerce_community(snap.get(_LISTENER_COMMUNITY_KEY), default="public")
    return {
        "running": bool(listener["running"]),
        "port": listener.get("port") or saved_port,
        "community": communities[0] if communities else saved_community,
        "resolve_mibs": bool(snap[_TRAP_RESOLVE_MIBS_KEY]),
        "uptime_seconds": state.uptime_seconds(_LISTENER_STARTED_AT_KEY) if listener["running"] else None,
    }


async def start_listener(
    *, port: int, community: str, resolve_mibs: bool,
    settings: Settings, state: StateStore, runtime_service,
) -> dict[str, Any]:
    from app.services.runtime import RuntimeServiceError
    try:
        await runtime_service.start_listener(
            host="0.0.0.0", port=port, communities=[community]
        )
    except RuntimeServiceError as exc:
        _log(f"Trap receiver start failed on UDP {port}: {exc}", settings, level="ERROR")
        raise TrapsError(str(exc)) from exc
    state.set_value(_LISTENER_PORT_KEY, int(port))
    state.set_value(_LISTENER_COMMUNITY_KEY, str(community))
    state.set_value(_TRAP_RESOLVE_MIBS_KEY, bool(resolve_mibs))
    state.set_value(_LISTENER_STARTED_AT_KEY, datetime.now(timezone.utc).isoformat())
    _log(f"Trap receiver started on UDP {port} community={community} resolve_mibs={bool(resolve_mibs)}", settings)
    await broadcast_status(settings=settings)
    return {"status": "started"}


async def stop_listener(
    *, settings: Settings, state: StateStore, runtime_service,
) -> dict[str, Any]:
    from app.services.runtime import RuntimeServiceError
    try:
        await runtime_service.stop_listener()
    except RuntimeServiceError as exc:
        _log(f"Trap receiver stop failed: {exc}", settings, level="ERROR")
        raise TrapsError(str(exc)) from exc
    state.set_value(_LISTENER_STARTED_AT_KEY, None)
    _log("Trap receiver stopped.", settings)
    await broadcast_status(settings=settings)
    return {"status": "stopped"}


async def send_trap(
    *,
    target: str,
    port: int,
    community: str,
    oid: str,
    varbinds: list[dict[str, Any]],
    settings: Settings,
    runtime_service,
) -> dict[str, Any]:
    from app.services import browser_service
    from app.services.bundle_state import get_bundle
    from app.services.runtime import RuntimeServiceError

    # Resolve MODULE::symbol OIDs
    resolved_oid = oid
    if "::" in oid:
        bundle = get_bundle()
        resolved = browser_service.resolve(oid, mode="numeric", bundle=bundle)
        if resolved.get("resolved"):
            resolved_oid = str(resolved.get("output") or oid)

    # Convert varbinds to runtime format
    runtime_varbinds = [_varbind_to_runtime(item, index=i) for i, item in enumerate(varbinds, 1)]

    try:
        await runtime_service.send_trap(
            host=target, port=port, community=community,
            notification=resolved_oid, varbinds=runtime_varbinds,
        )
    except RuntimeServiceError as exc:
        _log(f"Trap send failed to {target}:{port} notification={resolved_oid}: {exc}", settings, level="ERROR")
        raise TrapsError(str(exc)) from exc
    _log(f"Trap sent to {target}:{port} notification={resolved_oid} varbinds={len(runtime_varbinds)} community={community}", settings)
    return {"status": "sent", "target": target, "port": port}


def _varbind_to_runtime(item: dict[str, Any], *, index: int) -> dict[str, Any]:
    raw_oid = str(item.get("oid") or "").strip().lstrip(".")
    raw_type = str(item.get("type") or "String").strip()
    raw_value = item.get("value")

    type_map = {
        "Integer": "integer", "Integer32": "integer", "int": "integer",
        "Counter": "counter32", "Counter32": "counter32",
        "Counter64": "counter64",
        "Gauge32": "gauge32", "Gauge": "gauge32",
        "TimeTicks": "timeticks", "timeticks": "timeticks",
        "OID": "object-identifier", "OBJECT IDENTIFIER": "object-identifier",
        "IpAddress": "ip-address",
        "String": "octet-string", "OctetString": "octet-string",
    }
    value_type = type_map.get(raw_type, "octet-string")

    if value_type == "integer":
        try:
            v = int(bool(raw_value)) if isinstance(raw_value, bool) else int(raw_value or 0)
        except (TypeError, ValueError):
            v = 0
        value = {"type": "integer", "value": v}
    elif value_type in ("counter32", "gauge32", "timeticks"):
        try:
            v = int(raw_value or 0)
        except (TypeError, ValueError):
            v = 0
        value = {"type": value_type, "value": v}
    elif value_type == "counter64":
        try:
            v = int(raw_value or 0)
        except (TypeError, ValueError):
            v = 0
        value = {"type": "counter64", "value": v}
    elif value_type == "object-identifier":
        oid_val = str(raw_value or "1.3.6.1").strip().lstrip(".")
        if oid_val.count(".") < 1:
            raise TrapsError(f"VarBind {index} value: OBJECT IDENTIFIER requires at least two arcs (got {oid_val!r})")
        value = {"type": "object-identifier", "value": oid_val}
    elif value_type == "ip-address":
        value = {"type": "ip-address", "value": str(raw_value or "0.0.0.0")}
    else:
        value = {"type": "octet-string", "value": str(raw_value or "")}

    return {"target": raw_oid, "value": value}


def list_events(
    *,
    state: StateStore,
    history_service,
    limit: int = 100,
) -> dict[str, Any]:
    from app.services.bundle_state import get_bundle
    snap = state.snapshot()
    resolve_mibs = bool(snap[_TRAP_RESOLVE_MIBS_KEY])
    items = history_service.list_events(direction="received", limit=limit, offset=0)["items"]
    bundle = get_bundle()
    return {
        "data": [_format_trap_event(item, resolve_mibs=resolve_mibs, bundle=bundle) for item in items],
        "count": len(items),
    }


def get_trap_event_snapshot(item: dict[str, Any], *, state: StateStore, history_service) -> dict[str, Any]:
    from app.services.bundle_state import get_bundle
    snap = state.snapshot()
    resolve_mibs = bool(snap[_TRAP_RESOLVE_MIBS_KEY])
    return _format_trap_event(item, resolve_mibs=resolve_mibs, bundle=get_bundle())


def clear_events(*, history_service) -> dict[str, str]:
    from sqlalchemy import delete
    from app.models import NotificationEvent
    with history_service.session_factory() as session:
        session.execute(delete(NotificationEvent).where(NotificationEvent.direction == "received"))
        session.commit()
    return {"status": "cleared"}


def _format_trap_event(
    item: dict[str, Any],
    *,
    resolve_mibs: bool,
    bundle,
) -> dict[str, Any]:
    event = item.get("event") if isinstance(item.get("event"), dict) else dict(item)
    event_resolve_mibs = item.get("resolve_mibs")
    if not isinstance(event_resolve_mibs, bool):
        event_resolve_mibs = event.get("resolve_mibs")
    effective_resolve_mibs = event_resolve_mibs if isinstance(event_resolve_mibs, bool) else bool(resolve_mibs)
    source_address = item.get("source_address") or event.get("source_address") or {}
    source_host = str(source_address.get("host") or "")
    source_port = source_address.get("port")
    source = f"{source_host}:{source_port}" if source_host and source_port else source_host or "--"
    recorded_at = str(item.get("recorded_at") or event.get("recorded_at") or event.get("received_at") or "")
    notification_oid = str(item.get("notification_oid") or event.get("notification_oid") or "")

    # Try to resolve notification name from bundle
    notification_name = str(item.get("notification_name") or event.get("notification_name") or "").strip()
    if effective_resolve_mibs and bundle is not None and notification_oid:
        try:
            from trishul_snmp.mib.registry import oid_to_string
            from trishul_snmp.errors import UnknownOidError
            match = bundle.lookup(notification_oid)
            notification_name = bundle.display_symbolic_from_match(match)
        except Exception:
            pass

    trap_type = (
        notification_name
        if effective_resolve_mibs and notification_name
        else (notification_oid or item.get("pdu_type") or "trap")
    )
    if effective_resolve_mibs and "::" in str(trap_type):
        trap_type = str(trap_type).split("::", 1)[1]

    varbinds = []
    for vb in event.get("varbinds", []):
        symbolic = vb.get("symbolic") or vb.get("oid") or ""
        display = symbolic if effective_resolve_mibs else (vb.get("oid") or symbolic)
        raw_val = vb.get("value")
        # Raw value rides in ``value``; the enum label and units suffix render
        # the enrichment next to it, and display_value stays available for
        # text/detail contexts without duplicating the label in the row value.
        value = raw_val.get("display") if isinstance(raw_val, dict) and "display" in raw_val else (
            raw_val.get("value") if isinstance(raw_val, dict) else vb.get("display_value")
        )
        varbinds.append({
            "oid": vb.get("oid") or "",
            "name": display,
            "resolved": bool(effective_resolve_mibs and symbolic and symbolic != vb.get("oid")),
            "value": value,
            "display_value": vb.get("display_value"),
            "enum_label": vb.get("enum_label"),
            "units": vb.get("units"),
        })

    # time_str: HH:MM:SS extracted from ISO timestamp, for display in the UI table
    time_str = "--"
    if recorded_at:
        try:
            time_part = recorded_at.split("T", 1)[1] if "T" in recorded_at else recorded_at
            time_str = time_part.split("+")[0].split("Z")[0].split(".")[0]
        except Exception:
            time_str = recorded_at

    item_id = item.get("id")
    event_id = item.get("event_id")
    return {
        "id": int(item_id if item_id is not None else event_id) if (item_id is not None or event_id is not None) else None,
        "timestamp": recorded_at,
        "time_str": time_str,
        "source": source,
        "trap_type": trap_type,
        "resolve_mibs": effective_resolve_mibs,
        "resolved": bool(effective_resolve_mibs and notification_name and notification_name != notification_oid),
        "varbinds": varbinds,
    }
