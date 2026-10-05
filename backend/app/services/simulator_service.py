"""Simulator lifecycle, custom data, and activity log service."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

from app.core.config import Settings
from app.core.logging import emit_backend_log
from app.services.state_store import (
    StateStore,
    _SIMULATOR_COMMUNITY_KEY,
    _SIMULATOR_PORT_KEY,
    _SIMULATOR_STARTED_AT_KEY,
)
from app.services.realtime import broadcast_stats, broadcast_status


class SimulatorError(RuntimeError):
    pass


def _log(message: str, settings: Settings, *, level: str = "INFO") -> None:
    emit_backend_log(message, level=level, logger_name="app.operations", settings=settings)


def _runtime_objects_from_custom_data(
    payload: dict[str, Any],
    bundle=None,
    *,
    reject_invalid: bool = False,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Convert custom data dict (OID → value) to runtime object spec dicts.

    Type is inherited from the bundle node for the target OID — symbolic
    targets resolve by name, numeric OIDs by lookup — so numeric targets are
    typed like their symbolic equivalents instead of falling back to a default.
    Targets are canonicalized to their numeric OID form, so symbolic and
    numeric spellings of the same OID merge into a single entry. If the bundle
    has no type info for the target, the value is skipped with a warning rather
    than guessed. If a dict value with an explicit 'type' key is provided it
    is used as-is (advanced override). Values that cannot be coerced or that
    violate the node's declared constraints are skipped with a warning when
    ``reject_invalid`` is False (startup path); when ``reject_invalid`` is True
    (save/update path) the first invalid entry raises an explicit SimulatorError.

    Returns ``(objects, warnings)``.
    """
    from app.services.bundle_state import get_bundle as _get_bundle
    from app.services.mib_metadata import effective_constraints
    from trishul_snmp.mib.registry import oid_to_string

    active_bundle = bundle if bundle is not None else _get_bundle()

    objects: list[dict[str, Any]] = []
    warnings: list[str] = []
    for target, value in payload.items():
        target_str = str(target).strip()
        if not target_str:
            continue

        # Dict with explicit type payload — pass through unchanged
        if isinstance(value, dict) and "type" in value:
            objects.append({"target": target_str, "value": value})
            continue

        # Resolve syntax + constraints from the bundle node, and canonicalize
        # the target to its numeric OID form so symbolic and numeric spellings
        # of the same OID merge into one entry.
        syntax: str | None = None
        constraints = None
        canonical_target = target_str.lstrip(".")
        if active_bundle is not None:
            try:
                if "::" in target_str:
                    mod, rest = target_str.split("::", 1)
                    sym, _, instance = rest.partition(".")
                    node = active_bundle.resolve_node(mod, sym)
                    if node is not None:
                        syntax = node.syntax
                        constraints = effective_constraints(node, bundle=active_bundle)
                        node_oid = oid_to_string(node.oid)
                        canonical_target = f"{node_oid}.{instance}" if instance else node_oid
                else:
                    # Numeric OID — look up the owning node so the value gets
                    # the node's declared type instead of a default gauge32.
                    match = active_bundle.lookup(target_str)
                    node = active_bundle.resolve_node(match.module, match.symbol)
                    if node is not None:
                        syntax = node.syntax
                        constraints = effective_constraints(node, bundle=active_bundle)
            except Exception:
                pass

        # Build typed value from syntax
        spec, error = _coerce_custom_value(
            target_str,
            value,
            syntax,
            constraints=constraints,
        )
        if error is not None:
            message = f"{target_str}: {error}"
            if reject_invalid:
                raise SimulatorError(message)
            warnings.append(message)
            continue
        if spec is not None:
            objects.append({"target": canonical_target, "value": spec})

    return objects, warnings


