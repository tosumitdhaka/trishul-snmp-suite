from __future__ import annotations

import json

import pytest
from fastapi import HTTPException

pytestmark = pytest.mark.contract


def _login_token() -> str:
    from app.api.routes import settings as settings_module

    return settings_module.login(
        settings_module.LoginBody(username="admin", password="admin123")
    )["token"]


def test_bundle_oid_index_route_streams_sidecar_and_404s_when_missing(isolated_db):
    from types import SimpleNamespace

    from app.api.routes import browser as browser_module
    from app.models import BundleSet
    from app.services.bundles import BundleCompileRequest, BundleService

    token = _login_token()
    service = BundleService(isolated_db["settings"])
    result = service.compile_bundle(BundleCompileRequest(mib_names=["SNMPv2-MIB"]))
    bundle_set_id = result["bundle"]["id"]

    no_match_request = SimpleNamespace(headers={})
    response = browser_module.bundle_oid_index(
        bundle_set_id=bundle_set_id, request=no_match_request, x_auth_token=token
    )
    assert response.media_type == "application/json"
    # BRW-06: the sidecar is immutable per bundle id — served with caching.
    assert "ETag" in response.headers
    assert "immutable" in response.headers.get("Cache-Control", "")
    payload = json.loads(response.body)
    assert isinstance(payload.get("oids"), dict)
    assert "1.3.6.1.2.1.1" in payload["oids"]

    # A matching If-None-Match answers 304 without a body.
    etag = response.headers["ETag"]
    matched_request = SimpleNamespace(headers={"if-none-match": etag})
    refreshed = browser_module.bundle_oid_index(
        bundle_set_id=bundle_set_id, request=matched_request, x_auth_token=token
    )
    assert refreshed.status_code == 304
    assert not refreshed.body

    with pytest.raises(HTTPException) as excinfo:
        browser_module.bundle_oid_index(
            bundle_set_id=999999, request=no_match_request, x_auth_token=token
        )
    assert excinfo.value.status_code == 404

    with isolated_db["session_factory"]() as session:
        bundle = session.get(BundleSet, bundle_set_id)
        bundle.oid_index_path = str(
            isolated_db["settings"].data_dir / "missing" / "oid_index.json"
        )
        session.commit()

    with pytest.raises(HTTPException) as excinfo:
        browser_module.bundle_oid_index(
            bundle_set_id=bundle_set_id, request=no_match_request, x_auth_token=token
        )
    assert excinfo.value.status_code == 404


def test_browse_modules_reports_active_bundle_id_and_reflects_bundle_switch(isolated_db):
    from app.api.routes import browser as browser_module
    from app.services.bundles import BundleCompileRequest, BundleService

    token = _login_token()
    bundle_service = BundleService(isolated_db["settings"])

    first = bundle_service.compile_bundle(
        BundleCompileRequest(mib_names=["IF-MIB", "SNMPv2-MIB"], activate=True)
    )
    payload = browser_module.browse_modules(x_auth_token=token)
    assert payload["modules"]
    assert payload["active_bundle_id"] == first["bundle"]["id"]

    second = bundle_service.compile_bundle(
        BundleCompileRequest(mib_names=["SNMPv2-MIB"], activate=True)
    )
    switched = browser_module.browse_modules(x_auth_token=token)
    assert switched["active_bundle_id"] == second["bundle"]["id"]
    assert switched["active_bundle_id"] != first["bundle"]["id"]


def test_browser_routes_return_empty_catalog_shapes_when_no_bundle(isolated_db):
    from app.api.routes import browser as browser_module

    del isolated_db

    token = _login_token()
    assert browser_module.browse_modules(x_auth_token=token) == {
        "modules": [],
        "active_bundle_id": None,
    }
    assert browser_module.browse_module_tree(x_auth_token=token) == {"modules": [], "count": 0}
    assert browser_module.browse_oid_tree(
        root_oid="1.3.6.1",
        depth=2,
        module=None,
        type_filter=None,
        x_auth_token=token,
    ) == {"root": None, "children": [], "total_descendants": 0}
    assert browser_module.browse_search(query="sys", x_auth_token=token) == {
        "results": [],
        "count": 0,
    }
    assert browser_module.browse_node("1.3.6.1", x_auth_token=token) == {
        "node": None,
        "breadcrumb": [],
        "trap_objects": [],
    }


