from __future__ import annotations

from pathlib import Path

import pytest

pytestmark = pytest.mark.unit


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


def _write_mib(path: Path, module_name: str, *, imports: list[str] | None = None) -> None:
    imports = imports or []
    import_lines = ""
    if imports:
        import_lines = "IMPORTS\n" + "\n".join(
            f"    someSymbol FROM {name};" for name in imports
        )
    body = (
        f"{module_name} DEFINITIONS ::= BEGIN\n\n"
        f"{import_lines}\n"
        f"{module_name.lower().replace('-', '')}Node OBJECT IDENTIFIER ::= {{ 1 3 6 1 4 1 99999 1 }}\n\n"
        "END\n"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)


def _make_source_service(isolated_db, *, settings_snapshot: dict[str, object] | None = None, active_bundle=None):
    from app.services.mib_sources import ShellMibSourceService
    from app.services.state_store import _MIB_AUTO_FETCH_KEY, _MIB_REMOTE_SOURCES_KEY

    settings = isolated_db["settings"]
    settings.bundled_mibs_dir = settings.data_dir / "bundled-test"
    settings.tsmi_cache_dir = settings.data_dir / "bundles" / "cache" / "tsmi-test"
    settings.bundled_mibs_dir.mkdir(parents=True, exist_ok=True)
    settings.tsmi_cache_dir.mkdir(parents=True, exist_ok=True)

    snapshot = {
        _MIB_AUTO_FETCH_KEY: False,
        _MIB_REMOTE_SOURCES_KEY: [],
    }
    snapshot.update(settings_snapshot or {})

    logs: list[tuple[str, str]] = []
    service = ShellMibSourceService(
        error_cls=RuntimeError,
        session_factory=isolated_db["session_factory"],
        upload_dir=lambda: settings.data_dir / "mibs",
        bundled_mibs_dir=lambda: settings.bundled_mibs_dir,
        tsmi_cache_dir=lambda: settings.tsmi_cache_dir,
        load_settings=lambda: snapshot,
        emit_operation_log=lambda message, level="INFO": logs.append((level, message)),
        active_bundle_summary=lambda: active_bundle,
        unique_mib_names=_unique_names,
        bundled_mib_names=lambda: ["IF-MIB", "SNMPv2-MIB"],
        mib_auto_fetch_key=_MIB_AUTO_FETCH_KEY,
        mib_remote_sources_key=_MIB_REMOTE_SOURCES_KEY,
    )
    return service, settings, logs, snapshot


