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


# List payloads never expose the community string (RCV-15): the replay route
# applies the recorded value server-side when the override is blank, so the UI
# only ever sees this placeholder.
_COMMUNITY_MASK = "••••••"


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

    bundle = get_bundle()

    # Resolve MODULE::symbol OIDs
    resolved_oid = oid
    if "::" in oid:
        resolved = browser_service.resolve(oid, mode="numeric", bundle=bundle)
        if resolved.get("resolved"):
            resolved_oid = str(resolved.get("output") or oid)

    # Convert varbinds to runtime format
    runtime_varbinds = [_varbind_to_runtime(item, index=i) for i, item in enumerate(varbinds, 1)]

    # Enum membership is part of the varbind contract; enforce it server-side
    # so direct API sends get the same check as picker-driven form rows (TRP-05).
    _validate_enum_membership(runtime_varbinds, bundle=bundle)

    try:
        await runtime_service.send_trap(
            host=target, port=port, community=community,
            notification=resolved_oid, varbinds=runtime_varbinds,
        )
    except RuntimeServiceError as exc:
        _log(f"Trap send failed to {target}:{port} notification={resolved_oid}: {exc}", settings, level="ERROR")
        raise TrapsError(str(exc)) from exc
    _log(f"Trap sent to {target}:{port} notification={resolved_oid} varbinds={len(runtime_varbinds)} community={'***' if community else '(none)'}", settings)
    return {"status": "sent", "target": target, "port": port}


async def send_inform(
    *,
    target: str,
    port: int,
    community: str,
    oid: str,
    varbinds: list[dict[str, Any]],
    settings: Settings,
    runtime_service,
) -> dict[str, Any]:
    """Send the notification as an Inform request and await the acknowledgement.

    The runtime raises on a missing/failed acknowledgement (transport error or
    timeout), so a 200 response here means the receiver confirmed receipt; the
    serialized ``response`` still carries the PDU's error_status for the UI to
    surface (TRP-06).
    """
    from app.services import browser_service
    from app.services.bundle_state import get_bundle
    from app.services.runtime import RuntimeServiceError

    bundle = get_bundle()

    resolved_oid = oid
    if "::" in oid:
        resolved = browser_service.resolve(oid, mode="numeric", bundle=bundle)
        if resolved.get("resolved"):
            resolved_oid = str(resolved.get("output") or oid)

    runtime_varbinds = [_varbind_to_runtime(item, index=i) for i, item in enumerate(varbinds, 1)]
    _validate_enum_membership(runtime_varbinds, bundle=bundle)

    try:
        result = await runtime_service.send_inform(
            host=target, port=port, community=community,
            notification=resolved_oid, varbinds=runtime_varbinds,
        )
    except RuntimeServiceError as exc:
        _log(f"Inform send failed to {target}:{port} notification={resolved_oid}: {exc}", settings, level="ERROR")
        raise TrapsError(str(exc)) from exc
    _log(f"Inform sent to {target}:{port} notification={resolved_oid} varbinds={len(runtime_varbinds)} community={'***' if community else '(none)'}", settings)
    return {
        "status": "sent",
        "operation": "inform",
        "target": target,
        "port": port,
        "request_id": result.get("request_id"),
        "response": result.get("response"),
    }


async def replay_event(
    *,
    event_id: int,
    host: str | None,
    port: int | None,
    community: str | None,
    timeout: float | None,
    retries: int | None,
    settings: Settings,
    runtime_service,
) -> dict[str, Any]:
    """Replay a stored notification event with optional target overrides.

    The replay target defaults to the recorded values where sensible: sent
    events replay to their stored target; received events replay back to the
    source host. Port/community/timeout/retries fall through to the runtime's
    own recorded-value defaults (TRP-07).
    """
    from app.services.history import EventHistoryService, EventHistoryServiceError
    from app.services.runtime import RuntimeServiceError

    resolved_host = host
    if resolved_host is None:
        try:
            stored = EventHistoryService(settings).get_event(event_id)
        except EventHistoryServiceError as exc:
            raise TrapsError(str(exc)) from exc
        stored_event = stored.get("event")
        if isinstance(stored_event, dict):
            target = stored_event.get("target")
            if isinstance(target, dict) and isinstance(target.get("host"), str) and target["host"].strip():
                resolved_host = target["host"].strip()
            else:
                source_address = stored_event.get("source_address")
                if isinstance(source_address, dict) and isinstance(source_address.get("host"), str) and source_address["host"].strip():
                    resolved_host = source_address["host"].strip()

    try:
        result = await runtime_service.replay_notification_event(
            event_id=event_id,
            host=resolved_host,
            port=port,
            community=community,
            timeout=timeout,
            retries=retries,
        )
    except RuntimeServiceError as exc:
        _log(f"Trap replay failed for event {event_id}: {exc}", settings, level="ERROR")
        raise TrapsError(str(exc)) from exc
    _log(f"Trap replayed from event {event_id} as {result.get('operation')}", settings)
    return result


async def decode_payload(
    *,
    payload: str,
    encoding: str,
    source_host: str | None,
    source_port: int | None,
    settings: Settings,
    runtime_service,
) -> dict[str, Any]:
    """Decode an offline hex/base64 notification payload into PDU fields."""
    from app.services.runtime import RuntimeServiceError

    try:
        return await runtime_service.decode_notification_payload(
            payload=payload,
            encoding=encoding,
            source_host=source_host,
            source_port=source_port,
        )
    except RuntimeServiceError as exc:
        _log(f"Trap payload decode failed: {exc}", settings, level="ERROR")
        raise TrapsError(str(exc)) from exc