def _coerce_custom_value(
    target: str,
    value: Any,
    syntax: str | None,
    *,
    constraints=None,
) -> tuple[dict[str, Any] | None, str | None]:
    """Coerce a user-supplied value to the correct SNMP type based on MIB syntax.

    Returns ``(spec, error)``. ``spec`` is None when the value cannot be coerced
    or violates the node's declared constraints, in which case ``error`` explains
    why instead of silently skipping the value.
    """
    from app.services.mib_metadata import constraint_violation

    s = (syntax or "").split("(")[0].strip()

    # Determine SNMP type from syntax
    if s in _COUNTER_SYNTAXES:
        snmp_type = "counter32" if s != "Counter64" else "counter64"
    elif s in _GAUGE_SYNTAXES:
        snmp_type = "gauge32"
    elif s in _TIMETICKS_SYNTAXES:
        snmp_type = "timeticks"
    elif s in _OID_SYNTAXES:
        snmp_type = "object-identifier"
    elif s in _IP_SYNTAXES:
        snmp_type = "ip-address"
    elif s in _INTEGER_SYNTAXES:
        snmp_type = "integer"
    elif not s:
        # No syntax info — treat numeric values as gauge32, strings as octet-string
        snmp_type = "gauge32" if _is_numeric(value) else "octet-string"
    else:
        snmp_type = "octet-string"

    # Coerce value
    try:
        if snmp_type in ("integer", "gauge32", "timeticks", "counter32", "counter64"):
            raw = str(value).strip()
            try:
                numeric = int(raw)
            except ValueError:
                # int(float("3.7")) would silently truncate a fractional
                # value to 3; reject non-integer strings instead.
                as_float = float(raw)
                if not as_float.is_integer():
                    return None, f"value {value!r} is not a whole number; {snmp_type} requires an integer"
                numeric = int(as_float)
            message = constraint_violation(numeric, constraints)
            if message is not None:
                return None, message
            return {"type": snmp_type, "value": numeric}, None
        elif snmp_type == "object-identifier":
            oid_val = str(value).strip().lstrip(".")
            return {"type": "object-identifier", "value": oid_val}, None
        elif snmp_type == "ip-address":
            return {"type": "ip-address", "value": str(value).strip()}, None
        else:
            text = str(value)
            message = constraint_violation(text, constraints)
            if message is not None:
                return None, message
            return {"type": "octet-string", "value": text}, None
    except (ValueError, TypeError):
        return None, f"value {value!r} cannot be coerced to {snmp_type}"


