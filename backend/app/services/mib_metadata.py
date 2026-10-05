"""Shared enum/units metadata helpers for MIB nodes.

This module is the only place in the suite that interprets ``constraints`` as
an enumeration. New bundles carry the ``enums`` field (label→number map) on the
node; older bundles (pre-0.5.2 producers) expose enum/bits data only through
``constraints``. Both shapes are normalized here to a single label→number map.
"""
from __future__ import annotations

from typing import Any

_CONSTRAINT_ENUM_KINDS = ("enum", "bits")


def effective_constraints(node, *, bundle=None) -> Any:
    """Return *node*'s constraints, falling back to its type record's constraints.

    Type-level constraints (e.g. DisplayString's size) are resolved through the
    bundle so defaults and validation agree on the same effective bounds.
    """
    constraints = getattr(node, "constraints", None)
    if constraints is None and bundle is not None:
        syntax = getattr(node, "syntax", None)
        module = getattr(node, "module", None)
        if syntax and module:
            try:
                type_record = bundle.resolve_type(module, syntax)
            except Exception:
                type_record = None
            if type_record is not None:
                constraints = getattr(type_record, "constraints", None)
    return constraints


def enum_map(node) -> dict[str, int] | None:
    """Label→number map for *node*, from its ``enums`` field or enum/bits constraints."""
    raw_enums = getattr(node, "enums", None)
    if raw_enums:
        return dict(raw_enums)
    return _constraint_enum_map(getattr(node, "constraints", None))


def enum_values(node) -> list[dict[str, Any]]:
    """Dropdown shape ``[{label, value}]`` built on :func:`enum_map`."""
    mapping = enum_map(node)
    if not mapping:
        return []
    return [{"label": label, "value": value} for label, value in mapping.items()]


def first_enum_value(node) -> int | None:
    """First integer enum value for *node*, used as the simulator default.

    Only INTEGER enums qualify. BITS objects carry the same label→number map
    shape but their wire value is an octet string, so BITS nodes must be
    routed through :func:`is_bits_node` and never through this integer default.
    """
    mapping = enum_map(node)
    if not mapping:
        return None
    for value in mapping.values():
        if isinstance(value, int):
            return value
    return None


def is_bits_node(node, *, bundle=None) -> bool:
    """True when *node* is BITS-typed.

    BITS objects declare their label→bit map like enums, but the value they
    serve is an octet string. Detected from the node's syntax, its effective
    constraints (kind ``bits``), or the type record's ``base_type`` on new
    bundles.
    """
    if getattr(node, "syntax", None) == "BITS":
        return True
    constraints = effective_constraints(node, bundle=bundle)
    if isinstance(constraints, dict) and constraints.get("kind") == "bits":
        return True
    syntax = getattr(node, "syntax", None)
    module = getattr(node, "module", None)
    if bundle is not None and syntax and module:
        try:
            type_record = bundle.resolve_type(module, syntax)
        except Exception:
            type_record = None
        if type_record is not None and getattr(type_record, "base_type", None) == "BITS":
            return True
    return False


def range_bounds(constraints: Any) -> list[tuple[int, int]] | None:
    """Declared [min, max] pairs from a range constraint (or nested in a union)."""
    return _bounds_for_kind(constraints, "range")


def size_bounds(constraints: Any) -> list[tuple[int, int]] | None:
    """Declared [min, max] length pairs from a size constraint (or nested in a union)."""
    return _bounds_for_kind(constraints, "size")


def constraint_violation(value: Any, constraints: Any) -> str | None:
    """Return an actionable error message when *value* violates *constraints*.

    Handles ``range`` (integers), ``size`` (bytes/strings), and ``union``
    (value must satisfy at least one alternative) constraint kinds.
    """
    if not isinstance(constraints, dict):
        return None
    kind = constraints.get("kind")
    data = constraints.get("data")
    if kind == "range":
        if not isinstance(value, int) or isinstance(value, bool):
            return None
        return _bounds_violation(value, _bounds_pairs(data), label="range")
    if kind == "size":
        length = _value_length(value)
        if length is None:
            return None
        return _bounds_violation(length, _bounds_pairs(data), label="size")
    if kind == "union" and isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            if constraint_violation(value, item) is None:
                return None
        return "value does not satisfy any declared constraint alternative"
    return None


