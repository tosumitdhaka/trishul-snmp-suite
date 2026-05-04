import json
from io import BytesIO

import pytest
from fastapi import HTTPException
from starlette.datastructures import UploadFile


MISSING_DEP_MIB = """NEEDS-DEP-MIB DEFINITIONS ::= BEGIN
IMPORTS
    depRoot FROM MISSING-DEP-MIB;

testRoot OBJECT IDENTIFIER ::= { depRoot 1 }

END
"""

FETCHED_DEP_MIB = """MISSING-DEP-MIB DEFINITIONS ::= BEGIN
IMPORTS
    enterprises FROM SNMPv2-SMI;

depRoot OBJECT IDENTIFIER ::= { enterprises 99998 }

END
"""


class _Response:
    def __init__(self, status_code: int, text: str = ""):
        self.status_code = status_code
        self.text = text


def _upload(filename: str, content: str) -> UploadFile:
    return UploadFile(filename=filename, file=BytesIO(content.encode()))


@pytest.mark.asyncio
async def test_validate_batch_rejects_path_traversal(isolated_settings):
    from api.routers import mibs as mibs_router

    with pytest.raises(HTTPException) as exc:
        await mibs_router.validate_batch(files=[_upload("../evil.mib", "BAD DEFINITIONS ::= BEGIN END")])
    assert exc.value.status_code == 400
    assert "Directory traversal" in exc.value.detail


@pytest.mark.asyncio
async def test_validation_does_not_fetch_remote_dependencies(isolated_settings, monkeypatch):
    from services.mib_service import get_mib_service

    calls = []

    def _unexpected_get(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("validate-batch should never fetch remote MIBs")

    monkeypatch.setattr("services.mib_service.requests.get", _unexpected_get)

    file_path = isolated_settings.MIB_DIR / "NEEDS-DEP-MIB.mib"
    file_path.write_text(MISSING_DEP_MIB)

    service = get_mib_service()
    analysis = service.analyze_validation_batch([str(file_path)])

    assert analysis["global_missing_deps"] == ["MISSING-DEP-MIB"]
    assert calls == []


def test_manual_dependency_fetch_uses_ordered_configured_sources(isolated_settings, monkeypatch):
    from services.mib_service import get_mib_service

    isolated_settings.MIB_REMOTE_SOURCES = [
        "https://primary.example/@mib@",
        "https://secondary.example/@mib@.mib",
    ]
    calls = []

    def _fake_get(url, timeout=None, allow_redirects=None):
        calls.append(url)
        if url == "https://primary.example/MISSING-DEP-MIB":
            return _Response(404, "")
        if url == "https://secondary.example/MISSING-DEP-MIB.mib":
            return _Response(200, FETCHED_DEP_MIB)
        return _Response(500, "")

    monkeypatch.setattr("services.mib_service.requests.get", _fake_get)

    service = get_mib_service()
    payload = service.fetch_missing_dependencies(["MISSING-DEP-MIB"])

    assert calls == [
        "https://primary.example/MISSING-DEP-MIB",
        "https://secondary.example/MISSING-DEP-MIB.mib",
    ]
    assert payload["downloaded"][0]["source"] == "https://secondary.example/@mib@.mib"
    assert (isolated_settings.MIB_DIR / "MISSING-DEP-MIB.mib").exists()


def test_reload_auto_fetches_missing_dependencies_when_enabled(isolated_settings, monkeypatch):
    from api.routers import mibs as mibs_router
    from services.mib_service import get_mib_service

    isolated_settings.MIB_AUTO_FETCH = True
    (isolated_settings.MIB_DIR / "NEEDS-DEP-MIB.mib").write_text(MISSING_DEP_MIB)
    calls = []

    def _fake_get(url, timeout=None, allow_redirects=None):
        calls.append(url)
        if url == "https://mibs.pysnmp.com/asn1/MISSING-DEP-MIB":
            return _Response(200, FETCHED_DEP_MIB)
        return _Response(404, "")

    monkeypatch.setattr("services.mib_service.requests.get", _fake_get)

    service = get_mib_service()
    fetch_result = mibs_router._maybe_auto_fetch_dependencies(service)
    service.reload()

    assert fetch_result["enabled"] is True
    assert any(item["mib_name"] == "MISSING-DEP-MIB" for item in fetch_result["downloaded"])
    assert "https://mibs.pysnmp.com/asn1/MISSING-DEP-MIB" in calls
    assert (isolated_settings.MIB_DIR / "MISSING-DEP-MIB.mib").exists()


def _blank_mib_service(monkeypatch):
    from services import mib_service

    monkeypatch.setattr(mib_service.MibService, "_configure_sources", lambda self: None)
    monkeypatch.setattr(mib_service.MibService, "_load_all_mibs", lambda self: None)
    mib_service._mib_service_instance = None
    mib_service.MibService._instance = None
    return mib_service.MibService()


def test_reconcile_loaded_mib_clears_transient_failure(isolated_settings, monkeypatch):
    from services.mib_service import MibInfo

    service = _blank_mib_service(monkeypatch)
    failed = MibInfo("HOST-RESOURCES-MIB", str(isolated_settings.MIB_DIR / "HOST-RESOURCES-MIB.txt"), status="error")
    failed.error_message = "transient dependency error"
    failed.imports = ["IF-MIB", "SNMPv2-TC"]
    service.failed_mibs["HOST-RESOURCES-MIB"] = failed
    service.mib_builder.mibSymbols["HOST-RESOURCES-MIB"] = {}

    service._reconcile_loaded_mibs()

    assert "HOST-RESOURCES-MIB" not in service.failed_mibs
    assert "HOST-RESOURCES-MIB" in service.loaded_mibs
    assert service.loaded_mibs["HOST-RESOURCES-MIB"].status == "loaded"
    assert service.loaded_mibs["HOST-RESOURCES-MIB"].error_message is None


def test_ordered_mib_items_prioritizes_base_dependencies(isolated_settings, monkeypatch):
    service = _blank_mib_service(monkeypatch)

    ordered = service._ordered_mib_items(
        {
            "IP-MIB": "IP-MIB.txt",
            "IF-MIB": "IF-MIB.mib",
            "SNMPv2-TC": "SNMPv2-TC.txt",
            "IANAifType-MIB": "IANAifType-MIB.txt",
            "ZZZ-CUSTOM-MIB": "ZZZ-CUSTOM-MIB.mib",
        }
    )

    assert [name for name, _path in ordered] == [
        "SNMPv2-TC",
        "IANAifType-MIB",
        "IF-MIB",
        "IP-MIB",
        "ZZZ-CUSTOM-MIB",
    ]
