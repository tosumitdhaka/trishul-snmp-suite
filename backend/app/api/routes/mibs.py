from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.services import browser_service, mibs_service
from app.services.bundle_state import get_bundle
from app.services.mib_metadata import enum_values, input_type_for_syntax
from app.services.mibs_service import MibsError
from app.services.realtime import broadcast_mibs, broadcast_stats
from app.services.session import SessionService, SessionServiceError
from app.services.state_store import get_state_store

router = APIRouter()


class DependencyFetchBody(BaseModel):
    dependencies: list[str] = Field(default_factory=list)
    reload_after_fetch: bool = True


class MibDeleteBatchBody(BaseModel):
    paths: list[str] = Field(default_factory=list)


class MibDownloadBody(BaseModel):
    paths: list[str] = Field(default_factory=list)


class CatalogExportBody(BaseModel):
    format: str = Field("json", min_length=1)
    modules: list[str] = Field(default_factory=list)
    notifications: list[str] = Field(default_factory=list)
    source_groups: list[str] = Field(default_factory=list)
    export_type: str = Field("catalog", min_length=1)


def _require_auth(token: str | None) -> None:
    try:
        SessionService().require_username(token)
    except SessionServiceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


def _mibs_http(exc: MibsError):
    raise HTTPException(status_code=400, detail=str(exc)) from exc


def _ctx():
    from app.core.config import get_settings
    from app.services.bundles import BundleService
    settings = get_settings()
    return settings, get_state_store(), BundleService(settings)