def test_browse_node_payload_carries_constraint_kinds_for_detail_rendering(isolated_db):
    from app.api.routes import browser as browser_module
    from app.services.bundles import BundleCompileRequest, BundleService
    from trishul_snmp import load_bundle

    token = _login_token()
    service = BundleService(isolated_db["settings"])
    service.compile_bundle(
        BundleCompileRequest(mib_names=["IF-MIB", "SNMPv2-MIB"], activate=True)
    )

    # The browser detail panel (BRW-15) renders range/size/enum constraints
    # straight from the node payload — pin that all three kinds arrive.
    enum_node = browser_module.browse_node("IF-MIB::ifAdminStatus", module=None, x_auth_token=token)["node"]
    assert enum_node["constraints"] == {
        "kind": "enum",
        "data": [["up", 1], ["down", 2], ["testing", 3]],
    }

    size_node = browser_module.browse_node("SNMPv2-MIB::sysLocation", module=None, x_auth_token=token)["node"]
    assert size_node["constraints"] == {"kind": "size", "data": [[0, 255]]}

    range_node = browser_module.browse_node("SNMPv2-MIB::sysServices", module=None, x_auth_token=token)["node"]
    assert range_node["constraints"] == {"kind": "range", "data": [[0, 127]]}


def test_bundle_summary_route_reports_manifest_state_without_status_scan(isolated_db):
    from app.api.routes import browser as browser_module
    from app.services.bundles import BundleCompileRequest, BundleService

    token = _login_token()
    BundleService(isolated_db["settings"]).compile_bundle(
        BundleCompileRequest(mib_names=["IF-MIB", "SNMPv2-MIB"], activate=True)
    )

    summary = browser_module.bundle_summary(x_auth_token=token)
    # A bundle compiled by the current producer needs no recompile.
    assert summary["recompile_recommended"] is False
    assert summary["missing_capabilities"] == []
    assert isinstance(summary["active_bundle_id"], int)


def test_browser_search_route_forwards_filters_to_service(isolated_db, monkeypatch):
    from app.api.routes import browser as browser_module

    del isolated_db

    captured: dict[str, object] = {}

    def fake_search_bundle(*, query, module, type_filter, limit, bundle):
        captured["args"] = (query, module, type_filter, limit, bundle)
        return {"results": [{"name": "ifDescr"}], "count": 1}

    monkeypatch.setattr(browser_module.browser_service, "search_bundle", fake_search_bundle)

    payload = browser_module.browse_search(
        query="ifDescr",
        module="IF-MIB",
        type_filter="MibTableColumn",
        limit=25,
        x_auth_token=_login_token(),
    )
    assert payload == {"results": [{"name": "ifDescr"}], "count": 1}
    assert captured["args"] == ("ifDescr", "IF-MIB", "MibTableColumn", 25, None)


def test_browser_search_finds_notifications_ranked_first(isolated_db):
    # B-2: search must find NOTIFICATION-TYPE nodes; IF-MIB::linkDown ranks
    # first with the UI's "NotificationType" type spelling, and the
    # NotificationType filter returns only notifications.
    from app.api.routes import browser as browser_module
    from app.services.bundles import BundleCompileRequest, BundleService

    token = _login_token()
    BundleService(isolated_db["settings"]).compile_bundle(
        BundleCompileRequest(mib_names=["IF-MIB", "SNMPv2-MIB"], activate=True)
    )

    results = browser_module.browse_search(
        query="linkDown", module=None, type_filter=None, limit=30, x_auth_token=token
    )["results"]
    assert results[0]["full_name"] == "IF-MIB::linkDown"
    assert results[0]["type"] == "NotificationType"

    # A symbolic full_name query resolves directly to the notification.
    exact = browser_module.browse_search(
        query="IF-MIB::linkDown", module=None, type_filter=None, limit=30, x_auth_token=token
    )["results"]
    assert [item["full_name"] for item in exact] == ["IF-MIB::linkDown"]

    # NotificationType-filtered search returns only notifications.
    filtered = browser_module.browse_search(
        query="linkDown", module=None, type_filter="NotificationType", limit=30, x_auth_token=token
    )["results"]
    assert all(item["type"] == "NotificationType" for item in filtered)
    assert {item["full_name"] for item in filtered} == {"IF-MIB::linkDown"}


def test_browser_routes_require_auth(isolated_db):
    from app.api.routes import browser as browser_module

    del isolated_db

    with pytest.raises(HTTPException) as excinfo:
        browser_module.browse_modules(x_auth_token=None)
    assert excinfo.value.status_code == 401
