from __future__ import annotations

import json

import pytest

pytestmark = pytest.mark.unit


def _activate_mibs_bundle(isolated_db):
    from app.services.bundles import BundleCompileRequest, BundleService

    settings = isolated_db["settings"]
    bundle_service = BundleService(settings)
    bundle_service.compile_bundle(
        BundleCompileRequest(mib_names=["IF-MIB", "SNMPv2-MIB"], activate=True)
    )
    return bundle_service


def test_notification_member_enum_values_consolidate_old_and_new_node_shapes(isolated_db):
    from types import SimpleNamespace

    from app.services import mibs_service
    from app.services.bundle_state import get_bundle

    bundle_service = _activate_mibs_bundle(isolated_db)
    del bundle_service

    member = SimpleNamespace(module="IF-MIB", object="ifAdminStatus")

    new_payload = mibs_service._notification_member_payload(member, bundle=get_bundle())
    assert new_payload["enum_values"] == [
        {"label": "up", "value": 1},
        {"label": "down", "value": 2},
        {"label": "testing", "value": 3},
    ]
    assert new_payload["constraint"] == {
        "kind": "enum",
        "data": [["up", 1], ["down", 2], ["testing", 3]],
    }

    class _OldNode:
        oid = (1, 3, 6, 1, 2, 1, 2, 2, 1, 7)
        object_type = "OBJECT-TYPE"
        nodetype = "column"
        syntax = "INTEGER"
        max_access = "read-write"
        status = "current"
        description = "The desired state of the interface."
        index = None
        members = None
        enums = None
        units = None
        constraints = {"kind": "enum", "data": [["up", 1], ["down", 2], ["testing", 3]]}

    class _OldBundle:
        def resolve_node(self, module, symbol):
            del module, symbol
            return _OldNode()

    old_payload = mibs_service._notification_member_payload(member, bundle=_OldBundle())
    assert old_payload["enum_values"] == new_payload["enum_values"]
    assert old_payload["constraint"] == new_payload["constraint"]
    assert old_payload["oid"] == new_payload["oid"] == "1.3.6.1.2.1.2.2.1.7"
    assert old_payload["syntax"] == new_payload["syntax"] == "INTEGER"
    assert old_payload["input_type"] == new_payload["input_type"] == "Integer"


def test_status_module_rows_carry_module_metadata(isolated_db):
    from app.services import mibs_service
    from app.services.bundles import BundleCompileRequest, BundleService
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    state = StateStore(isolated_db["session_factory"])
    bundle_service = BundleService(settings)
    bundle_service.compile_bundle(
        BundleCompileRequest(mib_names=["IF-MIB", "SNMPv2-MIB"], activate=True)
    )

    status = mibs_service.get_status(
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )
    if_mib = next(item for item in status["mibs"] if item["name"] == "IF-MIB")
    assert if_mib["module_metadata"] is not None
    assert if_mib["module_metadata"]["lastupdated"]
    assert if_mib["module_metadata"]["organization"]
    assert len(if_mib["module_metadata"]["revisions"]) >= 1
    assert if_mib["module_metadata"]["revisions"][0]["date"]
    assert status["active_bundle_id"] is not None


def test_validate_upload_batch_surfaces_missing_dependencies(isolated_db):
    from app.services import mibs_service
    from app.services.bundles import BundleService
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    session_factory = isolated_db["session_factory"]
    state = StateStore(session_factory)
    bundle_service = BundleService(settings)

    payload = mibs_service.validate_upload_batch(
        [
            (
                "EXAMPLE-MIB.mib",
                b"""
EXAMPLE-MIB DEFINITIONS ::= BEGIN

IMPORTS
    MODULE-IDENTITY
        FROM SNMPv2-SMI
    MissingThing
        FROM MISSING-DEP-MIB;

exampleMib MODULE-IDENTITY
    LAST-UPDATED "202605120000Z"
    ORGANIZATION "Tests"
    DESCRIPTION "Validation coverage."
    ::= { 1 3 6 1 4 1 99999 1 }

END
""",
            )
        ],
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )

    assert payload["can_upload"] is False
    assert payload["global_missing_deps"] == ["MISSING-DEP-MIB"]
    assert payload["files"][0]["mib_name"] == "EXAMPLE-MIB"
    assert payload["files"][0]["missing_deps"] == ["MISSING-DEP-MIB"]
    assert payload["files"][0]["partial_blockers"] == ["MISSING-DEP-MIB"]
    assert payload["files"][0]["ready_for_partial"] is False
    assert payload["partial_compile"]["ready_mibs"] == []
    assert payload["partial_compile"]["blocked_mibs"] == ["EXAMPLE-MIB"]
    assert payload["dependency_fetch"]["auto_enabled"] is False
    assert "auto-fetch is disabled" in payload["upload_blocked_reason"]


