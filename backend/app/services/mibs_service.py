"""MIB upload, reload, delete, status, export — flat service."""
from __future__ import annotations

from collections import OrderedDict
from io import BytesIO
import json
from datetime import datetime, timezone
from pathlib import Path
import re
from typing import Any
from zipfile import ZIP_DEFLATED, ZipFile

from app.core.config import Settings
from app.core.logging import emit_backend_log
from app.services.bundle_state import get_bundle
from app.services.mib_metadata import enum_values
from app.services.state_store import (
    StateStore,
    _MIB_AUTO_FETCH_KEY,
    _MIB_RELOAD_COUNT_KEY,
    _MIB_REMOTE_SOURCES_KEY,
)


class MibsError(RuntimeError):
    pass


# Module-level source service singleton — caches disk scan results across requests.
# Invalidated (set to None) whenever the upload directory changes.
_source_svc_instance = None


def _invalidate_source_cache() -> None:
    global _source_svc_instance
    _source_svc_instance = None


def _log(message: str, settings: Settings, *, level: str = "INFO") -> None:
    emit_backend_log(message, level=level, logger_name="app.operations", settings=settings)


_EXPORT_SLUG_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _slug_fragment(value: str | None, *, fallback: str) -> str:
    normalized = _EXPORT_SLUG_RE.sub("-", str(value or "").strip())
    normalized = normalized.strip(" ._-").lower()
    return normalized or fallback


def _export_basename(payload: dict[str, Any], *, export_type: str) -> str:
    filters = payload.get("filters") or {}
    metadata = payload.get("metadata") or {}
    notifications = payload.get("notifications") or []
    modules = payload.get("modules") or []
    requested_notifications = filters.get("requested_notifications") or []
    requested_modules = filters.get("requested_modules") or []
    requested_source_groups = filters.get("requested_source_groups") or []

    if export_type in {"notifications", "notification-members"}:
        if len(requested_notifications) == 1:
            notification_name = requested_notifications[0]
        elif len(notifications) == 1:
            notification_name = (
                notifications[0].get("full_name")
                or notifications[0].get("name")
                or "notification"
            )
        else:
            notification_name = ""
        if notification_name:
            export_slug = "notification" if export_type == "notifications" else export_type
            return (
                f"{_slug_fragment(export_slug, fallback='notification')}-"
                f"{_slug_fragment(notification_name, fallback='notification')}"
            )

    if len(requested_modules) == 1:
        scope = requested_modules[0]
    elif len(modules) == 1:
        scope = modules[0].get("module_name") or modules[0].get("name")
    elif len(requested_source_groups) == 1:
        scope = requested_source_groups[0]
    else:
        scope = metadata.get("bundle_label") or metadata.get("bundle_key") or "active-bundle"

    return (
        f"{_slug_fragment(export_type, fallback='catalog')}-"
        f"{_slug_fragment(scope, fallback='active-bundle')}"
    )


def _input_type_for_syntax(syntax: str | None) -> str:
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


def _notification_member_payload(member, *, bundle) -> dict[str, Any]:
    module_name = str(getattr(member, "module", "") or "").strip()
    object_name = str(getattr(member, "object", "") or "").strip()
    payload: dict[str, Any] = {
        "module": module_name,
        "name": object_name,
        "oid": "",
        "syntax": "",
        "type": "",
        "status": "",
        "description": "",
        "input_type": "String",
    }

    try:
        node = bundle.resolve_node(module_name, object_name)
    except Exception:
        node = None

    if node is None:
        return payload

    from trishul_snmp.mib.registry import oid_to_string

    payload.update(
        {
            "oid": oid_to_string(node.oid) if node.oid else "",
            "syntax": node.syntax or "",
            "type": node.nodetype or node.object_type or "",
            "status": node.status or "",
            "description": node.description or "",
            "input_type": _input_type_for_syntax(node.syntax),
        }
    )
    member_enum_values = enum_values(node)
    if member_enum_values:
        payload["enum_values"] = member_enum_values
    payload["constraint"] = getattr(node, "constraints", None)
    return payload


def _bundle_summary_details(bundle_service) -> tuple[dict[str, dict[str, Any]], str, str, Any]:
    bundle_summary = bundle_service.get_effective_bundle_summary() or {}
    bundle_label = str(bundle_summary.get("label") or bundle_summary.get("bundle_key") or "active-bundle")
    bundle_key = str(bundle_summary.get("bundle_key") or "")
    bundle_id = bundle_summary.get("id")
    bundle_modules = {
        str(module.get("module_name") or ""): module
        for module in (bundle_summary.get("modules") or [])
        if str(module.get("module_name") or "").strip()
    }
    return bundle_modules, bundle_label, bundle_key, bundle_id


def _bundle_source_path_for_module(module_name: str, *, bundle_modules, source_svc) -> Path | None:
    bundle_module = bundle_modules.get(module_name) or {}
    raw_source_path = str(bundle_module.get("source_path") or "").strip()
    if raw_source_path:
        return Path(raw_source_path)
    return source_svc.source_path_for_module(module_name)


