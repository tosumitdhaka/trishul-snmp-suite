import os
import json
import shutil
from pathlib import Path


def _parse_remote_mib_sources(raw: str | None) -> list[str]:
    """Parse a newline/comma separated source list, keeping ordering stable."""
    if not raw:
        return []
    sources: list[str] = []
    for part in raw.replace(",", "\n").splitlines():
        source = part.strip()
        if source and source not in sources:
            sources.append(source)
    return sources


class Settings:
    # Base paths
    BASE_DIR   = Path(__file__).parent.parent.resolve()
    DATA_DIR   = BASE_DIR / "data"
    MIB_DIR    = DATA_DIR / "mibs"
    CONFIG_DIR = DATA_DIR / "configs"
    LOG_DIR    = DATA_DIR / "logs"
    BUNDLED_MIBS_DIR = BASE_DIR / "mibs_bundled"  # git-tracked starter MIBs

    # SNMP Settings
    SNMP_PORT  = int(os.getenv("SNMP_PORT",  "1061"))
    COMMUNITY  = os.getenv("SNMP_COMMUNITY", "public")
    TRAP_PORT  = int(os.getenv("TRAP_PORT",  "1162"))

    # File paths
    CUSTOM_DATA_FILE  = CONFIG_DIR / "custom_data.json"
    SECRETS_FILE      = CONFIG_DIR / "secrets.json"
    STATS_FILE        = CONFIG_DIR / "stats.json"
    APP_SETTINGS_FILE = CONFIG_DIR / "app_settings.json"
    TRAPS_FILE        = DATA_DIR   / "traps.jsonl"

    # Logging
    LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
    LOG_FILE  = LOG_DIR / "app.log"

    # Application metadata
    APP_NAME        = os.getenv("APP_NAME",        "Trishul SNMP Suite")
    APP_VERSION     = os.getenv("APP_VERSION",     "1.4.1")
    APP_AUTHOR      = os.getenv("APP_AUTHOR",      "Sumit Dhaka")
    APP_DESCRIPTION = os.getenv("APP_DESCRIPTION", "Professional SNMP Simulation Tool")

    # Security
    SESSION_TIMEOUT = int(os.getenv("SESSION_TIMEOUT", "3600"))

    # Auto-start flags
    AUTO_START_SIMULATOR     = os.getenv("AUTO_START_SIMULATOR",     "true").lower() == "true"
    AUTO_START_TRAP_RECEIVER = os.getenv("AUTO_START_TRAP_RECEIVER", "true").lower() == "true"

    # WebSocket internal UDP side-channel port (loopback only, not exposed)
    # Worker subprocesses send trap datagrams here so the main process
    # can broadcast real-time WS push events without shared memory.
    WS_INTERNAL_PORT = int(os.getenv("WS_INTERNAL_PORT", "19876"))

    # Remote MIB fetch (manual by default; upload/reload can opt into auto-fetch)
    DEFAULT_MIB_REMOTE_SOURCES = [
        "https://mibs.pysnmp.com/asn1/@mib@",
        "https://mibbrowser.online/mibs/@mib@.mib",
    ]
    MIB_AUTO_FETCH = os.getenv("MIB_AUTO_FETCH", "false").lower() == "true"
    MIB_REMOTE_SOURCES = (
        _parse_remote_mib_sources(os.getenv("MIB_REMOTE_SOURCES"))
        or DEFAULT_MIB_REMOTE_SOURCES.copy()
    )

    def __init__(self):
        self.DATA_DIR.mkdir(exist_ok=True)
        self.MIB_DIR.mkdir(exist_ok=True)
        self.CONFIG_DIR.mkdir(exist_ok=True)
        self.LOG_DIR.mkdir(exist_ok=True)

        if not self.CUSTOM_DATA_FILE.exists():
            self.CUSTOM_DATA_FILE.write_text('{}')

        if not self.SECRETS_FILE.exists():
            self.SECRETS_FILE.write_text(json.dumps(
                {"username": "admin", "password": "admin123"}, indent=2
            ))

        if not self.TRAPS_FILE.exists():
            self.TRAPS_FILE.touch()

        self._copy_bundled_mibs()

        self._apply_app_settings()

    def _copy_bundled_mibs(self):
        """Copy bundled starter MIBs to data/mibs/ on first run.

        Rules:
        - Only copies if destination file does NOT already exist (copy-if-absent).
        - Accepts .txt, .mib, .my extensions.
        - Silently skips on any error to never block startup.
        """
        if not self.BUNDLED_MIBS_DIR.exists():
            return
        try:
            for mib_file in sorted(self.BUNDLED_MIBS_DIR.iterdir()):
                if mib_file.is_file() and mib_file.suffix in ('.txt', '.mib', '.my'):
                    dest = self.MIB_DIR / mib_file.name
                    if not dest.exists():
                        shutil.copy2(mib_file, dest)
        except Exception:
            pass  # Never block startup due to MIB copy failure

    def _apply_app_settings(self):
        """Apply persisted app_settings.json on top of env defaults at startup."""
        if not self.APP_SETTINGS_FILE.exists():
            return
        try:
            data = json.loads(self.APP_SETTINGS_FILE.read_text())
            if "session_timeout" in data:
                self.SESSION_TIMEOUT = int(data["session_timeout"])
            if "auto_start_simulator" in data:
                self.AUTO_START_SIMULATOR = bool(data["auto_start_simulator"])
            if "auto_start_trap_receiver" in data:
                self.AUTO_START_TRAP_RECEIVER = bool(data["auto_start_trap_receiver"])
            if "mib_auto_fetch" in data:
                self.MIB_AUTO_FETCH = bool(data["mib_auto_fetch"])
            if "mib_remote_sources" in data and isinstance(data["mib_remote_sources"], list):
                sources = [str(source).strip() for source in data["mib_remote_sources"] if str(source).strip()]
                if sources:
                    self.MIB_REMOTE_SOURCES = sources
        except Exception:
            pass  # Corrupt file — silently fall back to env defaults


settings = Settings()


class AppMeta:
    NAME        = settings.APP_NAME
    VERSION     = settings.APP_VERSION
    AUTHOR      = settings.APP_AUTHOR
    DESCRIPTION = settings.APP_DESCRIPTION


meta = AppMeta()
