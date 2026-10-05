from __future__ import annotations

import hashlib
import json
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select

from app.core.config import Settings, get_settings
from app.db.session import create_session_factory
from app.models import AppSetting, AuthSession
from app.services.app_settings import AppSettingsService

_AUTH_USERNAME_KEY = "auth.username"
_AUTH_PASSWORD_HASH_KEY = "auth.password_hash"
_SQLITE_CREDENTIAL_STORE = "sqlite:app_settings"
_SQLITE_SESSION_STORE = "sqlite:auth_sessions"


class SessionServiceError(RuntimeError):
    """Raised when session operations fail."""

    def __init__(self, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


class SessionService:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.session_factory = create_session_factory(self.settings.database_url)
        self.app_settings = AppSettingsService(self.settings)

    def login(self, *, username: str, password: str) -> dict[str, str]:
        normalized_username = username.strip()
        if not normalized_username or not password:
            raise SessionServiceError("username and password are required.")

        with self.session_factory() as session:
            stored = self._load_credentials(session)
            if not secrets.compare_digest(normalized_username, stored["username"]):
                raise SessionServiceError("Invalid credentials.", status_code=401)
            if not self._verify_password(password, stored["password"]):
                raise SessionServiceError("Invalid credentials.", status_code=401)

            token = str(uuid.uuid4())
            issued_at = datetime.now(timezone.utc)
            session.add(
                AuthSession(
                    token=token,
                    username=normalized_username,
                    issued_at=issued_at,
                    last_seen_at=issued_at,
                )
            )
            session.commit()
            return {"token": token, "username": normalized_username}

    def logout(self, *, token: str | None) -> dict[str, str]:
        with self.session_factory() as session:
            _username, auth_session = self._require_session(session, token=token, touch=False)
            session.delete(auth_session)
            session.commit()
        return {"status": "logged_out"}

    def check(self, *, token: str | None) -> dict[str, str]:
        return {
            "status": "authenticated",
            "user": self.require_username(token),
        }

    def get_status(self, *, token: str | None) -> dict[str, object]:
        with self.session_factory() as session:
            username, auth_session = self._require_session(session, token=token, touch=True)
            timeout_seconds = self._effective_session_timeout()
            issued_at = self._normalize_dt(auth_session.issued_at)
            last_seen_at = self._normalize_dt(auth_session.last_seen_at)
            expires_at = last_seen_at + timedelta(seconds=timeout_seconds)
            remaining_seconds = max(
                0,
                int((expires_at - datetime.now(timezone.utc)).total_seconds()),
            )
            stored = self._load_credentials(session)
            active_session_count = int(
                session.scalar(select(func.count()).select_from(AuthSession)) or 0
            )
            return {
                "status": "authenticated",
                "user": username,
                "issued_at": issued_at.isoformat(),
                "expires_at": expires_at.isoformat(),
                "remaining_seconds": remaining_seconds,
                "active_session_count": active_session_count,
                "configured_username": stored["username"],
                "credential_store": _SQLITE_CREDENTIAL_STORE,
                "session_store": _SQLITE_SESSION_STORE,
            }

    def update_credentials(
        self,
        *,
        token: str | None,
        current_password: str,
        username: str,
        password: str,
    ) -> dict[str, object]:
        normalized_username = username.strip()
        if not normalized_username:
            raise SessionServiceError("username is required.")
        if not current_password:
            raise SessionServiceError("current_password is required.")
        if not password:
            raise SessionServiceError("password is required.")
        if len(password) < 6:
            raise SessionServiceError("password must be at least 6 characters.")

        with self.session_factory() as session:
            self._require_session(session, token=token, touch=False)
            stored = self._load_credentials(session)
            if not self._verify_password(current_password, stored["password"]):
                raise SessionServiceError("Current password incorrect.", status_code=403)

            if normalized_username != stored["username"]:
                raise SessionServiceError(
                    "The username is fixed and cannot be changed.",
                    status_code=400,
                )

            self._store_credentials(
                session,
                username=normalized_username,
                password_hash=self._hash_password(password),
            )
            session.execute(delete(AuthSession))
            session.commit()
            return {
                "status": "updated",
                "message": "Credentials updated. Please log in again.",
                "reauth_required": True,
            }

    def require_username(self, token: str | None) -> str:
        with self.session_factory() as session:
            username, _auth_session = self._require_session(session, token=token, touch=True)
            return username

    def validate_token(
        self,
        token: str | None,
        *,
        touch: bool = False,
    ) -> tuple[bool, str | None, str | None]:
        with self.session_factory() as session:
            try:
                username, _auth_session = self._require_session(session, token=token, touch=touch)
            except SessionServiceError as exc:
                return False, None, str(exc)
            return True, username, None

    def _require_session(
        self,
        session,
        *,
        token: str | None,
        touch: bool,
    ) -> tuple[str, AuthSession]:
        if not token:
            raise SessionServiceError(
                "Invalid or missing session token.",
                status_code=401,
            )

        auth_session = session.get(AuthSession, token)
        if auth_session is None:
            raise SessionServiceError(
                "Invalid or missing session token.",
                status_code=401,
            )

        last_seen_at = self._normalize_dt(auth_session.last_seen_at)
        elapsed = (datetime.now(timezone.utc) - last_seen_at).total_seconds()
        if elapsed > self._effective_session_timeout():
            session.delete(auth_session)
            session.commit()
            raise SessionServiceError(
                "Session expired. Please log in again.",
                status_code=401,
            )

        if touch:
            auth_session.last_seen_at = datetime.now(timezone.utc)
            session.commit()

        return auth_session.username, auth_session

    def _load_credentials(self, session) -> dict[str, str]:
        username_setting = session.get(AppSetting, _AUTH_USERNAME_KEY)
        password_setting = session.get(AppSetting, _AUTH_PASSWORD_HASH_KEY)
        username = self._setting_value(username_setting)
        password_hash = self._setting_value(password_setting)
        if username and password_hash:
            return {
                "username": username,
                "password": password_hash,
            }

        bootstrap = self._load_bootstrap_credentials_from_file() or self._default_credentials()
        normalized_username = str(bootstrap["username"]).strip() or self._default_credentials()["username"]
        raw_password = str(bootstrap["password"])
        normalized_password = raw_password if "$" in raw_password else self._hash_password(raw_password)
        self._store_credentials(
            session,
            username=normalized_username,
            password_hash=normalized_password,
        )
        session.commit()
        return {
            "username": normalized_username,
            "password": normalized_password,
        }

    def _store_credentials(self, session, *, username: str, password_hash: str) -> None:
        self._set_setting_value(session, _AUTH_USERNAME_KEY, username)
        self._set_setting_value(session, _AUTH_PASSWORD_HASH_KEY, password_hash)

    def _setting_value(self, setting: AppSetting | None) -> str | None:
        if setting is None or setting.value_json is None:
            return None
        value = str(setting.value_json).strip()
        return value or None

    def _set_setting_value(self, session, key: str, value: str) -> None:
        setting = session.get(AppSetting, key)
        if setting is None:
            setting = AppSetting(key=key, value_json=value)
            session.add(setting)
        else:
            setting.value_json = value

    def _load_bootstrap_credentials_from_file(self) -> dict[str, str] | None:
        path = self.settings.secrets_file
        if not path.exists():
            return None

        try:
            stored = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            return None

        username = str(stored.get("username") or "").strip()
        password = str(stored.get("password") or "")
        if not username or not password:
            return None
        return {
            "username": username,
            "password": password,
        }

    def _hash_password(self, password: str) -> str:
        salt = os.urandom(16).hex()
        digest = hashlib.sha256((salt + password).encode()).hexdigest()
        return f"{salt}${digest}"

    def _verify_password(self, plain: str, stored: str) -> bool:
        if "$" not in stored:
            return secrets.compare_digest(plain, stored)
        salt, expected_hash = stored.split("$", 1)
        digest = hashlib.sha256((salt + plain).encode()).hexdigest()
        return secrets.compare_digest(digest, expected_hash)

    def _default_credentials(self) -> dict[str, str]:
        return {
            "username": os.getenv("ADMIN_USER", "admin"),
            "password": os.getenv("ADMIN_PASS", "admin123"),
        }

    def _effective_session_timeout(self) -> int:
        return self.app_settings.get_int("session_timeout_seconds")

    def _normalize_dt(self, value: datetime) -> datetime:
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value


def reset_session_store(settings: Settings | None = None) -> None:
    runtime_settings = settings or get_settings()
    session_factory = create_session_factory(runtime_settings.database_url)
    with session_factory() as session:
        session.execute(delete(AuthSession))
        session.commit()