def _source_details_for_path(source_path: Path | None, *, source_svc) -> dict[str, str]:
    if source_path is None:
        return {
            "source_group": "",
            "source_kind": "",
            "source_relative_path": "",
        }

    source_kind = source_svc.module_source_kind(source_path)
    return {
        "source_group": source_svc.source_group_for_path(source_path, source_kind=source_kind),
        "source_kind": source_kind,
        "source_relative_path": source_svc.source_relative_path(source_path, source_kind=source_kind),
    }


def _compile_run_source_path_for_module(
    module_name: str,
    *,
    run_source_dirs: list[str] | None,
    source_svc,
) -> Path | None:
    normalized_name = str(module_name or "").strip()
    if not normalized_name:
        return None

    for raw_directory in run_source_dirs or []:
        directory = Path(str(raw_directory or "")).expanduser()
        if not directory.exists() or not directory.is_dir():
            continue
        for path in source_svc.iter_source_files(directory, recursive=False):
            if path.stem == normalized_name:
                return path
            try:
                text = path.read_text(errors="ignore")
            except OSError:
                continue
            if source_svc.extract_mib_name(path.name, text) == normalized_name:
                return path

    return source_svc.source_path_for_module(normalized_name)


def _source_group_summary(
    *,
    uploaded_inventory: list[dict[str, Any]],
    active_modules: list[dict[str, Any]],
    managed_source_kinds: set[str],
    root_upload_source_group: str,
) -> list[dict[str, Any]]:
    by_group: dict[str, dict[str, Any]] = {}

    for entry in uploaded_inventory:
        group = str(entry.get("group") or root_upload_source_group)
        bucket = by_group.setdefault(
            group,
            {"name": group, "file_count": 0, "mib_names": set(), "active_module_count": 0},
        )
        bucket["file_count"] += 1
        mib_name = str(entry.get("mib_name") or "").strip()
        if mib_name:
            bucket["mib_names"].add(mib_name)

    for module in active_modules or []:
        if str(module.get("source_kind") or "").lower() not in managed_source_kinds:
            continue
        group = str(module.get("source_group") or root_upload_source_group)
        bucket = by_group.setdefault(
            group,
            {"name": group, "file_count": 0, "mib_names": set(), "active_module_count": 0},
        )
        bucket["active_module_count"] += 1

    return [
        {
            "name": payload["name"],
            "file_count": payload["file_count"],
            "mib_count": len(payload["mib_names"]),
            "active_module_count": payload["active_module_count"],
        }
        for payload in sorted(by_group.values(), key=lambda item: item["name"])
    ]


def _compile_run_result_rows(compile_run) -> list[dict[str, Any]]:
    command = compile_run.command_json if isinstance(compile_run.command_json, dict) else {}
    rows = command.get("result_rows")
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict)]


def _make_source_service(settings: Settings, state: StateStore, bundle_service):
    global _source_svc_instance
    if _source_svc_instance is not None:
        return _source_svc_instance

    from app.services.mib_sources import ShellMibSourceService

    _source_svc_instance = ShellMibSourceService(
        error_cls=MibsError,
        session_factory=bundle_service.session_factory,
        upload_dir=lambda: settings.data_dir / "mibs",
        bundled_mibs_dir=lambda: settings.bundled_mibs_dir,
        tsmi_cache_dir=lambda: settings.tsmi_cache_dir,
        load_settings=state.snapshot,
        emit_operation_log=lambda msg, level="INFO": _log(msg, settings, level=level),
        active_bundle_summary=bundle_service.get_effective_bundle_summary,
        unique_mib_names=bundle_service._unique_mib_names,
        bundled_mib_names=bundle_service.bundled_mib_names,
        mib_auto_fetch_key=_MIB_AUTO_FETCH_KEY,
        mib_remote_sources_key=_MIB_REMOTE_SOURCES_KEY,
    )
    return _source_svc_instance


def _make_mutation_service(settings: Settings, state: StateStore, bundle_service, source_svc):
    from app.services.mib_mutations import ShellMibMutationService

    return ShellMibMutationService(
        error_cls=MibsError,
        bundle_service=bundle_service,
        session_factory=bundle_service.session_factory,
        upload_dir=lambda: settings.data_dir / "mibs",
        bundled_mibs_dir=lambda: settings.bundled_mibs_dir,
        emit_operation_log=lambda msg, level="INFO": _log(msg, settings, level=level),
        increment_counter=lambda key, amount=1: state.increment_counter(key, amount),
        load_mib_status=lambda: get_status(settings=settings, state=state, bundle_service=bundle_service, source_svc=source_svc),
        analyze_upload_batch=source_svc.analyze_upload_batch,
        apply_upload_batch_policy=source_svc.apply_upload_batch_policy,
        remote_fetch_policy=source_svc.remote_fetch_policy,
        select_upload_targets=source_svc.select_upload_targets,
        normalize_source_group=source_svc.normalize_source_group,
        reset_source_caches=source_svc.reset_source_caches,
        compile_target_mib_names=source_svc.compile_target_mib_names,
        compile_source_dirs=source_svc.compile_source_dirs,
        uploaded_bundle_label=source_svc.uploaded_bundle_label,
        materialize_cached_remote_modules=source_svc.materialize_cached_remote_modules,
        upload_result_rows=source_svc.upload_result_rows,
        dependency_fetch_payload=source_svc.dependency_fetch_payload,
        missing_dependencies_from_error=source_svc.missing_dependencies_from_error,
        uploaded_mib_names=source_svc.uploaded_mib_names,
        reload_uploaded_mibs=lambda: reload(settings=settings, state=state, bundle_service=bundle_service),
        uploaded_target_path=source_svc.uploaded_target_path,
        relative_upload_path=source_svc.relative_upload_path,
        prune_empty_upload_dirs=source_svc.prune_empty_upload_dirs,
        active_source_map=source_svc.active_source_map,
        promoted_active_sources=source_svc.promoted_active_sources,
        available_source_mib_names=source_svc.available_source_mib_names,
        mib_reload_count_key=_MIB_RELOAD_COUNT_KEY,
    )