def test_source_service_policy_selection_and_path_helpers(isolated_db):
    from app.services.state_store import _MIB_AUTO_FETCH_KEY, _MIB_REMOTE_SOURCES_KEY

    service, settings, _logs, snapshot = _make_source_service(
        isolated_db,
        settings_snapshot={
            _MIB_AUTO_FETCH_KEY: True,
            _MIB_REMOTE_SOURCES_KEY: [" https://example.invalid/a ", "", "https://example.invalid/b "],
        },
    )

    assert service.normalize_source_group(None) == "common"
    assert service.normalize_source_group(" Vendor/Core ") == "vendor/core"
    assert service.normalize_source_group("///") == "common"
    with pytest.raises(RuntimeError, match="Source group may only contain"):
        service.normalize_source_group("vendor/../core")

    assert service.source_group_precedence_key("") == (0, "")
    assert service.source_group_precedence_key("common") == (1, "common")
    assert service.source_group_precedence_key("vendor") == (2, "vendor")
    assert service.source_group_precedence_key("auto-fetched") == (3, "auto-fetched")

    invalid = service.apply_upload_batch_policy(
        {"files": [{"valid": False}], "global_missing_deps": []},
        policy={"enabled": False},
    )
    assert invalid["can_upload"] is False
    assert "Upload only accepts" in invalid["upload_blocked_reason"]

    empty = service.apply_upload_batch_policy(
        {"files": [], "global_missing_deps": []},
        policy={"enabled": False},
    )
    assert empty["can_upload"] is False
    assert empty["upload_blocked_reason"] == "Select at least one MIB source file."

    blocked = service.apply_upload_batch_policy(
        {"files": [{"valid": True}], "global_missing_deps": ["MISSING-DEP-MIB"]},
        policy={"enabled": False},
    )
    assert blocked["can_upload"] is False
    assert "auto-fetch is disabled" in blocked["upload_blocked_reason"]

    allowed = service.apply_upload_batch_policy(
        {"files": [{"valid": True}], "global_missing_deps": ["MISSING-DEP-MIB"]},
        policy={"enabled": True},
    )
    assert allowed["can_upload"] is True
    assert allowed["upload_blocked_reason"] is None

    policy = service.remote_fetch_policy()
    assert policy == {
        "enabled": True,
        "auto_enabled": True,
        "sources": ["https://example.invalid/a", "https://example.invalid/b"],
        "using_default_sources": False,
    }

    batch = {
        "files": [
            {"valid": True, "mib_name": "READY-A"},
            {"valid": False, "mib_name": "IGNORED"},
            {"valid": True, "mib_name": "READY-B"},
            {"valid": True, "mib_name": " "},
        ],
        "partial_compile": {"ready_mibs": ["READY-A", "READY-B", "READY-A"]},
    }
    assert service.select_upload_targets(
        batch=batch,
        compile_mode="full",
        compile_targets=None,
    ) == ["READY-A", "READY-B"]
    assert service.select_upload_targets(
        batch=batch,
        compile_mode="partial",
        compile_targets=["READY-B", "READY-B", "READY-A", "NOT-READY"],
    ) == ["READY-B", "READY-A"]
    with pytest.raises(RuntimeError, match="No ready MIBs are available"):
        service.select_upload_targets(
            batch={"files": [], "partial_compile": {"ready_mibs": []}},
            compile_mode="partial",
            compile_targets=None,
        )

    rows = service.upload_result_rows(
        batch={
            "files": [
                {"filename": "ready-a.mib", "mib_name": "READY-A", "partial_blockers": []},
                {"filename": "blocked-b.mib", "mib_name": "BLOCKED-B", "partial_blockers": ["BASE-DEP"]},
                {"filename": "skipped-c.mib", "mib_name": "SKIPPED-C", "partial_blockers": []},
            ]
        },
        selected_targets=["READY-A"],
        status="loaded",
    )
    assert rows[0] == {"filename": "ready-a.mib", "mib_name": "READY-A", "status": "loaded"}
    assert rows[1]["status"] == "skipped"
    assert rows[1]["missing_deps"] == ["BASE-DEP"]
    assert "dependencies are still missing" in rows[1]["error"]
    assert rows[2]["error"] == "Skipped in partial compile."

    dependency_payload = service.dependency_fetch_payload(
        policy=policy,
        attempted=["READY-A", "MISSING-DEP-MIB", "READY-A"],
        resolved=["READY-A", "READY-A"],
    )
    assert dependency_payload["enabled"] is True
    assert dependency_payload["attempted"] == ["MISSING-DEP-MIB", "READY-A"]
    assert dependency_payload["resolved"] == ["READY-A"]
    assert dependency_payload["failed"] == ["MISSING-DEP-MIB"]

    assert service.compile_target_mib_names(["READY-A", "", "IF-MIB", "READY-A"]) == [
        "READY-A",
        "IF-MIB",
        "SNMPv2-MIB",
    ]

    outside_file = settings.data_dir / "outside.mib"
    outside_file.write_text("OUTSIDE-MIB DEFINITIONS ::= BEGIN\nEND\n")
    assert service.relative_upload_path(outside_file) is None
    assert service.relative_upload_directory(outside_file.parent) == ""
    with pytest.raises(RuntimeError, match="managed upload directory"):
        service.uploaded_target_path("../escape.mib")


