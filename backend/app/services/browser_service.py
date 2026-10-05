from __future__ import annotations

from typing import Any

from trishul_snmp import MibBundle
from trishul_snmp.errors import (
    InvalidOidError,
    UnknownOidError,
    UnknownSymbolError,
)
from trishul_snmp.mib.models import MibNode
from trishul_snmp.mib.registry import oid_to_string, parse_oid

from app.services.mib_metadata import enum_map, enum_values, input_type_for_syntax


def _normalize_optional_filter(value: str | None) -> str | None:
    normalized = str(value or "").strip()
    return normalized or None


def _ui_type(node: MibNode) -> str:
    """Map MIB object_type/nodetype to the UI type label the frontend expects."""
    ot = (node.object_type or "").strip().upper()
    nt = (node.nodetype or "").strip().lower()
    if ot in ("NOTIFICATION-TYPE", "TRAP-TYPE"):
        return "NotificationType"
    if ot == "OBJECT-GROUP":
        return "ObjectGroup"
    if ot == "MODULE-COMPLIANCE":
        return "ModuleCompliance"
    if ot == "MODULE-IDENTITY":
        # BRW-05: module identities are not compliances — give them their own
        # label so the badge/icon don't mislead.
        return "ModuleIdentity"
    if nt == "table":
        return "MibTable"
    if nt == "row":
        return "MibTableRow"
    if nt == "column":
        return "MibTableColumn"
    if nt == "scalar":
        return "MibScalar"
    # OBJECT-TYPE with no nodetype, OBJECT IDENTIFIER, etc.
    return ot or nt or "Node"


def _node_to_record(node: MibNode) -> dict[str, Any]:
    oid_str = oid_to_string(node.oid) if node.oid else ""
    return {
        "entry_type": "notification" if node.object_type in ("NOTIFICATION-TYPE", "TRAP-TYPE") else "object",
        "name": node.name,
        "full_name": f"{node.module}::{node.name}",
        "module": node.module,
        "oid": oid_str,
        "oid_tuple": node.oid,
        "type": _ui_type(node),
        "syntax": node.syntax,
        "access": node.max_access,
        "status": node.status,
        "description": node.description or "",
        "indexes": list(node.index or []),
        "members": [
            {"module": m.module, "name": m.object}
            for m in (node.members or [])
        ],
        "constraints": node.constraints,
        "enums": enum_map(node),
        "units": node.units,
    }


def resolve(value: str, *, mode: str = "numeric", bundle: MibBundle | None) -> dict[str, Any]:
    if bundle is None:
        return {"input": value, "output": value, "resolved": False}
    normalized = value.strip()
    if not normalized:
        return {"input": value, "output": value, "resolved": False}

    # Try symbolic MODULE::symbol resolution
    if "::" in normalized:
        try:
            oid_tuple = bundle.resolve(normalized)
            if mode == "symbolic":
                output = normalized
            else:
                output = oid_to_string(oid_tuple)
            return {"input": value, "output": output, "resolved": True}
        except (UnknownSymbolError, UnknownOidError):
            pass

    # Try numeric OID lookup
    try:
        match = bundle.lookup(normalized)
        if mode == "symbolic":
            output = bundle.display_symbolic_from_match(match)
        else:
            output = oid_to_string(match.oid)
        return {"input": value, "output": output, "resolved": True}
    # BRW-04: only the expected lookup misses are graceful; real errors
    # (storage, codec, ...) must surface instead of being swallowed.
    except (UnknownOidError, InvalidOidError):
        pass

    # Try name-only search fallback
    results = bundle.search(normalized, limit=1)
    if results:
        node = results[0]
        oid_str = oid_to_string(node.oid)
        if mode == "symbolic":
            output = f"{node.module}::{node.name}"
        else:
            output = oid_str
        return {"input": value, "output": output, "resolved": True}

    return {"input": value, "output": value, "resolved": False}


def get_modules(*, bundle: MibBundle | None) -> dict[str, Any]:
    if bundle is None:
        return {"modules": []}
    modules = []
    for mod_name, mod_record in bundle.modules.items():
        notif_count = len(mod_record.notifications)
        obj_count = len(mod_record.objects)
        modules.append({
            "name": mod_name,
            "objects": obj_count,
            "notifications": notif_count,
        })
    modules.sort(key=lambda m: m["name"])
    return {"modules": modules}


def _build_children_by_parent(
    nodes: list,
) -> dict[tuple, list]:
    """Map each OID tuple to its direct children (one arc deeper)."""
    oid_set = {n.oid for n in nodes}
    children: dict[tuple, list] = {}
    for node in nodes:
        parent = node.oid[:-1]
        # Walk up to find the nearest parent that is also in the node set
        while parent and parent not in oid_set:
            parent = parent[:-1]
        children.setdefault(parent, []).append(node)
    return children


