from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

pytestmark = pytest.mark.contract


def _login(settings_module, *, username: str = "admin", password: str = "admin123") -> dict[str, str]:
    return settings_module.login(
        settings_module.LoginBody(username=username, password=password)
    )


def test_settings_routes_manage_session_and_app_preferences(isolated_db):
    from app.api.routes import settings as settings_module

    del isolated_db

    login = _login(settings_module)
    token = login["token"]
    assert login["username"] == "admin"

    assert settings_module.check_session(x_auth_token=token) == {
        "status": "authenticated",
        "user": "admin",
    }

    default_settings = asyncio.run(settings_module.get_settings_app(x_auth_token=token))
    assert default_settings["session_timeout"] == 3600
    assert default_settings["mib_remote_sources"] == []

    updated_settings = asyncio.run(
        settings_module.update_settings_app(
            settings_module.SettingsBody(
                auto_start_simulator=True,
                auto_start_trap_receiver=True,
                session_timeout=7200,
                mib_auto_fetch=True,
                mib_remote_sources=["https://example.invalid/@mib@"],
            ),
            x_auth_token=token,
        )
    )
    assert updated_settings["session_timeout"] == 7200
    assert updated_settings["auto_start_simulator"] is True
    assert updated_settings["auto_start_trap_receiver"] is True
    assert updated_settings["mib_auto_fetch"] is True
    assert updated_settings["mib_remote_sources"] == ["https://example.invalid/@mib@"]
    # Nothing is running yet, but both autostart flags are now on -> restart needed.
    assert updated_settings["restart_required"] is True

    # Toggling both autostart flags back off matches the (stopped) runtime state.
    settled_settings = asyncio.run(
        settings_module.update_settings_app(
            settings_module.SettingsBody(
                auto_start_simulator=False,
                auto_start_trap_receiver=False,
                session_timeout=7200,
                mib_auto_fetch=True,
                mib_remote_sources=[],
            ),
            x_auth_token=token,
        )
    )
    assert settled_settings["restart_required"] is False

    assert settings_module.logout(x_auth_token=token) == {"status": "logged_out"}

    with pytest.raises(HTTPException) as excinfo:
        settings_module.check_session(x_auth_token=token)
    assert excinfo.value.status_code == 401


def test_update_auth_allows_password_change_but_rejects_username_rename(isolated_db):
    from app.api.routes import settings as settings_module

    del isolated_db

    token = _login(settings_module)["token"]
    update = asyncio.run(
        settings_module.update_auth(
            settings_module.AuthBody(
                current_password="admin123",
                username="admin",
                password="betterpass",
            ),
            x_auth_token=token,
        )
    )
    assert update["reauth_required"] is True

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(settings_module.get_settings_app(x_auth_token=token))
    assert excinfo.value.status_code == 401

    relogin = _login(settings_module, username="admin", password="betterpass")
    assert relogin["username"] == "admin"
    assert settings_module.check_session(x_auth_token=relogin["token"]) == {
        "status": "authenticated",
        "user": "admin",
    }

    # Rename attempts are rejected at the API level: username is fixed.
    token2 = _login(settings_module, username="admin", password="betterpass")["token"]
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            settings_module.update_auth(
                settings_module.AuthBody(
                    current_password="betterpass",
                    username="renamed",
                    password="anotherpass",
                ),
                x_auth_token=token2,
            )
        )
    assert excinfo.value.status_code == 400
    assert "fixed" in str(excinfo.value.detail)

    # Rejected rename must not have wiped the existing session.
    assert settings_module.check_session(x_auth_token=token2) == {
        "status": "authenticated",
        "user": "admin",
    }


def test_update_auth_broadcasts_reauth_required_after_session_wipe(isolated_db, monkeypatch):
    from app.api.routes import settings as settings_module

    del isolated_db

    token = _login(settings_module)["token"]
    broadcast_calls: list[bool] = []

    async def fake_broadcast() -> None:
        broadcast_calls.append(True)

    monkeypatch.setattr(settings_module, "broadcast_reauth_required", fake_broadcast)

    # A rejected update (wrong current password) must not notify live clients.
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            settings_module.update_auth(
                settings_module.AuthBody(
                    current_password="wrongpass",
                    username="admin",
                    password="betterpass",
                ),
                x_auth_token=token,
            )
        )
    assert excinfo.value.status_code == 403
    assert broadcast_calls == []

    # A successful update wipes sessions and broadcasts the reauth notice.
    result = asyncio.run(
        settings_module.update_auth(
            settings_module.AuthBody(
                current_password="admin123",
                username="admin",
                password="betterpass",
            ),
            x_auth_token=token,
        )
    )
    assert result["reauth_required"] is True
    assert broadcast_calls == [True]