def test_source_service_inventory_precedence_and_duplicate_resolution(isolated_db):
    service, settings, _logs, _snapshot = _make_source_service(isolated_db)

    upload_root = settings.data_dir / "mibs"
    root_file = upload_root / "ROOT-MIB.mib"
    shared_common = upload_root / "common" / "SHARED-MIB.mib"
    dupe_vendor = upload_root / "vendor" / "DUPE-MIB.mib"
    named_vendor = upload_root / "vendor" / "vendor-copy-2026.txt"
    auto_file = upload_root / "auto-fetched" / "AUTO-MIB.my"
    bundled_file = settings.bundled_mibs_dir / "BUNDLED-MIB.mib"

    _write_mib(root_file, "ROOT-MIB")
    _write_mib(shared_common, "SHARED-MIB")
    _write_mib(dupe_vendor, "DUPE-MIB")
    _write_mib(named_vendor, "DECLARED-NAME-MIB", imports=["IF-MIB", "IF-MIB", "SNMPv2-MIB"])
    _write_mib(auto_file, "AUTO-MIB")
    _write_mib(bundled_file, "BUNDLED-MIB")

    inventory = {entry["relative_path"]: entry for entry in service.uploaded_source_inventory()}
    assert set(inventory) == {
        "ROOT-MIB.mib",
        "common/SHARED-MIB.mib",
        "vendor/DUPE-MIB.mib",
        "vendor/vendor-copy-2026.txt",
        "auto-fetched/AUTO-MIB.my",
    }
    assert inventory["ROOT-MIB.mib"]["group"] == "default"
    assert inventory["vendor/vendor-copy-2026.txt"]["mib_name"] == "DECLARED-NAME-MIB"

    assert set(service.uploaded_file_names()) == set(inventory)
    assert set(service.uploaded_mib_names()) == {
        "ROOT-MIB",
        "SHARED-MIB",
        "DUPE-MIB",
        "DECLARED-NAME-MIB",
        "AUTO-MIB",
    }
    assert set(service.available_source_mib_names()) >= {"BUNDLED-MIB", "ROOT-MIB", "AUTO-MIB"}

    assert [service.relative_upload_directory(path) for path in service.ordered_uploaded_source_dirs()] == [
        "",
        "common",
        "vendor",
        "auto-fetched",
    ]

    assert service.source_group_for_path(root_file, source_kind="uploaded") == "default"
    assert service.source_group_for_path(auto_file, source_kind="auto-fetched") == "auto-fetched"
    assert service.source_group_for_path(bundled_file, source_kind="bundled") == "bundled"
    assert service.source_group_for_path(Path("/tmp/compiled/bundle.json"), source_kind="compiled") == ""

    assert service.source_relative_path(root_file, source_kind="uploaded") == "ROOT-MIB.mib"
    assert service.source_relative_path(bundled_file, source_kind="bundled") == "BUNDLED-MIB.mib"
    assert service.relative_path_group("ROOT-MIB.mib") == "default"
    assert service.relative_path_group("vendor/vendor-copy-2026.txt") == "vendor"

    summary = {row["name"]: row for row in service.source_group_summary(
        [
            {"source_kind": "uploaded", "source_group": "common"},
            {"source_kind": "uploaded", "source_group": "vendor"},
            {"source_kind": "auto-fetched", "source_group": "auto-fetched"},
            {"source_kind": "bundled", "source_group": "bundled"},
        ]
    )}
    assert summary["default"] == {
        "name": "default",
        "file_count": 1,
        "mib_count": 1,
        "active_module_count": 0,
    }
    assert summary["common"]["active_module_count"] == 1
    assert summary["vendor"]["file_count"] == 2
    assert summary["auto-fetched"]["active_module_count"] == 1

    unique = service.upload_duplicate_resolution(
        mib_name="UNIQUE-MIB",
        target_relative_path="vendor/UNIQUE-MIB.mib",
        source_group="vendor",
        will_replace=False,
    )
    assert unique["resolution_status"] == "unique"

    shadowed = service.upload_duplicate_resolution(
        mib_name="SHARED-MIB",
        target_relative_path="vendor/SHARED-MIB.mib",
        source_group="vendor",
        will_replace=False,
    )
    assert shadowed["resolution_status"] == "shadowed"
    assert shadowed["predicted_active_relative_path"] == "common/SHARED-MIB.mib"
    assert shadowed["duplicate_sources"] == [
        {"relative_path": "common/SHARED-MIB.mib", "source_group": "common"}
    ]

    active = service.upload_duplicate_resolution(
        mib_name="DUPE-MIB",
        target_relative_path="common/DUPE-MIB.mib",
        source_group="common",
        will_replace=False,
    )
    assert active["resolution_status"] == "active"
    assert active["predicted_active_relative_path"] == "common/DUPE-MIB.mib"
    assert active["duplicate_sources"] == [
        {"relative_path": "vendor/DUPE-MIB.mib", "source_group": "vendor"}
    ]

    assert service.extract_mib_name("fallback-name.mib", "no definitions here") == "fallback-name"
    assert service.storage_file_name("unsupported.bin", "IGNORED-MIB") == "unsupported.bin"
    assert service.extract_imported_modules(
        "IMPORTS\n    x FROM IF-MIB;\n    y FROM IF-MIB;\n    z FROM SNMPv2-MIB;\n"
    ) == ["IF-MIB", "SNMPv2-MIB"]
    assert set(service.source_mib_names_in_dir(upload_root, recursive=True)) == {
        "AUTO-MIB",
        "DECLARED-NAME-MIB",
        "DUPE-MIB",
        "ROOT-MIB",
        "SHARED-MIB",
    }
    assert service.missing_dependencies_from_error(
        "MIB 'B-MIB' not found and MIB 'A-MIB' not found"
    ) == ["A-MIB", "B-MIB"]


