from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select

from app.models import BundleModule

BASE_IMPORT_MODULES = {
    "RFC-1212",
    "RFC-1215",
    "RFC1155-SMI",
    "SNMPv2-SMI-v1",
    "SNMPv2-TC-v1",
}
DEFAULT_UPLOAD_SOURCE_GROUP = "common"
AUTO_FETCHED_UPLOAD_SOURCE_GROUP = "auto-fetched"
ROOT_UPLOAD_SOURCE_GROUP = "default"
MANAGED_UPLOAD_SOURCE_KINDS = {"uploaded", "auto-fetched"}

_MIB_DEFINITIONS_RE = re.compile(
    r"^\s*([A-Za-z0-9-]+)\s+DEFINITIONS\s*::=\s*BEGIN",
    re.MULTILINE,
)
_MIB_IMPORT_RE = re.compile(r"\bFROM\s+([A-Za-z0-9-]+)\b")
_SOURCE_GROUP_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_SUPPORTED_MIB_EXTENSIONS = {".mib", ".txt", ".my"}


class ShellMibSourceService:
    def __init__(
        self,
        *,
        error_cls,
        session_factory,
        upload_dir,
        bundled_mibs_dir,
        tsmi_cache_dir,
        load_settings,
        emit_operation_log,
        active_bundle_summary,
        unique_mib_names,
        bundled_mib_names,
        mib_auto_fetch_key: str,
        mib_remote_sources_key: str,
    ) -> None:
        self.error_cls = error_cls
        self.session_factory = session_factory
        self.upload_dir = upload_dir
        self.bundled_mibs_dir = bundled_mibs_dir
        self.tsmi_cache_dir = tsmi_cache_dir
        self.load_settings = load_settings
        self.emit_operation_log = emit_operation_log
        self.active_bundle_summary = active_bundle_summary
        self.unique_mib_names = unique_mib_names
        self.bundled_mib_names = bundled_mib_names
        self.mib_auto_fetch_key = mib_auto_fetch_key
        self.mib_remote_sources_key = mib_remote_sources_key
        self._source_module_path_cache: dict[str, Path | None] = {}
        self._source_path_cache_warmed = False
        # MGR-05: the upload inventory scan reads every stored file once to
        # extract the declared MIB name (and, since 2.2.0-C, its IMPORTS).
        # The scan result is cached so `/api/mibs/status` does not re-read
        # each file for the warm path cache or the per-row import lists.
        self._source_inventory_cache: list[dict[str, Any]] | None = None
        self._imports_cache: dict[Path, list[str]] = {}

    def analyze_upload_batch(
        self,
        uploaded: list[tuple[str, bytes]],
        *,
        source_group: str | None = None,
    ) -> dict[str, Any]:
        target_group = self.normalize_source_group(source_group)
        target_dir = self.upload_dir() / Path(target_group)
        available_names = self.available_source_mib_names()
        analyzed: list[dict[str, Any]] = []
        batch_names: list[str] = []

        for filename, content in uploaded:
            suffix = Path(filename).suffix.lower()
            valid = suffix in _SUPPORTED_MIB_EXTENSIONS
            text = content.decode("utf-8", errors="ignore")
            safe_name = Path(filename).name
            mib_name = self.extract_mib_name(filename, text)
            storage_name = self.storage_file_name(filename, mib_name)
            imports = self.extract_imported_modules(text)
            target_relative_path = (
                (Path(target_group) / storage_name).as_posix() if storage_name else ""
            )
            analyzed.append(
                {
                    "filename": filename,
                    "safe_name": safe_name,
                    "storage_name": storage_name,
                    "mib_name": mib_name,
                    "valid": valid,
                    "imports": imports,
                    "source_group": target_group,
                    "target_relative_path": target_relative_path,
                    "will_replace": bool(storage_name and (target_dir / storage_name).exists()),
                    "errors": [] if valid else ["Unsupported file extension."],
                }
            )
            if mib_name:
                batch_names.append(mib_name)

        available_with_batch = set(available_names)
        available_with_batch.update(batch_names)

        batch_name_set = {name for name in batch_names if name}
        stable_available = {name for name in available_names if name not in batch_name_set}
        stable_available.update(BASE_IMPORT_MODULES)

        ready_names: set[str] = set()
        changed = True
        while changed:
            changed = False
            for entry in analyzed:
                mib_name = str(entry.get("mib_name") or "").strip()
                if not entry["valid"] or not mib_name or mib_name in ready_names:
                    continue
                blockers = [
                    module_name
                    for module_name in entry["imports"]
                    if module_name not in stable_available and module_name not in ready_names
                ]
                if blockers:
                    continue
                ready_names.add(mib_name)
                changed = True

        files: list[dict[str, Any]] = []
        all_valid = True
        for entry in analyzed:
            all_valid = all_valid and bool(entry["valid"])
            missing_deps = [
                module_name
                for module_name in entry["imports"]
                if module_name not in available_with_batch and module_name not in BASE_IMPORT_MODULES
            ]
            partial_blockers = [
                module_name
                for module_name in entry["imports"]
                if module_name not in stable_available and module_name not in ready_names
            ]
            ready_for_partial = (
                bool(entry["valid"])
                and bool(entry["mib_name"])
                and entry["mib_name"] in ready_names
            )
            files.append(
                {
                    "filename": entry["filename"],
                    "safe_name": entry["safe_name"],
                    "storage_name": entry["storage_name"],
                    "mib_name": entry["mib_name"],
                    "valid": entry["valid"],
                    "imports": entry["imports"],
                    "missing_deps": missing_deps,
                    "partial_blockers": partial_blockers,
                    "ready_for_partial": ready_for_partial,
                    "source_group": entry["source_group"],
                    "target_relative_path": entry["target_relative_path"],
                    "will_replace": entry["will_replace"],
                    "duplicate_resolution": self.upload_duplicate_resolution(
                        mib_name=str(entry["mib_name"] or "").strip(),
                        target_relative_path=str(entry["target_relative_path"] or ""),
                        source_group=target_group,
                        will_replace=bool(entry["will_replace"]),
                    ),
                    "errors": list(entry["errors"]),
                }
            )

        ready_mibs = [
            str(entry["mib_name"])
            for entry in files
            if entry["ready_for_partial"] and str(entry["mib_name"]).strip()
        ]
        blocked_mibs = [
            str(entry["mib_name"])
            for entry in files
            if entry["valid"] and str(entry["mib_name"]).strip() and str(entry["mib_name"]) not in ready_names
        ]

        return {
            "files": files,
            "source_group": target_group,
            "duplicate_modules": [
                {
                    "mib_name": str(entry.get("mib_name") or ""),
                    "target_relative_path": str(entry.get("target_relative_path") or ""),
                    "source_group": str(entry.get("source_group") or target_group),
                    "resolution_status": entry["duplicate_resolution"]["resolution_status"],
                    "predicted_active_relative_path": entry["duplicate_resolution"][
                        "predicted_active_relative_path"
                    ],
                    "predicted_active_source_group": entry["duplicate_resolution"][
                        "predicted_active_source_group"
                    ],
                    "duplicate_sources": list(entry["duplicate_resolution"]["duplicate_sources"]),
                    "warnings": list(entry["duplicate_resolution"]["warnings"]),
                }
                for entry in files
                if entry["duplicate_resolution"]["duplicate_sources"]
            ],
            "global_missing_deps": sorted(
                {
                    module_name
                    for entry in files
                    for module_name in entry["missing_deps"]
                }
            ),
            "can_upload": all_valid and len(files) > 0,
            "upload_blocked_reason": None,
            "partial_compile": {
                "ready_mibs": ready_mibs,
                "blocked_mibs": blocked_mibs,
                "can_partial_compile": bool(ready_mibs and blocked_mibs),
                "ready_count": len(ready_mibs),
                "blocked_count": len(blocked_mibs),
            },
        }

    def apply_upload_batch_policy(
        self,
        batch: dict[str, Any],
        *,
        policy: dict[str, Any],
    ) -> dict[str, Any]:
        files = list(batch.get("files") or [])
        has_invalid = any(not bool(entry.get("valid")) for entry in files)
        has_missing_deps = bool(batch.get("global_missing_deps"))
        auto_fetch_enabled = bool(policy.get("enabled"))
        if has_invalid:
            batch["can_upload"] = False
            batch["upload_blocked_reason"] = "Upload only accepts .mib, .txt, or .my files."
            return batch
        if not files:
            batch["can_upload"] = False
            batch["upload_blocked_reason"] = "Select at least one MIB source file."
            return batch
        if has_missing_deps and not auto_fetch_enabled:
            batch["can_upload"] = False
            batch["upload_blocked_reason"] = (
                "Full upload is blocked because required dependencies are missing and auto-fetch is disabled. "
                "Upload the missing MIBs, enable auto-fetch in Settings, or use partial compile for the ready MIBs."
            )
            return batch
        batch["can_upload"] = True
        batch["upload_blocked_reason"] = None
        return batch

    def remote_fetch_policy(self) -> dict[str, Any]:
        settings_snapshot = self.load_settings()
        enabled = bool(settings_snapshot[self.mib_auto_fetch_key])
        sources = [
            str(source).strip()
            for source in (settings_snapshot.get(self.mib_remote_sources_key) or [])
            if str(source).strip()
        ]
        return {
            "enabled": enabled,
            "auto_enabled": enabled,
            "sources": sources,
            "using_default_sources": bool(enabled and not sources),
        }

    def select_upload_targets(
        self,
        *,
        batch: dict[str, Any],
        compile_mode: str,
        compile_targets: list[str] | None,
    ) -> list[str]:
        normalized_mode = str(compile_mode or "full").strip().lower()
        if normalized_mode != "partial":
            return [
                str(entry["mib_name"])
                for entry in batch["files"]
                if entry["valid"] and str(entry["mib_name"]).strip()
            ]

        ready_mibs = [
            str(name).strip()
            for name in batch.get("partial_compile", {}).get("ready_mibs", [])
            if str(name).strip()
        ]
        requested = [
            str(name).strip()
            for name in (compile_targets or ready_mibs)
            if str(name).strip()
        ]
        allowed = set(ready_mibs)
        selected = [name for name in requested if name in allowed]
        if not selected:
            raise self.error_cls(
                "No ready MIBs are available for partial compile. Add the missing dependencies and try again."
            )
        return self.unique_mib_names(selected)

    def upload_result_rows(
        self,
        *,
        batch: dict[str, Any],
        selected_targets: list[str],
        status: str,
        error: str | None = None,
    ) -> list[dict[str, Any]]:
        selected = set(selected_targets)
        rows: list[dict[str, Any]] = []
        for entry in batch["files"]:
            mib_name = str(entry.get("mib_name") or "").strip()
            if mib_name in selected:
                payload = {
                    "filename": entry["filename"],
                    "mib_name": mib_name,
                    "status": status,
                }
                if error:
                    payload["error"] = error
                rows.append(payload)
                continue
            payload = {
                "filename": entry["filename"],
                "mib_name": mib_name,
                "status": "skipped",
                "missing_deps": list(entry.get("partial_blockers") or []),
            }
            if entry.get("partial_blockers"):
                payload["error"] = (
                    "Skipped in partial compile because dependencies are still missing: "
                    + ", ".join(str(name) for name in entry["partial_blockers"])
                )
            else:
                payload["error"] = "Skipped in partial compile."
            rows.append(payload)
        return rows

    def dependency_fetch_payload(
        self,
        *,
        policy: dict[str, Any],
        attempted: list[str] | None = None,
        resolved: list[str] | None = None,
        failed: list[str] | None = None,
    ) -> dict[str, Any]:
        attempted_set = {str(name).strip() for name in (attempted or []) if str(name).strip()}
        resolved_list = self.unique_mib_names(
            [str(name).strip() for name in (resolved or []) if str(name).strip()]
        )
        resolved_set = set(resolved_list)
        failed_list = self.unique_mib_names(
            [str(name).strip() for name in (failed or []) if str(name).strip()]
        )
        if not failed_list and attempted_set:
            failed_list = sorted(attempted_set - resolved_set)
        effective_enabled = bool(policy.get("enabled")) and bool(
            attempted_set or resolved_list or failed_list
        )
        return {
            "enabled": effective_enabled,
            "auto_enabled": bool(policy.get("auto_enabled")),
            "using_default_sources": bool(policy.get("using_default_sources")),
            "sources": list(policy.get("sources") or []),
            "attempted": sorted(attempted_set),
            "resolved": resolved_list,
            "downloaded": resolved_list,
            "cached": [],
            "failed": failed_list,
        }

    def uploaded_file_names(self) -> list[str]:
        return [entry["relative_path"] for entry in self.uploaded_source_inventory()]

    def uploaded_mib_names(self) -> list[str]:
        return self.unique_mib_names(
            [entry["mib_name"] for entry in self.uploaded_source_inventory() if entry["mib_name"]]
        )

    def compile_target_mib_names(self, mib_names: Any) -> list[str]:
        requested = [str(name).strip() for name in mib_names if str(name).strip()]
        return self.unique_mib_names(requested + self.bundled_mib_names())

    def available_source_mib_names(self) -> set[str]:
        names = set(self.uploaded_mib_names())
        names.update(self.source_mib_names_in_dir(self.bundled_mibs_dir()))
        return names

    def compile_source_dirs(self) -> list[str]:
        return [str(path) for path in self._source_search_directories()]

    def _source_search_directories(self) -> list[Path]:
        directories = self.ordered_uploaded_source_dirs()
        directories.append(self.bundled_mibs_dir())
        return directories

    def ordered_uploaded_source_dirs(self) -> list[Path]:
        directories = {entry["path"].parent for entry in self.uploaded_source_inventory()}
        return sorted(directories, key=self.upload_directory_sort_key)

    def upload_directory_sort_key(self, directory: Path) -> tuple[int, str]:
        relative = self.relative_upload_directory(directory)
        return self.source_group_precedence_key(relative)

    def uploaded_source_inventory(self) -> list[dict[str, Any]]:
        # MGR-05: the scan result is cached and reused by every caller within a
        # cache generation (status, export, duplicate resolution, warm path
        # cache). Mutations reset the caches, so the entries never go stale
        # across an upload/delete/fetch cycle.
        if self._source_inventory_cache is not None:
            return list(self._source_inventory_cache)
        inventory: list[dict[str, Any]] = []
        for path in self.iter_source_files(self.upload_dir(), recursive=True):
            relative_path = self.relative_upload_path(path)
            if relative_path is None:
                continue
            try:
                text = path.read_text(errors="ignore")
            except OSError:
                text = ""
            imports = self.extract_imported_modules(text)
            entry = {
                "path": path,
                "relative_path": relative_path,
                "group": self.relative_path_group(relative_path),
                "mib_name": self.extract_mib_name(path.name, text),
                # One read per file carries both the declared name and the
                # IMPORTS list, so downstream consumers never re-read the file.
                "imports": imports,
            }
            inventory.append(entry)
            self._imports_cache[path.resolve()] = imports
        self._source_inventory_cache = inventory
        return list(inventory)

    def imports_for_source(self, source_path: Path | None) -> list[str]:
        """IMPORTS for a source path, read at most once per cache generation.

        Managed upload paths are covered by the inventory scan; any other path
        (bundled/compiled/legacy run dir) is read on first use and memoized.
        """
        if source_path is None:
            return []
        try:
            resolved = source_path.resolve()
        except (OSError, RuntimeError):
            resolved = source_path
        cached = self._imports_cache.get(resolved)
        if cached is not None:
            return list(cached)
        try:
            text = source_path.read_text(errors="ignore")
        except OSError:
            imports: list[str] = []
        else:
            imports = self.extract_imported_modules(text)
        self._imports_cache[resolved] = imports
        return list(imports)

    def iter_source_files(self, directory: Path, *, recursive: bool = False) -> list[Path]:
        if not directory.exists():
            return []
        iterator = directory.rglob("*") if recursive else directory.iterdir()
        return sorted(
            path
            for path in iterator
            if path.is_file() and path.suffix.lower() in _SUPPORTED_MIB_EXTENSIONS
        )

    def normalize_source_group(self, source_group: str | None) -> str:
        raw_value = str(source_group or "").strip().replace("\\", "/")
        if not raw_value:
            return DEFAULT_UPLOAD_SOURCE_GROUP
        segments: list[str] = []
        for segment in raw_value.split("/"):
            normalized = segment.strip().lower()
            if not normalized:
                continue
            if normalized in {".", ".."} or _SOURCE_GROUP_SEGMENT_RE.fullmatch(normalized) is None:
                raise self.error_cls(
                    "Source group may only contain letters, numbers, dot, dash, underscore, and forward slashes."
                )
            segments.append(normalized)
        if not segments:
            return DEFAULT_UPLOAD_SOURCE_GROUP
        return "/".join(segments)

    def source_group_precedence_key(self, source_group: str | None) -> tuple[int, str]:
        normalized = str(source_group or "").strip().lower()
        if normalized in {"", "."}:
            return (0, "")
        if normalized == DEFAULT_UPLOAD_SOURCE_GROUP or normalized.startswith(
            f"{DEFAULT_UPLOAD_SOURCE_GROUP}/"
        ):
            return (1, normalized)
        if normalized == AUTO_FETCHED_UPLOAD_SOURCE_GROUP or normalized.startswith(
            f"{AUTO_FETCHED_UPLOAD_SOURCE_GROUP}/"
        ):
            return (3, normalized)
        return (2, normalized)

    def uploaded_bundle_label(self, source_group: str) -> str:
        group_slug = self._slug_fragment(source_group.replace("/", "-"))
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        return f"{group_slug}-upload-{timestamp}"

    def uploaded_target_path(self, relative_path: str) -> Path:
        raw_value = str(relative_path or "").strip().replace("\\", "/")
        if not raw_value:
            raise self.error_cls("MIB path is required.")
        upload_root = self.upload_dir().resolve()
        target = (upload_root / raw_value).resolve()
        try:
            target.relative_to(upload_root)
        except ValueError as exc:
            raise self.error_cls("MIB path must stay within the managed upload directory.") from exc
        return target

    def prune_empty_upload_dirs(self, start: Path) -> None:
        current = start
        upload_root = self.upload_dir().resolve()
        while current.exists():
            try:
                resolved = current.resolve()
            except OSError:
                break
            if resolved == upload_root:
                break
            try:
                current.rmdir()
            except OSError:
                break
            current = current.parent

    def reset_source_caches(self) -> None:
        # Clear the warmed flag too: _warm_source_path_cache() is a no-op while
        # the flag is set, so leaving it behind would make every post-reset
        # lookup miss against a cache that never repopulates.
        self._source_path_cache_warmed = False
        self._source_module_path_cache.clear()
        self._source_inventory_cache = None
        self._imports_cache.clear()

    def relative_upload_path(self, path: Path) -> str | None:
        try:
            return path.resolve().relative_to(self.upload_dir().resolve()).as_posix()
        except ValueError:
            return None

    def relative_upload_directory(self, directory: Path) -> str:
        try:
            relative = directory.resolve().relative_to(self.upload_dir().resolve()).as_posix()
        except ValueError:
            return ""
        return "" if relative == "." else relative

    def relative_path_group(self, relative_path: str) -> str:
        parent = Path(relative_path).parent.as_posix()
        return ROOT_UPLOAD_SOURCE_GROUP if parent in {"", "."} else parent

    def source_group_for_path(self, source_path: Path, *, source_kind: str) -> str:
        if source_kind in MANAGED_UPLOAD_SOURCE_KINDS:
            relative_path = self.relative_upload_path(source_path)
            if relative_path:
                return self.relative_path_group(relative_path)
        if source_kind == "bundled":
            return "bundled"
        return ""

    def source_relative_path(self, source_path: Path, *, source_kind: str) -> str:
        if source_kind in MANAGED_UPLOAD_SOURCE_KINDS:
            return self.relative_upload_path(source_path) or source_path.name
        return source_path.name

    def source_group_summary(self, active_modules: Any) -> list[dict[str, Any]]:
        inventory = self.uploaded_source_inventory()
        by_group: dict[str, dict[str, Any]] = {}
        for entry in inventory:
            group = str(entry["group"] or ROOT_UPLOAD_SOURCE_GROUP)
            bucket = by_group.setdefault(
                group,
                {"name": group, "file_count": 0, "mib_names": set(), "active_module_count": 0},
            )
            bucket["file_count"] += 1
            mib_name = str(entry.get("mib_name") or "").strip()
            if mib_name:
                bucket["mib_names"].add(mib_name)
        for module in active_modules or []:
            if str(module.get("source_kind") or "").lower() not in MANAGED_UPLOAD_SOURCE_KINDS:
                continue
            group = str(module.get("source_group") or ROOT_UPLOAD_SOURCE_GROUP)
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

    def _stored_source_entry(
        self,
        *,
        relative_path: str,
        source_group: str,
        mib_name: str,
    ) -> dict[str, str]:
        return {
            "relative_path": relative_path,
            "source_group": source_group,
            "mib_name": mib_name,
        }

    def _stored_source_precedence_key(self, entry: dict[str, Any]) -> tuple[int, str, str]:
        relative_path = str(entry.get("relative_path") or "")
        source_group = str(entry.get("source_group") or entry.get("group") or "")
        return (*self.source_group_precedence_key(source_group), relative_path)

    def _stored_sources_for_mib(
        self,
        mib_name: str,
        *,
        include_candidate: dict[str, Any] | None = None,
        replace_relative_path: str | None = None,
    ) -> list[dict[str, str]]:
        normalized_name = str(mib_name or "").strip()
        if not normalized_name:
            return []

        replace_key = str(replace_relative_path or "").strip()
        seen_paths: set[str] = set()
        stored: list[dict[str, str]] = []

        for entry in self.uploaded_source_inventory():
            if str(entry.get("mib_name") or "").strip() != normalized_name:
                continue
            relative_path = str(entry.get("relative_path") or "").strip()
            if not relative_path or relative_path == replace_key or relative_path in seen_paths:
                continue
            seen_paths.add(relative_path)
            stored.append(
                self._stored_source_entry(
                    relative_path=relative_path,
                    source_group=str(entry.get("group") or ROOT_UPLOAD_SOURCE_GROUP),
                    mib_name=normalized_name,
                )
            )

        if include_candidate is not None:
            candidate_relative_path = str(include_candidate.get("relative_path") or "").strip()
            if candidate_relative_path and candidate_relative_path not in seen_paths:
                stored.append(
                    self._stored_source_entry(
                        relative_path=candidate_relative_path,
                        source_group=str(include_candidate.get("source_group") or ""),
                        mib_name=normalized_name,
                    )
                )

        return sorted(stored, key=self._stored_source_precedence_key)

    def upload_duplicate_resolution(
        self,
        *,
        mib_name: str,
        target_relative_path: str,
        source_group: str,
        will_replace: bool,
    ) -> dict[str, Any]:
        normalized_name = str(mib_name or "").strip()
        normalized_target = str(target_relative_path or "").strip()
        if not normalized_name or not normalized_target:
            return {
                "resolution_status": "unique",
                "predicted_active_relative_path": normalized_target or None,
                "predicted_active_source_group": str(source_group or "").strip() or None,
                "duplicate_sources": [],
                "warnings": [],
            }

        candidate = {
            "relative_path": normalized_target,
            "source_group": source_group,
            "mib_name": normalized_name,
        }
        stored_sources = self._stored_sources_for_mib(
            normalized_name,
            include_candidate=candidate,
            replace_relative_path=normalized_target if will_replace else None,
        )
        duplicate_sources = [
            {
                "relative_path": str(entry["relative_path"]),
                "source_group": str(entry["source_group"]),
            }
            for entry in stored_sources
            if str(entry["relative_path"]) != normalized_target
        ]
        if not duplicate_sources:
            return {
                "resolution_status": "unique",
                "predicted_active_relative_path": normalized_target,
                "predicted_active_source_group": str(source_group or "").strip() or None,
                "duplicate_sources": [],
                "warnings": [],
            }

        predicted_active = stored_sources[0]
        predicted_active_relative_path = str(
            predicted_active.get("relative_path") or normalized_target
        )
        predicted_active_source_group = str(predicted_active.get("source_group") or source_group)
        would_become_active = predicted_active_relative_path == normalized_target
        if would_become_active:
            warnings = [
                (
                    "This upload will become the active source for this MIB. "
                    "Other stored copies will remain available but shadowed."
                )
            ]
            resolution_status = "active"
        else:
            warnings = [
                (
                    "Another stored source has higher precedence and will remain active: "
                    f"{predicted_active_relative_path}. This upload will be stored but shadowed "
                    "until the higher-precedence copy is deleted or replaced."
                )
            ]
            resolution_status = "shadowed"
        return {
            "resolution_status": resolution_status,
            "predicted_active_relative_path": predicted_active_relative_path,
            "predicted_active_source_group": predicted_active_source_group,
            "duplicate_sources": duplicate_sources,
            "warnings": warnings,
        }

    def active_source_map(self) -> dict[str, dict[str, Any]]:
        active_bundle = self.active_bundle_summary()
        if active_bundle is None:
            return {}

        active_sources: dict[str, dict[str, Any]] = {}
        for module in active_bundle["modules"]:
            resolved_source = module.get("source_path") or self.source_path_for_module(module["module_name"])
            source_path = Path(resolved_source or module.get("compiled_path") or module["module_name"])
            source_kind = self.module_source_kind(source_path)
            active_sources[module["module_name"]] = {
                "module_name": module["module_name"],
                "relative_path": self.source_relative_path(source_path, source_kind=source_kind),
                "source_group": self.source_group_for_path(source_path, source_kind=source_kind),
                "source_kind": source_kind,
            }
        return active_sources

    def promoted_active_sources(
        self,
        *,
        before_active_sources: dict[str, dict[str, Any]],
        after_active_sources: dict[str, dict[str, Any]],
        deleted_paths: list[str],
    ) -> list[dict[str, Any]]:
        deleted = {str(path or "").strip() for path in deleted_paths if str(path or "").strip()}
        if not deleted:
            return []

        promotions: list[dict[str, Any]] = []
        for module_name, previous in before_active_sources.items():
            previous_relative_path = str(previous.get("relative_path") or "").strip()
            if previous_relative_path not in deleted:
                continue
            current = after_active_sources.get(module_name)
            if current is None:
                continue
            current_relative_path = str(current.get("relative_path") or "").strip()
            if not current_relative_path or current_relative_path == previous_relative_path:
                continue
            promotions.append(
                {
                    "mib_name": module_name,
                    "previous_relative_path": previous_relative_path,
                    "active_relative_path": current_relative_path,
                    "source_group": current.get("source_group"),
                    "source_kind": current.get("source_kind"),
                }
            )
        return sorted(promotions, key=lambda item: item["mib_name"])

    def extract_mib_name(self, filename: str, text: str) -> str:
        match = _MIB_DEFINITIONS_RE.search(text)
        if match is not None:
            return match.group(1).strip()
        return Path(filename).stem

    def storage_file_name(self, filename: str, mib_name: str) -> str:
        suffix = Path(filename).suffix.lower()
        if suffix not in _SUPPORTED_MIB_EXTENSIONS:
            return Path(filename).name
        normalized_mib_name = str(mib_name or "").strip()
        if normalized_mib_name:
            return f"{normalized_mib_name}{suffix}"
        return Path(filename).name

    def extract_imported_modules(self, text: str) -> list[str]:
        seen: set[str] = set()
        imports: list[str] = []
        for module_name in _MIB_IMPORT_RE.findall(text):
            normalized = module_name.strip()
            if not normalized or normalized in seen:
                continue
            imports.append(normalized)
            seen.add(normalized)
        return imports

    def source_mib_names_in_dir(self, directory: Path, *, recursive: bool = False) -> list[str]:
        names: list[str] = []
        for path in self.iter_source_files(directory, recursive=recursive):
            try:
                text = path.read_text(errors="ignore")
            except OSError:
                continue
            name = self.extract_mib_name(path.name, text)
            if name:
                names.append(name)
        return self.unique_mib_names(names)

    def missing_dependencies_from_error(self, error_text: str | None) -> list[str]:
        # Legacy fallback: parse "MIB 'X' not found" strings still present in some error paths.
        # Structured missing_dependencies from CompileResult are used where available.
        if not error_text:
            return []
        import re as _re
        pattern = _re.compile(r"MIB '([^']+)' not found")
        return sorted({name.strip() for name in pattern.findall(error_text) if name.strip()})

    def module_source_kind(self, source_path: Path) -> str:
        try:
            resolved = source_path.resolve()
        except FileNotFoundError:
            resolved = source_path
        try:
            relative = resolved.relative_to(self.upload_dir())
            group = self.relative_path_group(relative.as_posix())
            if group == AUTO_FETCHED_UPLOAD_SOURCE_GROUP or group.startswith(
                f"{AUTO_FETCHED_UPLOAD_SOURCE_GROUP}/"
            ):
                return "auto-fetched"
            return "uploaded"
        except ValueError:
            pass
        try:
            resolved.relative_to(self.bundled_mibs_dir())
            return "bundled"
        except ValueError:
            return "compiled"

    def _warm_source_path_cache(self) -> None:
        """Scan all upload directories once and build a complete mib_name→path index.

        The upload-dir portion reuses the inventory scan (MGR-05) — the
        declared MIB name is already extracted there, so no second file read.
        Bundled sources are read once and indexed by stem and declared name.
        After this runs, source_path_for_module will always hit the cache — no
        per-module disk scan needed.
        """
        if getattr(self, "_source_path_cache_warmed", False):
            return
        self._source_path_cache_warmed = True

        for entry in self.uploaded_source_inventory():
            path = entry["path"]
            stem = path.stem
            # Always index by stem
            if stem not in self._source_module_path_cache:
                self._source_module_path_cache[stem] = path
            # Also index by declared MIB name from the inventory scan
            declared = str(entry.get("mib_name") or "").strip()
            if declared and declared not in self._source_module_path_cache:
                self._source_module_path_cache[declared] = path

        for path in self.iter_source_files(self.bundled_mibs_dir(), recursive=True):
            stem = path.stem
            if stem not in self._source_module_path_cache:
                self._source_module_path_cache[stem] = path
            try:
                text = path.read_text(errors="ignore")
                declared = self.extract_mib_name(path.name, text)
                if declared and declared not in self._source_module_path_cache:
                    self._source_module_path_cache[declared] = path
            except OSError:
                pass

    def source_path_for_module(
        self,
        module_name: str,
        *,
        hint_path: Path | None = None,
    ) -> Path | None:
        if hint_path is not None and hint_path.exists():
            return hint_path

        # Warm entire cache in one pass before any lookup
        self._warm_source_path_cache()

        # Return cached result — None means "not found in upload dirs"
        return self._source_module_path_cache.get(module_name, None)

    def materialize_cached_remote_modules(
        self,
        module_names: list[str],
        *,
        bundle_set_id: int | None = None,
    ) -> dict[str, str]:
        raw_cache_dir = self.tsmi_cache_dir() / "raw"
        if not raw_cache_dir.exists():
            return {}

        persisted: dict[str, str] = {}
        target_dir = self.upload_dir() / AUTO_FETCHED_UPLOAD_SOURCE_GROUP
        target_dir.mkdir(parents=True, exist_ok=True)

        for module_name in self.unique_mib_names(module_names):
            if not module_name:
                continue
            existing_source = self.source_path_for_module(module_name)
            if existing_source is not None and existing_source.exists():
                source_kind = self.module_source_kind(existing_source)
                if source_kind in MANAGED_UPLOAD_SOURCE_KINDS:
                    persisted[module_name] = str(existing_source)
                    continue

            cached_source = self.cached_remote_source_path(module_name)
            if cached_source is None:
                continue

            suffix = cached_source.suffix.lower()
            if suffix not in _SUPPORTED_MIB_EXTENSIONS:
                suffix = ".mib"
            target_path = target_dir / f"{module_name}{suffix}"
            target_path.write_text(cached_source.read_text(errors="ignore"), encoding="utf-8")
            persisted[module_name] = str(target_path)

        if not persisted:
            return {}

        self.reset_source_caches()
        if bundle_set_id is not None:
            with self.session_factory() as session:
                bundle_modules = session.scalars(
                    select(BundleModule)
                    .where(BundleModule.bundle_set_id == bundle_set_id)
                    .where(BundleModule.module_name.in_(list(persisted.keys())))
                ).all()
                for module in bundle_modules:
                    source_path = persisted.get(module.module_name)
                    if source_path:
                        module.source_path = source_path
                session.commit()

        self.emit_operation_log(
            f"Persisted auto-fetched MIB sources: count={len(persisted)}",
        )
        self.emit_operation_log(
            "Persisted auto-fetched MIB source detail: " + ", ".join(sorted(persisted)),
            level="DEBUG",
        )
        return persisted

    def cached_remote_source_path(self, module_name: str) -> Path | None:
        raw_cache_dir = self.tsmi_cache_dir() / "raw"
        if not raw_cache_dir.exists():
            return None
        for path in sorted(raw_cache_dir.glob("*"), reverse=True):
            if not path.is_file():
                continue
            try:
                text = path.read_text(errors="ignore")
            except OSError:
                continue
            if self.extract_mib_name(path.name, text) == module_name:
                return path
        return None

    def _slug_fragment(self, value: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "-", str(value or "").strip().lower()).strip("-")
        return slug or "bundle"