def get_status(
    *, settings: Settings, state: StateStore, bundle_service, source_svc=None
) -> dict[str, Any]:
    if source_svc is None:
        source_svc = _make_source_service(settings, state, bundle_service)

    from app.services.mib_sources import (
        BASE_IMPORT_MODULES,
        MANAGED_UPLOAD_SOURCE_KINDS,
        ROOT_UPLOAD_SOURCE_GROUP,
    )

    def _imports_for_source(source_path: Path | None) -> list[str]:
        if source_path is None or not source_path.exists():
            return []
        try:
            text = source_path.read_text(errors="ignore")
        except OSError:
            return []
        return source_svc.extract_imported_modules(text)

    bundle = get_bundle()
    uploaded_inventory = source_svc.uploaded_source_inventory()
    bundle_modules, _, _, active_bundle_id = _bundle_summary_details(bundle_service)
    manifest_summary = bundle_service.get_effective_bundle_manifest_summary() or {}

    rows_by_module: "OrderedDict[str, dict[str, Any]]" = OrderedDict()
    active_uploaded_paths: set[str] = set()
    active_uploaded_sources_by_module: dict[str, dict[str, Any]] = {}
    active_rows_by_path: dict[str, dict[str, Any]] = {}
    if bundle is not None:
        for mod_name, mod_record in bundle.modules.items():
            source_path = _bundle_source_path_for_module(
                mod_name,
                bundle_modules=bundle_modules,
                source_svc=source_svc,
            )
            if source_path is not None:
                source_details = _source_details_for_path(source_path, source_svc=source_svc)
                source_kind = source_details["source_kind"] or "compiled"
                source_group = source_details["source_group"]
                relative_path = source_details["source_relative_path"]
                deletable = source_kind in MANAGED_UPLOAD_SOURCE_KINDS
                builtin = source_kind == "bundled" or not deletable
                file_name = source_path.name
                imports = _imports_for_source(source_path)
            else:
                source_kind = "compiled"
                source_group = ""
                relative_path = ""
                deletable = False
                builtin = False
                file_name = ""
                imports = []
            row_payload = {
                "name": mod_name,
                "file": file_name,
                "relative_path": relative_path,
                "objects": len(mod_record.objects),
                "traps": len(mod_record.notifications),
                "imports": imports,
                "builtin": builtin,
                "deletable": deletable,
                "source_kind": source_kind,
                "source_group": source_group,
                "status": "active",
                "module_metadata": dict(mod_record.module_metadata)
                if getattr(mod_record, "module_metadata", None)
                else None,
            }
            rows_by_module[mod_name] = row_payload
            if deletable and relative_path:
                active_uploaded_paths.add(relative_path)
                active_uploaded_sources_by_module[mod_name] = row_payload
                active_rows_by_path[relative_path] = row_payload

    from sqlalchemy import select
    from app.models import CompileRun
    error_rows_by_path: "OrderedDict[str, dict[str, Any]]" = OrderedDict()
    with bundle_service.session_factory() as session:
        failed_runs = session.scalars(
            select(CompileRun)
            .where(CompileRun.status == "failed")
            .order_by(CompileRun.id.desc())
            .limit(5)
        ).all()
        for run in failed_runs:
            run_result_rows = _compile_run_result_rows(run)
            if run_result_rows:
                for result_row in run_result_rows:
                    row_status = str(result_row.get("status_label") or "").strip().lower()
                    if row_status not in {"failed", "invalid", "missing_deps"}:
                        continue
                    raw_source_path = str(result_row.get("source_path") or "").strip()
                    if not raw_source_path:
                        continue
                    source_path = Path(raw_source_path)
                    source_details = _source_details_for_path(source_path, source_svc=source_svc)
                    source_kind = source_details["source_kind"]
                    if source_kind not in MANAGED_UPLOAD_SOURCE_KINDS:
                        continue
                    relative_path = source_details["source_relative_path"] or source_path.name
                    if relative_path in active_uploaded_paths or relative_path in error_rows_by_path:
                        continue
                    missing_deps = bundle_service._unique_mib_names(
                        [
                            str(dep).strip()
                            for dep in (result_row.get("missing_dependencies") or [])
                            if str(dep).strip()
                        ]
                    )
                    error_rows_by_path[relative_path] = {
                        "name": str(result_row.get("name") or source_path.stem),
                        "file": relative_path,
                        "relative_path": relative_path,
                        "objects": 0,
                        "traps": 0,
                        "imports": _imports_for_source(source_path),
                        "builtin": False,
                        "error": str(result_row.get("error") or run.error_text or "Compile failed."),
                        "status": "missing_deps" if missing_deps else row_status,
                        "missing_deps": missing_deps,
                        "deletable": True,
                        "source_kind": source_kind,
                        "source_group": source_details["source_group"],
                    }
                continue

            requested = bundle_service._unique_mib_names(run.requested_mib_names_json or [])
            missing_deps = source_svc.missing_dependencies_from_error(run.error_text)
            status_label = "missing_deps" if missing_deps else "failed"
            for name in requested or [run.bundle_key or "compile-run"]:
                if name in rows_by_module:
                    continue
                source_path = _compile_run_source_path_for_module(
                    name,
                    run_source_dirs=run.source_dirs_json,
                    source_svc=source_svc,
                )
                if source_path is None:
                    continue
                source_details = _source_details_for_path(source_path, source_svc=source_svc)
                source_kind = source_details["source_kind"]
                if source_kind not in MANAGED_UPLOAD_SOURCE_KINDS:
                    continue
                relative_path = source_details["source_relative_path"] or source_path.name
                if relative_path in active_uploaded_paths or relative_path in error_rows_by_path:
                    continue
                error_rows_by_path[relative_path] = {
                    "name": name,
                    "file": relative_path,
                    "relative_path": relative_path,
                    "objects": 0,
                    "traps": 0,
                    "imports": _imports_for_source(source_path),
                    "builtin": False,
                    "error": run.error_text or "Compile failed.",
                    "status": status_label,
                    "missing_deps": missing_deps,
                    "deletable": True,
                    "source_kind": source_kind,
                    "source_group": source_details["source_group"],
                }

    available_names = source_svc.available_source_mib_names()
    source_inventory_rows_by_path: "OrderedDict[str, dict[str, Any]]" = OrderedDict()
    for entry in uploaded_inventory:
        relative_path = str(entry.get("relative_path") or "").strip()
        if not relative_path or relative_path in source_inventory_rows_by_path:
            continue
        source_path = Path(entry["path"])
        source_kind = source_svc.module_source_kind(source_path)
        if source_kind not in MANAGED_UPLOAD_SOURCE_KINDS:
            continue
        source_group = str(entry.get("group") or ROOT_UPLOAD_SOURCE_GROUP)
        mib_name = str(entry.get("mib_name") or Path(relative_path).stem)
        imports = _imports_for_source(source_path)
        base_row = {
            "name": mib_name,
            "file": relative_path,
            "relative_path": relative_path,
            "objects": 0,
            "traps": 0,
            "imports": imports,
            "builtin": False,
            "deletable": True,
            "source_kind": source_kind,
            "source_group": source_group,
            "status": "pending",
            "missing_deps": [],
        }

        active_row = active_rows_by_path.get(relative_path)
        if active_row is not None:
            source_inventory_rows_by_path[relative_path] = {
                **active_row,
                "file": relative_path,
                "relative_path": relative_path,
                "status": "active",
            }
            continue

        active_source = active_uploaded_sources_by_module.get(mib_name)
        if active_source is not None and active_source.get("relative_path") != relative_path:
            active_relative_path = str(active_source.get("relative_path") or "")
            source_inventory_rows_by_path[relative_path] = {
                **base_row,
                "objects": int(active_source.get("objects") or 0),
                "traps": int(active_source.get("traps") or 0),
                "error": (
                    "Another stored source for this MIB is active: "
                    f"{active_relative_path}. This copy is currently shadowed; "
                    "delete the duplicate or replace the active source."
                ),
                "status": "shadowed",
                "active_relative_path": active_relative_path,
            }
            continue

        failure_row = error_rows_by_path.get(relative_path)
        if failure_row is not None:
            source_inventory_rows_by_path[relative_path] = {
                **base_row,
                **failure_row,
                "file": relative_path,
                "relative_path": relative_path,
            }
            continue

        missing_deps = [
            module_name
            for module_name in imports
            if module_name not in available_names and module_name not in BASE_IMPORT_MODULES
        ]
        source_inventory_rows_by_path[relative_path] = {
            **base_row,
            "error": (
                "Stored source is not part of the active bundle. "
                + (
                    "Missing dependencies: " + ", ".join(missing_deps)
                    if missing_deps
                    else "Reload to compile it or delete it."
                )
            ),
            "status": "missing_deps" if missing_deps else "pending",
            "missing_deps": missing_deps,
        }

    active_modules = list(rows_by_module.values())
    source_inventory = list(source_inventory_rows_by_path.values())
    failed_modules = [
        row
        for row in source_inventory
        if str(row.get("status") or "").lower() in {"failed", "missing_deps", "invalid"}
    ]
    return {
        "loaded": len(active_modules),
        "failed": len(failed_modules),
        "mibs": active_modules,
        "active_modules": active_modules,
        "errors": failed_modules,
        "failed_modules": failed_modules,
        "source_inventory": source_inventory,
        "source_groups": _source_group_summary(
            uploaded_inventory=uploaded_inventory,
            active_modules=active_modules,
            managed_source_kinds=MANAGED_UPLOAD_SOURCE_KINDS,
            root_upload_source_group=ROOT_UPLOAD_SOURCE_GROUP,
        ),
        "producer_version": manifest_summary.get("producer_version"),
        "recompile_recommended": bool(manifest_summary.get("recompile_recommended")),
        "missing_capabilities": manifest_summary.get("missing_capabilities") or [],
        "active_bundle_id": active_bundle_id,
    }