def test_source_service_cache_materialization_and_active_source_tracking(isolated_db):
    from app.models import BundleModule, BundleSet

    upload_bundle = {
        "modules": [
            {"module_name": "DECLARED-CACHE-MIB", "source_path": ""},
            {"module_name": "REMOTE-CACHE-MIB", "source_path": ""},
            {"module_name": "UNSUPPORTED-CACHE-MIB", "source_path": ""},
            {"module_name": "BUNDLED-MIB", "source_path": ""},
            {"module_name": "COMPILED-ONLY", "compiled_path": "/tmp/compiled/COMPILED-ONLY.json"},
        ]
    }
    service, settings, logs, _snapshot = _make_source_service(
        isolated_db,
        active_bundle=upload_bundle,
    )

    upload_root = settings.data_dir / "mibs"
    declared_path = upload_root / "common" / "vendor-copy-2026.txt"
    bundled_file = settings.bundled_mibs_dir / "BUNDLED-MIB.mib"
    raw_cache_dir = settings.tsmi_cache_dir / "raw"
    raw_cache_dir.mkdir(parents=True, exist_ok=True)
    remote_cache = raw_cache_dir / "https_example.invalid_remote-cache.txt"
    unsupported_cache = raw_cache_dir / "https_example.invalid_unsupported-cache"

    _write_mib(declared_path, "DECLARED-CACHE-MIB")
    _write_mib(bundled_file, "BUNDLED-MIB")
    _write_mib(remote_cache, "REMOTE-CACHE-MIB")
    _write_mib(unsupported_cache, "UNSUPPORTED-CACHE-MIB")

    with isolated_db["session_factory"]() as session:
        bundle_set = BundleSet(
            bundle_key="bundle-1",
            label="test bundle",
            storage_path=str(settings.data_dir / "bundle-1.json"),
            status="active",
            is_active=True,
        )
        session.add(bundle_set)
        session.flush()
        session.add_all(
            [
                BundleModule(bundle_set_id=bundle_set.id, module_name="REMOTE-CACHE-MIB"),
                BundleModule(bundle_set_id=bundle_set.id, module_name="UNSUPPORTED-CACHE-MIB"),
            ]
        )
        session.commit()
        bundle_set_id = bundle_set.id

    assert service.cached_remote_source_path("REMOTE-CACHE-MIB") == remote_cache
    assert service.cached_remote_source_path("MISSING-MIB") is None
    assert service.source_path_for_module("vendor-copy-2026") == declared_path
    assert service.source_path_for_module("DECLARED-CACHE-MIB") == declared_path
    hint_path = settings.data_dir / "hint-file.mib"
    _write_mib(hint_path, "HINT-MIB")
    assert service.source_path_for_module("IGNORED", hint_path=hint_path) == hint_path

    persisted = service.materialize_cached_remote_modules(
        ["REMOTE-CACHE-MIB", "UNSUPPORTED-CACHE-MIB", "DECLARED-CACHE-MIB", "MISSING-MIB"],
        bundle_set_id=bundle_set_id,
    )
    assert persisted["DECLARED-CACHE-MIB"] == str(declared_path)
    assert Path(persisted["REMOTE-CACHE-MIB"]).name == "REMOTE-CACHE-MIB.txt"
    assert Path(persisted["UNSUPPORTED-CACHE-MIB"]).name == "UNSUPPORTED-CACHE-MIB.mib"
    assert (upload_root / "auto-fetched" / "REMOTE-CACHE-MIB.txt").exists()
    assert (upload_root / "auto-fetched" / "UNSUPPORTED-CACHE-MIB.mib").exists()

    with isolated_db["session_factory"]() as session:
        modules = {
            row.module_name: row.source_path
            for row in session.query(BundleModule).order_by(BundleModule.module_name).all()
        }
    assert modules["REMOTE-CACHE-MIB"] == persisted["REMOTE-CACHE-MIB"]
    assert modules["UNSUPPORTED-CACHE-MIB"] == persisted["UNSUPPORTED-CACHE-MIB"]

    auto_fetched_path = upload_root / "auto-fetched" / "REMOTE-CACHE-MIB.txt"
    upload_bundle["modules"][0]["source_path"] = str(declared_path)
    upload_bundle["modules"][1]["source_path"] = str(auto_fetched_path)
    upload_bundle["modules"][2]["source_path"] = str(upload_root / "auto-fetched" / "UNSUPPORTED-CACHE-MIB.mib")
    upload_bundle["modules"][3]["source_path"] = str(bundled_file)

    active_sources = service.active_source_map()
    assert active_sources["DECLARED-CACHE-MIB"]["source_kind"] == "uploaded"
    assert active_sources["DECLARED-CACHE-MIB"]["relative_path"] == "common/vendor-copy-2026.txt"
    assert active_sources["REMOTE-CACHE-MIB"]["source_kind"] == "auto-fetched"
    assert active_sources["BUNDLED-MIB"]["source_kind"] == "bundled"
    assert active_sources["COMPILED-ONLY"]["source_kind"] == "compiled"

    promotions = service.promoted_active_sources(
        before_active_sources={
            "DECLARED-CACHE-MIB": {"relative_path": "common/old-copy.mib"},
            "REMOTE-CACHE-MIB": {"relative_path": "auto-fetched/REMOTE-CACHE-MIB.txt"},
        },
        after_active_sources={
            "DECLARED-CACHE-MIB": active_sources["DECLARED-CACHE-MIB"],
            "REMOTE-CACHE-MIB": active_sources["REMOTE-CACHE-MIB"],
        },
        deleted_paths=["common/old-copy.mib"],
    )
    assert promotions == [
        {
            "mib_name": "DECLARED-CACHE-MIB",
            "previous_relative_path": "common/old-copy.mib",
            "active_relative_path": "common/vendor-copy-2026.txt",
            "source_group": "common",
            "source_kind": "uploaded",
        }
    ]
    assert service.promoted_active_sources(
        before_active_sources={},
        after_active_sources={},
        deleted_paths=[],
    ) == []

    assert any("Persisted auto-fetched MIB sources" in message for _level, message in logs)


