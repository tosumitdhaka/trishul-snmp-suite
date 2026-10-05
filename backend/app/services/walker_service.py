"""SNMP walk execution and result formatting service."""
from __future__ import annotations

import logging
import re
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any

from app.core.config import Settings
from app.core.logging import emit_backend_log
from app.services.state_store import (
    StateStore,
    _WALK_OIDS_RETURNED_KEY,
    _WALKS_EXECUTED_KEY,
)
from app.services.realtime import broadcast_stats


class WalkerError(RuntimeError):
    pass


logger = logging.getLogger(__name__)

_INTEGER_INDEX_SYNTAX_MARKERS = (
    "integer",
    "interfaceindex",
    "rowstatus",
    "truthvalue",
    "counter",
    "gauge",
    "timeticks",
)

# Conservative whitelist of octet-string-style index syntaxes. Any syntax that
# is neither clearly integer nor clearly string (e.g. an integer TC like
# InetAddressType) is not decoded — the heuristic fallback applies instead.
_STRING_INDEX_SYNTAX_MARKERS = (
    "octetstring",
    "displaystring",
    "snmpadminstring",
    "physaddress",
    "macaddress",
    "datandtime",
    "printablestring",
    "ia5string",
    "utf8string",
    "string",
)


def _raw_value(entry: dict[str, Any]) -> Any:
    v = entry.get("value")
    if isinstance(v, dict):
        if "value" in v:
            return v.get("value")
        if "display" in v:
            return v.get("display")
    return entry.get("display_value")


def _extract_value(entry: dict[str, Any]) -> Any:
    if entry.get("display_value") is not None:
        return entry.get("display_value")
    return _raw_value(entry)


def _walk_item(entry: dict[str, Any], *, use_mibs: bool) -> dict[str, Any]:
    # Raw value in the payload; enum_label/units ride along as enrichment so
    # the UI can render the badge next to the raw value instead of duplicating
    # the label already embedded in display_value.
    value = _raw_value(entry)
    if use_mibs:
        return {
            "oid": entry["oid"],
            "symbolic": entry.get("symbolic") or entry["oid"],
            "type": entry.get("value_type"),
            "value": value,
            "enum_label": entry.get("enum_label"),
            "units": entry.get("units"),
        }
    return {
        "oid": entry["oid"],
        "type": entry.get("value_type"),
        "value": value,
        "enum_label": entry.get("enum_label"),
        "units": entry.get("units"),
    }


def _walk_line(entry: dict[str, Any], *, use_mibs: bool) -> str:
    label = (entry.get("symbolic") or entry["oid"]) if use_mibs else entry["oid"]
    return f"{label} = {_extract_value(entry)}"


# Whole words that mark a numeric object as an identifier/label rather than a
# measurement. Matched against camelCase-split words only — substring matching
# misclassified names like "ifVideoBitRate" or "ifWidth" (both contain "id").
_LABEL_WORD_MARKERS = frozenset({
    "index",
    "indices",
    "id",
    "ids",
    "identifier",
    "identifiers",
    "name",
    "descr",
    "description",
    "serial",
    "mac",
    "type",
    "version",
    "status",
    "address",
    "addr",
    "phys",
    "physical",
})


def _name_words(object_name: str) -> set[str]:
    """Split a MIB object name into lowercase words.

    "ifPhysAddress" -> {"if", "phys", "address"}; acronym-led names split on
    the acronym boundary too ("sysORDIndex" -> {"sys", "ord", "index"});
    "dot1dStpPort" keeps the leading "dot1d" token intact.
    """
    text = str(object_name or "").strip()
    if not text:
        return set()
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    spaced = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", spaced)
    return {word.lower() for word in re.split(r"[^A-Za-z0-9]+", spaced) if word}


def _value_is_metric(object_name: str, value_type: str, value: Any) -> bool:
    del value
    if value_type not in {"integer", "counter32", "counter64", "gauge32", "timeticks"}:
        return False
    return not (_name_words(object_name) & _LABEL_WORD_MARKERS)


def _metric_value(value_type: str, value: Any) -> int | float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        numeric = float(value)
    else:
        text = str(value).strip()
        if not text:
            return None
        m = re.search(r"(-?\d+)", text)
        if m is None:
            return None
        numeric = float(m.group(1))
    if value_type == "timeticks":
        numeric /= 100.0
    return int(numeric) if float(numeric).is_integer() else numeric


def _is_integer_index_syntax(syntax: str) -> bool:
    normalized = syntax.lower().replace("-", "").replace(" ", "")
    return any(marker in normalized for marker in _INTEGER_INDEX_SYNTAX_MARKERS)


def _is_string_index_syntax(syntax: str) -> bool:
    normalized = syntax.lower().replace("-", "").replace(" ", "")
    return any(marker in normalized for marker in _STRING_INDEX_SYNTAX_MARKERS)


