from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

pytestmark = pytest.mark.contract


class DummyUploadFile:
    def __init__(self, filename: str, content: bytes) -> None:
        self.filename = filename
        self._content = content

    async def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            return self._content
        return self._content[:size]


def _login_token() -> str:
    from app.api.routes import settings as settings_module

    return settings_module.login(
        settings_module.LoginBody(username="admin", password="admin123")
    )["token"]


def test_get_mib_objects_carries_enum_values_for_enum_nodes(isolated_db):
    from app.api.routes import mibs as mibs_module
    from app.services.bundles import BundleCompileRequest, BundleService

    token = _login_token()
    BundleService(isolated_db["settings"]).compile_bundle(
        BundleCompileRequest(mib_names=["IF-MIB", "SNMPv2-MIB"], activate=True)
    )

    objects = mibs_module.get_mib_objects(x_auth_token=token)["objects"]
    by_name = {obj["name"]: obj for obj in objects}
    assert by_name["ifAdminStatus"]["enum_values"] == [
        {"label": "up", "value": 1},
        {"label": "down", "value": 2},
        {"label": "testing", "value": 3},
    ]
    assert by_name["ifAdminStatus"]["constraint"] == {
        "kind": "enum",
        "data": [["up", 1], ["down", 2], ["testing", 3]],
    }
    assert "enum_values" not in by_name["ifDescr"]
    # TRP-02: picker varbind types must follow the node's syntax
    assert by_name["ifAdminStatus"]["input_type"] == "Integer"
    # ifType's syntax is the IANAifType TC (defining MIB not in this bundle),
    # so its base type is unresolvable from the syntax string — same behavior
    # as the trap-catalog path.
    assert by_name["ifType"]["input_type"] == "String"
    assert by_name["ifSpeed"]["input_type"] == "Gauge"
    assert by_name["ifInOctets"]["input_type"] == "Counter"
    assert by_name["ifDescr"]["input_type"] == "String"
    assert by_name["sysUpTime"]["input_type"] == "TimeTicks"


def test_mib_routes_report_empty_catalog_shapes_when_no_bundle(isolated_db):
    from app.api.routes import mibs as mibs_module

    del isolated_db

    token = _login_token()
    assert mibs_module.get_mib_status(x_auth_token=token) == {
        "loaded": 0,
        "failed": 0,
        "mibs": [],
        "active_modules": [],
        "errors": [],
        "failed_modules": [],
        "source_inventory": [],
        "source_groups": [],
        "producer_version": None,
        "recompile_recommended": False,
        "missing_capabilities": [],
        "active_bundle_id": None,
        "active_bundle_label": "active-bundle",
    }
    assert mibs_module.get_mib_objects(x_auth_token=token) == {"objects": []}
    assert mibs_module.get_mib_traps(x_auth_token=token) == {"traps": []}
    assert mibs_module.resolve_mib(
        oid="1.3.6.1.2.1.1.5.0",
        mode="symbolic",
        x_auth_token=token,
    ) == {
        "input": "1.3.6.1.2.1.1.5.0",
        "output": "1.3.6.1.2.1.1.5.0",
        "resolved": False,
    }


def test_validate_upload_route_reads_files_and_forwards_source_group(isolated_db, monkeypatch):
    from app.api.routes import mibs as mibs_module

    token = _login_token()
    settings = isolated_db["settings"]
    state = object()
    bundle_service = object()
    captured: dict[str, object] = {}

    monkeypatch.setattr(mibs_module, "_ctx", lambda: (settings, state, bundle_service))

    def fake_validate_upload_batch(uploaded, *, source_group, settings, state, bundle_service):
        captured["args"] = (uploaded, source_group, settings, state, bundle_service)
        return {"can_upload": True, "files": [{"name": "TEST-MIB"}]}

    monkeypatch.setattr(mibs_module.mibs_service, "validate_upload_batch", fake_validate_upload_batch)

    payload = asyncio.run(
        mibs_module.validate_batch(
            files=[DummyUploadFile("TEST-MIB.mib", b"TEST CONTENT")],
            source_group="vendor/core",
            x_auth_token=token,
        )
    )
    assert payload == {"can_upload": True, "files": [{"name": "TEST-MIB"}]}
    assert captured["args"] == (
        [("TEST-MIB.mib", b"TEST CONTENT")],
        "vendor/core",
        settings,
        state,
        bundle_service,
    )


