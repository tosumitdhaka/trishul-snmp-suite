from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from app.services import walker_service
from app.services.session import SessionService, SessionServiceError
from app.services.state_store import get_state_store
from app.services.walker_service import WalkerError

router = APIRouter()


class WalkBody(BaseModel):
    target: str = Field(..., min_length=1)
    port: int = Field(161, ge=1, le=65535)
    community: str = Field("public", min_length=1)
    oid: str = Field(..., min_length=1)
    parse: bool = True
    use_mibs: bool = True
    json_format: str = Field("flat", min_length=1)
    timeout_ms: int = Field(2000, ge=500, le=10000)
    retries: int = Field(1, ge=0, le=5)


def _require_auth(token: str | None) -> None:
    try:
        SessionService().require_username(token)
    except SessionServiceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/walk/execute")
async def execute_walk(
    body: WalkBody,
    x_auth_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_auth(x_auth_token)
    from app.core.config import get_settings
    from app.services.runtime import get_runtime_service
    try:
        return await walker_service.execute(
            target=body.target,
            port=body.port,
            community=body.community,
            oid=body.oid,
            parse=body.parse,
            use_mibs=body.use_mibs,
            json_format=body.json_format,
            timeout_ms=body.timeout_ms,
            retries=body.retries,
            settings=get_settings(),
            state=get_state_store(),
            runtime_service=get_runtime_service(),
        )
    except WalkerError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