def validate_upload_batch(
    uploaded: list[tuple[str, bytes]],
    *,
    source_group: str | None = None,
    settings: Settings,
    state: StateStore,
    bundle_service,
) -> dict[str, Any]:
    source_svc = _make_source_service(settings, state, bundle_service)
    mutation_svc = _make_mutation_service(settings, state, bundle_service, source_svc)
    return mutation_svc.validate_upload_batch(uploaded, source_group=source_group)


def upload(
    uploaded: list[tuple[str, bytes]],
    *,
    compile_mode: str = "full",
    compile_targets: list[str] | None = None,
    source_group: str | None = None,
    settings: Settings,
    state: StateStore,
    bundle_service,
) -> dict[str, Any]:
    _invalidate_source_cache()
    source_svc = _make_source_service(settings, state, bundle_service)
    mutation_svc = _make_mutation_service(settings, state, bundle_service, source_svc)
    return mutation_svc.save_uploaded_mibs(
        uploaded,
        compile_mode=compile_mode,
        compile_targets=compile_targets,
        source_group=source_group,
    )


def reload(*, settings: Settings, state: StateStore, bundle_service) -> dict[str, Any]:
    _invalidate_source_cache()
    source_svc = _make_source_service(settings, state, bundle_service)
    mutation_svc = _make_mutation_service(settings, state, bundle_service, source_svc)
    return mutation_svc.reload_uploaded_mib_bundle()


