import json
import shutil
import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


@pytest.fixture()
def isolated_settings(monkeypatch, tmp_path):
    from core.config import settings
    from core.security import ACTIVE_SESSIONS
    from core import stats_store
    from services import mib_service
    from services.sim_manager import SimulatorManager
    from services.trap_manager import trap_manager

    data_dir = tmp_path / "data"
    mib_dir = data_dir / "mibs"
    config_dir = data_dir / "configs"
    log_dir = data_dir / "logs"
    for directory in (data_dir, mib_dir, config_dir, log_dir):
        directory.mkdir(parents=True, exist_ok=True)

    custom_data_file = config_dir / "custom_data.json"
    secrets_file = config_dir / "secrets.json"
    stats_file = config_dir / "stats.json"
    app_settings_file = config_dir / "app_settings.json"
    traps_file = data_dir / "traps.jsonl"

    custom_data_file.write_text("{}")
    secrets_file.write_text(json.dumps({"username": "admin", "password": "admin123"}))
    traps_file.touch()

    for mib_file in settings.BUNDLED_MIBS_DIR.iterdir():
        if mib_file.is_file() and mib_file.suffix in (".txt", ".mib", ".my"):
            shutil.copy2(mib_file, mib_dir / mib_file.name)

    monkeypatch.setattr(settings, "DATA_DIR", data_dir, raising=False)
    monkeypatch.setattr(settings, "MIB_DIR", mib_dir, raising=False)
    monkeypatch.setattr(settings, "CONFIG_DIR", config_dir, raising=False)
    monkeypatch.setattr(settings, "LOG_DIR", log_dir, raising=False)
    monkeypatch.setattr(settings, "CUSTOM_DATA_FILE", custom_data_file, raising=False)
    monkeypatch.setattr(settings, "SECRETS_FILE", secrets_file, raising=False)
    monkeypatch.setattr(settings, "STATS_FILE", stats_file, raising=False)
    monkeypatch.setattr(settings, "APP_SETTINGS_FILE", app_settings_file, raising=False)
    monkeypatch.setattr(settings, "TRAPS_FILE", traps_file, raising=False)
    monkeypatch.setattr(settings, "AUTO_START_SIMULATOR", False, raising=False)
    monkeypatch.setattr(settings, "AUTO_START_TRAP_RECEIVER", False, raising=False)
    monkeypatch.setattr(settings, "SESSION_TIMEOUT", 3600, raising=False)
    monkeypatch.setattr(settings, "MIB_AUTO_FETCH", False, raising=False)
    monkeypatch.setattr(
        settings,
        "MIB_REMOTE_SOURCES",
        [
            "https://mibs.pysnmp.com/asn1/@mib@",
            "https://mibbrowser.online/mibs/@mib@.mib",
        ],
        raising=False,
    )

    ACTIVE_SESSIONS.clear()
    mib_service._mib_service_instance = None
    mib_service.MibService._instance = None
    SimulatorManager._process = None
    trap_manager.process = None
    trap_manager._start_time = None
    trap_manager.resolve_mibs = True
    trap_manager.log_file = str(traps_file)
    trap_manager.mib_path = str(mib_dir)
    trap_manager._port = settings.TRAP_PORT
    trap_manager._community = settings.COMMUNITY
    stats_store.reset()

    yield settings

    ACTIVE_SESSIONS.clear()
    mib_service._mib_service_instance = None
    mib_service.MibService._instance = None
    SimulatorManager._process = None
    trap_manager.process = None
    trap_manager._start_time = None


@pytest.fixture()
def auth_token(isolated_settings):
    from api.routers.settings import LoginRequest, login

    payload = login(LoginRequest(username="admin", password="admin123"))
    return payload["token"]


@pytest.fixture()
def auth_username():
    return "admin"