def _is_numeric(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return True
    try:
        float(str(value).strip())
        return True
    except (ValueError, TypeError):
        return False


def load_custom_data(settings: Settings) -> tuple[dict[str, Any], str | None]:
    """Load the persisted custom-data payload.

    Returns ``(payload, warning)``; ``warning`` is set when the file exists but
    cannot be parsed, so a corrupt ``custom_data.json`` is surfaced to the
    operator instead of being silently treated as an empty override set.
    """
    path = settings.config_dir / "custom_data.json"
    if not path.exists():
        return {}, None
    try:
        payload = json.loads(path.read_text())
    except OSError as exc:
        warning = f"Could not read {path.name}: {exc}"
        _log(f"Simulator custom data warning: {warning}", settings, level="WARNING")
        return {}, warning
    except json.JSONDecodeError as exc:
        warning = f"{path.name} is not valid JSON ({exc}); custom overrides were not loaded."
        _log(f"Simulator custom data warning: {warning}", settings, level="WARNING")
        return {}, warning
    if not isinstance(payload, dict):
        warning = f"{path.name} does not contain a JSON object; custom overrides were not loaded."
        _log(f"Simulator custom data warning: {warning}", settings, level="WARNING")
        return {}, warning
    return payload, None


import random as _random

_BUNDLE_OBJECTS_TABLE_ROWS = 2
_COUNTER_SYNTAXES = {"Counter32", "Counter64"}
_GAUGE_SYNTAXES = {"Gauge32", "Gauge", "Unsigned32"}
_TIMETICKS_SYNTAXES = {"TimeTicks", "TimeStamp", "TimeTicks32"}
_INTEGER_SYNTAXES = {"Integer32", "INTEGER", "Integer", "TruthValue"}
_OID_SYNTAXES = {"OBJECT IDENTIFIER", "AutonomousType", "ObjectIdentifier"}
_IP_SYNTAXES = {"IpAddress", "InetAddress", "IpV4orV6Addr"}
_STRING_SYNTAXES = {"OctetString", "DisplayString", "SnmpAdminString", "DateAndTime",
                    "PhysAddress", "MacAddress"}


def _default_value_for_syntax(
    syntax: str | None,
    name: str,
    *,
    index: int,
    node=None,
    bundle=None,
) -> dict[str, Any]:
    from app.services.mib_metadata import (
        effective_constraints,
        first_enum_value,
        is_bits_node,
        range_bounds,
        size_bounds,
    )

    s = (syntax or "").split("(")[0].strip()
    low = name.lower()
    constraints = effective_constraints(node, bundle=bundle)

    # SIM-10: BITS-typed objects serve an octet string, not the integer bit
    # number that the shared enum map would otherwise resolve to.
    if is_bits_node(node, bundle=bundle):
        return {"type": "octet-string", "value": ""}

    # Enum INTEGER: use first enum value regardless of object name
    enum_val = first_enum_value(node)
    if enum_val is not None:
        return {"type": "integer", "value": enum_val}

    # Numeric types with a declared range: draw inside the declared bounds
    bounds = range_bounds(constraints)
    if bounds:
        min_val, max_val = bounds[0]
        if s in _COUNTER_SYNTAXES:
            return {"type": "counter32" if s != "Counter64" else "counter64", "value": _random.randint(min_val, max_val)}
        if s in _GAUGE_SYNTAXES:
            return {"type": "gauge32", "value": _random.randint(min_val, max_val)}
        if s in _TIMETICKS_SYNTAXES:
            return {"type": "timeticks", "value": _random.randint(min_val, max_val)}
        return {"type": "integer", "value": _random.randint(min_val, max_val)}

    if s in _COUNTER_SYNTAXES:
        v = _random.randint(1000, 999999)
        return {"type": "counter32" if s != "Counter64" else "counter64", "value": v}
    if s in _GAUGE_SYNTAXES:
        return {"type": "gauge32", "value": _random.randint(1, 1000000000)}
    if s in _TIMETICKS_SYNTAXES:
        return {"type": "timeticks", "value": _random.randint(0, 5000000)}
    if s in _OID_SYNTAXES:
        return {"type": "object-identifier", "value": "1.3.6.1.2.1.1"}
    if s in _IP_SYNTAXES:
        return {"type": "ip-address", "value": f"127.0.0.{index}"}
    if "phys" in low or "mac" in low or s == "PhysAddress" or s == "MacAddress":
        mac = f"00:11:22:33:44:{index:02x}"
        return {"type": "octet-string", "value": _clamp_mac_to_size(mac, constraints)}
    if "descr" in low or "name" in low or "alias" in low:
        return {"type": "octet-string", "value": _clamp_string_to_size(f"{name}-{index}", constraints)}
    if s in _INTEGER_SYNTAXES:
        return {"type": "integer", "value": _random.randint(1, 100)}
    if s in _STRING_SYNTAXES or not s:
        return {"type": "octet-string", "value": _clamp_string_to_size(f"{name}-{index}", constraints)}
    return {"type": "integer", "value": _random.randint(1, 100)}


def _clamp_string_to_size(value: str, constraints) -> str:
    """Trim or pad *value* so its length satisfies the declared size bounds."""
    from app.services.mib_metadata import size_bounds

    bounds = size_bounds(constraints)
    if not bounds:
        return value
    min_len, max_len = bounds[0]
    if len(value) > max_len:
        return value[:max_len]
    if len(value) < min_len:
        return (value + "x" * min_len)[:min_len]
    return value


def _clamp_mac_to_size(value: str, constraints) -> str:
    """Trim or pad a display-format MAC/phys address to the declared size bounds.

    PhysAddress/MacAddress size constraints count *bytes*, not display
    characters: ``"00:11:22:33:44:01"`` is 6 bytes but 17 characters, so a
    character-count clamp would truncate it to ``"00:11:"`` (a garbled MAC).
    Octets are clamped/padded by byte count instead, so the display form stays
    well-formed even when the type declares a byte-size bound.
    """
    from app.services.mib_metadata import size_bounds

    bounds = size_bounds(constraints)
    if not bounds:
        return value
    min_len, max_len = bounds[0]
    octets = value.split(":")
    if len(octets) > max_len:
        octets = octets[:max_len]
    while len(octets) < min_len:
        octets.append("00")
    return ":".join(octets)


def _bundle_objects(settings: Settings) -> list[dict[str, Any]]:
    """Generate default simulator objects from the active bundle when custom_data is empty."""
    from app.services.bundle_state import get_bundle
    bundle = get_bundle()
    if bundle is None:
        return []

    objects: list[dict[str, Any]] = []
    for mod_name, mod_record in bundle.modules.items():
        for node_name, node in mod_record.objects.items():
            if not hasattr(node, 'nodetype') or not hasattr(node, 'oid'):
                continue
            if node.nodetype not in ("scalar", "column"):
                continue
            if getattr(node, 'max_access', None) == 'not-accessible':
                continue
            if getattr(node, 'status', None) in ('obsolete', 'deprecated'):
                continue

            from trishul_snmp.mib.registry import oid_to_string
            oid_str = oid_to_string(node.oid)
            syntax = getattr(node, 'syntax', None)

            if node.nodetype == "scalar":
                objects.append({
                    "target": f"{oid_str}.0",
                    "value": _default_value_for_syntax(syntax, node_name, index=0, node=node, bundle=bundle),
                })
            else:
                is_index_col = "index" in node_name.lower()
                for i in range(1, _BUNDLE_OBJECTS_TABLE_ROWS + 1):
                    if is_index_col:
                        value = {"type": "integer", "value": i}
                    else:
                        value = _default_value_for_syntax(syntax, node_name, index=i, node=node, bundle=bundle)
                    objects.append({"target": f"{oid_str}.{i}", "value": value})

    return objects


async def get_status(*, state: StateStore, runtime_service) -> dict[str, Any]:
    # SIM-13: prefer the lightweight responder status accessor over the full
    # runtime state, which serializes every configured object and rule that
    # the status payload discards.
    get_responder_status = getattr(runtime_service, "get_responder_status", None)
    if callable(get_responder_status):
        responder = await get_responder_status()
    else:
        runtime_state = await runtime_service.get_state()
        responder = runtime_state["responder"]
    communities = responder.get("communities") or []
    snap = state.snapshot()
    saved_port = state.coerce_port(snap.get(_SIMULATOR_PORT_KEY), default=1061)
    saved_community = state.coerce_community(snap.get(_SIMULATOR_COMMUNITY_KEY), default="public")
    return {
        "running": bool(responder["running"]),
        "port": responder.get("port") or saved_port,
        "community": communities[0] if communities else saved_community,
        "pid": os.getpid() if responder["running"] else None,
        "uptime_seconds": state.uptime_seconds(_SIMULATOR_STARTED_AT_KEY) if responder["running"] else None,
        "requests": int(responder.get("request_count") or 0),
        "last_activity": responder.get("last_activity"),
        "restart_required": bool(responder.get("restart_required")),
    }


async def start(
    *, port: int, community: str, settings: Settings, state: StateStore, runtime_service
) -> dict[str, Any]:
    from app.services.runtime import RuntimeServiceError
    from app.services.bundle_state import get_bundle
    active_bundle = get_bundle()
    custom, custom_warning = load_custom_data(settings)
    bundle_objs = _bundle_objects(settings)
    warnings: list[str] = []
    if custom_warning:
        warnings.append(custom_warning)
        _log(f"Simulator custom data warning: {custom_warning}", settings, level="WARNING")
    if custom:
        # Merge: bundle objects form the base, custom data overrides specific OIDs.
        # Type is inherited from the bundle for each target; stale invalid values
        # are skipped with a warning so a bad custom_data.json cannot block start.
        obj_map: dict[str, dict[str, Any]] = {o["target"]: o for o in bundle_objs}
        custom_objects, warnings = _runtime_objects_from_custom_data(custom, bundle=active_bundle)
        for warning in warnings:
            _log(f"Simulator custom data warning: {warning}", settings, level="WARNING")
        for o in custom_objects:
            obj_map[o["target"]] = o
        objects = list(obj_map.values())
        source = "merged"
    else:
        objects = bundle_objs
        source = "bundle"
    try:
        await runtime_service.start_responder(
            host="0.0.0.0",
            port=port,
            communities=[community],
            objects=objects,
        )
    except RuntimeServiceError as exc:
        _log(f"Simulator start failed on UDP {port}: {exc}", settings, level="ERROR")
        raise SimulatorError(str(exc)) from exc
    state.set_value(_SIMULATOR_PORT_KEY, int(port))
    state.set_value(_SIMULATOR_COMMUNITY_KEY, str(community))
    state.set_value(_SIMULATOR_STARTED_AT_KEY, datetime.now(timezone.utc).isoformat())
    _log(f"Simulator started on UDP {port} community={community} objects={len(objects)} source={source}", settings)
    await broadcast_status(settings=settings)
    await broadcast_stats(settings=settings)
    payload: dict[str, Any] = {
        "status": "started",
        "message": "Simulator started successfully.",
        "port": port,
        "community": community,
    }
    if warnings:
        payload["custom_data_warnings"] = warnings
    return payload


async def stop(*, settings: Settings, state: StateStore, runtime_service) -> dict[str, Any]:
    from app.services.runtime import RuntimeServiceError
    try:
        await runtime_service.stop_responder()
    except RuntimeServiceError as exc:
        _log(f"Simulator stop failed: {exc}", settings, level="ERROR")
        raise SimulatorError(str(exc)) from exc
    state.set_value(_SIMULATOR_STARTED_AT_KEY, None)
    _log("Simulator stopped.", settings)
    await broadcast_status(settings=settings)
    await broadcast_stats(settings=settings)
    return {"status": "stopped", "message": "Simulator stopped successfully."}


async def restart(*, settings: Settings, state: StateStore, runtime_service) -> dict[str, Any]:
    current = await get_status(state=state, runtime_service=runtime_service)
    port = int(current["port"] or 1061)
    community = str(current["community"] or "public")
    await stop(settings=settings, state=state, runtime_service=runtime_service)
    return await start(port=port, community=community, settings=settings, state=state, runtime_service=runtime_service)


def get_custom_data(*, settings: Settings) -> dict[str, Any]:
    return load_custom_data(settings)[0]


async def save_custom_data(
    payload: Any, *, settings: Settings, runtime_service
) -> dict[str, Any]:
    from app.services.bundle_state import get_bundle
    from app.services.runtime import RuntimeServiceError
    if not isinstance(payload, dict):
        raise SimulatorError("Custom data must be a JSON object mapping OIDs or symbolic targets to values.")
    # Merge with bundle objects — same logic as start(), but invalid entries
    # are rejected here so bad data cannot be persisted.
    active_bundle = get_bundle()
    bundle_objs = _bundle_objects(settings)
    obj_map: dict[str, dict[str, Any]] = {o["target"]: o for o in bundle_objs}
    custom_objects, _warnings = _runtime_objects_from_custom_data(
        payload,
        bundle=active_bundle,
        reject_invalid=True,
    )
    for o in custom_objects:
        obj_map[o["target"]] = o
    merged_objects = list(obj_map.values())
    try:
        await runtime_service.set_responder_objects(objects=merged_objects, replace=True)
    except RuntimeServiceError as exc:
        _log(f"Failed to apply custom simulator data: {exc}", settings, level="ERROR")
        raise SimulatorError(str(exc)) from exc
    path = settings.config_dir / "custom_data.json"
    try:
        path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    except OSError as exc:
        raise SimulatorError(f"Failed to persist custom data: {exc}") from exc
    n = len(payload)
    _log(f"Custom simulator data saved with {n} override{'s' if n != 1 else ''}.", settings)
    await broadcast_stats(settings=settings)
    return {"status": "saved", "message": f"Custom data stored ({n} override{'s' if n != 1 else ''})."}


async def get_logs(*, limit: int = 200, runtime_service) -> dict[str, Any]:
    from app.services.runtime import RuntimeServiceError
    try:
        return await runtime_service.list_simulator_activity(limit=limit)
    except RuntimeServiceError as exc:
        raise SimulatorError(str(exc)) from exc


async def clear_logs(*, runtime_service) -> dict[str, Any]:
    from app.services.runtime import RuntimeServiceError
    try:
        return await runtime_service.clear_simulator_activity()
    except RuntimeServiceError as exc:
        raise SimulatorError(str(exc)) from exc