def fetch_dependencies(
    dependencies: list[str],
    *,
    settings: Settings,
    state: StateStore,
    bundle_service,
) -> dict[str, Any]:
    _invalidate_source_cache()
    source_svc = _make_source_service(settings, state, bundle_service)
    mutation_svc = _make_mutation_service(settings, state, bundle_service, source_svc)
    return mutation_svc.fetch_dependencies(dependencies)


def delete_mib(
    path: str,
    *,
    settings: Settings,
    state: StateStore,
    bundle_service,
) -> dict[str, Any]:
    _invalidate_source_cache()
    source_svc = _make_source_service(settings, state, bundle_service)
    mutation_svc = _make_mutation_service(settings, state, bundle_service, source_svc)
    return mutation_svc.delete_uploaded_mib(path)


def delete_mibs(
    paths: list[str],
    *,
    settings: Settings,
    state: StateStore,
    bundle_service,
) -> dict[str, Any]:
    _invalidate_source_cache()
    source_svc = _make_source_service(settings, state, bundle_service)
    mutation_svc = _make_mutation_service(settings, state, bundle_service, source_svc)
    return mutation_svc.delete_uploaded_mibs(paths)


def download_mib_sources(
    paths: list[str],
    *,
    settings: Settings,
    state: StateStore,
    bundle_service,
) -> dict[str, Any]:
    source_svc = _make_source_service(settings, state, bundle_service)
    normalized_paths = list(
        OrderedDict.fromkeys(
            str(path or "").strip().replace("\\", "/")
            for path in (paths or [])
            if str(path or "").strip()
        )
    )
    if not normalized_paths:
        raise MibsError("Select at least one stored MIB source to download.")

    resolved_paths: list[tuple[str, Path]] = []
    missing_paths: list[str] = []
    for relative_path in normalized_paths:
        try:
            target = source_svc.uploaded_target_path(relative_path)
        except MibsError:
            missing_paths.append(relative_path)
            continue
        if not target.exists() or not target.is_file():
            missing_paths.append(relative_path)
            continue
        resolved_paths.append((relative_path, target))

    if missing_paths:
        missing_preview = ", ".join(missing_paths[:5])
        if len(missing_paths) > 5:
            missing_preview += f", +{len(missing_paths) - 5} more"
        raise MibsError(f"Stored MIB source not found: {missing_preview}")

    if len(resolved_paths) == 1:
        _relative_path, target = resolved_paths[0]
        return {
            "filename": target.name,
            "media_type": "application/octet-stream",
            "content": target.read_bytes(),
        }

    archive = BytesIO()
    with ZipFile(archive, mode="w", compression=ZIP_DEFLATED) as bundle:
        for relative_path, target in resolved_paths:
            bundle.write(target, arcname=relative_path)

    return {
        "filename": "mib-sources.zip",
        "media_type": "application/zip",
        "content": archive.getvalue(),
    }


