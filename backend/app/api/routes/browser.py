from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import Response

from app.services import browser_service
from app.services.bundle_state import get_bundle
from app.services.session import SessionService, SessionServiceError


def _require_authenticated_user(token):
    try:
        return SessionService().require_username(token)
    except SessionServiceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


def _ctx():
    from app.core.config import get_settings
    from app.services.bundles import BundleService
    from app.services.state_store import get_state_store

    settings = get_settings()
    return settings, get_state_store(), BundleService(settings)

router = APIRouter()


@router.get("/bundles/{bundle_set_id}/oid-index")
def bundle_oid_index(
    bundle_set_id: int,
    request: Request,
    x_auth_token: str | None = Header(default=None),
) -> Response:
    """Stream a bundle set's oid_index.json sidecar from disk.

    BRW-06: bundle sets are immutable once compiled and the id is part of the
    URL, so the payload is served with a strong ETag (id + size + mtime) and
    immutable caching — repeat hits answer 304 without re-reading the file.
    """
    _require_authenticated_user(x_auth_token)
    from app.db.session import create_session_factory
    from app.models import BundleSet

    # BRW-06: this is a static-file stream — a plain session factory is
    # enough, without constructing the full service/state context.
    with create_session_factory()() as session:
        bundle = session.get(BundleSet, bundle_set_id)
    oid_index_path = bundle.oid_index_path if bundle is not None else None
    if not oid_index_path or not Path(oid_index_path).exists():
        raise HTTPException(status_code=404, detail="Bundle set oid-index sidecar not found.")

    file_path = Path(oid_index_path)
    stat = file_path.stat()
    etag = f'"{bundle_set_id}-{stat.st_size}-{int(stat.st_mtime)}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={
            "ETag": etag,
            "Cache-Control": "private, max-age=86400, immutable",
        })
    return Response(
        content=file_path.read_bytes(),
        media_type="application/json",
        headers={
            "ETag": etag,
            "Cache-Control": "private, max-age=86400, immutable",
        },
    )


@router.get("/mibs/browse/modules")
def browse_modules(
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_authenticated_user(x_auth_token)
    payload = browser_service.get_modules(bundle=get_bundle())
    _settings, _state, bundle_service = _ctx()
    payload["active_bundle_id"] = (bundle_service.get_effective_bundle_summary() or {}).get("id")
    return payload


@router.get("/mibs/bundle-summary")
def bundle_summary(
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """BRW-27: lightweight manifest summary for the browser's detail notice.

    Reads only the effective bundle's manifest and pointer rows — no source
    inventory scan like /api/mibs/status — so the browser can check
    recompile_recommended on entry and on every mibs broadcast cheaply.
    """
    _require_authenticated_user(x_auth_token)
    _settings, _state, bundle_service = _ctx()
    manifest = bundle_service.get_effective_bundle_manifest_summary() or {}
    bundle = bundle_service.get_effective_bundle_summary() or {}
    return {
        "active_bundle_id": bundle.get("id"),
        "producer_version": manifest.get("producer_version"),
        "missing_capabilities": manifest.get("missing_capabilities") or [],
        "recompile_recommended": bool(manifest.get("recompile_recommended")),
    }


@router.get("/mibs/browse/tree/module")
def browse_module_tree(
    module: str | None = Query(default=None),
    type_filter: str | None = Query(default=None),
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_authenticated_user(x_auth_token)
    return browser_service.get_module_tree(module=module, type_filter=type_filter, bundle=get_bundle())


@router.get("/mibs/browse/tree/oid")
def browse_oid_tree(
    root_oid: str = Query(..., min_length=1),
    depth: int = Query(1, ge=1, le=6),
    module: str | None = Query(default=None),
    type_filter: str | None = Query(default=None),
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_authenticated_user(x_auth_token)
    return browser_service.get_oid_tree(
        root_oid=root_oid,
        depth=depth,
        module=module,
        type_filter=type_filter,
        bundle=get_bundle(),
    )


@router.get("/mibs/browse/search")
def browse_search(
    query: str = Query(..., min_length=1),
    module: str | None = Query(default=None),
    type_filter: str | None = Query(default=None),
    limit: int = Query(100, ge=1, le=500),
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_authenticated_user(x_auth_token)
    return browser_service.search_bundle(
        query=query,
        module=module,
        type_filter=type_filter,
        limit=limit,
        bundle=get_bundle(),
    )


@router.get("/mibs/browse/node/{oid:path}")
def browse_node(
    oid: str,
    module: str | None = None,
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_authenticated_user(x_auth_token)
    return browser_service.get_node(oid, module=module, bundle=get_bundle())
