from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.unit


class _BundleServiceStub:
    def __init__(self, session_factory) -> None:
        self.session_factory = session_factory
        self.compile_requests: list[object] = []
        self.activate_calls: list[int] = []
        self.compile_result = {
            "bundle": {"id": 101},
            "remote_modules": [],
            "activation": {"bundle": {"id": 101}},
        }
        self.compile_error: Exception | None = None
        self.activate_result = {"bundle": {"id": 201}}
        self.bundled_names = ["IF-MIB", "SNMPv2-MIB"]

    def compile_bundle(self, request):
        self.compile_requests.append(request)
        if self.compile_error is not None:
            raise self.compile_error
        return self.compile_result

    def activate_bundle(self, bundle_id: int):
        self.activate_calls.append(bundle_id)
        return self.activate_result

    def bundled_mib_names(self) -> list[str]:
        return list(self.bundled_names)


def _unique_names(names) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for name in names:
        normalized = str(name or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return ordered


def _prune_upload_dirs(upload_root: Path, start: Path) -> None:
    current = start
    while current.exists() and current != upload_root:
        try:
            current.rmdir()
        except OSError:
            break
        current = current.parent


def _make_mutation_service(
    isolated_db,
    *,
    batch: dict[str, object] | None = None,
    remote_policy: dict[str, object] | None = None,
    selected_targets: list[str] | None = None,
    uploaded_mib_names: list[str] | None = None,
    status_payload: dict[str, object] | None = None,
    reload_result: dict[str, object] | None = None,
    reload_error: Exception | None = None,
    active_maps: list[dict[str, dict[str, object]]] | None = None,
    promotions: list[dict[str, object]] | None = None,
):
    from app.services.mib_mutations import ShellMibMutationService
    from app.services.state_store import _MIB_RELOAD_COUNT_KEY

    settings = isolated_db["settings"]
    settings.bundled_mibs_dir = settings.data_dir / "bundled-mutations"
    settings.bundled_mibs_dir.mkdir(parents=True, exist_ok=True)

    upload_root = settings.data_dir / "mibs"
    upload_root.mkdir(parents=True, exist_ok=True)

    bundle_service = _BundleServiceStub(isolated_db["session_factory"])
    logs: list[tuple[str, str]] = []
    counter_calls: list[tuple[str, int]] = []
    materialized: list[tuple[list[str], int | None]] = []
    reset_calls: list[str] = []
    active_map_queue = list(active_maps or [{}])

    batch_payload = batch or {
        "files": [
            {
                "filename": "READY-MIB.mib",
                "mib_name": "READY-MIB",
                "valid": True,
                "target_relative_path": "common/READY-MIB.mib",
                "partial_blockers": [],
            }
        ],
        "global_missing_deps": [],
        "can_upload": True,
        "upload_blocked_reason": None,
        "partial_compile": {"ready_mibs": ["READY-MIB"]},
    }
    remote_policy_payload = remote_policy or {
        "enabled": False,
        "auto_enabled": False,
        "using_default_sources": False,
        "sources": [],
    }
    selected = selected_targets if selected_targets is not None else [
        str(entry.get("mib_name") or "").strip()
        for entry in batch_payload.get("files", [])
        if str(entry.get("mib_name") or "").strip()
    ]
    uploaded_names = list(uploaded_mib_names or [])
    status = status_payload or {"loaded": 2, "failed": 1}
    dependency_status = reload_result or {"loaded": 3, "failed": 0, "dependency_fetch": {"resolved": []}}

    def _row_payload(*, batch, selected_targets, status, error=None):
        rows = []
        selected_set = set(selected_targets)
        for entry in batch["files"]:
            mib_name = str(entry.get("mib_name") or "").strip()
            if mib_name in selected_set:
                payload = {"filename": entry["filename"], "mib_name": mib_name, "status": status}
                if error:
                    payload["error"] = error
                rows.append(payload)
            else:
                payload = {
                    "filename": entry["filename"],
                    "mib_name": mib_name,
                    "status": "skipped",
                    "missing_deps": list(entry.get("partial_blockers") or []),
                }
                payload["error"] = (
                    "Skipped in partial compile because dependencies are still missing: "
                    + ", ".join(str(name) for name in entry.get("partial_blockers") or [])
                ) if entry.get("partial_blockers") else "Skipped in partial compile."
                rows.append(payload)
        return rows

    def _dependency_payload(*, policy, attempted=None, resolved=None, failed=None):
        attempted_list = _unique_names(attempted or [])
        resolved_list = _unique_names(resolved or [])
        failed_list = _unique_names(failed or [])
        if not failed_list and attempted_list:
            failed_list = sorted(set(attempted_list) - set(resolved_list))
        return {
            "enabled": bool(policy.get("enabled")) and bool(attempted_list or resolved_list or failed_list),
            "auto_enabled": bool(policy.get("auto_enabled")),
            "using_default_sources": bool(policy.get("using_default_sources")),
            "sources": list(policy.get("sources") or []),
            "attempted": attempted_list,
            "resolved": resolved_list,
            "downloaded": resolved_list,
            "cached": [],
            "failed": failed_list,
        }

    def _active_source_map():
        if len(active_map_queue) > 1:
            return active_map_queue.pop(0)
        return dict(active_map_queue[0])

    def _reload_uploaded_mibs():
        if reload_error is not None:
            raise reload_error
        return dependency_status

    service = ShellMibMutationService(
        error_cls=RuntimeError,
        bundle_service=bundle_service,
        session_factory=isolated_db["session_factory"],
        upload_dir=lambda: upload_root,
        bundled_mibs_dir=lambda: settings.bundled_mibs_dir,
        emit_operation_log=lambda message, level="INFO": logs.append((level, message)),
        increment_counter=lambda key, amount=1: counter_calls.append((key, amount)),
        load_mib_status=lambda: status,
        analyze_upload_batch=lambda uploaded, source_group=None: batch_payload,
        apply_upload_batch_policy=lambda payload, policy: payload,
        remote_fetch_policy=lambda: remote_policy_payload,
        select_upload_targets=lambda batch, compile_mode, compile_targets: list(selected),
        normalize_source_group=lambda source_group=None: "common" if not source_group else str(source_group).strip().lower(),
        reset_source_caches=lambda: reset_calls.append("reset"),
        compile_target_mib_names=lambda mib_names: _unique_names(mib_names),
        compile_source_dirs=lambda: [str(upload_root), str(settings.bundled_mibs_dir)],
        uploaded_bundle_label=lambda source_group: f"{source_group}-upload-label",
        materialize_cached_remote_modules=lambda modules, bundle_set_id=None: materialized.append((list(modules), bundle_set_id)),
        upload_result_rows=_row_payload,
        dependency_fetch_payload=_dependency_payload,
        missing_dependencies_from_error=lambda text: ["MISSING-DEP-MIB"] if "MISSING-DEP-MIB" in str(text) else [],
        uploaded_mib_names=lambda: list(uploaded_names),
        reload_uploaded_mibs=_reload_uploaded_mibs,
        uploaded_target_path=lambda relative_path: upload_root / Path(relative_path),
        relative_upload_path=lambda path: path.resolve().relative_to(upload_root.resolve()).as_posix(),
        prune_empty_upload_dirs=lambda start: _prune_upload_dirs(upload_root.resolve(), start),
        active_source_map=_active_source_map,
        promoted_active_sources=lambda **kwargs: list(promotions or []),
        available_source_mib_names=lambda: {"IF-MIB", "READY-MIB", "CACHED-MIB"},
        mib_reload_count_key=_MIB_RELOAD_COUNT_KEY,
    )
    return service, settings, bundle_service, {
        "logs": logs,
        "counter_calls": counter_calls,
        "materialized": materialized,
        "reset_calls": reset_calls,
        "upload_root": upload_root,
    }


def test_save_uploaded_mibs_validates_empty_invalid_and_blocked_full_uploads(isolated_db):
    from app.services.bundles import BundleServiceError

    service, _settings, _bundle_service, _ctx = _make_mutation_service(isolated_db)
    with pytest.raises(RuntimeError, match="No files were uploaded"):
        service.save_uploaded_mibs([])

    invalid_batch = {
        "files": [
            {
                "filename": "invalid.bin",
                "mib_name": "INVALID-MIB",
                "valid": False,
                "target_relative_path": "common/invalid.bin",
                "partial_blockers": [],
            }
        ],
        "global_missing_deps": [],
        "can_upload": False,
        "upload_blocked_reason": None,
        "partial_compile": {"ready_mibs": []},
    }
    invalid_service, _settings, _bundle_service, _ctx = _make_mutation_service(
        isolated_db,
        batch=invalid_batch,
    )
    with pytest.raises(RuntimeError, match="Upload only accepts"):
        invalid_service.save_uploaded_mibs([("invalid.bin", b"bad")])

    blocked_batch = {
        "files": [
            {
                "filename": "blocked.mib",
                "mib_name": "BLOCKED-MIB",
                "valid": True,
                "target_relative_path": "common/BLOCKED-MIB.mib",
                "partial_blockers": ["MISSING-DEP-MIB"],
            }
        ],
        "global_missing_deps": ["MISSING-DEP-MIB"],
        "can_upload": False,
        "upload_blocked_reason": "Full upload is blocked until dependency issues are resolved.",
        "partial_compile": {"ready_mibs": []},
    }
    blocked_service, _settings, _bundle_service, _ctx = _make_mutation_service(
        isolated_db,
        batch=blocked_batch,
    )
    with pytest.raises(RuntimeError, match="Full upload is blocked"):
        blocked_service.save_uploaded_mibs([("blocked.mib", b"blocked")])


def test_save_uploaded_mibs_covers_success_and_compile_failure_paths(isolated_db):
    from app.services.bundles import BundleServiceError

    batch = {
        "files": [
            {
                "filename": "ready.mib",
                "mib_name": "READY-MIB",
                "valid": True,
                "target_relative_path": "common/READY-MIB.mib",
                "partial_blockers": [],
            },
            {
                "filename": "blocked.mib",
                "mib_name": "BLOCKED-MIB",
                "valid": True,
                "target_relative_path": "common/BLOCKED-MIB.mib",
                "partial_blockers": ["MISSING-DEP-MIB"],
            },
            {
                "filename": "skipped.mib",
                "mib_name": "SKIPPED-MIB",
                "valid": True,
                "target_relative_path": "",
                "partial_blockers": [],
            },
        ],
        "global_missing_deps": ["MISSING-DEP-MIB"],
        "can_upload": True,
        "upload_blocked_reason": None,
        "partial_compile": {"ready_mibs": ["READY-MIB"]},
    }
    remote_policy = {
        "enabled": True,
        "auto_enabled": True,
        "using_default_sources": True,
        "sources": ["https://example.invalid"],
    }
    service, settings, bundle_service, ctx = _make_mutation_service(
        isolated_db,
        batch=batch,
        remote_policy=remote_policy,
        selected_targets=["READY-MIB"],
    )

    result = service.save_uploaded_mibs(
        [
            ("ready.mib", b"READY-MIB DEFINITIONS ::= BEGIN\nEND\n"),
            ("blocked.mib", b"BLOCKED-MIB DEFINITIONS ::= BEGIN\nEND\n"),
            ("skipped.mib", b"SKIPPED-MIB DEFINITIONS ::= BEGIN\nEND\n"),
        ],
        compile_mode="partial",
        source_group="Common",
    )
    assert result["compile_mode"] == "partial"
    assert result["compiled_mibs"] == ["READY-MIB"]
    assert result["source_group"] == "common"
    assert (ctx["upload_root"] / "common" / "READY-MIB.mib").exists()
    assert (ctx["upload_root"] / "common" / "BLOCKED-MIB.mib").exists()
    assert (ctx["upload_root"] / "common" / "SKIPPED-MIB.mib").exists() is False
    assert bundle_service.compile_requests[0].label == "common-upload-label"
    assert bundle_service.compile_requests[0].online is True
    assert bundle_service.compile_requests[0].remote_sources == ["https://example.invalid"]
    assert bundle_service.compile_requests[0].mib_names == ["READY-MIB"]
    assert ctx["materialized"] == [([], 101)]
    assert ctx["reset_calls"] == ["reset"]
    assert result["results"][0]["status"] == "loaded"
    assert result["results"][1]["status"] == "skipped"
    assert result["dependency_fetch"]["resolved"] == []
    assert result["dependency_fetch"]["failed"] == ["MISSING-DEP-MIB"]
    info_logs = [message for level, message in ctx["logs"] if level == "INFO"]
    warning_logs = [message for level, message in ctx["logs"] if level == "WARNING"]
    debug_logs = [message for level, message in ctx["logs"] if level == "DEBUG"]
    assert any(
        "Uploading MIB batch: source_group=common mode=partial received_files=3 saved_files=2 selected_mibs=1 remote_fetch=True"
        in message
        for message in info_logs
    )
    assert any(
        "Uploaded MIB batch compiled: source_group=common mode=partial received_files=3 saved_files=2 result_rows=3 loaded=1 skipped=2 failed=0 errors=0 remote_resolved=0 remote_unresolved=1"
        in message
        for message in info_logs
    )
    assert any(
        "Upload unresolved remote dependencies: MISSING-DEP-MIB" in message
        for message in warning_logs
    )
    assert any(
        "Upload MIB batch detail:" in message and "selected_targets=['READY-MIB']" in message
        for message in debug_logs
    )
    assert all("selected_targets=[" not in message for message in info_logs)
    assert all("compile_targets=[" not in message for message in info_logs)

    failing_service, _settings, failing_bundle_service, failing_ctx = _make_mutation_service(
        isolated_db,
        batch=batch,
        remote_policy=remote_policy,
        selected_targets=["READY-MIB"],
    )
    failing_bundle_service.compile_error = BundleServiceError("MIB 'MISSING-DEP-MIB' not found")
    failed = failing_service.save_uploaded_mibs(
        [
            ("ready.mib", b"READY-MIB DEFINITIONS ::= BEGIN\nEND\n"),
            ("blocked.mib", b"BLOCKED-MIB DEFINITIONS ::= BEGIN\nEND\n"),
            ("skipped.mib", b"SKIPPED-MIB DEFINITIONS ::= BEGIN\nEND\n"),
        ],
        compile_mode="partial",
    )
    assert failed["results"][0]["status"] == "failed"
    assert failed["results"][0]["error"] == "MIB 'MISSING-DEP-MIB' not found"
    assert failed["dependency_fetch"]["failed"] == ["MISSING-DEP-MIB"]
    assert any(
        level == "ERROR"
        and "Uploaded MIB compile failed: source_group=common mode=partial received_files=3 saved_files=2 result_rows=3 loaded=0 skipped=2 failed=1 errors=0 remote_resolved=0 remote_unresolved=1 error=MIB 'MISSING-DEP-MIB' not found"
        in message
        for level, message in failing_ctx["logs"]
    )
    assert any(
        level == "ERROR" and "Upload failed MIB modules: READY-MIB" in message
        for level, message in failing_ctx["logs"]
    )
    assert any(
        level == "WARNING" and "Upload unresolved remote dependencies: MISSING-DEP-MIB" in message
        for level, message in failing_ctx["logs"]
    )


def test_reload_without_uploads_recompiles_starter_when_producer_is_below_floor(isolated_db):
    from app.models import BundleSet
    from app.services.state_store import _MIB_RELOAD_COUNT_KEY

    service, settings, bundle_service, ctx = _make_mutation_service(
        isolated_db,
        uploaded_mib_names=[],
        status_payload={"loaded": 4, "failed": 0},
    )
    starter_manifest = settings.data_dir / "starter-manifest.json"
    starter_manifest.write_text('{"producer_version": "0.4.5", "modules": [], "sidecars": {}}')
    with isolated_db["session_factory"]() as session:
        starter = BundleSet(
            bundle_key="starter-bundle",
            label="Bundled Starter MIBs",
            storage_path=str(settings.data_dir / "starter.json"),
            manifest_path=str(starter_manifest),
            status="active",
            is_active=True,
        )
        session.add(starter)
        session.commit()
        starter_id = starter.id

    reloaded = service.reload_uploaded_mib_bundle()
    assert reloaded == {
        "loaded": 4,
        "failed": 0,
        "dependency_fetch": {
            "enabled": False,
            "auto_enabled": False,
            "using_default_sources": False,
            "sources": [],
            "attempted": [],
            "resolved": [],
            "downloaded": [],
            "cached": [],
            "failed": [],
        },
    }
    assert ctx["counter_calls"] == [(_MIB_RELOAD_COUNT_KEY, 1)]
    # Old producer -> a NEW bundle set is compiled and activated, never the stale one.
    assert bundle_service.compile_requests[-1].label == "Bundled Starter MIBs"
    assert bundle_service.compile_requests[-1].mib_dirs == [str(settings.bundled_mibs_dir)]
    assert bundle_service.activate_calls == []


def test_reload_without_uploads_reactivates_starter_when_producer_is_current(isolated_db):
    from app.models import BundleSet
    from app.services.state_store import _MIB_RELOAD_COUNT_KEY

    service, settings, bundle_service, ctx = _make_mutation_service(
        isolated_db,
        uploaded_mib_names=[],
        status_payload={"loaded": 4, "failed": 0},
    )
    starter_manifest = settings.data_dir / "current-manifest.json"
    starter_manifest.write_text('{"producer_version": "0.5.3", "modules": [], "sidecars": {}}')
    with isolated_db["session_factory"]() as session:
        starter = BundleSet(
            bundle_key="starter-bundle",
            label="Bundled Starter MIBs",
            storage_path=str(settings.data_dir / "starter.json"),
            manifest_path=str(starter_manifest),
            status="active",
            is_active=True,
        )
        session.add(starter)
        session.commit()
        starter_id = starter.id

    service.reload_uploaded_mib_bundle()
    assert ctx["counter_calls"] == [(_MIB_RELOAD_COUNT_KEY, 1)]
    # Current producer -> existing activate-by-label path unchanged.
    assert bundle_service.compile_requests == []
    assert bundle_service.activate_calls == [starter_id]


def test_reload_and_activate_bundled_starter_bundle_cover_main_branches(isolated_db):
    from app.models import BundleSet
    from app.services.bundles import BundleServiceError
    from app.services.state_store import _MIB_RELOAD_COUNT_KEY

    service, settings, bundle_service, ctx = _make_mutation_service(
        isolated_db,
        uploaded_mib_names=[],
        status_payload={"loaded": 4, "failed": 0},
    )
    reloaded = service.reload_uploaded_mib_bundle()
    assert reloaded == {
        "loaded": 4,
        "failed": 0,
        "dependency_fetch": {
            "enabled": False,
            "auto_enabled": False,
            "using_default_sources": False,
            "sources": [],
            "attempted": [],
            "resolved": [],
            "downloaded": [],
            "cached": [],
            "failed": [],
        },
    }
    assert ctx["counter_calls"] == [(_MIB_RELOAD_COUNT_KEY, 1)]

    with isolated_db["session_factory"]() as session:
        starter = BundleSet(
            bundle_key="starter-bundle",
            label="Bundled Starter MIBs",
            storage_path=str(settings.data_dir / "starter.json"),
            status="active",
            is_active=True,
        )
        session.add(starter)
        session.commit()
        starter_id = starter.id

    activated = service.activate_bundled_starter_bundle()
    assert activated == bundle_service.activate_result
    assert bundle_service.activate_calls[-1] == starter_id

    no_starter_service, _settings, no_starter_bundle_service, _ctx = _make_mutation_service(isolated_db)
    no_starter_bundle_service.bundled_names = []
    with isolated_db["session_factory"]() as session:
        session.query(BundleSet).delete()
        session.commit()
    assert no_starter_service.activate_bundled_starter_bundle() is None

    compile_starter_service, _settings, compile_starter_bundle_service, _ctx = _make_mutation_service(isolated_db)
    with isolated_db["session_factory"]() as session:
        session.query(BundleSet).delete()
        session.commit()
    activation = compile_starter_service.activate_bundled_starter_bundle()
    assert activation == {"bundle": {"id": 101}}
    assert compile_starter_bundle_service.compile_requests[-1].label == "Bundled Starter MIBs"
    assert compile_starter_bundle_service.compile_requests[-1].mib_dirs == [str(settings.bundled_mibs_dir)]

    uploaded_reload_service, _settings, uploaded_reload_bundle_service, ctx = _make_mutation_service(
        isolated_db,
        uploaded_mib_names=["READY-MIB"],
        remote_policy={
            "enabled": True,
            "auto_enabled": True,
            "using_default_sources": False,
            "sources": ["https://example.invalid"],
        },
        status_payload={"loaded": 5, "failed": 1},
    )
    uploaded_reload_bundle_service.compile_result = {"bundle": {"id": 404}, "remote_modules": ["REMOTE-MIB"]}
    uploaded_reload = uploaded_reload_service.reload_uploaded_mib_bundle()
    assert uploaded_reload["loaded"] == 5
    assert uploaded_reload["failed"] == 1
    assert uploaded_reload["dependency_fetch"]["resolved"] == ["REMOTE-MIB"]
    assert ctx["materialized"] == [(["REMOTE-MIB"], 404)]
    assert any(
        level == "INFO"
        and "Reloading uploaded MIB bundle: uploaded_mibs=1 remote_fetch=True" in message
        for level, message in ctx["logs"]
    )
    assert any(
        level == "INFO"
        and "Reloaded uploaded MIB bundle: uploaded_mibs=1 loaded=5 failed=1 remote_resolved=1 remote_unresolved=0"
        in message
        for level, message in ctx["logs"]
    )
    assert any(
        level == "DEBUG"
        and "Reload uploaded MIB detail: uploaded_mibs=['READY-MIB'] compile_targets=['READY-MIB']"
        in message
        for level, message in ctx["logs"]
    )

    failing_reload_service, _settings, failing_reload_bundle_service, _ctx = _make_mutation_service(
        isolated_db,
        uploaded_mib_names=["READY-MIB"],
    )
    failing_reload_bundle_service.compile_error = BundleServiceError("reload failed")
    with pytest.raises(RuntimeError, match="reload failed"):
        failing_reload_service.reload_uploaded_mib_bundle()

    failing_no_uploaded_service, _settings, failing_no_uploaded_bundle_service, _ctx = _make_mutation_service(
        isolated_db,
        uploaded_mib_names=[],
    )
    failing_no_uploaded_bundle_service.compile_error = BundleServiceError("starter failed")
    with pytest.raises(RuntimeError, match="starter failed"):
        failing_no_uploaded_service.reload_uploaded_mib_bundle()


def test_delete_helpers_and_fetch_dependencies_cover_rollbacks_and_promotions(isolated_db):
    from app.models import BundleSet

    service, settings, bundle_service, _ctx = _make_mutation_service(isolated_db)
    upload_root = settings.data_dir / "mibs"
    first = upload_root / "vendor" / "FIRST-MIB.mib"
    second = upload_root / "vendor" / "SECOND-MIB.mib"
    first.parent.mkdir(parents=True, exist_ok=True)
    first.write_text("FIRST-MIB DEFINITIONS ::= BEGIN\nEND\n")
    second.write_text("SECOND-MIB DEFINITIONS ::= BEGIN\nEND\n")

    requests = service._collect_delete_requests(["vendor/FIRST-MIB.mib", "", "vendor/FIRST-MIB.mib"])
    assert len(requests) == 1
    assert requests[0][1] == "vendor/FIRST-MIB.mib"
    with pytest.raises(RuntimeError, match="does not exist"):
        service._collect_delete_requests(["vendor/MISSING-MIB.mib"])

    preserved = upload_root / "vendor" / "PRESERVED-MIB.mib"
    preserved.write_text("CURRENT")
    service._restore_deleted_sources(
        [(preserved, "vendor/PRESERVED-MIB.mib", preserved.parent, b"STALE")]
    )
    assert preserved.read_text() == "CURRENT"

    delete_no_reload_service, _settings, _bundle_service, _ctx = _make_mutation_service(isolated_db)
    no_reload_path = upload_root / "juniper" / "NO-RELOAD-MIB.mib"
    no_reload_path.parent.mkdir(parents=True, exist_ok=True)
    no_reload_path.write_text("NO-RELOAD-MIB DEFINITIONS ::= BEGIN\nEND\n")
    deleted = delete_no_reload_service.delete_uploaded_mib(
        "juniper/NO-RELOAD-MIB.mib",
        reload_after_delete=False,
    )
    assert deleted == {
        "status": "deleted",
        "filename": "juniper/NO-RELOAD-MIB.mib",
        "reload_applied": False,
    }
    assert no_reload_path.exists() is False

    promoted = [
        {
            "mib_name": "PROMOTED-MIB",
            "previous_relative_path": "common/PROMOTED-MIB-old.mib",
            "active_relative_path": "vendor/PROMOTED-MIB.mib",
            "source_group": "vendor",
            "source_kind": "uploaded",
        }
    ]
    promoted_service, _settings, _bundle_service, _ctx = _make_mutation_service(
        isolated_db,
        promotions=promoted,
        active_maps=[
            {"PROMOTED-MIB": {"relative_path": "common/PROMOTED-MIB-old.mib"}},
            {"PROMOTED-MIB": {"relative_path": "vendor/PROMOTED-MIB.mib"}},
        ],
        reload_result={"loaded": 7, "failed": 1, "dependency_fetch": {"resolved": ["REMOTE-MIB"]}},
    )
    promoted_path = upload_root / "common" / "PROMOTED-MIB-old.mib"
    promoted_path.parent.mkdir(parents=True, exist_ok=True)
    promoted_path.write_text("PROMOTED-MIB DEFINITIONS ::= BEGIN\nEND\n")
    promoted_deleted = promoted_service.delete_uploaded_mib("common/PROMOTED-MIB-old.mib")
    assert promoted_deleted["loaded"] == 7
    assert promoted_deleted["failed"] == 1
    assert promoted_deleted["promoted_sources"] == promoted

    rollback_service, _settings, _bundle_service, _ctx = _make_mutation_service(
        isolated_db,
        reload_error=RuntimeError("reload failed"),
    )
    rollback_path = upload_root / "ericsson" / "ROLLBACK-MIB.mib"
    rollback_path.parent.mkdir(parents=True, exist_ok=True)
    rollback_path.write_text("ROLLBACK-MIB DEFINITIONS ::= BEGIN\nEND\n")
    with pytest.raises(RuntimeError, match="The source file has been restored"):
        rollback_service.delete_uploaded_mib("ericsson/ROLLBACK-MIB.mib")
    assert rollback_path.exists() is True

    bulk_service, _settings, _bundle_service, _ctx = _make_mutation_service(
        isolated_db,
        promotions=promoted,
        active_maps=[
            {"PROMOTED-MIB": {"relative_path": "common/FIRST.mib"}},
            {"PROMOTED-MIB": {"relative_path": "vendor/PROMOTED-MIB.mib"}},
        ],
        reload_result={"loaded": 8, "failed": 0, "dependency_fetch": {"resolved": []}},
    )
    bulk_first = upload_root / "common" / "FIRST.mib"
    bulk_second = upload_root / "common" / "SECOND.mib"
    bulk_first.parent.mkdir(parents=True, exist_ok=True)
    bulk_first.write_text("FIRST DEFINITIONS ::= BEGIN\nEND\n")
    bulk_second.write_text("SECOND DEFINITIONS ::= BEGIN\nEND\n")
    bulk_deleted = bulk_service.delete_uploaded_mibs(["common/FIRST.mib", "common/SECOND.mib"])
    assert bulk_deleted["deleted_count"] == 2
    assert bulk_deleted["promoted_sources"] == promoted

    empty_bulk_service, _settings, _bundle_service, _ctx = _make_mutation_service(isolated_db)
    with pytest.raises(RuntimeError, match="Select at least one uploaded MIB file to delete"):
        empty_bulk_service.delete_uploaded_mibs(["", "   "])

    fetch = service.fetch_dependencies(["CACHED-MIB", "MISSING-MIB", "CACHED-MIB"])
    assert fetch == {
        "enabled": False,
        "auto_enabled": False,
        "using_default_sources": False,
        "sources": [],
        "resolved": [],
        "downloaded": [],
        "cached": ["CACHED-MIB"],
        "failed": ["MISSING-MIB"],
    }