def test_upload_routes_reject_oversized_files(isolated_db, monkeypatch):
    from app.api.routes import mibs as mibs_module

    token = _login_token()
    cap = mibs_module.MAX_UPLOAD_FILE_BYTES

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            mibs_module.validate_batch(
                files=[DummyUploadFile("huge.mib", b"x" * (cap + 1))],
                source_group=None,
                x_auth_token=token,
            )
        )
    assert excinfo.value.status_code == 413
    assert "huge.mib" in excinfo.value.detail
    assert "size limit" in excinfo.value.detail

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            mibs_module.upload_mibs(
                files=[DummyUploadFile("huge.mib", b"x" * (cap + 1))],
                x_auth_token=token,
            )
        )
    assert excinfo.value.status_code == 413

    # Exactly at the cap still reaches the service layer intact.
    settings = isolated_db["settings"]
    state = object()
    bundle_service = object()
    captured: dict[str, object] = {}
    monkeypatch.setattr(mibs_module, "_ctx", lambda: (settings, state, bundle_service))

    def fake_validate_upload_batch(uploaded, *, source_group, settings, state, bundle_service):
        captured["uploaded"] = uploaded
        return {"can_upload": True, "files": []}

    monkeypatch.setattr(mibs_module.mibs_service, "validate_upload_batch", fake_validate_upload_batch)

    at_cap = b"x" * cap
    payload = asyncio.run(
        mibs_module.validate_batch(
            files=[DummyUploadFile("edge.mib", at_cap)],
            source_group=None,
            x_auth_token=token,
        )
    )
    assert payload == {"can_upload": True, "files": []}
    assert captured["uploaded"] == [("edge.mib", at_cap)]


def test_upload_route_parses_compile_targets_and_broadcasts(isolated_db, monkeypatch):
    from app.api.routes import mibs as mibs_module

    token = _login_token()
    settings = isolated_db["settings"]
    state = object()
    bundle_service = object()
    captured: dict[str, object] = {}
    broadcasts: list[tuple[str, object]] = []

    monkeypatch.setattr(mibs_module, "_ctx", lambda: (settings, state, bundle_service))

    def fake_upload(
        uploaded,
        *,
        compile_mode,
        compile_targets,
        source_group,
        settings,
        state,
        bundle_service,
    ):
        captured["args"] = (
            uploaded,
            compile_mode,
            compile_targets,
            source_group,
            settings,
            state,
            bundle_service,
        )
        return {"results": [{"status": "loaded"}]}

    async def fake_broadcast_mibs(*, settings):
        broadcasts.append(("mibs", settings))

    async def fake_broadcast_stats(*, settings):
        broadcasts.append(("stats", settings))

    monkeypatch.setattr(mibs_module.mibs_service, "upload", fake_upload)
    monkeypatch.setattr(mibs_module, "broadcast_mibs", fake_broadcast_mibs)
    monkeypatch.setattr(mibs_module, "broadcast_stats", fake_broadcast_stats)

    payload = asyncio.run(
        mibs_module.upload_mibs(
            files=[DummyUploadFile("TEST-MIB.mib", b"TEST CONTENT")],
            compile_mode="partial",
            compile_targets='["IF-MIB", "SNMPv2-MIB", ""]',
            source_group="vendor",
            x_auth_token=token,
        )
    )
    assert payload == {"results": [{"status": "loaded"}]}
    assert captured["args"] == (
        [("TEST-MIB.mib", b"TEST CONTENT")],
        "partial",
        ["IF-MIB", "SNMPv2-MIB"],
        "vendor",
        settings,
        state,
        bundle_service,
    )
    assert broadcasts == [("mibs", settings), ("stats", settings)]


def test_upload_route_rejects_invalid_compile_target_json(isolated_db):
    from app.api.routes import mibs as mibs_module

    del isolated_db

    token = _login_token()

    with pytest.raises(HTTPException, match="valid JSON"):
        asyncio.run(
            mibs_module.upload_mibs(
                files=[],
                compile_targets="not-json",
                x_auth_token=token,
            )
        )

    with pytest.raises(HTTPException, match="JSON array"):
        asyncio.run(
            mibs_module.upload_mibs(
                files=[],
                compile_targets='{"name":"TEST-MIB"}',
                x_auth_token=token,
            )
        )


