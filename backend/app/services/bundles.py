from __future__ import annotations

import asyncio
import concurrent.futures
import hashlib
import json
import logging
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from trishul_smi import CompilerConfig, FileReader, HttpReader, MibCompiler
from trishul_snmp import load_bundle as _load_tsnmp_bundle

from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.core.config import Settings, get_settings
from app.db.session import create_session_factory
from app.models import AppSetting, BundleModule, BundleSet, CompileRun

SUPPORTED_MIB_SUFFIXES = (".txt", ".mib", ".my")
_MIB_DEFINITIONS_RE = re.compile(r"^\s*([A-Za-z0-9-]+)\s+DEFINITIONS\s*::=\s*BEGIN", re.MULTILINE)
_INVALID_COMPILE_ERROR_RE = re.compile(
    r"(failed to parse mib|parse error|unexpected error .*parse|cannot parse)",
    re.IGNORECASE,
)
BUNDLED_STARTER_MIBS = (
    "IF-MIB",
    "IANAifType-MIB",
    "SNMP-FRAMEWORK-MIB",
    "SNMPv2-CONF",
    "SNMPv2-MIB",
    "SNMPv2-SMI",
    "SNMPv2-TC",
)
logger = logging.getLogger(__name__)
_LOG_PREVIEW_LIMIT = 10

# Producer version at which enum/units metadata entered the MIB JSON IR.
# Bundles compiled by older producers lack these capabilities.
CAPABILITY_FLOOR = "0.5.2"
PRODUCER_CAPABILITIES = {"enums": "0.5.2", "units": "0.5.2"}

# MGR-06: compiles are heavy, write into a shared bundle-sets directory, and
# can spawn remote fetches. Concurrent compiles from different requests (e.g.
# two browser tabs) would corrupt each other's output, so all compiles are
# serialized process-wide.
_COMPILE_LOCK = threading.Lock()


def _producer_version_below(version: Any, floor: str) -> bool:
    """True when *version* is a parseable producer version strictly below *floor*.

    A missing, blank, or otherwise unparseable producer version means the
    manifest predates producer capability tracking — treat it as below the
    floor so those bundles get the recompile recommendation instead of
    silently passing as modern.
    """
    if isinstance(version, bool):
        return True
    if isinstance(version, (int, float)):
        version = str(version)
    if not isinstance(version, str) or not version.strip():
        return True

    def _parts(value: str) -> list[int]:
        parts: list[int] = []
        for chunk in value.split("."):
            digits = ""
            for char in chunk:
                if char.isdigit():
                    digits += char
                else:
                    break
            if not digits:
                break
            parts.append(int(digits))
        return parts

    return _parts(version) < _parts(floor)


def _missing_capabilities(producer_version: Any) -> list[str]:
    """Capabilities (sorted) that a producer below ``producer_version`` lacks."""
    return sorted(
        name
        for name, floor in PRODUCER_CAPABILITIES.items()
        if _producer_version_below(producer_version, floor)
    )


def _preview_items(items: list[str], *, limit: int = _LOG_PREVIEW_LIMIT) -> str:
    normalized = [str(item).strip() for item in items if str(item).strip()]
    if not normalized:
        return ""
    if len(normalized) <= limit:
        return ", ".join(normalized)
    return f"{', '.join(normalized[:limit])}, +{len(normalized) - limit} more"


class BundleServiceError(RuntimeError):
    """Raised when bundle lifecycle operations fail."""


@dataclass(slots=True)
class BundleCompileRequest:
    mib_names: list[str]
    mib_dirs: list[str] | None = None
    label: str | None = None
    activate: bool = False
    online: bool = False
    remote_sources: list[str] | None = None