def _bounds_for_kind(constraints: Any, kind: str) -> list[tuple[int, int]] | None:
    if not isinstance(constraints, dict):
        return None
    data = constraints.get("data")
    if constraints.get("kind") == kind and isinstance(data, list):
        return _bounds_pairs(data) or None
    if constraints.get("kind") == "union" and isinstance(data, list):
        pairs: list[tuple[int, int]] = []
        for item in data:
            if isinstance(item, dict) and item.get("kind") == kind:
                pairs.extend(_bounds_pairs(item.get("data")))
        return pairs or None
    return None


def _bounds_pairs(data: Any) -> list[tuple[int, int]]:
    pairs: list[tuple[int, int]] = []
    if not isinstance(data, list):
        return pairs
    for item in data:
        if (
            isinstance(item, (list, tuple))
            and len(item) == 2
            and isinstance(item[0], int)
            and isinstance(item[1], int)
            and not isinstance(item[0], bool)
            and not isinstance(item[1], bool)
        ):
            pairs.append((item[0], item[1]))
    return pairs


def _bounds_violation(value: int, pairs: list[tuple[int, int]], *, label: str) -> str | None:
    if not pairs:
        return None
    if any(low <= value <= high for low, high in pairs):
        return None
    display = ", ".join(f"{low}..{high}" for low, high in pairs)
    prefix = "value length" if label == "size" else "value"
    return f"{prefix} {value} is outside the declared {label} {display}"


def _value_length(value: Any) -> int | None:
    if isinstance(value, (bytes, bytearray)):
        return len(value)
    if isinstance(value, str):
        return len(value.encode("utf-8"))
    return None


def _constraint_enum_map(constraints: Any) -> dict[str, int] | None:
    if not isinstance(constraints, dict) or constraints.get("kind") not in _CONSTRAINT_ENUM_KINDS:
        return None
    data = constraints.get("data")
    if not isinstance(data, list):
        return None

    result: dict[str, int] = {}
    for item in data:
        if isinstance(item, (list, tuple)) and len(item) == 2:
            label, value = item[0], item[1]
        elif isinstance(item, dict):
            label = item.get("name") or item.get("label") or item.get("symbol") or ""
            value = item.get("value")
        else:
            continue
        if isinstance(label, str) and label.strip() and isinstance(value, int):
            result[label] = value
    return result or None


def input_type_for_syntax(syntax: str | None) -> str:
    """Map a MIB syntax string to the varbind type label the trap sender UI expects.

    Canonical implementation shared by the MIB objects route, the trap catalog,
    and the browser member payload. INTEGER/Counter/Gauge/TimeTicks syntaxes
    must map to their numeric types so picker-added varbinds default to the
    correct type (and constraint validation can fire).
    """
    normalized = (syntax or "").split("(")[0].strip()
    lowered = normalized.lower().replace("-", "")
    if normalized in ("OBJECT IDENTIFIER", "AutonomousType") or lowered == "objectidentifier":
        return "OID"
    if "ipaddress" in lowered or "inetaddress" in lowered:
        return "IpAddress"
    if "timeticks" in lowered or "timestamp" in lowered:
        return "TimeTicks"
    if "counter64" in lowered or "counter" in lowered:
        return "Counter"
    if "gauge" in lowered or "unsigned" in lowered:
        return "Gauge"
    if "integer" in lowered or "truthvalue" in lowered or "rowstatus" in lowered or "interfaceindex" in lowered:
        return "Integer"
    return "String"