def export_catalog(
    *,
    format: str = "json",
    modules: list[str] | None = None,
    notifications: list[str] | None = None,
    source_groups: list[str] | None = None,
    export_type: str = "catalog",
    settings: Settings,
    state: StateStore,
    bundle_service,
) -> dict[str, Any]:
    """Export MIB catalog from the live in-memory bundle."""
    bundle = get_bundle()
    if bundle is None:
        raise MibsError("No active MIB bundle is loaded.")
    from trishul_snmp.mib.registry import oid_to_string
    from app.services.mib_sources import MANAGED_UPLOAD_SOURCE_KINDS, ROOT_UPLOAD_SOURCE_GROUP

    supported_export_types = {
        "catalog",
        "summary",
        "modules",
        "objects",
        "notifications",
        "notification-members",
    }
    if export_type not in supported_export_types:
        raise MibsError(f"Unsupported catalog export type: {export_type}")

    source_svc = _make_source_service(settings, state, bundle_service)
    uploaded_inventory = source_svc.uploaded_source_inventory()
    bundle_modules, bundle_label, bundle_key, _bundle_id = _bundle_summary_details(bundle_service)
    inventory_entries_by_module: dict[str, list[dict[str, Any]]] = {}
    for entry in uploaded_inventory:
        mib_name = str(entry.get("mib_name") or "").strip()
        if mib_name:
            inventory_entries_by_module.setdefault(mib_name, []).append(entry)

    mod_filter = set(modules) if modules else None
    notif_filter = set(notifications) if notifications else None
    requested_source_groups: list[str] = []
    for group in source_groups or []:
        normalized_group = source_svc.normalize_source_group(group)
        if normalized_group and normalized_group not in requested_source_groups:
            requested_source_groups.append(normalized_group)
    source_group_filter = set(requested_source_groups) if requested_source_groups else None

    result_modules = []
    result_notifications = []
    result_objects = []
    result_notification_members = []

    memberships_by_module: dict[str, list[dict[str, str]]] = {}
    filtered_source_details_by_module: dict[str, dict[str, str] | None] = {}
    def module_memberships(module_name: str) -> list[dict[str, str]]:
        if module_name in memberships_by_module:
            return memberships_by_module[module_name]

        source_path = _bundle_source_path_for_module(
            module_name,
            bundle_modules=bundle_modules,
            source_svc=source_svc,
        )
        memberships: list[dict[str, str]] = []
        seen_relative_paths: set[str] = set()

        if source_path is not None:
            active_details = _source_details_for_path(source_path, source_svc=source_svc)
            memberships.append(active_details)
            relative_path = active_details.get("source_relative_path") or ""
            if relative_path:
                seen_relative_paths.add(relative_path)
            if active_details.get("source_kind") in MANAGED_UPLOAD_SOURCE_KINDS:
                for entry in inventory_entries_by_module.get(module_name, []):
                    relative_path = str(entry.get("relative_path") or "").strip()
                    if not relative_path or relative_path in seen_relative_paths:
                        continue
                    entry_source_path = Path(entry["path"])
                    source_kind = source_svc.module_source_kind(entry_source_path)
                    if source_kind not in MANAGED_UPLOAD_SOURCE_KINDS:
                        continue
                    memberships.append(
                        {
                            "source_group": str(entry.get("group") or ROOT_UPLOAD_SOURCE_GROUP),
                            "source_kind": source_kind,
                            "source_relative_path": relative_path,
                        }
                    )
                    seen_relative_paths.add(relative_path)

        if not memberships:
            memberships = [
                {
                    "source_group": "",
                    "source_kind": "",
                    "source_relative_path": "",
                }
            ]

        memberships_by_module[module_name] = memberships
        return memberships

    def module_source_details(module_name: str) -> dict[str, str] | None:
        if module_name in filtered_source_details_by_module:
            return filtered_source_details_by_module[module_name]
        memberships = module_memberships(module_name)
        if source_group_filter:
            for requested_group in requested_source_groups:
                for membership in memberships:
                    if membership["source_group"] == requested_group:
                        filtered_source_details_by_module[module_name] = membership
                        return membership
            filtered_source_details_by_module[module_name] = None
            return None

        filtered_source_details_by_module[module_name] = memberships[0] if memberships else None
        return filtered_source_details_by_module[module_name]

    for mod_name, mod_record in bundle.modules.items():
        if mod_filter and mod_name not in mod_filter:
            continue
        module_source = module_source_details(mod_name)
        if module_source is None:
            continue

        mod_notifications = []
        for notification in mod_record.notifications.values():
            notification_full_name = f"{notification.module}::{notification.name}"
            if notif_filter and notification_full_name not in notif_filter:
                continue

            members = []
            for position, member in enumerate(notification.members or [], start=1):
                member_payload = _notification_member_payload(
                    member,
                    bundle=bundle,
                )
                member_payload["position"] = position
                members.append(member_payload)
                result_notification_members.append(
                    {
                        "notification_module": notification.module,
                        "notification_name": notification.name,
                        "notification_oid": oid_to_string(notification.oid),
                        "notification_source_group": module_source["source_group"],
                        "notification_source_kind": module_source["source_kind"],
                        "notification_source_relative_path": module_source["source_relative_path"],
                        "member_module": member_payload["module"],
                        "member_name": member_payload["name"],
                        "member_oid": member_payload["oid"],
                        "syntax": member_payload["syntax"],
                        "type": member_payload["type"],
                        "status": member_payload["status"],
                        "description": member_payload["description"],
                        "input_type": member_payload["input_type"],
                        "enum_values": member_payload.get("enum_values", []),
                        "position": position,
                    }
                )

            mod_notifications.append(
                {
                    "module": notification.module,
                    "name": notification.name,
                    "full_name": notification_full_name,
                    "oid": oid_to_string(notification.oid),
                    "description": notification.description or "",
                    "source_group": module_source["source_group"],
                    "source_kind": module_source["source_kind"],
                    "source_relative_path": module_source["source_relative_path"],
                    "member_count": len(members),
                    "members": members,
                }
            )

        mod_objects = [
            {
                "module": o.module,
                "name": o.name,
                "full_name": f"{o.module}::{o.name}",
                "oid": oid_to_string(o.oid),
                "syntax": o.syntax or "",
                "nodetype": o.nodetype or "",
                "status": o.status or "",
                "description": o.description or "",
                "source_group": module_source["source_group"],
                "source_kind": module_source["source_kind"],
                "source_relative_path": module_source["source_relative_path"],
            }
            for o in mod_record.objects.values()
        ]
        result_modules.append({
            "module_name": mod_name,
            "object_count": len(mod_record.objects),
            "notification_count": len(mod_record.notifications),
            "source_group": module_source["source_group"],
            "source_kind": module_source["source_kind"],
            "source_relative_path": module_source["source_relative_path"],
        })
        result_notifications.extend(mod_notifications)
        result_objects.extend(mod_objects)

    summary = {
        "module_count": len(result_modules),
        "object_count": len(result_objects),
        "notification_count": len(result_notifications),
        "notification_member_count": len(result_notification_members),
    }

    if export_type == "notifications":
        result_objects = []
        result_notification_members = []
    elif export_type == "objects":
        result_notifications = []
        result_notification_members = []
    elif export_type == "modules":
        result_notifications = []
        result_objects = []
        result_notification_members = []
    elif export_type == "summary":
        result_modules = []
        result_notifications = []
        result_objects = []
        result_notification_members = []
    elif export_type == "notification-members":
        result_notifications = []
        result_objects = []

    return {
        "export_version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "filters": {
            "export_type": export_type,
            "requested_modules": sorted(mod_filter) if mod_filter else [],
            "requested_notifications": sorted(notif_filter) if notif_filter else [],
            "requested_source_groups": requested_source_groups,
        },
        "metadata": {
            "bundle_label": bundle_label,
            "bundle_key": bundle_key,
        },
        "summary": summary,
        "modules": result_modules,
        "objects": result_objects,
        "notifications": result_notifications,
        "notification_members": result_notification_members,
    }