def test_validate_upload_batch_allows_full_upload_when_auto_fetch_enabled(isolated_db):
    from app.models import AppSetting
    from app.services import mibs_service
    from app.services.bundles import BundleService
    from app.services.state_store import StateStore, _MIB_AUTO_FETCH_KEY

    settings = isolated_db["settings"]
    session_factory = isolated_db["session_factory"]

    with session_factory() as session:
        session.add(AppSetting(key=_MIB_AUTO_FETCH_KEY, value_json=True))
        session.commit()

    state = StateStore(session_factory)
    bundle_service = BundleService(settings)

    payload = mibs_service.validate_upload_batch(
        [
            (
                "EXAMPLE-MIB.mib",
                b"""
EXAMPLE-MIB DEFINITIONS ::= BEGIN

IMPORTS
    MODULE-IDENTITY
        FROM SNMPv2-SMI
    MissingThing
        FROM MISSING-DEP-MIB;

exampleMib MODULE-IDENTITY
    LAST-UPDATED "202605120000Z"
    ORGANIZATION "Tests"
    DESCRIPTION "Validation coverage."
    ::= { 1 3 6 1 4 1 99999 1 }

END
""",
            )
        ],
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )

    assert payload["can_upload"] is True
    assert payload["dependency_fetch"]["auto_enabled"] is True
    assert payload["upload_blocked_reason"] is None


def test_validate_upload_batch_reports_duplicate_shadowing_by_source_group(isolated_db):
    from app.services import mibs_service
    from app.services.bundles import BundleService
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    session_factory = isolated_db["session_factory"]
    existing_common = settings.data_dir / "mibs" / "common" / "JUNIPER-MAG-MIB.mib"
    existing_common.parent.mkdir(parents=True, exist_ok=True)
    existing_common.write_text(
        """
JUNIPER-MAG-MIB DEFINITIONS ::= BEGIN

magRoot OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 2636 3 65 1 }

END
""".strip()
        + "\n"
    )

    state = StateStore(session_factory)
    bundle_service = BundleService(settings)

    payload = mibs_service.validate_upload_batch(
        [
            (
                "JUNIPER-MAG-MIB.txt",
                b"""
JUNIPER-MAG-MIB DEFINITIONS ::= BEGIN

magRoot OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 2636 3 65 1 }

END
""",
            )
        ],
        source_group="juniper",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )

    assert payload["can_upload"] is True
    assert payload["duplicate_modules"] == [
        {
            "mib_name": "JUNIPER-MAG-MIB",
            "target_relative_path": "juniper/JUNIPER-MAG-MIB.txt",
            "source_group": "juniper",
            "resolution_status": "shadowed",
            "predicted_active_relative_path": "common/JUNIPER-MAG-MIB.mib",
            "predicted_active_source_group": "common",
            "duplicate_sources": [
                {
                    "relative_path": "common/JUNIPER-MAG-MIB.mib",
                    "source_group": "common",
                }
            ],
            "warnings": [
                (
                    "Another stored source has higher precedence and will remain active: "
                    "common/JUNIPER-MAG-MIB.mib. This upload will be stored but shadowed "
                    "until the higher-precedence copy is deleted or replaced."
                )
            ],
        }
    ]
    assert payload["files"][0]["duplicate_resolution"]["resolution_status"] == "shadowed"
    assert (
        payload["files"][0]["duplicate_resolution"]["predicted_active_relative_path"]
        == "common/JUNIPER-MAG-MIB.mib"
    )


def test_validate_upload_batch_canonicalizes_target_path_from_declared_mib_name(isolated_db):
    from app.services import mibs_service
    from app.services.bundles import BundleService
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    session_factory = isolated_db["session_factory"]
    state = StateStore(session_factory)
    bundle_service = BundleService(settings)

    payload = mibs_service.validate_upload_batch(
        [
            (
                "vendor-copy-2026.txt",
                b"""
CANONICAL-UPLOAD-MIB DEFINITIONS ::= BEGIN

IMPORTS
    enterprises FROM SNMPv2-SMI;

canonicalUploadNode OBJECT IDENTIFIER ::= { enterprises 424242 }

END
""",
            )
        ],
        source_group="vendor",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )

    assert payload["files"][0]["safe_name"] == "vendor-copy-2026.txt"
    assert payload["files"][0]["storage_name"] == "CANONICAL-UPLOAD-MIB.txt"
    assert payload["files"][0]["target_relative_path"] == "vendor/CANONICAL-UPLOAD-MIB.txt"


def test_upload_uses_ready_targets_and_setting_driven_remote_fetch(isolated_db, monkeypatch):
    from app.models import AppSetting
    from app.services import mibs_service
    from app.services.bundles import BundleService
    from app.services.state_store import StateStore, _MIB_AUTO_FETCH_KEY

    settings = isolated_db["settings"]
    session_factory = isolated_db["session_factory"]

    with session_factory() as session:
        session.add(AppSetting(key=_MIB_AUTO_FETCH_KEY, value_json=True))
        session.commit()

    state = StateStore(session_factory)
    bundle_service = BundleService(settings)

    cached_remote_source = settings.tsmi_cache_dir / "raw" / "https_example.invalid_MISSING-DEP-MIB.mib"
    cached_remote_source.parent.mkdir(parents=True, exist_ok=True)
    cached_remote_source.write_text(
        """
MISSING-DEP-MIB DEFINITIONS ::= BEGIN

missingDepNode OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 99999 99 }

END
""".strip()
        + "\n"
    )
    captured: dict[str, object] = {}

    def fake_compile_bundle(request):
        captured["request"] = request
        return {
            "bundle": {"id": 1},
            "remote_modules": ["MISSING-DEP-MIB"],
        }

    monkeypatch.setattr(bundle_service, "compile_bundle", fake_compile_bundle)

    result = mibs_service.upload(
        [
            (
                "READY-MIB.mib",
                b"""
READY-MIB DEFINITIONS ::= BEGIN

readyNode OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 99999 1 }

END
""",
            ),
            (
                "BLOCKED-MIB.mib",
                b"""
BLOCKED-MIB DEFINITIONS ::= BEGIN

IMPORTS
    MissingThing
        FROM MISSING-DEP-MIB;

blockedNode OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 99999 2 }

END
""",
            ),
        ],
        compile_mode="partial",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )

    request = captured["request"]
    assert request.online is True
    assert request.remote_sources == []
    assert "READY-MIB" in request.mib_names
    assert "BLOCKED-MIB" not in request.mib_names
    assert request.label.startswith("common-upload-")
    assert result["compile_mode"] == "partial"
    assert result["compiled_mibs"] == ["READY-MIB"]
    assert any(
        row["status"] == "loaded" and row["mib_name"] == "READY-MIB"
        for row in result["results"]
    )
    assert any(
        row["status"] == "skipped" and row["mib_name"] == "BLOCKED-MIB"
        for row in result["results"]
    )
    assert result["dependency_fetch"]["enabled"] is True
    assert result["dependency_fetch"]["using_default_sources"] is True
    assert result["dependency_fetch"]["resolved"] == ["MISSING-DEP-MIB"]
    assert (settings.data_dir / "mibs" / "auto-fetched" / "MISSING-DEP-MIB.mib").exists()