def test_source_service_guard_branches_and_read_failures(isolated_db, monkeypatch):
    service, settings, _logs, _snapshot = _make_source_service(isolated_db)

    upload_root = settings.data_dir / "mibs"
    broken_upload = upload_root / "common" / "BROKEN-MIB.mib"
    _write_mib(broken_upload, "DECLARED-BROKEN-MIB")

    real_read_text = Path.read_text

    def _flaky_read_text(self: Path, *args, **kwargs):
        if self == broken_upload:
            raise OSError("broken upload read")
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", _flaky_read_text)

    inventory = service.uploaded_source_inventory()
    assert inventory == [
        {
            "path": broken_upload,
            "relative_path": "common/BROKEN-MIB.mib",
            "group": "common",
            "mib_name": "BROKEN-MIB",
            "imports": [],
        }
    ]
    assert service.source_mib_names_in_dir(upload_root, recursive=True) == []

    with pytest.raises(RuntimeError, match="MIB path is required"):
        service.uploaded_target_path("")

    assert service._stored_sources_for_mib("") == []
    assert service.missing_dependencies_from_error(None) == []
    assert service.storage_file_name("fallback-name.mib", "") == "fallback-name.mib"
    assert service.upload_duplicate_resolution(
        mib_name="",
        target_relative_path="",
        source_group="common",
        will_replace=False,
    ) == {
        "resolution_status": "unique",
        "predicted_active_relative_path": None,
        "predicted_active_source_group": "common",
        "duplicate_sources": [],
        "warnings": [],
    }
    assert service.promoted_active_sources(
        before_active_sources={
            "REMOVED-MIB": {"relative_path": "common/REMOVED-MIB.mib"},
            "UNCHANGED-MIB": {"relative_path": "common/UNCHANGED-MIB.mib"},
        },
        after_active_sources={
            "UNCHANGED-MIB": {"relative_path": "common/UNCHANGED-MIB.mib"},
        },
        deleted_paths=["common/REMOVED-MIB.mib", "common/UNCHANGED-MIB.mib"],
    ) == []