@router.get("/mibs/status")
def get_mib_status(
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_auth(x_auth_token)
    settings, state, bundle_service = _ctx()
    return mibs_service.get_status(settings=settings, state=state, bundle_service=bundle_service)


@router.get("/mibs/traps")
def get_mib_traps(
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_auth(x_auth_token)
    return browser_service.get_trap_catalog(bundle=get_bundle())


@router.get("/mibs/objects")
def get_mib_objects(
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_auth(x_auth_token)
    bundle = get_bundle()
    if bundle is None:
        return {"objects": []}
    from trishul_snmp.mib.registry import oid_to_string

    def _object_payload(node) -> dict[str, Any]:
        payload = {
            "name": node.name,
            "full_name": f"{node.module}::{node.name}",
            "module": node.module,
            "oid": oid_to_string(node.oid),
            "syntax": node.syntax or "",
            "type": node.nodetype or node.object_type or "",
            "input_type": input_type_for_syntax(node.syntax),
            "constraint": node.constraints,
        }
        node_enum_values = enum_values(node)
        if node_enum_values:
            payload["enum_values"] = node_enum_values
        return payload

    objects = [
        _object_payload(node)
        for node in bundle.iter_objects()
        if node.object_type not in ("NOTIFICATION-TYPE", "TRAP-TYPE")
    ]
    return {"objects": sorted(objects, key=lambda o: (o["module"], o["name"]))}


@router.get("/mibs/resolve")
def resolve_mib(
    oid: str = Query(..., min_length=1),
    mode: str = Query("numeric"),
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_auth(x_auth_token)
    return browser_service.resolve(oid, mode=mode, bundle=get_bundle())


@router.post("/mibs/validate-batch")
async def validate_batch(
    files: list[UploadFile] = File(default_factory=list),
    source_group: str | None = Form(default=None),
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_auth(x_auth_token)
    uploaded = [(u.filename or "", await u.read()) for u in files]
    settings, state, bundle_service = _ctx()
    try:
        return mibs_service.validate_upload_batch(
            uploaded, source_group=source_group,
            settings=settings, state=state, bundle_service=bundle_service,
        )
    except MibsError as exc:
        _mibs_http(exc)


@router.post("/mibs/upload")
async def upload_mibs(
    files: list[UploadFile] = File(default_factory=list),
    compile_mode: str = Form("full"),
    compile_targets: str | None = Form(default=None),
    source_group: str | None = Form(default=None),
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_auth(x_auth_token)
    uploaded = [(u.filename or "", await u.read()) for u in files]
    parsed_targets = None
    if compile_targets:
        try:
            raw = json.loads(compile_targets)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="compile_targets must be valid JSON.") from exc
        if not isinstance(raw, list):
            raise HTTPException(status_code=400, detail="compile_targets must be a JSON array.")
        parsed_targets = [str(i).strip() for i in raw if str(i).strip()]
    settings, state, bundle_service = _ctx()
    try:
        result = mibs_service.upload(
            uploaded, compile_mode=compile_mode, compile_targets=parsed_targets,
            source_group=source_group, settings=settings, state=state, bundle_service=bundle_service,
        )
    except MibsError as exc:
        _mibs_http(exc)
    await broadcast_mibs(settings=settings)
    await broadcast_stats(settings=settings)
    return result


@router.post("/mibs/export")
def export_mib_catalog(
    body: CatalogExportBody,
    x_auth_token: str | None = Header(default=None),
) -> Response:
    _require_auth(x_auth_token)
    settings, state, bundle_service = _ctx()
    try:
        export_file = mibs_service.export_catalog_file(
            format=body.format,
            modules=body.modules,
            notifications=body.notifications,
            source_groups=body.source_groups,
            export_type=body.export_type,
            settings=settings,
            state=state,
            bundle_service=bundle_service,
        )
    except MibsError as exc:
        _mibs_http(exc)
    return Response(
        content=export_file["content"],
        media_type=str(export_file["media_type"]),
        headers={"Content-Disposition": f'attachment; filename="{export_file["filename"]}"'},
    )


@router.post("/mibs/download")
def download_mib_sources(
    body: MibDownloadBody,
    x_auth_token: str | None = Header(default=None),
) -> Response:
    _require_auth(x_auth_token)
    settings, state, bundle_service = _ctx()
    try:
        download_file = mibs_service.download_mib_sources(
            paths=body.paths,
            settings=settings,
            state=state,
            bundle_service=bundle_service,
        )
    except MibsError as exc:
        _mibs_http(exc)
    return Response(
        content=download_file["content"],
        media_type=str(download_file["media_type"]),
        headers={"Content-Disposition": f'attachment; filename="{download_file["filename"]}"'},
    )


@router.post("/mibs/reload")
async def reload_mibs(
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_auth(x_auth_token)
    settings, state, bundle_service = _ctx()
    try:
        result = mibs_service.reload(settings=settings, state=state, bundle_service=bundle_service)
    except MibsError as exc:
        _mibs_http(exc)
    await broadcast_mibs(settings=settings)
    await broadcast_stats(settings=settings)
    return result


@router.post("/mibs/fetch-dependencies")
def fetch_dependencies(
    body: DependencyFetchBody,
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_auth(x_auth_token)
    settings, state, bundle_service = _ctx()
    return mibs_service.fetch_dependencies(
        body.dependencies, settings=settings, state=state, bundle_service=bundle_service,
    )


@router.delete("/mibs/file")
async def delete_mib_file(
    path: str = Query(..., min_length=1),
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_auth(x_auth_token)
    settings, state, bundle_service = _ctx()
    try:
        result = mibs_service.delete_mib(path, settings=settings, state=state, bundle_service=bundle_service)
    except MibsError as exc:
        _mibs_http(exc)
    await broadcast_mibs(settings=settings)
    await broadcast_stats(settings=settings)
    return result


@router.post("/mibs/delete-batch")
async def delete_mib_batch(
    body: MibDeleteBatchBody,
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_auth(x_auth_token)
    settings, state, bundle_service = _ctx()
    try:
        result = mibs_service.delete_mibs(body.paths, settings=settings, state=state, bundle_service=bundle_service)
    except MibsError as exc:
        _mibs_http(exc)
    await broadcast_mibs(settings=settings)
    await broadcast_stats(settings=settings)
    return result


@router.delete("/mibs/{filename:path}")
async def delete_mib(
    filename: str,
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_auth(x_auth_token)
    settings, state, bundle_service = _ctx()
    try:
        result = mibs_service.delete_mib(filename, settings=settings, state=state, bundle_service=bundle_service)
    except MibsError as exc:
        _mibs_http(exc)
    await broadcast_mibs(settings=settings)
    await broadcast_stats(settings=settings)
    return result