class BundleService:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.session_factory = create_session_factory(self.settings.database_url)

    def ensure_bootstrap_bundle(self) -> dict[str, Any] | None:
        with self.session_factory() as session:
            active_bundle = self._select_active_bundle(session)
            if active_bundle is not None:
                return self._bundle_summary(active_bundle)

            starter_bundle = self._select_bundle_by_label(session, "Bundled Starter MIBs")

        if starter_bundle is not None:
            logger.info(
                "No active bundle flag found; activating bundled starter bundle %s",
                starter_bundle.bundle_key,
            )
            return self.activate_bundle(starter_bundle.id)["bundle"]

        starter_mibs = self._bundled_mib_names()
        if not starter_mibs:
            logger.warning("Bundled MIB bootstrap skipped because no bundled source files were found")
            return None

        logger.info(
            "Bootstrapping bundled starter bundle from %d bundled MIB sources",
            len(starter_mibs),
        )
        result = self.compile_bundle(
            BundleCompileRequest(
                mib_names=starter_mibs,
                mib_dirs=[str(self.settings.bundled_mibs_dir)],
                activate=True,
                label="Bundled Starter MIBs",
            )
        )
        return result["activation"]["bundle"]

    def get_effective_bundle_summary(self) -> dict[str, Any] | None:
        with self.session_factory() as session:
            bundle = self._select_active_bundle(session) or self._select_latest_bundle(session)
            if bundle is None:
                return None
            return self._bundle_summary(bundle)

    def get_effective_bundle_manifest_summary(self) -> dict[str, Any] | None:
        """Manifest summary for the effective bundle, or None when unavailable."""
        with self.session_factory() as session:
            bundle = self._select_active_bundle(session) or self._select_latest_bundle(session)
            if bundle is None:
                return None
            try:
                manifest = self._load_manifest(bundle)
            except BundleServiceError:
                return None
            return self._manifest_summary(manifest)

    def bundled_mib_names(self) -> list[str]:
        return self._bundled_mib_names()

    def list_state(self) -> dict[str, Any]:
        with self.session_factory() as session:
            bundles = session.scalars(select(BundleSet).order_by(BundleSet.id.desc())).all()
            compile_runs = session.scalars(select(CompileRun).order_by(CompileRun.id.desc()).limit(10)).all()
            module_counts = dict(
                session.execute(
                    select(BundleModule.bundle_set_id, func.count(BundleModule.id))
                    .group_by(BundleModule.bundle_set_id)
                ).all()
            )
            active_bundle_id = self._get_setting_value(session, "active_bundle_id")
            previous_active_bundle_id = self._get_setting_value(session, "previous_active_bundle_id")
            pointer = self._read_active_pointer(
                session,
                active_bundle_id=active_bundle_id,
                previous_active_bundle_id=previous_active_bundle_id,
            )

            return {
                "paths": {
                    "bundles_dir": str(self.settings.bundles_dir),
                    "bundle_sets_dir": str(self.settings.bundle_sets_dir),
                    "tsmi_cache_dir": str(self.settings.tsmi_cache_dir),
                },
                "active_bundle_id": active_bundle_id,
                "previous_active_bundle_id": previous_active_bundle_id,
                "active_pointer": pointer,
                "bundles": [
                    self._bundle_list_summary(bundle, module_counts.get(bundle.id, 0))
                    for bundle in bundles
                ],
                "compile_runs": [self._compile_run_summary(compile_run) for compile_run in compile_runs],
            }

    def compile_bundle(self, request: BundleCompileRequest) -> dict[str, Any]:
        mib_names = self._unique_mib_names(request.mib_names)
        source_dirs = self._resolve_source_dirs(request.mib_dirs)
        selected_source_paths = self._selected_source_paths(mib_names, source_dirs)

        # MGR-06: one compile at a time process-wide (see _COMPILE_LOCK). The
        # lock spans the DB writes too, so a fresh "running" run row is always
        # recorded before the next compile starts.
        with _COMPILE_LOCK:
            with self.session_factory() as session:
                compile_run = CompileRun(
                    requested_mib_names_json=mib_names,
                    source_dirs_json=[str(path) for path in source_dirs],
                    status="running",
                    started_at=datetime.now(timezone.utc),
                )
                session.add(compile_run)
                session.commit()
                session.refresh(compile_run)
                compile_run_id = compile_run.id

                bundle_key = self._build_bundle_key(
                    compile_run_id, mib_names or [source_dirs[0].name]
                )
                bundle_dir = self.settings.bundle_sets_dir / bundle_key
                bundle_dir.mkdir(parents=True, exist_ok=False)

                compile_meta = {
                    "mib_names": mib_names,
                    "source_dirs": [str(p) for p in source_dirs],
                    "selected_source_paths": selected_source_paths,
                    "output_dir": str(bundle_dir),
                    "online": request.online,
                    "remote_sources": request.remote_sources or [],
                }
                compile_run.command_json = dict(compile_meta)
                compile_run.bundle_key = bundle_key
                compile_run.output_dir = str(bundle_dir)
                session.commit()

            # MGR-06: the compiler runs with NO DB session open. The "running"
            # run row is already committed above; the outcome is recorded below
            # in a fresh session. A slow compile therefore never pins a pooled
            # connection or an open transaction.
            normalized_sources = [
                str(s).strip() for s in (request.remote_sources or []) if str(s).strip()
            ]
            use_http = request.online or bool(normalized_sources)
            logger.info(
                "Starting bundle compile %s modules=%d source_dirs=%d remote_fetch=%s output_dir=%s",
                bundle_key,
                len(mib_names),
                len(source_dirs),
                use_http,
                bundle_dir,
            )
            logger.debug(
                "Bundle compile %s detail: modules=%s source_dirs=%s remote_sources=%s",
                bundle_key,
                mib_names,
                [str(p) for p in source_dirs],
                normalized_sources,
            )
            config = CompilerConfig(
                output_dir=bundle_dir,
                cache_dir=self.settings.tsmi_cache_dir,
                emit_manifest=True,
                emit_oid_index=True,
                reproducible=True,
                **({} if not normalized_sources else {"sources": normalized_sources}),
            )
            compiler = MibCompiler(config)
            for source_dir in source_dirs:
                compiler.add_reader(FileReader(source_dir))

            async def _run_compile():
                if use_http:
                    async with HttpReader(*config.sources) as http:
                        compiler.add_reader(http)
                        return await compiler.compile(*mib_names)
                return await compiler.compile(*mib_names)

            # Run the async compiler synchronously — works whether or not an
            # event loop is already running (lifespan context, tests, etc.).
            try:
                running_loop = asyncio.get_running_loop()
            except RuntimeError:
                running_loop = None

            if running_loop is not None:
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(asyncio.run, _run_compile())
                    results = future.result()
            else:
                results = asyncio.run(_run_compile())

            failed = [r for r in results if r.status == "failed"]
            missing = [r for r in results if r.status == "missing"]
            compile_meta["result_rows"] = self._compile_result_rows(results, source_dirs)

            with self.session_factory() as session:
                compile_run = session.get(CompileRun, compile_run_id)
                if compile_run is None:
                    raise BundleServiceError(
                        f"Compile run {compile_run_id} disappeared mid-compile."
                    )
                compile_run.finished_at = datetime.now(timezone.utc)

                if failed or missing:
                    missing_deps = sorted({
                        dep
                        for r in (failed + missing)
                        for dep in r.missing_dependencies
                    })
                    error_parts = [r.error for r in (failed + missing) if r.error]
                    error_text = "; ".join(error_parts) or "tsmi compile failed"
                    compile_run.status = "failed"
                    compile_run.error_text = error_text
                    compile_run.command_json = dict(compile_meta)
                    session.commit()
                    logger.error(
                        "Bundle compile failed for %s failed=%d missing=%d error=%s",
                        bundle_key,
                        len(failed),
                        len(missing),
                        error_text,
                    )
                    if missing_deps:
                        logger.warning(
                            "Bundle compile %s unresolved dependencies: %s",
                            bundle_key,
                            _preview_items(missing_deps),
                        )
                    logger.debug(
                        "Bundle compile %s failure detail: result_rows=%s",
                        bundle_key,
                        compile_meta["result_rows"],
                    )
                    raise BundleServiceError(error_text)

                manifest_path = bundle_dir / "manifest.json"
                oid_index_path = bundle_dir / "oid_index.json"
                manifest = json.loads(manifest_path.read_text())

                bundle_set = BundleSet(
                    bundle_key=bundle_key,
                    label=request.label or self._default_label(mib_names, manifest),
                    storage_path=str(bundle_dir),
                    manifest_path=str(manifest_path),
                    oid_index_path=str(oid_index_path),
                    status="compiled",
                    is_active=False,
                )
                session.add(bundle_set)
                session.flush()

                for module in manifest.get("modules", []):
                    module_name = module["module"]
                    compiled_path = bundle_dir / module["file"]
                    compiled_data = json.loads(compiled_path.read_text())
                    bundle_set.modules.append(
                        BundleModule(
                            module_name=module_name,
                            source_path=self._find_source_path(module_name, source_dirs),
                            compiled_path=str(compiled_path),
                            module_identity_oid=self._extract_module_identity_oid(compiled_data),
                            object_count=len(compiled_data.get("objects", {})),
                            notification_count=len(compiled_data.get("notifications", {})),
                        )
                    )

                bundle_set.content_hash = self._compute_content_hash(bundle_dir, manifest)
                compile_run.bundle_set_id = bundle_set.id
                compile_run.manifest_path = str(manifest_path)
                compile_run.oid_index_path = str(oid_index_path)
                compile_run.status = "succeeded"
                compile_run.command_json = dict(compile_meta)
                session.commit()
                session.refresh(bundle_set)
                session.refresh(compile_run)
                remote_modules = sorted(
                    module.module_name
                    for module in bundle_set.modules
                    if not module.source_path
                )

                logger.info(
                    "Bundle compile succeeded for %s modules=%d remote_modules=%d",
                    bundle_key,
                    len(bundle_set.modules),
                    len(remote_modules),
                )
                logger.debug(
                    "Bundle compile %s detail: remote_modules=%s",
                    bundle_key,
                    remote_modules,
                )

                result = {
                    "compile_run": self._compile_run_summary(compile_run),
                    "bundle": self._bundle_summary(bundle_set),
                    "remote_modules": remote_modules,
                }
                bundle_set_id = bundle_set.id
            if request.activate:
                result["activation"] = self.activate_bundle(bundle_set_id)
            return result

    def activate_bundle(self, bundle_set_id: int) -> dict[str, Any]:
        with self.session_factory() as session:
            target = session.get(BundleSet, bundle_set_id)
            if target is None:
                raise BundleServiceError(f"Bundle set {bundle_set_id} does not exist.")

            if not Path(target.manifest_path or "").exists():
                raise BundleServiceError(f"Bundle set {bundle_set_id} is missing manifest.json.")

            current_active_id = self._get_setting_value(session, "active_bundle_id")

            for bundle in session.scalars(select(BundleSet)).all():
                if bundle.id == bundle_set_id:
                    bundle.is_active = True
                    bundle.status = "active"
                elif bundle.is_active:
                    bundle.is_active = False
                    bundle.status = "compiled"

            self._set_setting_value(session, "previous_active_bundle_id", current_active_id)
            self._set_setting_value(session, "active_bundle_id", bundle_set_id)

            # Load the activated bundle into memory BEFORE committing the
            # pointer swap. If the compiled data cannot be loaded, the DB
            # transaction rolls back (the previous active bundle keeps
            # serving) and the caller gets a real error instead of a
            # pointer that claims an active bundle nothing can serve.
            from app.services.bundle_state import set_bundle
            try:
                loaded_bundle = _load_tsnmp_bundle(target.storage_path)
            except Exception as exc:
                logger.exception(
                    "Failed to load activated bundle into memory: %s", target.storage_path
                )
                raise BundleServiceError(
                    f"Failed to activate bundle set {bundle_set_id}: "
                    "its compiled data could not be loaded. The previously "
                    "active bundle remains in effect."
                ) from exc

            session.commit()
            session.refresh(target)
            set_bundle(loaded_bundle)

            return {
                "active_bundle_id": bundle_set_id,
                "previous_active_bundle_id": current_active_id,
                "bundle": self._bundle_summary(target),
                "active_pointer": self._active_pointer_payload(target, current_active_id),
            }

    def get_bundle(self, bundle_set_id: int) -> dict[str, Any]:
        with self.session_factory() as session:
            bundle = session.get(BundleSet, bundle_set_id)
            if bundle is None:
                raise BundleServiceError(f"Bundle set {bundle_set_id} does not exist.")

            manifest = self._load_manifest(bundle)
            module_payloads = self._load_module_payloads(bundle)
            compile_runs = session.scalars(
                select(CompileRun)
                .where(CompileRun.bundle_set_id == bundle.id)
                .order_by(CompileRun.id.desc())
            ).all()

            return {
                "bundle": self._bundle_summary(bundle),
                "manifest": self._manifest_summary(manifest),
                "dependency_graph": self._dependency_graph(bundle, module_payloads),
                "compile_runs": [self._compile_run_detail(run) for run in compile_runs],
            }

    def diff_bundles(self, left_bundle_set_id: int, right_bundle_set_id: int) -> dict[str, Any]:
        with self.session_factory() as session:
            left_bundle = session.get(BundleSet, left_bundle_set_id)
            if left_bundle is None:
                raise BundleServiceError(f"Bundle set {left_bundle_set_id} does not exist.")
            right_bundle = session.get(BundleSet, right_bundle_set_id)
            if right_bundle is None:
                raise BundleServiceError(f"Bundle set {right_bundle_set_id} does not exist.")

            if (
                left_bundle.content_hash is not None
                and right_bundle.content_hash is not None
                and left_bundle.content_hash == right_bundle.content_hash
            ):
                # Content-hash fast path: identical hashes prove the module
                # files are byte-for-byte equivalent, so no per-module
                # comparison work is needed.
                return {
                    "identical": True,
                    "hash": left_bundle.content_hash,
                    "left_bundle": self._bundle_summary(left_bundle),
                    "right_bundle": self._bundle_summary(right_bundle),
                }

            left_payloads = self._load_module_payloads(left_bundle)
            right_payloads = self._load_module_payloads(right_bundle)
            left_modules = {module.module_name: module for module in left_bundle.modules}
            right_modules = {module.module_name: module for module in right_bundle.modules}

            left_names = set(left_modules)
            right_names = set(right_modules)
            added_names = sorted(right_names - left_names)
            removed_names = sorted(left_names - right_names)

            modules_changed: list[dict[str, Any]] = []
            total_objects_added = sum(right_modules[name].object_count for name in added_names)
            total_objects_removed = sum(left_modules[name].object_count for name in removed_names)
            total_objects_changed = 0
            total_notifications_added = sum(
                right_modules[name].notification_count for name in added_names
            )
            total_notifications_removed = sum(
                left_modules[name].notification_count for name in removed_names
            )
            total_notifications_changed = 0

            for module_name in sorted(left_names & right_names):
                change = self._module_diff(
                    module_name=module_name,
                    left_module=left_modules[module_name],
                    right_module=right_modules[module_name],
                    left_payload=left_payloads[module_name],
                    right_payload=right_payloads[module_name],
                )
                if change is None:
                    continue
                modules_changed.append(change)
                total_objects_added += len(change["objects"]["added"])
                total_objects_removed += len(change["objects"]["removed"])
                total_objects_changed += len(change["objects"]["changed"])
                total_notifications_added += len(change["notifications"]["added"])
                total_notifications_removed += len(change["notifications"]["removed"])
                total_notifications_changed += len(change["notifications"]["changed"])

            return {
                "identical": False,
                "left_bundle": self._bundle_summary(left_bundle),
                "right_bundle": self._bundle_summary(right_bundle),
                "summary": {
                    "modules": {
                        "left_total": len(left_names),
                        "right_total": len(right_names),
                        "added": len(added_names),
                        "removed": len(removed_names),
                        "changed": len(modules_changed),
                    },
                    "objects": {
                        "left_total": sum(module.object_count for module in left_bundle.modules),
                        "right_total": sum(module.object_count for module in right_bundle.modules),
                        "added": total_objects_added,
                        "removed": total_objects_removed,
                        "changed": total_objects_changed,
                    },
                    "notifications": {
                        "left_total": sum(module.notification_count for module in left_bundle.modules),
                        "right_total": sum(module.notification_count for module in right_bundle.modules),
                        "added": total_notifications_added,
                        "removed": total_notifications_removed,
                        "changed": total_notifications_changed,
                    },
                },
                "modules_added": [
                    self._bundle_module_inventory(right_modules[name], right_payloads[name])
                    for name in added_names
                ],
                "modules_removed": [
                    self._bundle_module_inventory(left_modules[name], left_payloads[name])
                    for name in removed_names
                ],
                "modules_changed": modules_changed,
            }

    def rollback_bundle(self) -> dict[str, Any]:
        with self.session_factory() as session:
            previous_active_id = self._get_setting_value(session, "previous_active_bundle_id")

        if previous_active_id is None:
            raise BundleServiceError("No previous active bundle is available for rollback.")

        return self.activate_bundle(previous_active_id)

    def sync_active_pointer(self) -> dict[str, Any] | None:
        return self.read_active_pointer()

    def read_active_pointer(self) -> dict[str, Any] | None:
        with self.session_factory() as session:
            active_bundle_id = self._get_setting_value(session, "active_bundle_id")
            previous_active_bundle_id = self._get_setting_value(session, "previous_active_bundle_id")
            return self._read_active_pointer(
                session,
                active_bundle_id=active_bundle_id,
                previous_active_bundle_id=previous_active_bundle_id,
            )

    def _load_manifest(self, bundle: BundleSet) -> dict[str, Any]:
        manifest_path = Path(bundle.manifest_path or "")
        if not manifest_path.exists():
            raise BundleServiceError(
                f"Bundle set {bundle.id} is missing manifest.json."
            )
        return json.loads(manifest_path.read_text())

    def _compute_content_hash(self, bundle_dir: Path, manifest: dict[str, Any]) -> str:
        """SHA-256 over the sorted manifest-declared module files."""
        hasher = hashlib.sha256()
        module_files = sorted(
            str(entry.get("file") or "")
            for entry in manifest.get("modules", [])
            if str(entry.get("file") or "").strip()
        )
        for filename in module_files:
            hasher.update(Path(bundle_dir, filename).read_bytes())
        return hasher.hexdigest()

    def _load_module_payloads(self, bundle: BundleSet) -> dict[str, dict[str, Any]]:
        payloads: dict[str, dict[str, Any]] = {}
        for module in bundle.modules:
            compiled_path = Path(module.compiled_path or "")
            if not compiled_path.exists():
                raise BundleServiceError(
                    f"Compiled JSON for module {module.module_name} is missing: {compiled_path}"
                )
            payloads[module.module_name] = json.loads(compiled_path.read_text())
        return payloads

    def _manifest_summary(self, manifest: dict[str, Any]) -> dict[str, Any]:
        producer_version = manifest.get("producer_version")
        missing_capabilities = _missing_capabilities(producer_version)
        return {
            "schema_version": manifest.get("schema_version"),
            "producer_version": producer_version,
            "generated_by": manifest.get("generated_by"),
            "generated_at": manifest.get("generated_at"),
            "modules": [entry.get("module") for entry in manifest.get("modules", [])],
            "sidecars": manifest.get("sidecars", {}),
            "recompile_recommended": bool(missing_capabilities),
            "missing_capabilities": missing_capabilities,
        }

    def _dependency_graph(
        self,
        bundle: BundleSet,
        module_payloads: dict[str, dict[str, Any]],
    ) -> dict[str, Any]:
        present_names = {module.module_name for module in bundle.modules}
        incoming: dict[str, set[str]] = {name: set() for name in present_names}
        external_dependencies: set[str] = set()
        edges: list[dict[str, Any]] = []
        nodes: list[dict[str, Any]] = []

        for module in sorted(bundle.modules, key=lambda item: item.module_name):
            payload = module_payloads[module.module_name]
            imports = payload.get("imports", {})
            import_rows = []
            for imported_module in sorted(imports):
                symbols = sorted(str(symbol) for symbol in imports.get(imported_module, []))
                target_present = imported_module in present_names
                if target_present:
                    incoming.setdefault(imported_module, set()).add(module.module_name)
                else:
                    external_dependencies.add(imported_module)
                edge = {
                    "source": module.module_name,
                    "target": imported_module,
                    "symbol_count": len(symbols),
                    "symbols": symbols,
                    "target_present": target_present,
                }
                edges.append(edge)
                import_rows.append(edge)

            nodes.append(
                {
                    "module_name": module.module_name,
                    "module_identity_oid": module.module_identity_oid,
                    "source_path": module.source_path,
                    "compiled_path": module.compiled_path,
                    "object_count": module.object_count,
                    "notification_count": module.notification_count,
                    "imports": import_rows,
                    "imported_by": [],
                }
            )

        for node in nodes:
            node["imported_by"] = sorted(incoming.get(node["module_name"], set()))

        return {
            "nodes": nodes,
            "edges": sorted(edges, key=lambda edge: (edge["source"], edge["target"])),
            "external_dependencies": sorted(external_dependencies),
        }

    def _bundle_module_inventory(
        self,
        module: BundleModule,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        return {
            "module_name": module.module_name,
            "module_identity_oid": module.module_identity_oid,
            "object_count": module.object_count,
            "notification_count": module.notification_count,
            "imports": sorted(payload.get("imports", {}).keys()),
        }

    def _module_diff(
        self,
        *,
        module_name: str,
        left_module: BundleModule,
        right_module: BundleModule,
        left_payload: dict[str, Any],
        right_payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        object_diff = self._named_map_diff(
            left_payload.get("objects", {}),
            right_payload.get("objects", {}),
        )
        notification_diff = self._named_map_diff(
            left_payload.get("notifications", {}),
            right_payload.get("notifications", {}),
        )
        import_diff = self._imports_diff(
            left_payload.get("imports", {}),
            right_payload.get("imports", {}),
        )

        changed = any(
            (
                object_diff["added"],
                object_diff["removed"],
                object_diff["changed"],
                notification_diff["added"],
                notification_diff["removed"],
                notification_diff["changed"],
                import_diff["added_modules"],
                import_diff["removed_modules"],
                import_diff["changed_modules"],
            )
        )
        if not changed:
            return None

        return {
            "module_name": module_name,
            "left": self._bundle_module_inventory(left_module, left_payload),
            "right": self._bundle_module_inventory(right_module, right_payload),
            "objects": object_diff,
            "notifications": notification_diff,
            "imports": import_diff,
        }

    def _named_map_diff(
        self,
        left_items: dict[str, Any],
        right_items: dict[str, Any],
    ) -> dict[str, Any]:
        left_names = set(left_items)
        right_names = set(right_items)
        common = left_names & right_names
        return {
            "left_total": len(left_names),
            "right_total": len(right_names),
            "added": sorted(right_names - left_names),
            "removed": sorted(left_names - right_names),
            "changed": sorted(
                name for name in common if left_items[name] != right_items[name]
            ),
        }

    def _imports_diff(
        self,
        left_imports: dict[str, list[str]],
        right_imports: dict[str, list[str]],
    ) -> dict[str, Any]:
        left_modules = set(left_imports)
        right_modules = set(right_imports)
        changed_modules: list[dict[str, Any]] = []

        for module_name in sorted(left_modules & right_modules):
            left_symbols = {str(symbol) for symbol in left_imports.get(module_name, [])}
            right_symbols = {str(symbol) for symbol in right_imports.get(module_name, [])}
            if left_symbols == right_symbols:
                continue
            changed_modules.append(
                {
                    "module_name": module_name,
                    "added_symbols": sorted(right_symbols - left_symbols),
                    "removed_symbols": sorted(left_symbols - right_symbols),
                }
            )

        return {
            "added_modules": sorted(right_modules - left_modules),
            "removed_modules": sorted(left_modules - right_modules),
            "changed_modules": changed_modules,
        }

    def _resolve_source_dirs(self, configured_dirs: list[str] | None) -> list[Path]:
        raw_dirs = configured_dirs or [str(self.settings.bundled_mibs_dir)]
        resolved_dirs: list[Path] = []
        for raw_dir in raw_dirs:
            path = Path(raw_dir).expanduser()
            if not path.is_absolute():
                path = (self.settings.repo_root / path).resolve()
            if not path.exists():
                raise BundleServiceError(f"MIB source directory does not exist: {path}")
            resolved_dirs.append(path)
        return resolved_dirs

    def _unique_mib_names(self, raw_names: list[str]) -> list[str]:
        ordered: list[str] = []
        seen: set[str] = set()
        for raw_name in raw_names:
            name = raw_name.strip()
            if not name or name in seen:
                continue
            ordered.append(name)
            seen.add(name)
        return ordered

    def _bundled_mib_names(self) -> list[str]:
        if not self.settings.bundled_mibs_dir.exists():
            return []
        available = {
            path.stem
            for path in self.settings.bundled_mibs_dir.iterdir()
            if path.is_file() and path.suffix.lower() in SUPPORTED_MIB_SUFFIXES
        }
        missing = [name for name in BUNDLED_STARTER_MIBS if name not in available]
        if missing:
            logger.warning("Bundled starter MIB set is incomplete; missing files for %s", missing)
        return [name for name in BUNDLED_STARTER_MIBS if name in available]

    def _select_active_bundle(self, session) -> BundleSet | None:
        stmt = (
            select(BundleSet)
            .options(selectinload(BundleSet.modules))
            .where(BundleSet.is_active.is_(True))
            .order_by(BundleSet.id.desc())
            .limit(1)
        )
        return session.scalars(stmt).first()

    def _select_latest_bundle(self, session) -> BundleSet | None:
        stmt = select(BundleSet).options(selectinload(BundleSet.modules)).order_by(BundleSet.id.desc()).limit(1)
        return session.scalars(stmt).first()

    def _select_bundle_by_label(self, session, label: str) -> BundleSet | None:
        stmt = (
            select(BundleSet)
            .options(selectinload(BundleSet.modules))
            .where(BundleSet.label == label)
            .order_by(BundleSet.id.desc())
            .limit(1)
        )
        return session.scalars(stmt).first()

    def _build_bundle_key(self, compile_run_id: int, mib_names: list[str]) -> str:
        basis = "-".join(mib_names[:2]) if mib_names else "bundle"
        slug = re.sub(r"[^a-z0-9]+", "-", basis.lower()).strip("-") or "bundle"
        return f"run-{compile_run_id:06d}-{slug}"

    def _default_label(self, mib_names: list[str], manifest: dict[str, Any]) -> str:
        if mib_names:
            return ", ".join(mib_names)
        modules = [module["module"] for module in manifest.get("modules", [])]
        return ", ".join(modules[:3]) or "Compiled bundle"

    def _selected_source_paths(
        self,
        mib_names: list[str],
        source_dirs: list[Path],
    ) -> dict[str, str | None]:
        return {
            module_name: self._find_source_path(module_name, source_dirs)
            for module_name in self._unique_mib_names(mib_names)
            if str(module_name or "").strip()
        }

    def _compile_result_status_label(self, result) -> str:
        if getattr(result, "missing_dependencies", None):
            return "missing_deps"
        raw_status = str(getattr(result, "status", "") or "").strip().lower()
        if raw_status == "failed" and _INVALID_COMPILE_ERROR_RE.search(str(getattr(result, "error", "") or "")):
            return "invalid"
        if raw_status in {"compiled", "cached", "missing"}:
            return raw_status
        return raw_status or "failed"

    def _compile_result_rows(
        self,
        results: list[Any],
        source_dirs: list[Path],
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        source_paths = self._selected_source_paths(
            [
                str(getattr(result, "name", "") or "").strip()
                for result in results
            ],
            source_dirs,
        )
        for result in results:
            name = str(getattr(result, "name", "") or "").strip()
            raw_status = str(getattr(result, "status", "") or "").strip().lower()
            if raw_status in {"compiled", "cached"}:
                continue
            missing_dependencies = [
                str(dep).strip()
                for dep in (getattr(result, "missing_dependencies", None) or [])
                if str(dep).strip()
            ]
            rows.append(
                {
                    "name": name,
                    "status": raw_status,
                    "status_label": self._compile_result_status_label(result),
                    "error": str(getattr(result, "error", "") or "").strip() or None,
                    "missing_dependencies": missing_dependencies,
                    "is_dependency": bool(getattr(result, "is_dependency", False)),
                    "source_path": source_paths.get(name),
                }
            )
        return rows

    def _find_source_path(self, module_name: str, source_dirs: list[Path]) -> str | None:
        candidates = [f"{module_name}{suffix}" for suffix in SUPPORTED_MIB_SUFFIXES]
        for source_dir in source_dirs:
            for candidate in candidates:
                path = source_dir / candidate
                if path.exists():
                    return str(path)
        for source_dir in source_dirs:
            for path in source_dir.iterdir():
                if not path.is_file() or path.suffix.lower() not in SUPPORTED_MIB_SUFFIXES:
                    continue
                try:
                    text = path.read_text(errors="ignore")
                except OSError:
                    continue
                match = _MIB_DEFINITIONS_RE.search(text)
                if match is not None and match.group(1).strip() == module_name:
                    return str(path)
        return None

    def _extract_module_identity_oid(self, compiled_data: dict[str, Any]) -> str | None:
        for object_data in compiled_data.get("objects", {}).values():
            if object_data.get("object_type") == "MODULE-IDENTITY":
                return object_data.get("oid")
        return None

    def _active_pointer_payload(self, bundle_set: BundleSet, previous_active_bundle_id: int | None) -> dict[str, Any]:
        payload = {
            "bundle_set_id": bundle_set.id,
            "bundle_key": bundle_set.bundle_key,
            "label": bundle_set.label,
            "storage_path": bundle_set.storage_path,
            "manifest_path": bundle_set.manifest_path,
            "oid_index_path": bundle_set.oid_index_path,
            "previous_active_bundle_id": previous_active_bundle_id,
            "resolved_at": datetime.now(timezone.utc).isoformat(),
        }
        return payload

    def _read_active_pointer(
        self,
        session,
        *,
        active_bundle_id: int | None,
        previous_active_bundle_id: int | None,
    ) -> dict[str, Any] | None:
        if active_bundle_id is None:
            return None
        active_bundle = session.get(BundleSet, active_bundle_id)
        if active_bundle is None:
            return None
        return self._active_pointer_payload(active_bundle, previous_active_bundle_id)

    def _get_setting_value(self, session, key: str) -> Any | None:
        setting = session.get(AppSetting, key)
        return setting.value_json if setting is not None else None

    def _set_setting_value(self, session, key: str, value: Any) -> None:
        setting = session.get(AppSetting, key)
        if setting is None:
            setting = AppSetting(key=key, value_json=value)
            session.add(setting)
        else:
            setting.value_json = value

    def _bundle_list_summary(self, bundle: BundleSet, module_count: int) -> dict[str, Any]:
        """Summary row for the bundle list — no modules array, no manifest read.

        The list endpoint is a lightweight index (MGR-28): per-bundle module
        detail, the manifest, and manifest-derived fields (producer_version)
        all live on the detail route. Keeping manifest reads out of the list
        avoids one disk read per bundle per call.
        """
        return {
            "id": bundle.id,
            "bundle_key": bundle.bundle_key,
            "label": bundle.label,
            "status": bundle.status,
            "is_active": bundle.is_active,
            "producer_version": None,
            "storage_path": bundle.storage_path,
            "manifest_path": bundle.manifest_path,
            "oid_index_path": bundle.oid_index_path,
            "content_hash": bundle.content_hash,
            "module_count": module_count,
            "created_at": bundle.created_at.isoformat() if bundle.created_at else None,
            "updated_at": bundle.updated_at.isoformat() if bundle.updated_at else None,
        }

    def _bundle_summary(self, bundle: BundleSet) -> dict[str, Any]:
        producer_version: Any = None
        manifest_path = Path(bundle.manifest_path or "")
        if manifest_path.exists():
            try:
                manifest_data = json.loads(manifest_path.read_text())
                producer_version = manifest_data.get("producer_version")
            except (OSError, ValueError):
                producer_version = None
        return {
            "id": bundle.id,
            "bundle_key": bundle.bundle_key,
            "label": bundle.label,
            "status": bundle.status,
            "is_active": bundle.is_active,
            "producer_version": producer_version,
            "storage_path": bundle.storage_path,
            "manifest_path": bundle.manifest_path,
            "oid_index_path": bundle.oid_index_path,
            "content_hash": bundle.content_hash,
            "module_count": len(bundle.modules),
            "modules": [
                {
                    "id": module.id,
                    "module_name": module.module_name,
                    "source_path": module.source_path,
                    "compiled_path": module.compiled_path,
                    "module_identity_oid": module.module_identity_oid,
                    "object_count": module.object_count,
                    "notification_count": module.notification_count,
                }
                for module in sorted(bundle.modules, key=lambda item: item.module_name)
            ],
            "created_at": bundle.created_at.isoformat() if bundle.created_at else None,
            "updated_at": bundle.updated_at.isoformat() if bundle.updated_at else None,
        }

    def _compile_run_summary(self, compile_run: CompileRun) -> dict[str, Any]:
        return {
            "id": compile_run.id,
            "requested_mib_names": compile_run.requested_mib_names_json,
            "source_dirs": compile_run.source_dirs_json,
            "bundle_key": compile_run.bundle_key,
            "output_dir": compile_run.output_dir,
            "manifest_path": compile_run.manifest_path,
            "oid_index_path": compile_run.oid_index_path,
            "bundle_set_id": compile_run.bundle_set_id,
            "status": compile_run.status,
            "error_text": compile_run.error_text,
            "started_at": compile_run.started_at.isoformat() if compile_run.started_at else None,
            "finished_at": compile_run.finished_at.isoformat() if compile_run.finished_at else None,
        }

    def _compile_run_detail(self, compile_run: CompileRun) -> dict[str, Any]:
        payload = self._compile_run_summary(compile_run)
        payload["command"] = compile_run.command_json
        payload["stdout_text"] = compile_run.stdout_text
        payload["stderr_text"] = compile_run.stderr_text
        return payload