def test_status_surfaces_active_bundle_producer_capabilities(isolated_db):
    from app.services import mibs_service
    from app.services.bundles import BundleCompileRequest, BundleService
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    state = StateStore(isolated_db["session_factory"])
    bundle_service = BundleService(settings)

    bundle_service.compile_bundle(
        BundleCompileRequest(mib_names=["IF-MIB", "SNMPv2-MIB"], activate=True)
    )

    status = mibs_service.get_status(
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )
    assert status["producer_version"] == "0.5.3"
    assert status["recompile_recommended"] is False
    assert status["missing_capabilities"] == []
    assert status["active_bundle_id"] is not None
    assert status["active_bundle_label"]
    assert status["loaded"] == len(status["mibs"])


def test_reload_without_uploaded_mibs_reverts_to_bundled_starter_bundle(isolated_db):
    from app.services import mibs_service
    from app.services.bundles import BundleService
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    session_factory = isolated_db["session_factory"]
    state = StateStore(session_factory)
    bundle_service = BundleService(settings)

    result = mibs_service.reload(settings=settings, state=state, bundle_service=bundle_service)
    effective_bundle = BundleService(settings).get_effective_bundle_summary()

    assert result["loaded"] >= 1
    assert result["failed"] == 0
    assert effective_bundle is not None
    assert effective_bundle["label"] == "Bundled Starter MIBs"
    assert effective_bundle["is_active"] is True
    assert any(module["module_name"] == "IF-MIB" for module in effective_bundle["modules"])


def test_upload_saves_into_source_group_and_reports_group_inventory(isolated_db, monkeypatch):
    from app.services import mibs_service
    from app.services.bundles import BundleService
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    session_factory = isolated_db["session_factory"]
    state = StateStore(session_factory)
    bundle_service = BundleService(settings)

    captured: dict[str, object] = {}

    def fake_compile_bundle(request):
        captured["request"] = request
        return {
            "bundle": {"id": 1},
            "remote_modules": [],
        }

    monkeypatch.setattr(bundle_service, "compile_bundle", fake_compile_bundle)

    result = mibs_service.upload(
        [
            (
                "ERICSSON-TEST-MIB.mib",
                b"""
ERICSSON-TEST-MIB DEFINITIONS ::= BEGIN

testNode OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 99999 7 }

END
""",
            )
        ],
        source_group="ericsson/core",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )

    request = captured["request"]
    assert request.mib_dirs[0].endswith("/mibs/ericsson/core")
    assert request.mib_dirs[-1].endswith("/mibs_bundled")
    assert request.label.startswith("ericsson-core-upload-")
    assert result["source_group"] == "ericsson/core"
    assert (settings.data_dir / "mibs" / "ericsson" / "core" / "ERICSSON-TEST-MIB.mib").exists()

    status = mibs_service.get_status(settings=settings, state=state, bundle_service=bundle_service)
    group_rows = {item["name"]: item for item in status["source_groups"]}
    assert group_rows["ericsson/core"]["file_count"] == 1
    assert group_rows["ericsson/core"]["mib_count"] == 1


def test_upload_compiles_when_filename_differs_from_declared_mib_name(isolated_db):
    from app.services import mibs_service
    from app.services.bundles import BundleService
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    session_factory = isolated_db["session_factory"]
    state = StateStore(session_factory)
    bundle_service = BundleService(settings)

    result = mibs_service.upload(
        [
            (
                "vendor-copy-2026.txt",
                b"""
CANONICAL-UPLOAD-MIB DEFINITIONS ::= BEGIN

IMPORTS
    enterprises FROM SNMPv2-SMI;

canonicalUploadNode OBJECT IDENTIFIER ::= { enterprises 424242 }

END
""",
            )
        ],
        source_group="vendor",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )

    assert result["results"][0]["status"] == "loaded"
    assert (settings.data_dir / "mibs" / "vendor" / "CANONICAL-UPLOAD-MIB.txt").exists()
    assert (settings.data_dir / "mibs" / "vendor" / "vendor-copy-2026.txt").exists() is False

    status = mibs_service.get_status(settings=settings, state=state, bundle_service=bundle_service)
    loaded_by_name = {row["name"]: row for row in status["mibs"]}
    assert loaded_by_name["CANONICAL-UPLOAD-MIB"]["relative_path"] == "vendor/CANONICAL-UPLOAD-MIB.txt"