def test_export_route_returns_attachment_response(isolated_db, monkeypatch):
    from app.api.routes import mibs as mibs_module

    token = _login_token()
    settings = isolated_db["settings"]
    state = object()
    bundle_service = object()
    captured: dict[str, object] = {}

    monkeypatch.setattr(mibs_module, "_ctx", lambda: (settings, state, bundle_service))

    def fake_export_catalog_file(
        *,
        format,
        modules,
        notifications,
        source_groups,
        export_type,
        settings,
        state,
        bundle_service,
    ):
        captured["args"] = (
            format,
            modules,
            notifications,
            source_groups,
            export_type,
            settings,
            state,
            bundle_service,
        )
        return {
            "filename": "catalog.json",
            "media_type": "application/json",
            "content": b'{"modules":[]}',
        }

    monkeypatch.setattr(mibs_module.mibs_service, "export_catalog_file", fake_export_catalog_file)

    response = mibs_module.export_mib_catalog(
        mibs_module.CatalogExportBody(
            format="json",
            modules=["IF-MIB"],
            notifications=["IF-MIB::linkDown"],
            source_groups=["vendor"],
            export_type="catalog",
        ),
        x_auth_token=token,
    )
    assert response.body == b'{"modules":[]}'
    assert response.media_type == "application/json"
    assert response.headers["content-disposition"] == 'attachment; filename="catalog.json"'
    assert captured["args"] == (
        "json",
        ["IF-MIB"],
        ["IF-MIB::linkDown"],
        ["vendor"],
        "catalog",
        settings,
        state,
        bundle_service,
    )


def test_download_route_returns_attachment_response(isolated_db, monkeypatch):
    from app.api.routes import mibs as mibs_module

    token = _login_token()
    settings = isolated_db["settings"]
    state = object()
    bundle_service = object()
    captured: dict[str, object] = {}

    monkeypatch.setattr(mibs_module, "_ctx", lambda: (settings, state, bundle_service))

    def fake_download_mib_sources(*, paths, settings, state, bundle_service):
        captured["args"] = (paths, settings, state, bundle_service)
        return {
            "filename": "TEST-MIB.mib",
            "media_type": "application/octet-stream",
            "content": b"TEST CONTENT",
        }

    monkeypatch.setattr(mibs_module.mibs_service, "download_mib_sources", fake_download_mib_sources)

    response = mibs_module.download_mib_sources(
        mibs_module.MibDownloadBody(paths=["vendor/TEST-MIB.mib"]),
        x_auth_token=token,
    )
    assert response.body == b"TEST CONTENT"
    assert response.media_type == "application/octet-stream"
    assert response.headers["content-disposition"] == 'attachment; filename="TEST-MIB.mib"'
    assert captured["args"] == (
        ["vendor/TEST-MIB.mib"],
        settings,
        state,
        bundle_service,
    )