def _index_context_for_object(
    bundle: Any,
    module_name: str,
    object_name: str,
) -> tuple[tuple[int, ...] | None, list[dict[str, str]], str] | None:
    """Resolve one walked object to its row-identity and index columns.

    Returns ``(column_oid, index_columns, row_key)`` where ``column_oid`` is
    None for scalars, ``index_columns`` are ``{"name", "syntax"}`` descriptors
    from the owning row's ``index`` list, and ``row_key`` is a stable
    row-identity string used to scope grouped rows. Per-object resolution
    (instead of resolving only the walk root) keeps index-aware decoding
    working for table/MIB-root walks, and the row-key scoping stops rows from
    different tables (or distinct scalars) merging into mega-rows (WLK-04).
    Returns None when the object does not resolve to a column/scalar node —
    the heuristic fallback applies.
    """
    try:
        node = bundle.resolve_node(module_name, object_name)
    except Exception:
        return None
    if node is None or len(node.oid) < 2:
        return None
    if node.nodetype == "scalar":
        return None, [], f"{module_name}::{object_name}"
    if node.nodetype != "column":
        return None
    row_oid = node.oid[:-1]
    try:
        row_match = bundle.lookup(row_oid)
        row_node = bundle.resolve_node(row_match.module, row_match.symbol)
    except Exception:
        return None
    if row_node is None or not row_node.index:
        return None
    columns: list[dict[str, str]] = []
    for index_name in row_node.index:
        try:
            index_node = bundle.resolve_node(row_match.module, index_name)
        except Exception:
            index_node = None
        if index_node is None:
            return None
        columns.append({
            "name": str(index_name),
            "syntax": (index_node.syntax or "").split("(")[0].strip(),
        })
    return tuple(node.oid), columns, f"{row_match.module}::{row_match.symbol}"


def _decode_instance_index(
    oid_str: str,
    column_oid: tuple[int, ...],
    index_columns: list[dict[str, str]],
) -> str | None:
    """Decode a varbind OID suffix into an instance index key.

    Integer index columns consume one sub-identifier each; octet-string index
    columns consume the remaining sub-identifiers as bytes (trailing position).
    Returns None when the suffix cannot be decoded against the index list.
    """
    try:
        parts = [int(part) for part in oid_str.strip().lstrip(".").split(".") if part]
    except ValueError:
        return None
    if len(parts) <= len(column_oid) or parts[: len(column_oid)] != list(column_oid):
        return None
    suffix = parts[len(column_oid):]
    decoded: list[str] = []
    position = 0
    for column in index_columns:
        syntax = str(column.get("syntax") or "").strip()
        if _is_integer_index_syntax(syntax):
            if position >= len(suffix):
                return None
            decoded.append(str(suffix[position]))
            position += 1
        elif not _is_string_index_syntax(syntax):
            return None
        else:
            remaining = suffix[position:]
            position = len(suffix)
            if not remaining:
                decoded.append("")
            else:
                try:
                    decoded.append(bytes(remaining).decode("utf-8", errors="replace"))
                except (ValueError, TypeError):
                    return None
    if position != len(suffix):
        return None
    return ".".join(decoded)


