"""Bundle lifecycle routes: list, detail, diff, and activate (rollback)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.params import Query as _QueryParam

from app.services.bundles import BundleService, BundleServiceError
from app.services.realtime import broadcast_mibs, broadcast_stats
from app.services.session import SessionService, SessionServiceError


def _require_authenticated_user(token: str | None) -> str:
    try:
        return SessionService().require_username(token)
    except SessionServiceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


def _ctx() -> tuple[Any, Any, BundleService]:
    from app.core.config import get_settings
    from app.services.state_store import get_state_store

    settings = get_settings()
    return settings, get_state_store(), BundleService(settings)


def _not_found(exc: BundleServiceError) -> None:
    raise HTTPException(status_code=404, detail=str(exc)) from exc


router = APIRouter()


@router.get("/bundles")
def list_bundles(
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """List bundle sets with lifecycle metadata."""
    _require_authenticated_user(x_auth_token)
    _settings, _state, bundle_service = _ctx()
    state = bundle_service.list_state()
    return {
        "bundles": state["bundles"],
        "active_bundle_id": state["active_bundle_id"],
        "previous_active_bundle_id": state["previous_active_bundle_id"],
        "active_pointer": state["active_pointer"],
    }


@router.get("/bundles/{bundle_set_id}")
def get_bundle_detail(
    bundle_set_id: int,
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """Fetch a bundle set's detail (modules, manifest, compile runs)."""
    _require_authenticated_user(x_auth_token)
    _settings, _state, bundle_service = _ctx()
    try:
        return bundle_service.get_bundle(bundle_set_id)
    except BundleServiceError as exc:
        _not_found(exc)


@router.get("/bundles/{bundle_set_id}/diff")
def diff_bundle(
    bundle_set_id: int,
    against: int | None = Query(default=None),
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """Diff a bundle set against the active bundle (or an explicit pair).

    Identical ``content_hash`` values short-circuit to ``{identical: true}``
    with no per-module comparison.
    """
    _require_authenticated_user(x_auth_token)
    _settings, _state, bundle_service = _ctx()
    if isinstance(against, _QueryParam):
        # Direct-call contract tests invoke this route as a plain function
        # (no ASGI dependency injection), so omitting `against` leaves the
        # `Query(default=None)` sentinel object itself in the parameter
        # instead of None. Real HTTP requests always resolve `against` to an
        # int or None before the handler body runs, so this branch only ever
        # fires for direct calls — normalize the sentinel to "diff against the
        # active bundle", which is exactly what omitting the query param asks
        # for. (MGR-29: kept here deliberately — a shared test helper would
        # hide the same handling in the tests while the route's ASGI behavior
        # stays identical.)
        against = None
    if against is None:
        active_summary = bundle_service.get_effective_bundle_summary()
        if active_summary is None:
            raise HTTPException(status_code=409, detail="No active bundle is available to diff against.")
        against = int(active_summary["id"])
    if against == bundle_set_id:
        raise HTTPException(status_code=400, detail="A bundle cannot be diffed against itself.")
    try:
        return bundle_service.diff_bundles(bundle_set_id, against)
    except BundleServiceError as exc:
        _not_found(exc)


@router.post("/bundles/{bundle_set_id}/activate")
async def activate_bundle(
    bundle_set_id: int,
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """Activate a bundle set (rollback path), loading it before the pointer commit."""
    _require_authenticated_user(x_auth_token)
    _settings, _state, bundle_service = _ctx()
    try:
        result = bundle_service.activate_bundle(bundle_set_id)
    except BundleServiceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # The pointer swap changes which catalog every client serves — other
    # tabs' oid-index/tree caches and trap pickers must re-sync (MGR-27).
    await broadcast_mibs(settings=_settings)
    await broadcast_stats(settings=_settings)
    return result