def get_module_tree(
    *,
    module: str | None,
    type_filter: str | None,
    bundle: MibBundle | None,
) -> dict[str, Any]:
    module = _normalize_optional_filter(module)
    type_filter = _normalize_optional_filter(type_filter)
    if bundle is None:
        return {"modules": [], "count": 0}

    mod_names = [module] if module else sorted(bundle.modules.keys())
    result_modules = []
    total_nodes = 0
    for mod_name in mod_names:
        nodes = list(bundle.iter_objects(module=mod_name))
        nodes += list(bundle.iter_notifications(module=mod_name))
        if type_filter:
            nodes = [n for n in nodes if _ui_type(n) == type_filter]
        if not nodes:
            continue
        total_nodes += len(nodes)
        nodes.sort(key=lambda n: n.oid)

        oid_set = {n.oid for n in nodes}
        children_by_parent = _build_children_by_parent(nodes)

        # Top-level nodes: those whose parent OID is not in this module's node set
        top_level = [n for n in nodes if n.oid[:-1] not in oid_set]

        def make_node(n) -> dict[str, Any]:
            record = _node_to_record(n)
            record["has_children"] = bool(children_by_parent.get(n.oid))
            return record

        result_modules.append({
            "name": mod_name,
            "module": mod_name,
            "oid": oid_to_string(nodes[0].oid) if nodes else "",
            "type": "Module",
            # BRW-14: per-module object count (post-filter) so the module
            # row badge can report objects, not just top-level roots.
            "object_count": len(nodes),
            "children": [make_node(n) for n in top_level],
        })

    return {
        "modules": result_modules,
        # BRW-14: the count badge reports every object/notification in view,
        # not just the top-level roots shown collapsed.
        "count": total_nodes,
    }


def get_oid_tree(
    *,
    root_oid: str,
    depth: int = 1,
    module: str | None,
    type_filter: str | None,
    bundle: MibBundle | None,
) -> dict[str, Any]:
    module = _normalize_optional_filter(module)
    type_filter = _normalize_optional_filter(type_filter)
    if bundle is None:
        return {"root": None, "children": [], "total_descendants": 0}

    try:
        root_tuple = parse_oid(root_oid)
    except Exception:
        return {"root": None, "children": [], "total_descendants": 0}

    # Find root node
    root_node = None
    try:
        match = bundle.lookup(root_tuple)
        root_node = bundle.resolve_node(match.module, match.symbol)
    except (UnknownOidError, InvalidOidError):
        pass

    root_record = _node_to_record(root_node) if root_node else {
        "oid": root_oid, "oid_tuple": root_tuple, "name": root_oid, "full_name": root_oid,
        "module": "", "type": "", "entry_type": "object",
    }

    # Collect direct children (one level below root)
    all_nodes = list(bundle.iter_objects(module=module))
    all_nodes += list(bundle.iter_notifications(module=module))
    if type_filter:
        all_nodes = [n for n in all_nodes if _ui_type(n) == type_filter]

    prefix_len = len(root_tuple)
    # BRW-03: one pass over the node set. Direct children become records;
    # deeper nodes mark their child-level ancestor so has_children is a set
    # lookup instead of a re-scan of every node per child.
    children: list[MibNode] = []
    parents_with_descendants: set[tuple] = set()
    descendants = 0
    for n in all_nodes:
        if n.oid[:prefix_len] != root_tuple or len(n.oid) <= prefix_len:
            continue
        descendants += 1
        if len(n.oid) > prefix_len + 1:
            parents_with_descendants.add(n.oid[: prefix_len + 1])
            continue
        children.append(n)

    child_records = []
    for n in children:
        record = _node_to_record(n)
        record["has_children"] = n.oid in parents_with_descendants
        child_records.append(record)
    child_records.sort(key=lambda r: r["oid"])

    return {
        "root": root_record,
        "children": child_records,
        "total_descendants": descendants,
    }


_UI_TYPE_TO_OBJECT_TYPE: dict[str, str] = {
    "NotificationType": "NOTIFICATION-TYPE",
    "MibScalar": "OBJECT-TYPE",
    "MibTable": "OBJECT-TYPE",
    "MibTableRow": "OBJECT-TYPE",
    "MibTableColumn": "OBJECT-TYPE",
    "ObjectGroup": "OBJECT-GROUP",
    "ModuleCompliance": "MODULE-COMPLIANCE",
    "ModuleIdentity": "MODULE-IDENTITY",
}


