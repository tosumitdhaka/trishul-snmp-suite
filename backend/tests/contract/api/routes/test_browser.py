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
    from app.api.routes import browser as browser_module
    from app.models import BundleSet
    from app.services.bundles import BundleCompileRequest, BundleService

    token = _login_token()
    service = BundleService(isolated_db["settings"])
    result = service.compile_bundle(BundleCompileRequest(mib_names=["SNMPv2-MIB"]))
    bundle_set_id = result["bundle"]["id"]

    response = browser_module.bundle_oid_index(bundle_set_id=bundle_set_id, x_auth_token=token)
    assert response.media_type == "application/json"
    payload = json.loads(response.body)
    assert isinstance(payload.get("oids"), dict)
    assert "1.3.6.1.2.1.1" in payload["oids"]

    with pytest.raises(HTTPException) as excinfo:
        browser_module.bundle_oid_index(bundle_set_id=999999, x_auth_token=token)
    assert excinfo.value.status_code == 404

    with isolated_db["session_factory"]() as session:
        bundle = session.get(BundleSet, bundle_set_id)
        bundle.oid_index_path = str(
            isolated_db["settings"].data_dir / "missing" / "oid_index.json"
        )
        session.commit()

    with pytest.raises(HTTPException) as excinfo:
        browser_module.bundle_oid_index(bundle_set_id=bundle_set_id, x_auth_token=token)
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


def test_browser_routes_require_auth(isolated_db):
    from app.api.routes import browser as browser_module

    del isolated_db

    with pytest.raises(HTTPException) as excinfo:
        browser_module.browse_modules(x_auth_token=None)
    assert excinfo.value.status_code == 401