def _walk_compat_items(
    varbinds: list[dict[str, Any]],
    *,
    target_host: str,
    root_oid: str,
    use_mibs: bool,
) -> list[dict[str, Any]]:
    category = root_oid.split("::", 1)[1] if "::" in root_oid else root_oid
    timestamp = int(datetime.now(timezone.utc).timestamp())
    rows: OrderedDict[str, dict[str, Any]] = OrderedDict()
    bundle = None
    if use_mibs:
        from app.services.bundle_state import get_bundle

        bundle = get_bundle()
    context_cache: dict[
        tuple[str, str],
        tuple[tuple[int, ...] | None, list[dict[str, str]], str] | None,
    ] = {}
    for entry in varbinds:
        symbolic = str(entry.get("symbolic") or "").strip()
        oid = str(entry.get("oid") or "").strip()
        label = symbolic if use_mibs and symbolic else oid
        if not label:
            continue
        module_name, object_name, index = "Unknown", label, "0"
        remainder = label
        if "::" in label:
            module_name, remainder = label.split("::", 1)
            module_name = module_name.strip() or "Unknown"
            remainder = remainder.strip()
        # Bare numeric label: symbolic resolution failed (WLK-01). Split on
        # the LAST sub-identifier so the column prefix stays the object name
        # and the instance tail becomes the index — first-dot splitting
        # produced garbage rows like metric_name="1" with the whole OID tail
        # as the instance index.
        numeric_label = "::" not in label and remainder.lstrip(".")[:1].isdigit()
        if "." in remainder:
            if numeric_label:
                object_name, index = remainder.rsplit(".", 1)
            else:
                object_name, index = remainder.split(".", 1)
        elif oid:
            parts = [p for p in oid.split(".") if p]
            if len(parts) > 1:
                object_name = remainder or oid
                index = parts[-1]
        object_name = object_name.strip() or remainder or oid
        row_key: str | None = None
        if bundle is not None and "::" in label and not numeric_label:
            cache_key = (module_name, object_name)
            if cache_key not in context_cache:
                context_cache[cache_key] = _index_context_for_object(
                    bundle, module_name, object_name
                )
            context = context_cache[cache_key]
            if context is not None:
                column_oid, index_columns, context_row_key = context
                if column_oid is not None and index_columns and oid:
                    decoded_index = _decode_instance_index(oid, column_oid, index_columns)
                    if decoded_index is None:
                        logger.info(
                            "Index-aware instance decoding skipped for %s (object=%s); using heuristic",
                            oid,
                            object_name,
                        )
                    else:
                        index = decoded_index
                # Scope the row key to the owning row/scalar so grouped rows
                # from different tables (or distinct scalars) never merge
                # into mega-rows (WLK-04).
                row_key = f"{context_row_key}|{index}"
        index = index.strip() or "0"
        if row_key is None:
            row_key = index
        value = _raw_value(entry)
        value_type = str(entry.get("value_type") or "").strip().lower()
        row = rows.setdefault(row_key, {"index": index, "labels": {}, "metrics": {}})
        if _value_is_metric(object_name, value_type, value):
            mv = _metric_value(value_type, value)
            if mv is None:
                row["labels"][object_name] = value
            else:
                row["metrics"][object_name] = {
                    "value": mv,
                    "module": module_name,
                    "enum_label": entry.get("enum_label"),
                    "units": entry.get("units"),
                }
        else:
            row["labels"][object_name] = value
    output = []
    for row in rows.values():
        labels = dict(row["labels"])
        labels["snmp_index"] = row["index"]
        for metric_name, md in row["metrics"].items():
            output.append({
                "metric_name": metric_name,
                "value": md["value"],
                "mib_module": md["module"],
                "metric_category": category,
                "agent_host": target_host,
                "timestamp": timestamp,
                "labels": labels.copy(),
                "enum_label": md.get("enum_label"),
                "units": md.get("units"),
            })
    return output


async def execute(
    *,
    target: str,
    port: int,
    community: str,
    oid: str,
    parse: bool,
    use_mibs: bool,
    json_format: str = "current",
    timeout_ms: int = 2000,
    retries: int = 1,
    settings: Settings,
    state: StateStore,
    runtime_service,
) -> dict[str, Any]:
    from app.services.runtime import RuntimeServiceError
    raw_format = str(json_format or "flat").strip().lower()
    if raw_format in {"grouped", "metrics"}:
        normalized_format = "grouped"
    else:
        normalized_format = "flat"
    # Defensive clamp: the route validates bounds, direct callers are clamped
    # into the supported window instead of reaching the SNMP engine unbounded.
    timeout_ms = max(500, min(10000, int(timeout_ms if timeout_ms is not None else 2000)))
    retries = max(0, min(5, int(retries if retries is not None else 1)))
    try:
        result = await runtime_service.manager_walk(
            host=target,
            port=port,
            community=community,
            root=oid,
            bulk=True,
            timeout=timeout_ms / 1000.0,
            retries=retries,
        )
    except RuntimeServiceError as exc:
        emit_backend_log(
            f"Walk failed for {target}:{port} root={oid}: {exc}",
            level="ERROR", logger_name="app.operations", settings=settings,
        )
        raise WalkerError(str(exc)) from exc

    varbinds = result.get("varbinds", [])
    state.increment_counter(_WALKS_EXECUTED_KEY, 1)
    state.increment_counter(_WALK_OIDS_RETURNED_KEY, len(varbinds))
    raw_lines = [_walk_line(e, use_mibs=use_mibs) for e in varbinds]
    emit_backend_log(
        f"Walk completed for {target}:{port} root={oid} count={len(varbinds)} "
        f"parse={bool(parse)} use_mibs={bool(use_mibs)} json_format={normalized_format} "
        f"timeout_ms={timeout_ms} retries={retries}",
        logger_name="app.operations", settings=settings,
    )
    await broadcast_stats(settings=settings)

    if parse:
        if normalized_format == "grouped":
            items = _walk_compat_items(varbinds, target_host=target, root_oid=oid, use_mibs=use_mibs)
            if not items and raw_lines:
                return {"mode": "label", "count": len(raw_lines), "data": raw_lines, "rawLines": raw_lines, "json_format": normalized_format}
        else:
            items = [_walk_item(e, use_mibs=use_mibs) for e in varbinds]
        return {"mode": "parsed", "count": len(items), "data": items, "rawLines": raw_lines, "json_format": normalized_format}

    return {"mode": "raw", "count": len(raw_lines), "data": raw_lines, "rawLines": raw_lines, "json_format": normalized_format}