def _coerce_int(value: Any, *, index: int, type_label: str) -> int:
    """Strictly coerce a varbind value to an integer.

    Bad numerics raise ``TrapsError`` with the offending value instead of being
    silently coerced to 0 (TRP-04). Bools are accepted (True -> 1); fractional
    floats and non-numeric values are rejected.
    """
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, float):
        if value.is_integer():
            return int(value)
        raise TrapsError(f"VarBind {index} value: {value!r} is not a valid {type_label}")
    try:
        return int(value)
    except (TypeError, ValueError):
        raise TrapsError(f"VarBind {index} value: {value!r} is not a valid {type_label}") from None


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
        value = {"type": "integer", "value": _coerce_int(raw_value, index=index, type_label="Integer")}
    elif value_type in ("counter32", "gauge32", "timeticks"):
        value = {"type": value_type, "value": _coerce_int(raw_value, index=index, type_label=raw_type)}
    elif value_type == "counter64":
        value = {"type": "counter64", "value": _coerce_int(raw_value, index=index, type_label="Counter64")}
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


def _validate_enum_membership(runtime_varbinds: list[dict[str, Any]], *, bundle) -> None:
    """Reject integer varbind values that fall outside a declared enum.

    Resolves each integer varbind's target OID against the active bundle and
    compares the value with the MIB-declared enum map. Varbinds whose target is
    unknown, non-enum, or not an integer type are left untouched; anything that
    resolves to an enum must be a member (TRP-05).
    """
    if bundle is None:
        return
    from app.services.mib_metadata import enum_map

    for index, vb in enumerate(runtime_varbinds, 1):
        value = vb.get("value") or {}
        if value.get("type") != "integer":
            continue
        target = str(vb.get("target") or "").strip().lstrip(".")
        if not target:
            continue
        try:
            match = bundle.lookup(target)
            node = bundle.resolve_node(match.module, match.symbol)
        except Exception:
            continue
        mapping = enum_map(node) if node is not None else None
        if not mapping:
            continue
        numeric = value.get("value")
        if numeric not in mapping.values():
            allowed = ", ".join(f"{label}={number}" for label, number in mapping.items())
            raise TrapsError(
                f"VarBind {index} value {numeric!r} is not a member of the declared enum ({allowed})"
            )


def list_events(
    *,
    state: StateStore,
    history_service,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    from app.services.bundle_state import get_bundle
    snap = state.snapshot()
    resolve_mibs = bool(snap[_TRAP_RESOLVE_MIBS_KEY])
    result = history_service.list_events(direction="received", limit=limit, offset=offset)
    items = result["items"]
    bundle = get_bundle()
    return {
        "data": [_format_trap_event(item, resolve_mibs=resolve_mibs, bundle=bundle) for item in items],
        "count": len(items),
        "total": int(result.get("total", len(items))),
        "limit": limit,
        "offset": offset,
    }


def get_trap_event_snapshot(item: dict[str, Any], *, state: StateStore, history_service) -> dict[str, Any]:
    from app.services.bundle_state import get_bundle
    snap = state.snapshot()
    resolve_mibs = bool(snap[_TRAP_RESOLVE_MIBS_KEY])
    return _format_trap_event(item, resolve_mibs=resolve_mibs, bundle=get_bundle())


def clear_events(*, history_service) -> dict[str, str]:
    from sqlalchemy import delete, text
    from app.models import NotificationEvent
    with history_service.session_factory() as session:
        session.execute(delete(NotificationEvent).where(NotificationEvent.direction == "received"))
        # The FTS mirror (notification_event_search) is not cascaded by the
        # DELETE above; purge the received rows so search never matches
        # orphaned ids and the mirror cannot grow unboundedly (RCV-04).
        session.execute(text("DELETE FROM notification_event_search WHERE direction = 'received'"))
        session.commit()
    return {"status": "cleared"}


def delete_event(*, history_service, event_id: int) -> dict[str, Any]:
    """Delete a single received trap and its FTS mirror row (RCV-12).

    Only ``received`` events are deletable through this path; sent/decoded
    history stays untouched.
    """
    from sqlalchemy import text
    from app.models import NotificationEvent

    event_id = int(event_id)
    with history_service.session_factory() as session:
        row = session.get(NotificationEvent, event_id)
        if row is None or row.direction != "received":
            raise TrapsError(f"Notification event {event_id} is not a received trap.")
        session.delete(row)
        session.execute(
            text("DELETE FROM notification_event_search WHERE event_id = :event_id"),
            {"event_id": str(event_id)},
        )
        session.commit()
    return {"status": "deleted", "id": event_id}


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

    # time_str: full "YYYY-MM-DD HH:MM:SS" so cross-day traps stay
    # distinguishable at a glance (RCV-06); the raw ISO timestamp rides along
    # in ``timestamp`` for tooltip-level precision.
    time_str = "--"
    if recorded_at:
        try:
            if "T" in recorded_at:
                date_part, time_part = recorded_at.split("T", 1)
                time_str = f"{date_part} {time_part.split('+')[0].split('Z')[0].split('.')[0]}"
            else:
                time_str = recorded_at.split(".")[0].split("+")[0].split("Z")[0]
        except Exception:
            time_str = recorded_at

    item_id = item.get("id")
    event_id = item.get("event_id")
    community = item.get("community") or event.get("community")
    return {
        "id": int(item_id if item_id is not None else event_id) if (item_id is not None or event_id is not None) else None,
        "timestamp": recorded_at,
        "time_str": time_str,
        "source": source,
        "trap_type": trap_type,
        "community": _COMMUNITY_MASK if community else None,
        "resolve_mibs": effective_resolve_mibs,
        "resolved": bool(effective_resolve_mibs and notification_name and notification_name != notification_oid),
        "varbinds": varbinds,
    }