def test_status_classifies_parse_failures_as_invalid(isolated_db):
    from app.services import mibs_service
    from app.services.bundles import BundleService
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    session_factory = isolated_db["session_factory"]
    state = StateStore(session_factory)
    bundle_service = BundleService(settings)

    result = mibs_service.upload(
        [
            (
                "BROKEN-MIB.mib",
                b"""
BROKEN-MIB DEFINITIONS ::= BEGIN

brokenNode OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 99999

END
""",
            )
        ],
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )

    assert result["results"][0]["status"] == "failed"

    status = mibs_service.get_status(settings=settings, state=state, bundle_service=bundle_service)
    assert status["loaded"] == 0
    assert status["failed"] == 1
    assert status["errors"] == status["failed_modules"]
    assert status["failed_modules"][0]["name"] == "BROKEN-MIB"
    assert status["failed_modules"][0]["file"] == "common/BROKEN-MIB.mib"
    assert status["failed_modules"][0]["deletable"] is True
    assert status["failed_modules"][0]["status"] == "invalid"
    inventory_by_file = {row["file"]: row for row in status["source_inventory"]}
    assert inventory_by_file["common/BROKEN-MIB.mib"]["status"] == "invalid"


def test_status_surfaces_failed_runs_beyond_the_recent_window(isolated_db):
    from app.models import CompileRun
    from app.services import mibs_service
    from app.services.bundles import BundleService
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    session_factory = isolated_db["session_factory"]
    state = StateStore(session_factory)
    bundle_service = BundleService(settings)

    stale_path = settings.data_dir / "mibs" / "common" / "STALE-FAIL-MIB.mib"
    stale_path.parent.mkdir(parents=True, exist_ok=True)
    stale_path.write_text(
        "STALE-FAIL-MIB DEFINITIONS ::= BEGIN\n"
        "staleFailNode OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 99999 70 }\n"
        "END\n"
    )

    with session_factory() as session:
        for index in range(7):
            names = ["STALE-FAIL-MIB"] if index == 0 else ["NEWER-FAIL-MIB"]
            session.add(
                CompileRun(
                    requested_mib_names_json=names,
                    source_dirs_json=[],
                    status="failed",
                    error_text="simulated compile failure",
                )
            )
        session.commit()

    status = mibs_service.get_status(
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )

    # MGR-09: only the 5 most-recent failed runs used to be scanned, so the
    # oldest failure's file sat "pending" forever. The widened scan window
    # surfaces it as failed.
    inventory_by_file = {row["file"]: row for row in status["source_inventory"]}
    assert inventory_by_file["common/STALE-FAIL-MIB.mib"]["status"] == "failed"
    assert status["failed"] == 1
    assert status["failed_modules"][0]["name"] == "STALE-FAIL-MIB"


