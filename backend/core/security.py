import hashlib
import json
import os
import secrets
import uuid
from datetime import datetime, timezone
from typing import Optional
from fastapi import HTTPException, status, Header
from core.config import settings

# BUG-15 fix: use settings.SECRETS_FILE exclusively — no duplicate path definition here.

# ---------------------------------------------------------------------------
# Password hashing  (BUG-4)
# ---------------------------------------------------------------------------
# Format stored on disk:  "<hex-salt>$<sha256-hex>"
# Legacy plaintext values (no '$') are transparently migrated on next login
# or credential change.

def _hash_password(password: str) -> str:
    """Return a salted SHA-256 hash string: '<salt>$<hash>'."""
    salt = os.urandom(16).hex()
    h = hashlib.sha256((salt + password).encode()).hexdigest()
    return f"{salt}${h}"


def _verify_password(plain: str, stored: str) -> bool:
    """Verify plain password against stored hash or legacy plaintext."""
    if '$' not in stored:
        # Legacy plaintext — timing-safe comparison
        return secrets.compare_digest(plain, stored)
    salt, expected_hash = stored.split('$', 1)
    candidate = hashlib.sha256((salt + plain).encode()).hexdigest()
    return secrets.compare_digest(candidate, expected_hash)


# ---------------------------------------------------------------------------
# Session store  (BUG-5)
# ---------------------------------------------------------------------------
# { token_uuid: (username, issued_at) }
# Resets on container restart — for persistence a DB/Redis would be needed.

ACTIVE_SESSIONS: dict[str, tuple[str, datetime]] = {}


# ---------------------------------------------------------------------------
# Credential helpers
# ---------------------------------------------------------------------------

def get_stored_credentials() -> dict:
    if settings.SECRETS_FILE.exists():
        try:
            with open(settings.SECRETS_FILE, 'r') as f:
                return json.load(f)
        except Exception:
            pass
    # Final fallback — env vars (useful for first-boot containers)
    return {
        "username": os.getenv("ADMIN_USER", "admin"),
        "password": os.getenv("ADMIN_PASS", "admin")
    }


def save_credentials(username: str, password: str) -> None:
    """Hash password and persist credentials to secrets.json."""
    os.makedirs(settings.CONFIG_DIR, exist_ok=True)
    with open(settings.SECRETS_FILE, 'w') as f:
        json.dump({"username": username, "password": _hash_password(password)}, f, indent=2)


# ---------------------------------------------------------------------------
# Auth logic
# ---------------------------------------------------------------------------

def login_user(username: str, password: str) -> Optional[str]:
    """
    Validate credentials and issue a session token.
    Transparently migrates legacy plaintext passwords to hashed format
    on first successful login.

    Returns token string on success, None on failure.
    """
    stored = get_stored_credentials()

    if not secrets.compare_digest(username, stored["username"]):
        return None

    if not _verify_password(password, stored["password"]):
        return None

    # Migrate plaintext password to hashed format on first successful login
    if '$' not in stored["password"]:
        save_credentials(username, password)

    token = str(uuid.uuid4())
    ACTIVE_SESSIONS[token] = (username, datetime.now(timezone.utc))
    return token


def logout_user(token: str) -> None:
    """Remove session token. Safe to call with an already-expired token."""
    ACTIVE_SESSIONS.pop(token, None)


def validate_session_token(token: Optional[str]) -> tuple[bool, Optional[str], str]:
    """
    Shared session validator for REST and WebSocket code paths.

    Returns:
        (is_valid, username, reason)
    """
    if not token or token not in ACTIVE_SESSIONS:
        return False, None, "Invalid or missing session token"

    username, issued_at = ACTIVE_SESSIONS[token]
    if issued_at.tzinfo is None:
        issued_at = issued_at.replace(tzinfo=timezone.utc)

    elapsed = (datetime.now(timezone.utc) - issued_at).total_seconds()
    if elapsed > settings.SESSION_TIMEOUT:
        ACTIVE_SESSIONS.pop(token, None)
        return False, None, "Session expired. Please log in again."

    return True, username, ""


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------

def validate_auth(x_auth_token: Optional[str] = Header(None)) -> str:
    """
    Validate session token and enforce SESSION_TIMEOUT.  (BUG-5)
    Returns the authenticated username.
    """
    valid, username, reason = validate_session_token(x_auth_token)
    if not valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=reason
        )

    return username
