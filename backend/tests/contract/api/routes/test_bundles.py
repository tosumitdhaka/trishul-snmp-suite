"""Contract tests for the bundle lifecycle routes (MGR-04)."""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

pytestmark = pytest.mark.contract


def _login_token() -> str:
    from app.api.routes import settings as settings_module

    return settings_module.login(
        settings_module.LoginBody(username="admin", password="admin123")
    )["token"]


def test_list_bundles_route_reports_empty_state(isolated_db):
    from app.api.routes import bundles as bundles_module

    del isolated_db

    token = _login_token()
    payload = bundles_module.list_bundles(x_auth_token=token)
    assert payload["bundles"] == []
    assert payload["active_bundle_id"] is None
    assert payload["previous_active_bundle_id"] is None


def test_list_and_detail_bundle_routes_expose_lifecycle_metadata(isolated_db):
    from app.api.routes import bundles as bundles_module
    from app.services.bundles import BundleCompileRequest, BundleService

    token = _login_token()
    service = BundleService(isolated_db["settings"])
    result = service.compile_bundle(
        BundleCompileRequest(mib_names=["IF-MIB", "SNMPv2-MIB"], activate=True)
    )
    bundle_id = result["bundle"]["id"]

    listed = bundles_module.list_bundles(x_auth_token=token)
    assert listed["active_bundle_id"] == bundle_id
    row = next(item for item in listed["bundles"] if item["id"] == bundle_id)
    assert row["label"]
    assert row["created_at"] is not None
    assert row["is_active"] is True
    assert row["content_hash"]
    assert row["module_count"] >= 1
    # MGR-28: the list payload is a lightweight index — no modules array and
    # no manifest-derived fields (producer_version); those live on the detail
    # route below.
    assert "modules" not in row
    assert row["producer_version"] is None

    detail = bundles_module.get_bundle_detail(bundle_set_id=bundle_id, x_auth_token=token)
    assert detail["bundle"]["id"] == bundle_id
    assert "IF-MIB" in detail["manifest"]["modules"]
    assert {module["module_name"] for module in detail["bundle"]["modules"]} >= {
        "IF-MIB",
        "SNMPv2-MIB",
    }

    with pytest.raises(HTTPException) as excinfo:
        bundles_module.get_bundle_detail(bundle_set_id=999999, x_auth_token=token)
    assert excinfo.value.status_code == 404


def test_diff_bundle_route_uses_hash_fast_path_for_identical_bundles(isolated_db):
    from app.api.routes import bundles as bundles_module
    from app.services.bundles import BundleCompileRequest, BundleService

    token = _login_token()
    service = BundleService(isolated_db["settings"])
    first = service.compile_bundle(BundleCompileRequest(mib_names=["SNMPv2-MIB"]))
    second = service.compile_bundle(BundleCompileRequest(mib_names=["SNMPv2-MIB"]))
    service.activate_bundle(first["bundle"]["id"])

    # Default `against` resolves to the active bundle; identical hashes short-circuit.
    diff = bundles_module.diff_bundle(
        bundle_set_id=second["bundle"]["id"],
        x_auth_token=token,
    )
    assert diff["identical"] is True
    assert diff["hash"] == first["bundle"]["content_hash"] == second["bundle"]["content_hash"]
    assert "modules_added" not in diff and "modules_removed" not in diff

    # Explicit pair diff: different module sets produce a per-module comparison.
    third = service.compile_bundle(
        BundleCompileRequest(mib_names=["IF-MIB", "SNMPv2-MIB"])
    )
    changed = bundles_module.diff_bundle(
        bundle_set_id=third["bundle"]["id"],
        against=first["bundle"]["id"],
        x_auth_token=token,
    )
    assert changed["identical"] is False
    assert "IF-MIB" in {item["module_name"] for item in changed["modules_removed"]}

    with pytest.raises(HTTPException) as excinfo:
        bundles_module.diff_bundle(bundle_set_id=999999, x_auth_token=token)
    assert excinfo.value.status_code == 404

    with pytest.raises(HTTPException) as excinfo:
        bundles_module.diff_bundle(
            bundle_set_id=first["bundle"]["id"],
            against=first["bundle"]["id"],
            x_auth_token=token,
        )
    assert excinfo.value.status_code == 400


def test_diff_bundle_route_409_when_no_active_bundle(isolated_db):
    from app.api.routes import bundles as bundles_module
    from app.services.bundles import BundleCompileRequest, BundleService

    del isolated_db

    token = _login_token()
    with pytest.raises(HTTPException) as excinfo:
        bundles_module.diff_bundle(bundle_set_id=1, x_auth_token=token)
    assert excinfo.value.status_code == 409


def test_activate_bundle_route_rolls_back_to_previous_bundle(isolated_db):
    from app.api.routes import bundles as bundles_module
    from app.services.bundles import BundleCompileRequest, BundleService

    token = _login_token()
    service = BundleService(isolated_db["settings"])
    first = service.compile_bundle(
        BundleCompileRequest(mib_names=["SNMPv2-MIB"], activate=True)
    )
    second = service.compile_bundle(
        BundleCompileRequest(mib_names=["IF-MIB", "SNMPv2-MIB"], activate=True)
    )
    assert service.list_state()["active_bundle_id"] == second["bundle"]["id"]

    # Rollback: activate the first bundle again through the route.
    activated = asyncio.run(
        bundles_module.activate_bundle(
            bundle_set_id=first["bundle"]["id"],
            x_auth_token=token,
        )
    )
    assert activated["active_bundle_id"] == first["bundle"]["id"]
    assert activated["previous_active_bundle_id"] == second["bundle"]["id"]
    assert activated["bundle"]["is_active"] is True

    state = service.list_state()
    assert state["active_bundle_id"] == first["bundle"]["id"]
    assert state["previous_active_bundle_id"] == second["bundle"]["id"]

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(bundles_module.activate_bundle(bundle_set_id=999999, x_auth_token=token))
    assert excinfo.value.status_code == 400


def test_activate_bundle_route_broadcasts_mibs_and_stats(isolated_db, monkeypatch):
    from app.api.routes import bundles as bundles_module
    from app.services.bundles import BundleCompileRequest, BundleService

    token = _login_token()
    service = BundleService(isolated_db["settings"])
    first = service.compile_bundle(
        BundleCompileRequest(mib_names=["SNMPv2-MIB"], activate=True)
    )
    second = service.compile_bundle(
        BundleCompileRequest(mib_names=["IF-MIB", "SNMPv2-MIB"], activate=True)
    )

    broadcasts: list[tuple[str, object]] = []

    async def fake_broadcast_mibs(*, settings):
        broadcasts.append(("mibs", settings))

    async def fake_broadcast_stats(*, settings):
        broadcasts.append(("stats", settings))

    monkeypatch.setattr(bundles_module, "broadcast_mibs", fake_broadcast_mibs)
    monkeypatch.setattr(bundles_module, "broadcast_stats", fake_broadcast_stats)

    # MGR-27: activating a bundle swaps the catalog every client serves — the
    # route must broadcast so other tabs' caches (oid-index/tree, trap
    # picker) re-sync, mirroring the mibs mutation routes.
    activated = asyncio.run(
        bundles_module.activate_bundle(
            bundle_set_id=first["bundle"]["id"],
            x_auth_token=token,
        )
    )
    assert activated["active_bundle_id"] == first["bundle"]["id"]
    assert broadcasts == [("mibs", isolated_db["settings"]), ("stats", isolated_db["settings"])]