def test_mib_mutation_routes_delegate_and_broadcast(isolated_db, monkeypatch):
    from app.api.routes import mibs as mibs_module

    token = _login_token()
    settings = isolated_db["settings"]
    state = object()
    bundle_service = object()
    captured: dict[str, object] = {}
    broadcasts: list[tuple[str, object]] = []

    monkeypatch.setattr(mibs_module, "_ctx", lambda: (settings, state, bundle_service))

    def fake_reload(*, settings, state, bundle_service):
        captured["reload"] = (settings, state, bundle_service)
        return {"loaded": 4, "failed": 0}

    def fake_fetch_dependencies(dependencies, *, reload_after_fetch=True, settings, state, bundle_service):
        captured["fetch"] = (dependencies, reload_after_fetch, settings, state, bundle_service)
        return {"resolved": dependencies}

    def fake_delete_mib(path, *, settings, state, bundle_service):
        captured.setdefault("delete", []).append((path, settings, state, bundle_service))
        return {"filename": path}

    def fake_delete_mibs(paths, *, settings, state, bundle_service):
        captured["delete_batch"] = (paths, settings, state, bundle_service)
        return {"deleted": len(paths)}

    async def fake_broadcast_mibs(*, settings):
        broadcasts.append(("mibs", settings))

    async def fake_broadcast_stats(*, settings):
        broadcasts.append(("stats", settings))

    monkeypatch.setattr(mibs_module.mibs_service, "reload", fake_reload)
    monkeypatch.setattr(mibs_module.mibs_service, "fetch_dependencies", fake_fetch_dependencies)
    monkeypatch.setattr(mibs_module.mibs_service, "delete_mib", fake_delete_mib)
    monkeypatch.setattr(mibs_module.mibs_service, "delete_mibs", fake_delete_mibs)
    monkeypatch.setattr(mibs_module, "broadcast_mibs", fake_broadcast_mibs)
    monkeypatch.setattr(mibs_module, "broadcast_stats", fake_broadcast_stats)

    assert asyncio.run(mibs_module.reload_mibs(x_auth_token=token)) == {"loaded": 4, "failed": 0}
    assert captured["reload"] == (settings, state, bundle_service)

    fetched = asyncio.run(
        mibs_module.fetch_dependencies(
            mibs_module.DependencyFetchBody(dependencies=["MISSING-DEP-MIB"], reload_after_fetch=False),
            x_auth_token=token,
        )
    )
    assert fetched == {"resolved": ["MISSING-DEP-MIB"]}
    assert captured["fetch"] == (["MISSING-DEP-MIB"], False, settings, state, bundle_service)

    fetched_with_reload = asyncio.run(
        mibs_module.fetch_dependencies(
            mibs_module.DependencyFetchBody(dependencies=["MISSING-DEP-MIB"]),
            x_auth_token=token,
        )
    )
    assert fetched_with_reload == {"resolved": ["MISSING-DEP-MIB"]}
    assert captured["fetch"] == (["MISSING-DEP-MIB"], True, settings, state, bundle_service)
    # The fetch broadcast a MIB refresh so other tabs re-sync.
    assert ("mibs", settings) in broadcasts

    assert asyncio.run(
        mibs_module.delete_mib_file(path="vendor/TEST-MIB.mib", x_auth_token=token)
    ) == {"filename": "vendor/TEST-MIB.mib"}

    assert asyncio.run(
        mibs_module.delete_mib_batch(
            mibs_module.MibDeleteBatchBody(paths=["vendor/A.mib", "vendor/B.mib"]),
            x_auth_token=token,
        )
    ) == {"deleted": 2}
    assert captured["delete_batch"] == (
        ["vendor/A.mib", "vendor/B.mib"],
        settings,
        state,
        bundle_service,
    )

    assert asyncio.run(mibs_module.delete_mib("vendor/C.mib", x_auth_token=token)) == {
        "filename": "vendor/C.mib"
    }
    assert captured["delete"] == [
        ("vendor/TEST-MIB.mib", settings, state, bundle_service),
        ("vendor/C.mib", settings, state, bundle_service),
    ]
    assert broadcasts == [
        ("mibs", settings),
        ("stats", settings),
        ("mibs", settings),
        ("stats", settings),
        # fetch-dependencies broadcast (reload_after_fetch=False variant)
        ("mibs", settings),
        ("stats", settings),
        # fetch-dependencies broadcast (default reload_after_fetch variant)
        ("mibs", settings),
        ("stats", settings),
        ("mibs", settings),
        ("stats", settings),
        ("mibs", settings),
        ("stats", settings),
    ]


def test_mib_routes_require_auth_and_translate_service_errors(isolated_db, monkeypatch):
    from app.api.routes import mibs as mibs_module
    from app.services.mibs_service import MibsError

    with pytest.raises(HTTPException) as excinfo:
        mibs_module.get_mib_status(x_auth_token=None)
    assert excinfo.value.status_code == 401

    monkeypatch.setattr(
        mibs_module,
        "_ctx",
        lambda: (isolated_db["settings"], object(), object()),
    )
    monkeypatch.setattr(
        mibs_module.mibs_service,
        "reload",
        lambda **kwargs: (_ for _ in ()).throw(MibsError("reload failed")),
    )

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(mibs_module.reload_mibs(x_auth_token=_login_token()))
    assert excinfo.value.status_code == 400
    assert excinfo.value.detail == "reload failed"