def search_bundle(
    *,
    query: str,
    module: str | None,
    type_filter: str | None,
    limit: int = 100,
    bundle: MibBundle | None,
) -> dict[str, Any]:
    module = _normalize_optional_filter(module)
    type_filter = _normalize_optional_filter(type_filter)
    if bundle is None:
        return {"results": [], "count": 0}
    # Translate UI type label to raw object_type for the bundle search
    raw_type_filter = _UI_TYPE_TO_OBJECT_TYPE.get(type_filter or "", type_filter) if type_filter else None
    # The raw filter is many-to-one (four UI types map to OBJECT-TYPE), so the
    # first page of raw matches can be dominated by nodes of the wrong UI
    # type. Grow the fetch window until enough post-filter matches are
    # collected or the underlying search is exhausted.
    post_filter_type = (
        type_filter
        if type_filter in {"MibScalar", "MibTable", "MibTableRow", "MibTableColumn"}
        else None
    )

    nodes: list[MibNode] = []
    if post_filter_type:
        fetch_limit = limit * 2
        max_fetch_limit = max(limit * 10, 1000)
        while True:
            nodes = bundle.search(query, module=module, type_filter=raw_type_filter, limit=fetch_limit)
            matches = [n for n in nodes if _ui_type(n) == post_filter_type]
            if len(matches) >= limit or len(nodes) < fetch_limit:
                nodes = matches
                break
            if fetch_limit >= max_fetch_limit:
                nodes = matches
                break
            fetch_limit = min(fetch_limit * 4, max_fetch_limit)
    else:
        nodes = bundle.search(query, module=module, type_filter=raw_type_filter, limit=limit)
    results = [_node_to_record(n) for n in nodes[:limit]]
    results.sort(key=lambda r: (r["module"], r["name"]))
    return {"results": results, "count": len(results)}


def _input_type_for_syntax(syntax: str | None) -> str:
    """Delegate to the canonical mapping in ``mib_metadata``."""
    return input_type_for_syntax(syntax)


def _member_entry(member, bundle: MibBundle) -> dict[str, Any]:
    """Build a rich varbind descriptor for a notification member."""
    mod = str(getattr(member, "module", "") or "").strip()
    obj = str(getattr(member, "object", "") or "").strip()
    entry: dict[str, Any] = {
        "name": obj,
        "full_name": f"{mod}::{obj}" if mod and obj else obj,
        "module": mod,
        "oid": "",
        "syntax": "",
        "input_type": "String",
    }
    try:
        node = bundle.resolve_node(mod, obj)
        if node is not None:
            entry["oid"] = oid_to_string(node.oid) if node.oid else ""
            entry["syntax"] = node.syntax or ""
            entry["input_type"] = _input_type_for_syntax(node.syntax)
            entry["constraint"] = node.constraints
            enum_vals = enum_values(node)
            if enum_vals:
                entry["enum_values"] = enum_vals
    except Exception:
        pass
    return entry


def get_trap_catalog(*, bundle: MibBundle | None) -> dict[str, Any]:
    if bundle is None:
        return {"traps": []}
    traps = []
    for node in bundle.iter_notifications():
        oid_str = oid_to_string(node.oid) if node.oid else ""
        objects = [_member_entry(m, bundle) for m in (node.members or [])]
        traps.append({
            "name": node.name,
            "full_name": f"{node.module}::{node.name}",
            "oid": oid_str,
            "module": node.module,
            "description": node.description or "",
            "objects": objects,
        })
    return {"traps": sorted(traps, key=lambda t: (t["module"], t["name"]))}


def get_node(oid: str, *, module: str | None, bundle: MibBundle | None) -> dict[str, Any]:
    if bundle is None:
        return {"node": None, "breadcrumb": [], "trap_objects": []}

    node = None
    # Try MODULE::symbol format
    if "::" in oid:
        parts = oid.split("::", 1)
        node = bundle.resolve_node(parts[0], parts[1].split(".")[0])
    if node is None:
        try:
            match = bundle.lookup(oid)
            node = bundle.resolve_node(match.module, match.symbol)
        except (UnknownOidError, InvalidOidError):
            pass

    node_record = _node_to_record(node) if node else None

    # Build breadcrumb from OID parents
    breadcrumb: list[dict[str, Any]] = []
    if node:
        for i in range(1, len(node.oid)):
            prefix = node.oid[:i]
            try:
                m = bundle.lookup(prefix)
                parent = bundle.resolve_node(m.module, m.symbol)
                if parent:
                    breadcrumb.append({
                        "oid": oid_to_string(prefix),
                        "name": parent.name,
                        "full_name": f"{parent.module}::{parent.name}",
                        "module": parent.module,
                    })
            except (UnknownOidError, InvalidOidError):
                pass

    # Trap objects (notification members)
    trap_objects: list[dict[str, Any]] = []
    if node and node.object_type in ("NOTIFICATION-TYPE", "TRAP-TYPE") and node.members:
        for member in node.members:
            trap_objects.append(_member_entry(member, bundle))

    return {
        "node": node_record,
        "breadcrumb": breadcrumb,
        "trap_objects": trap_objects,
    }