def test_source_service_singleton_construction_is_thread_safe(isolated_db):
    import threading

    from app.services import mibs_service
    from app.services.bundles import BundleService
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    state = StateStore(isolated_db["session_factory"])
    bundle_service = BundleService(settings)

    mibs_service._invalidate_source_cache()
    results: list[object] = []
    errors: list[BaseException] = []
    barrier = threading.Barrier(4)

    def build():
        try:
            barrier.wait()
            results.append(mibs_service._make_source_service(settings, state, bundle_service))
        except BaseException as exc:  # pragma: no cover - failure diagnostics
            errors.append(exc)

    threads = [threading.Thread(target=build) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    # MGR-10: racing callers must observe one singleton, never two instances
    # or a torn-down cache holder.
    assert errors == []
    assert len({id(item) for item in results}) == 1

    # Invalidation is serialized too: dropping the instance and rebuilding
    # yields a fresh working service, not the stale one.
    mibs_service._invalidate_source_cache()
    rebuilt = mibs_service._make_source_service(settings, state, bundle_service)
    assert rebuilt is not results[0]


def test_status_uses_compile_run_source_path_for_failed_duplicates(isolated_db):
    from app.services import mibs_service
    from app.services.bundles import BundleService
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    session_factory = isolated_db["session_factory"]
    state = StateStore(session_factory)
    bundle_service = BundleService(settings)

    result = mibs_service.upload(
        [
            (
                "BROKEN-DUP-MIB.mib",
                b"""
BROKEN-DUP-MIB DEFINITIONS ::= BEGIN

brokenNode OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 99999

END
""",
            )
        ],
        source_group="vendor",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )

    assert result["results"][0]["status"] == "failed"

    higher_precedence_copy = settings.data_dir / "mibs" / "common" / "BROKEN-DUP-MIB.mib"
    higher_precedence_copy.parent.mkdir(parents=True, exist_ok=True)
    higher_precedence_copy.write_text(
        """
BROKEN-DUP-MIB DEFINITIONS ::= BEGIN

IMPORTS
    enterprises FROM SNMPv2-SMI;

brokenDupNode OBJECT IDENTIFIER ::= { enterprises 99999 }

END
""".strip()
        + "\n"
    )
    mibs_service._invalidate_source_cache()

    status = mibs_service.get_status(
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )

    assert status["failed"] == 1
    inventory_by_file = {row["file"]: row for row in status["source_inventory"]}
    assert inventory_by_file["vendor/BROKEN-DUP-MIB.mib"]["status"] == "invalid"
    assert inventory_by_file["vendor/BROKEN-DUP-MIB.mib"]["file"] == "vendor/BROKEN-DUP-MIB.mib"
    assert inventory_by_file["common/BROKEN-DUP-MIB.mib"]["status"] == "pending"
    assert status["failed_modules"] == [inventory_by_file["vendor/BROKEN-DUP-MIB.mib"]]


def test_status_reports_shadowed_duplicate_sources(isolated_db):
    from app.services import mibs_service
    from app.services.bundles import BundleService
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    session_factory = isolated_db["session_factory"]
    state = StateStore(session_factory)
    bundle_service = BundleService(settings)

    result = mibs_service.upload(
        [
            (
                "JUNIPER-MAG-MIB.mib",
                b"""
JUNIPER-MAG-MIB DEFINITIONS ::= BEGIN

IMPORTS
    enterprises FROM SNMPv2-SMI;

juniperMagNode OBJECT IDENTIFIER ::= { enterprises 99999 }

END
""",
            )
        ],
        source_group="common",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )

    assert result["results"][0]["status"] == "loaded"

    shadowed_path = settings.data_dir / "mibs" / "juniper" / "JUNIPER-MAG-MIB.mib"
    shadowed_path.parent.mkdir(parents=True, exist_ok=True)
    shadowed_path.write_text(
        "JUNIPER-MAG-MIB DEFINITIONS ::= BEGIN\n"
        "IMPORTS enterprises FROM SNMPv2-SMI;\n"
        "juniperMagShadowedNode OBJECT IDENTIFIER ::= { enterprises 99998 }\n"
        "END\n"
    )
    mibs_service._invalidate_source_cache()

    status = mibs_service.get_status(
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )

    assert status["loaded"] >= 1
    assert status["failed"] == 0
    assert status["errors"] == []
    assert status["failed_modules"] == []
    inventory_by_file = {row["file"]: row for row in status["source_inventory"]}
    assert inventory_by_file["common/JUNIPER-MAG-MIB.mib"]["status"] == "active"
    assert inventory_by_file["juniper/JUNIPER-MAG-MIB.mib"]["status"] == "shadowed"
    assert (
        inventory_by_file["juniper/JUNIPER-MAG-MIB.mib"]["active_relative_path"]
        == "common/JUNIPER-MAG-MIB.mib"
    )
    assert inventory_by_file["juniper/JUNIPER-MAG-MIB.mib"]["objects"] >= 1


def test_export_catalog_scopes_shadowed_duplicate_membership_by_source_group(isolated_db):
    from app.services import mibs_service
    from app.services.bundles import BundleService
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    session_factory = isolated_db["session_factory"]
    state = StateStore(session_factory)
    bundle_service = BundleService(settings)

    result = mibs_service.upload(
        [
            (
                "JUNIPER-MAG-MIB.mib",
                b"""
JUNIPER-MAG-MIB DEFINITIONS ::= BEGIN

IMPORTS
    enterprises FROM SNMPv2-SMI;

juniperMagNode OBJECT IDENTIFIER ::= { enterprises 99999 }

END
""",
            )
        ],
        source_group="common",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )

    assert result["results"][0]["status"] == "loaded"

    shadowed_path = settings.data_dir / "mibs" / "juniper" / "JUNIPER-MAG-MIB.mib"
    shadowed_path.parent.mkdir(parents=True, exist_ok=True)
    shadowed_path.write_text(
        "JUNIPER-MAG-MIB DEFINITIONS ::= BEGIN\n"
        "IMPORTS enterprises FROM SNMPv2-SMI;\n"
        "juniperMagShadowedNode OBJECT IDENTIFIER ::= { enterprises 99998 }\n"
        "END\n"
    )
    mibs_service._invalidate_source_cache()

    catalog = mibs_service.export_catalog(
        source_groups=["juniper"],
        export_type="catalog",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )

    assert catalog["filters"]["requested_source_groups"] == ["juniper"]
    assert catalog["summary"]["module_count"] == 1
    assert {module["module_name"] for module in catalog["modules"]} == {"JUNIPER-MAG-MIB"}
    assert catalog["modules"][0]["source_group"] == "juniper"
    assert catalog["modules"][0]["source_relative_path"] == "juniper/JUNIPER-MAG-MIB.mib"
    assert all(item["source_group"] == "juniper" for item in catalog["objects"])


def test_delete_uploaded_mib_supports_grouped_relative_paths(isolated_db):
    from app.services import mibs_service
    from app.services.bundles import BundleService
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    session_factory = isolated_db["session_factory"]
    grouped_path = settings.data_dir / "mibs" / "juniper" / "JUNIPER-TEST-MIB.mib"
    grouped_path.parent.mkdir(parents=True, exist_ok=True)
    grouped_path.write_text(
        """
JUNIPER-TEST-MIB DEFINITIONS ::= BEGIN

testNode OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 99999 8 }

END
""".strip()
        + "\n"
    )

    state = StateStore(session_factory)
    bundle_service = BundleService(settings)

    deleted = mibs_service.delete_mib(
        "juniper/JUNIPER-TEST-MIB.mib",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )

    assert deleted["filename"] == "juniper/JUNIPER-TEST-MIB.mib"
    assert deleted["reload_applied"] is True
    assert "loaded" in deleted
    assert grouped_path.exists() is False


def test_delete_uploaded_mib_restores_file_when_rebuild_fails(isolated_db, monkeypatch):
    from app.services import mibs_service
    from app.services.bundles import BundleService, BundleServiceError
    from app.services.mibs_service import MibsError
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    session_factory = isolated_db["session_factory"]
    mib_path = settings.data_dir / "mibs" / "ericsson" / "ERICSSON-ROLLBACK-MIB.mib"
    mib_path.parent.mkdir(parents=True, exist_ok=True)
    mib_path.write_text(
        "ERICSSON-ROLLBACK-MIB DEFINITIONS ::= BEGIN\n"
        "rollbackNode OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 99999 9 }\n"
        "END\n"
    )

    state = StateStore(session_factory)
    bundle_service = BundleService(settings)
    monkeypatch.setattr(
        bundle_service,
        "compile_bundle",
        lambda request: (_ for _ in ()).throw(BundleServiceError("simulated rebuild failure")),
    )

    with pytest.raises(MibsError, match="restored"):
        mibs_service.delete_mib(
            "ericsson/ERICSSON-ROLLBACK-MIB.mib",
            settings=settings,
            state=state,
            bundle_service=bundle_service,
        )

    assert mib_path.exists() is True


def test_delete_uploaded_mibs_delete_files_and_prune_empty_dir(isolated_db):
    from app.services import mibs_service
    from app.services.bundles import BundleService
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    session_factory = isolated_db["session_factory"]
    first_path = settings.data_dir / "mibs" / "juniper" / "JUNIPER-A.mib"
    second_path = settings.data_dir / "mibs" / "juniper" / "JUNIPER-B.mib"
    first_path.parent.mkdir(parents=True, exist_ok=True)
    first_path.write_text(
        "JUNIPER-A DEFINITIONS ::= BEGIN\n"
        "juniperANode OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 99999 10 }\n"
        "END\n"
    )
    second_path.write_text(
        "JUNIPER-B DEFINITIONS ::= BEGIN\n"
        "juniperBNode OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 99999 11 }\n"
        "END\n"
    )

    state = StateStore(session_factory)
    bundle_service = BundleService(settings)

    deleted = mibs_service.delete_mibs(
        ["juniper/JUNIPER-A.mib", "juniper/JUNIPER-B.mib"],
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )

    assert first_path.exists() is False
    assert second_path.exists() is False
    assert first_path.parent.exists() is False
    assert deleted["reload_applied"] is True
    assert "loaded" in deleted


def test_delete_uploaded_mibs_restore_files_when_rebuild_fails(isolated_db, monkeypatch):
    from app.services import mibs_service
    from app.services.bundles import BundleService, BundleServiceError
    from app.services.mibs_service import MibsError
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    session_factory = isolated_db["session_factory"]
    first_path = settings.data_dir / "mibs" / "ericsson" / "ERICSSON-A.mib"
    second_path = settings.data_dir / "mibs" / "ericsson" / "ERICSSON-B.mib"
    first_path.parent.mkdir(parents=True, exist_ok=True)
    first_path.write_text(
        "ERICSSON-A DEFINITIONS ::= BEGIN\n"
        "ericssonANode OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 99999 12 }\n"
        "END\n"
    )
    second_path.write_text(
        "ERICSSON-B DEFINITIONS ::= BEGIN\n"
        "ericssonBNode OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 99999 13 }\n"
        "END\n"
    )

    state = StateStore(session_factory)
    bundle_service = BundleService(settings)
    monkeypatch.setattr(
        bundle_service,
        "compile_bundle",
        lambda request: (_ for _ in ()).throw(BundleServiceError("simulated rebuild failure")),
    )

    with pytest.raises(MibsError, match="restored"):
        mibs_service.delete_mibs(
            ["ericsson/ERICSSON-A.mib", "ericsson/ERICSSON-B.mib"],
            settings=settings,
            state=state,
            bundle_service=bundle_service,
        )

    assert first_path.exists() is True
    assert second_path.exists() is True


def test_export_catalog_requires_an_active_bundle(isolated_db):
    from app.services import mibs_service
    from app.services.bundle_state import set_bundle
    from app.services.mibs_service import MibsError
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    state = StateStore(isolated_db["session_factory"])
    bundle_service = _activate_mibs_bundle(isolated_db)
    set_bundle(None)

    with pytest.raises(MibsError, match="No active MIB bundle"):
        mibs_service.export_catalog(
            settings=settings,
            state=state,
            bundle_service=bundle_service,
        )


def test_export_catalog_filters_and_export_types_cover_live_bundle_exports(isolated_db):
    from app.services import mibs_service
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    state = StateStore(isolated_db["session_factory"])
    bundle_service = _activate_mibs_bundle(isolated_db)

    catalog = mibs_service.export_catalog(
        modules=["IF-MIB"],
        notifications=["IF-MIB::linkDown"],
        export_type="catalog",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )
    assert catalog["export_version"] == 2
    assert catalog["filters"]["export_type"] == "catalog"
    assert catalog["summary"]["module_count"] == 1
    assert catalog["summary"]["notification_count"] == 1
    assert catalog["summary"]["notification_member_count"] >= 1
    assert catalog["notifications"][0]["full_name"] == "IF-MIB::linkDown"
    assert catalog["notifications"][0]["member_count"] == len(catalog["notifications"][0]["members"])
    assert "full_name" not in catalog["notifications"][0]["members"][0]
    assert "source_group" not in catalog["notifications"][0]["members"][0]
    assert "source_kind" not in catalog["notifications"][0]["members"][0]
    assert "source_relative_path" not in catalog["notifications"][0]["members"][0]
    assert catalog["notification_members"]
    assert all("member_full_name" not in item for item in catalog["notification_members"])
    assert all("member_source_group" not in item for item in catalog["notification_members"])
    assert all("member_source_kind" not in item for item in catalog["notification_members"])
    assert all("member_source_relative_path" not in item for item in catalog["notification_members"])
    assert all("notification_full_name" not in item for item in catalog["notification_members"])
    assert all(item["module"] == "IF-MIB" for item in catalog["objects"])

    objects_only = mibs_service.export_catalog(
        modules=["IF-MIB"],
        export_type="objects",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )
    assert objects_only["notifications"] == []
    assert objects_only["summary"]["object_count"] >= 1

    modules_only = mibs_service.export_catalog(
        modules=["IF-MIB"],
        export_type="modules",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )
    assert modules_only["objects"] == []
    assert modules_only["notifications"] == []
    assert modules_only["summary"]["module_count"] == 1

    class _ScopedSourceService:
        def normalize_source_group(self, source_group):
            return str(source_group or "").strip()

        def uploaded_source_inventory(self):
            return []

        def source_path_for_module(self, module_name):
            del module_name
            return None

        def module_source_kind(self, source_path):
            return "uploaded" if "juniper" in source_path.as_posix() else "bundled"

        def source_group_for_path(self, source_path, *, source_kind):
            del source_kind
            return "juniper" if "juniper" in source_path.as_posix() else "bundled"

        def source_relative_path(self, source_path, *, source_kind):
            del source_kind
            return source_path.name

    bundle_service.get_effective_bundle_summary = lambda: {
        "label": "Lab Bundle",
        "bundle_key": "lab-bundle",
        "modules": [
            {"module_name": "IF-MIB", "source_path": "/virtual/juniper/IF-MIB.mib"},
            {"module_name": "SNMPv2-MIB", "source_path": "/virtual/bundled/SNMPv2-MIB.mib"},
        ],
    }
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(mibs_service, "_make_source_service", lambda *args, **kwargs: _ScopedSourceService())
    try:
        scoped = mibs_service.export_catalog(
            source_groups=["juniper"],
            export_type="catalog",
            settings=settings,
            state=state,
            bundle_service=bundle_service,
        )
    finally:
        monkeypatch.undo()

    assert scoped["filters"]["requested_source_groups"] == ["juniper"]
    assert scoped["metadata"]["bundle_label"] == "Lab Bundle"
    assert {module["module_name"] for module in scoped["modules"]} == {"IF-MIB"}
    assert all(item["source_group"] == "juniper" for item in scoped["objects"])

    summary_only = mibs_service.export_catalog(
        modules=["IF-MIB"],
        export_type="summary",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )
    assert summary_only["modules"] == []
    assert summary_only["objects"] == []
    assert summary_only["notifications"] == []
    assert summary_only["notification_members"] == []
    assert summary_only["summary"]["module_count"] == 1


def test_export_catalog_file_supports_json_and_csv_formats(isolated_db):
    from app.services import mibs_service
    from app.services.mibs_service import MibsError
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    state = StateStore(isolated_db["session_factory"])
    bundle_service = _activate_mibs_bundle(isolated_db)

    json_file = mibs_service.export_catalog_file(
        format="json",
        notifications=["IF-MIB::linkDown"],
        export_type="notifications",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )
    assert json_file["filename"] == "notification-if-mib-linkdown.json"
    assert json_file["media_type"] == "application/json"
    json_payload = json.loads(json_file["content"].decode("utf-8"))
    assert json_payload["objects"] == []
    assert json_payload["notifications"][0]["full_name"] == "IF-MIB::linkDown"
    assert json_payload["notifications"][0]["members"]
    assert "full_name" not in json_payload["notifications"][0]["members"][0]
    assert "source_group" not in json_payload["notifications"][0]["members"][0]
    assert "source_kind" not in json_payload["notifications"][0]["members"][0]
    assert "source_relative_path" not in json_payload["notifications"][0]["members"][0]
    assert json_payload["notification_members"] == []

    csv_notifications = mibs_service.export_catalog_file(
        format="csv",
        notifications=["IF-MIB::linkDown"],
        export_type="notifications",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )
    assert csv_notifications["filename"] == "notification-if-mib-linkdown.csv"
    assert csv_notifications["media_type"] == "text/csv"
    csv_notifications_text = csv_notifications["content"].decode("utf-8")
    assert (
        csv_notifications_text.splitlines()[0]
        == "notification_module,notification_name,notification_oid,notification_source_group,notification_source_kind,notification_source_relative_path,member_count,member_module,member_name,member_oid,syntax,type,status,input_type,position,enum_values,description,notification_description"
    )
    assert "IF-MIB,linkDown,1.3.6.1.6.3.1.1.5.3" in csv_notifications_text
    assert "IF-MIB,ifIndex,1.3.6.1.2.1.2.2.1.1" in csv_notifications_text

    csv_objects = mibs_service.export_catalog_file(
        format="csv",
        modules=["IF-MIB"],
        export_type="objects",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )
    assert csv_objects["filename"] == "objects-if-mib.csv"
    assert (
        csv_objects["content"].decode("utf-8").splitlines()[0]
        == "module,name,full_name,oid,nodetype,syntax,status,source_group,source_kind,source_relative_path,description"
    )

    csv_modules = mibs_service.export_catalog_file(
        format="csv",
        modules=["IF-MIB"],
        export_type="modules",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )
    assert csv_modules["filename"] == "modules-if-mib.csv"
    assert (
        csv_modules["content"].decode("utf-8").splitlines()[0]
        == "module_name,object_count,notification_count,source_group,source_kind,source_relative_path"
    )

    csv_summary = mibs_service.export_catalog_file(
        format="csv",
        modules=["IF-MIB"],
        export_type="summary",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )
    assert csv_summary["filename"] == "summary-if-mib.csv"
    csv_summary_text = csv_summary["content"].decode("utf-8")
    assert csv_summary_text.splitlines()[0] == "key,value"
    assert "module_count,1" in csv_summary_text

    csv_catalog = mibs_service.export_catalog_file(
        format="csv",
        notifications=["IF-MIB::linkDown"],
        export_type="catalog",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )
    assert csv_catalog["filename"].endswith(".csv")
    csv_catalog_text = csv_catalog["content"].decode("utf-8")
    assert (
        csv_catalog_text.splitlines()[0]
        == "entry_type,module,name,oid,kind,syntax,status,source_group,source_kind,source_relative_path,description,notification_module,notification_name,notification_oid,input_type,position,enum_values,object_count,notification_count,member_count"
    )
    assert "notification,IF-MIB,linkDown,1.3.6.1.6.3.1.1.5.3,notification" in csv_catalog_text

    json_notification_members = mibs_service.export_catalog_file(
        format="json",
        notifications=["IF-MIB::linkDown"],
        export_type="notification-members",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )
    assert json_notification_members["filename"] == "notification-members-if-mib-linkdown.json"
    members_payload = json.loads(json_notification_members["content"].decode("utf-8"))
    assert members_payload["notifications"] == []
    assert members_payload["notification_members"]
    assert members_payload["notification_members"][0]["notification_module"] == "IF-MIB"
    assert members_payload["notification_members"][0]["notification_name"] == "linkDown"
    assert "notification_full_name" not in members_payload["notification_members"][0]
    assert "member_full_name" not in members_payload["notification_members"][0]
    assert "member_source_group" not in members_payload["notification_members"][0]
    assert "member_source_kind" not in members_payload["notification_members"][0]
    assert "member_source_relative_path" not in members_payload["notification_members"][0]

    csv_notification_members = mibs_service.export_catalog_file(
        format="csv",
        notifications=["IF-MIB::linkDown"],
        export_type="notification-members",
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )
    assert csv_notification_members["filename"] == "notification-members-if-mib-linkdown.csv"
    assert (
        csv_notification_members["content"].decode("utf-8").splitlines()[0]
        == "notification_module,notification_name,notification_oid,notification_source_group,member_module,member_name,member_oid,syntax,type,status,input_type,position,enum_values,description"
    )

    with pytest.raises(MibsError, match="Unsupported catalog export format"):
        mibs_service.export_catalog_file(
            format="xml",
            settings=settings,
            state=state,
            bundle_service=bundle_service,
        )


def test_download_mib_sources_returns_single_file_or_zip(isolated_db):
    from app.services import mibs_service
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    upload_root = settings.data_dir / "mibs"
    first_path = upload_root / "juniper" / "JUNIPER-ONE.mib"
    second_path = upload_root / "juniper" / "JUNIPER-TWO.mib"
    first_path.parent.mkdir(parents=True, exist_ok=True)
    first_path.write_text("JUNIPER-ONE DEFINITIONS ::= BEGIN\nEND\n")
    second_path.write_text("JUNIPER-TWO DEFINITIONS ::= BEGIN\nEND\n")

    state = StateStore(isolated_db["session_factory"])
    bundle_service = _activate_mibs_bundle(isolated_db)

    single = mibs_service.download_mib_sources(
        ["juniper/JUNIPER-ONE.mib"],
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )
    assert single["filename"] == "JUNIPER-ONE.mib"
    assert single["media_type"] == "application/octet-stream"
    assert b"JUNIPER-ONE" in single["content"]

    multiple = mibs_service.download_mib_sources(
        ["juniper/JUNIPER-ONE.mib", "juniper/JUNIPER-TWO.mib"],
        settings=settings,
        state=state,
        bundle_service=bundle_service,
    )
    assert multiple["filename"] == "mib-sources.zip"
    assert multiple["media_type"] == "application/zip"

    import io
    import zipfile

    with zipfile.ZipFile(io.BytesIO(multiple["content"])) as archive:
        assert sorted(archive.namelist()) == ["juniper/JUNIPER-ONE.mib", "juniper/JUNIPER-TWO.mib"]


def test_download_mib_sources_rejects_missing_paths(isolated_db):
    from app.services import mibs_service
    from app.services.mibs_service import MibsError
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    state = StateStore(isolated_db["session_factory"])
    bundle_service = _activate_mibs_bundle(isolated_db)

    with pytest.raises(MibsError, match="Stored MIB source not found"):
        mibs_service.download_mib_sources(
            ["juniper/MISSING.mib"],
            settings=settings,
            state=state,
            bundle_service=bundle_service,
        )
