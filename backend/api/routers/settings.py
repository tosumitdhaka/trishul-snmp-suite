import json
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel, Field
from core.security import save_credentials, validate_auth, login_user, logout_user, get_stored_credentials, _verify_password
from core.config import settings

router = APIRouter(prefix="/settings", tags=["Settings"])


# ---------------------------------------------------------------------------
# Auth models & endpoints (unchanged)
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    username: str
    password: str


class AuthUpdate(BaseModel):
    current_password: str
    username: str
    password: str


@router.post("/login")
def login(creds: LoginRequest):
    """Public endpoint — issues a session token on valid credentials."""
    token = login_user(creds.username, creds.password)
    if not token:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return {"token": token, "username": creds.username}


@router.post("/logout")
async def logout(
    x_auth_token: str = Header(None),
    _username: str = Depends(validate_auth)
):
    """Invalidate the current session token."""
    logout_user(x_auth_token)
    return {"status": "logged_out"}


@router.get("/check")
def check_auth_status(username: str = Depends(validate_auth)):
    return {"status": "authenticated", "user": username}


@router.post("/auth", dependencies=[Depends(validate_auth)])
def update_auth(creds: AuthUpdate):
    """Change username and/or password. Requires current password verification."""
    stored = get_stored_credentials()
    if not _verify_password(creds.current_password, stored["password"]):
        raise HTTPException(status_code=403, detail="Current password incorrect")
    save_credentials(creds.username, creds.password)
    return {"status": "updated", "message": "Credentials updated. Please log in again."}


# ---------------------------------------------------------------------------
# App Settings — persisted to data/configs/app_settings.json
# ---------------------------------------------------------------------------

# Schema / defaults — single source of truth
DEFAULT_APP_SETTINGS: dict = {
    "auto_start_simulator":     settings.AUTO_START_SIMULATOR,
    "auto_start_trap_receiver": settings.AUTO_START_TRAP_RECEIVER,
    "session_timeout":          settings.SESSION_TIMEOUT,
    "mib_auto_fetch":           settings.MIB_AUTO_FETCH,
    "mib_remote_sources":       list(settings.MIB_REMOTE_SOURCES),
}


class AppSettingsUpdate(BaseModel):
    auto_start_simulator:     Optional[bool] = None
    auto_start_trap_receiver: Optional[bool] = None
    session_timeout:          Optional[int]  = Field(None, ge=60, le=86400)
    mib_auto_fetch:           Optional[bool] = None
    mib_remote_sources:       Optional[list[str]] = None


def _normalize_remote_sources(sources: list[str]) -> list[str]:
    normalized: list[str] = []
    for source in sources:
        value = str(source).strip()
        if not value:
            continue
        if "@mib@" not in value:
            raise HTTPException(
                status_code=422,
                detail=f"Remote source '{value}' must include the @mib@ placeholder."
            )
        if not (value.startswith("https://") or value.startswith("http://")):
            raise HTTPException(
                status_code=422,
                detail=f"Remote source '{value}' must use http:// or https://."
            )
        if value not in normalized:
            normalized.append(value)
    if not normalized:
        raise HTTPException(status_code=422, detail="At least one remote MIB source is required.")
    return normalized


def _load_app_settings() -> dict:
    """Return current app_settings.json merged with defaults."""
    data = {
        **DEFAULT_APP_SETTINGS,
        "mib_remote_sources": list(DEFAULT_APP_SETTINGS["mib_remote_sources"]),
    }
    if settings.APP_SETTINGS_FILE.exists():
        try:
            saved = json.loads(settings.APP_SETTINGS_FILE.read_text())
            # Only accept known keys to guard against stale/corrupt data
            data.update({k: v for k, v in saved.items() if k in DEFAULT_APP_SETTINGS})
            if isinstance(data.get("mib_remote_sources"), list):
                data["mib_remote_sources"] = _normalize_remote_sources(data["mib_remote_sources"])
        except Exception:
            pass
    return data


def _save_app_settings(data: dict) -> None:
    settings.APP_SETTINGS_FILE.write_text(json.dumps(data, indent=2))


def _apply_runtime_app_settings(data: dict) -> None:
    settings.AUTO_START_SIMULATOR = bool(data["auto_start_simulator"])
    settings.AUTO_START_TRAP_RECEIVER = bool(data["auto_start_trap_receiver"])
    settings.SESSION_TIMEOUT = int(data["session_timeout"])
    settings.MIB_AUTO_FETCH = bool(data["mib_auto_fetch"])
    settings.MIB_REMOTE_SOURCES = list(data["mib_remote_sources"])


@router.get("/app", dependencies=[Depends(validate_auth)])
def get_app_settings():
    """Return current application behaviour settings."""
    return _load_app_settings()


@router.post("/app", dependencies=[Depends(validate_auth)])
def update_app_settings(body: AppSettingsUpdate):
    """
    Persist application behaviour settings.
    Changes are written to app_settings.json and applied on next container restart.
    """
    current = _load_app_settings()
    restart_required = False
    if body.auto_start_simulator is not None:
        restart_required = restart_required or body.auto_start_simulator != current["auto_start_simulator"]
        current["auto_start_simulator"] = body.auto_start_simulator
    if body.auto_start_trap_receiver is not None:
        restart_required = restart_required or body.auto_start_trap_receiver != current["auto_start_trap_receiver"]
        current["auto_start_trap_receiver"] = body.auto_start_trap_receiver
    if body.session_timeout is not None:
        current["session_timeout"] = body.session_timeout
    if body.mib_auto_fetch is not None:
        current["mib_auto_fetch"] = body.mib_auto_fetch
    if body.mib_remote_sources is not None:
        current["mib_remote_sources"] = _normalize_remote_sources(body.mib_remote_sources)
    _save_app_settings(current)
    _apply_runtime_app_settings(current)
    return {"status": "saved", "restart_required": restart_required, "settings": current}