def test_update_settings_app_rejects_invalid_remote_sources(isolated_db):
    from app.api.routes import settings as settings_module

    del isolated_db

    token = _login(settings_module)["token"]

    # Missing the @mib@ placeholder.
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            settings_module.update_settings_app(
                settings_module.SettingsBody(
                    auto_start_simulator=True,
                    auto_start_trap_receiver=True,
                    session_timeout=1234,
                    mib_auto_fetch=True,
                    mib_remote_sources=["https://example.invalid/mibs/IF-MIB"],
                ),
                x_auth_token=token,
            )
        )
    assert excinfo.value.status_code == 400
    assert "@mib@" in str(excinfo.value.detail)

    # Non-http(s) scheme.
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            settings_module.update_settings_app(
                settings_module.SettingsBody(
                    mib_remote_sources=["ftp://example.invalid/mibs/@mib@"],
                ),
                x_auth_token=token,
            )
        )
    assert excinfo.value.status_code == 400
    assert "http(s)" in str(excinfo.value.detail)

    # Nothing was persisted by the failed attempts — sources AND the other
    # settings (autostart flags, session_timeout, auto-fetch) stay at defaults.
    unchanged = asyncio.run(settings_module.get_settings_app(x_auth_token=token))
    assert unchanged["mib_remote_sources"] == []
    assert unchanged["auto_start_simulator"] is False
    assert unchanged["auto_start_trap_receiver"] is False
    assert unchanged["session_timeout"] == 3600
    assert unchanged["mib_auto_fetch"] is False

    # Valid entries are normalized and stored.
    saved = asyncio.run(
        settings_module.update_settings_app(
            settings_module.SettingsBody(
                auto_start_simulator=False,
                auto_start_trap_receiver=False,
                mib_remote_sources=[
                    "  https://example.invalid/mibs/@mib@  ",
                    "http://other.invalid/@mib@.mib",
                    "   ",
                ],
            ),
            x_auth_token=token,
        )
    )
    assert saved["mib_remote_sources"] == [
        "https://example.invalid/mibs/@mib@",
        "http://other.invalid/@mib@.mib",
    ]


def test_restart_required_tracks_settings_versus_runtime_state(isolated_db, monkeypatch):
    import app.services.runtime as runtime_module
    from app.api.routes import settings as settings_module

    del isolated_db

    token = _login(settings_module)["token"]

    class StubRuntime:
        def __init__(self, *, sim_running: bool, trap_running: bool) -> None:
            self._sim_running = sim_running
            self._trap_running = trap_running

        async def get_state(self) -> dict[str, object]:
            return {
                "responder": {"running": self._sim_running},
                "notifications": {"listener": {"running": self._trap_running}},
            }

    def _save(**flags) -> bool:
        return asyncio.run(
            settings_module.update_settings_app(
                settings_module.SettingsBody(
                    auto_start_simulator=flags["sim"],
                    auto_start_trap_receiver=flags["trap"],
                    mib_remote_sources=[],
                ),
                x_auth_token=token,
            )
        )["restart_required"]

    # Simulator running, autostart off -> restart would stop it.
    monkeypatch.setattr(
        runtime_module, "get_runtime_service", lambda: StubRuntime(sim_running=True, trap_running=False)
    )
    assert _save(sim=False, trap=False) is True

    # Simulator running, autostart on -> matches runtime, no restart needed.
    assert _save(sim=True, trap=False) is False

    # Trap receiver not running, autostart on -> restart would start it.
    monkeypatch.setattr(
        runtime_module, "get_runtime_service", lambda: StubRuntime(sim_running=True, trap_running=False)
    )
    assert _save(sim=True, trap=True) is True

    # Both autostart flags match a fully stopped runtime -> no restart needed.
    monkeypatch.setattr(
        runtime_module, "get_runtime_service", lambda: StubRuntime(sim_running=False, trap_running=False)
    )
    assert _save(sim=False, trap=False) is False


def test_session_routes_translate_service_errors(monkeypatch):
    from app.api.routes import settings as settings_module
    from app.services.session import SessionServiceError

    class FailingSessionService:
        def login(self, **kwargs):
            del kwargs
            raise SessionServiceError("login denied", status_code=401)

        def logout(self, **kwargs):
            del kwargs
            raise SessionServiceError("logout denied", status_code=403)

        def check(self, **kwargs):
            del kwargs
            raise SessionServiceError("session expired", status_code=401)

        def update_credentials(self, **kwargs):
            del kwargs
            raise SessionServiceError("credential conflict", status_code=409)

    monkeypatch.setattr(
        settings_module,
        "_session_service_factory",
        lambda: FailingSessionService(),
    )

    with pytest.raises(HTTPException) as excinfo:
        settings_module.login(settings_module.LoginBody(username="admin", password="bad"))
    assert excinfo.value.status_code == 401
    assert excinfo.value.detail == "login denied"

    with pytest.raises(HTTPException) as excinfo:
        settings_module.logout(x_auth_token="demo-token")
    assert excinfo.value.status_code == 403
    assert excinfo.value.detail == "logout denied"

    with pytest.raises(HTTPException) as excinfo:
        settings_module.check_session(x_auth_token="demo-token")
    assert excinfo.value.status_code == 401
    assert excinfo.value.detail == "session expired"

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            settings_module.update_auth(
                settings_module.AuthBody(
                    current_password="old",
                    username="admin",
                    password="newpass",
                ),
                x_auth_token="demo-token",
            )
        )
    assert excinfo.value.status_code == 409
    assert excinfo.value.detail == "credential conflict"


def test_shell_health_probe_returns_ok():
    from app.api.routes import settings as settings_module

    assert settings_module.shell_health_probe() == {"status": "ok"}