def test_source_service_cached_remote_guard_branches(isolated_db, monkeypatch):
    service, settings, _logs, _snapshot = _make_source_service(isolated_db)

    assert service.cached_remote_source_path("MISSING-BEFORE-CACHE") is None

    raw_cache_dir = settings.tsmi_cache_dir / "raw"
    raw_cache_dir.mkdir(parents=True, exist_ok=True)
    (raw_cache_dir / "nested").mkdir()
    broken_cache = raw_cache_dir / "broken-cache.mib"
    _write_mib(broken_cache, "BROKEN-CACHE")

    real_read_text = Path.read_text

    def _flaky_cache_read(self: Path, *args, **kwargs):
        if self == broken_cache:
            raise OSError("broken cache read")
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", _flaky_cache_read)

    assert service.cached_remote_source_path("BROKEN-CACHE") is None
    assert service.materialize_cached_remote_modules(["MISSING-CACHE-MIB"]) == {}


def test_reset_source_caches_rebuilds_path_cache_on_next_lookup(isolated_db):
    service, settings, _logs, _snapshot = _make_source_service(isolated_db)
    upload_root = settings.data_dir / "mibs"
    source = upload_root / "common" / "RESET-CACHE-MIB.mib"
    _write_mib(source, "RESET-CACHE-MIB")

    assert service.source_path_for_module("RESET-CACHE-MIB") == source

    # Upload/delete flows reset caches mid-session; the next lookup must
    # re-warm from disk instead of missing against the cleared cache.
    service.reset_source_caches()

    assert service.source_path_for_module("RESET-CACHE-MIB") == source


def test_scan_results_are_cached_and_reused_across_callers(isolated_db, monkeypatch):
    """MGR-05: one disk read per stored file per cache generation.

    The inventory scan carries mib_name AND imports; the warm path cache and
    import lookups reuse the scan instead of re-reading each file, and a
    mutation-triggered reset forces a fresh scan.
    """
    service, settings, _logs, _snapshot = _make_source_service(isolated_db)
    upload_root = settings.data_dir / "mibs"
    _write_mib(upload_root / "common" / "CACHED-A-MIB.mib", "CACHED-A-MIB", imports=["IF-MIB"])
    _write_mib(upload_root / "vendor" / "CACHED-B-MIB.mib", "CACHED-B-MIB", imports=["SNMPv2-MIB"])

    real_read_text = Path.read_text
    reads = {"count": 0}

    def _counting_read(self: Path, *args, **kwargs):
        reads["count"] += 1
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", _counting_read)

    first = service.uploaded_source_inventory()
    second = service.uploaded_source_inventory()
    assert len(first) == 2
    assert first == second
    # Repeated calls hit the cache: both files were read exactly once.
    assert reads["count"] == 2

    by_path = {entry["relative_path"]: entry for entry in first}
    assert by_path["common/CACHED-A-MIB.mib"]["imports"] == ["IF-MIB"]
    assert by_path["vendor/CACHED-B-MIB.mib"]["imports"] == ["SNMPv2-MIB"]

    # Path-cache warm + import lookups reuse the scan — still no re-reads.
    assert service.source_path_for_module("CACHED-A-MIB") == upload_root / "common" / "CACHED-A-MIB.mib"
    assert service.imports_for_source(upload_root / "common" / "CACHED-A-MIB.mib") == ["IF-MIB"]
    assert reads["count"] == 2

    # import_for_source for a path outside the inventory reads once, then caches.
    outside = settings.data_dir / "standalone" / "STANDALONE-MIB.mib"
    _write_mib(outside, "STANDALONE-MIB", imports=["IF-MIB"])
    assert service.imports_for_source(outside) == ["IF-MIB"]
    assert service.imports_for_source(outside) == ["IF-MIB"]
    assert reads["count"] == 3

    # A mutation resets the caches; the next scan reads the files again.
    service.reset_source_caches()
    service.uploaded_source_inventory()
    assert reads["count"] == 5