def export_catalog_file(
    *,
    format: str = "json",
    modules: list[str] | None = None,
    notifications: list[str] | None = None,
    source_groups: list[str] | None = None,
    export_type: str = "catalog",
    settings: Settings,
    state: StateStore,
    bundle_service,
) -> dict[str, Any]:
    payload = export_catalog(
        format=format,
        modules=modules,
        notifications=notifications,
        source_groups=source_groups,
        export_type=export_type,
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )
    normalized_format = str(format or "json").strip().lower()
    basename = _export_basename(payload, export_type=export_type)
    if normalized_format == "json":
        return {
            "filename": f"{basename}.json",
            "media_type": "application/json",
            "content": json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8"),
        }
    if normalized_format == "csv":
        import csv, io
        out = io.StringIO(newline="")
        writer = csv.writer(out)
        if export_type == "summary":
            writer.writerow(["key", "value"])
            writer.writerow(["bundle_label", payload.get("metadata", {}).get("bundle_label", "")])
            writer.writerow(["bundle_key", payload.get("metadata", {}).get("bundle_key", "")])
            for key, value in (payload.get("summary") or {}).items():
                writer.writerow([key, value])
            for key, value in (payload.get("filters") or {}).items():
                if isinstance(value, list):
                    writer.writerow([key, ", ".join(str(item) for item in value)])
                else:
                    writer.writerow([key, value])
        elif export_type == "modules":
            writer.writerow(
                [
                    "module_name",
                    "object_count",
                    "notification_count",
                    "source_group",
                    "source_kind",
                    "source_relative_path",
                ]
            )
            for module in payload.get("modules", []):
                writer.writerow(
                    [
                        module.get("module_name", ""),
                        module.get("object_count", 0),
                        module.get("notification_count", 0),
                        module.get("source_group", ""),
                        module.get("source_kind", ""),
                        module.get("source_relative_path", ""),
                    ]
                )
        elif export_type == "objects":
            writer.writerow(
                [
                    "module",
                    "name",
                    "full_name",
                    "oid",
                    "nodetype",
                    "syntax",
                    "status",
                    "source_group",
                    "source_kind",
                    "source_relative_path",
                    "description",
                ]
            )
            for obj in payload.get("objects", []):
                writer.writerow(
                    [
                        obj.get("module", ""),
                        obj.get("name", ""),
                        obj.get("full_name", ""),
                        obj.get("oid", ""),
                        obj.get("nodetype", ""),
                        obj.get("syntax", ""),
                        obj.get("status", ""),
                        obj.get("source_group", ""),
                        obj.get("source_kind", ""),
                        obj.get("source_relative_path", ""),
                        obj.get("description", ""),
                    ]
                )
        elif export_type == "notifications":
            writer.writerow(
                [
                    "notification_module",
                    "notification_name",
                    "notification_oid",
                    "notification_source_group",
                    "notification_source_kind",
                    "notification_source_relative_path",
                    "member_count",
                    "member_module",
                    "member_name",
                    "member_oid",
                    "syntax",
                    "type",
                    "status",
                    "input_type",
                    "position",
                    "enum_values",
                    "description",
                    "notification_description",
                ]
            )
            for notification in payload.get("notifications", []):
                members = notification.get("members") or [{}]
                for index, member in enumerate(members, start=1):
                    writer.writerow(
                        [
                            notification.get("module", ""),
                            notification.get("name", ""),
                            notification.get("oid", ""),
                            notification.get("source_group", ""),
                            notification.get("source_kind", ""),
                            notification.get("source_relative_path", ""),
                            notification.get("member_count", 0),
                            member.get("module", ""),
                            member.get("name", ""),
                            member.get("oid", ""),
                            member.get("syntax", ""),
                            member.get("type", ""),
                            member.get("status", ""),
                            member.get("input_type", ""),
                            member.get("position", index if member else 0),
                            json.dumps(member.get("enum_values", []), ensure_ascii=False),
                            member.get("description", ""),
                            notification.get("description", ""),
                        ]
                    )
        elif export_type == "notification-members":
            writer.writerow(
                [
                    "notification_module",
                    "notification_name",
                    "notification_oid",
                    "notification_source_group",
                    "member_module",
                    "member_name",
                    "member_oid",
                    "syntax",
                    "type",
                    "status",
                    "input_type",
                    "position",
                    "enum_values",
                    "description",
                ]
            )
            for member in payload.get("notification_members", []):
                writer.writerow(
                    [
                        member.get("notification_module", ""),
                        member.get("notification_name", ""),
                        member.get("notification_oid", ""),
                        member.get("notification_source_group", ""),
                        member.get("member_module", ""),
                        member.get("member_name", ""),
                        member.get("member_oid", ""),
                        member.get("syntax", ""),
                        member.get("type", ""),
                        member.get("status", ""),
                        member.get("input_type", ""),
                        member.get("position", 0),
                        json.dumps(member.get("enum_values", []), ensure_ascii=False),
                        member.get("description", ""),
                    ]
                )
        else:
            writer.writerow(
                [
                    "entry_type",
                    "module",
                    "name",
                    "oid",
                    "kind",
                    "syntax",
                    "status",
                    "source_group",
                    "source_kind",
                    "source_relative_path",
                    "description",
                    "notification_module",
                    "notification_name",
                    "notification_oid",
                    "input_type",
                    "position",
                    "enum_values",
                    "object_count",
                    "notification_count",
                    "member_count",
                ]
            )
            for module in payload.get("modules", []):
                writer.writerow(
                    [
                        "module",
                        module.get("module_name", ""),
                        module.get("module_name", ""),
                        "",
                        "module",
                        "",
                        "",
                        module.get("source_group", ""),
                        module.get("source_kind", ""),
                        module.get("source_relative_path", ""),
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        module.get("object_count", 0),
                        module.get("notification_count", 0),
                        "",
                    ]
                )
            for obj in payload.get("objects", []):
                writer.writerow(
                    [
                        "object",
                        obj.get("module", ""),
                        obj.get("name", ""),
                        obj.get("oid", ""),
                        obj.get("nodetype", ""),
                        obj.get("syntax", ""),
                        obj.get("status", ""),
                        obj.get("source_group", ""),
                        obj.get("source_kind", ""),
                        obj.get("source_relative_path", ""),
                        obj.get("description", ""),
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                    ]
                )
            for notification in payload.get("notifications", []):
                writer.writerow(
                    [
                        "notification",
                        notification.get("module", ""),
                        notification.get("name", ""),
                        notification.get("oid", ""),
                        "notification",
                        "",
                        "",
                        notification.get("source_group", ""),
                        notification.get("source_kind", ""),
                        notification.get("source_relative_path", ""),
                        notification.get("description", ""),
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        notification.get("member_count", 0),
                    ]
                )
            for member in payload.get("notification_members", []):
                writer.writerow(
                    [
                        "notification-member",
                        member.get("member_module", ""),
                        member.get("member_name", ""),
                        member.get("member_oid", ""),
                        member.get("type", ""),
                        member.get("syntax", ""),
                        member.get("status", ""),
                        "",
                        "",
                        "",
                        member.get("description", ""),
                        member.get("notification_module", ""),
                        member.get("notification_name", ""),
                        member.get("notification_oid", ""),
                        member.get("input_type", ""),
                        member.get("position", 0),
                        json.dumps(member.get("enum_values", []), ensure_ascii=False),
                        "",
                        "",
                        "",
                    ]
                )
        return {
            "filename": f"{basename}.csv",
            "media_type": "text/csv",
            "content": out.getvalue().encode("utf-8"),
        }
    raise MibsError("Unsupported catalog export format. Use json or csv.")
