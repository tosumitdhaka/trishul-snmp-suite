from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path


def _env_flag(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _resolve_path(value: str | None, *, default: Path, base: Path) -> Path:
    if not value:
        return default
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = base / path
    return path.resolve()


def _resolve_log_destination(value: str | None, *, containerized: bool) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"", "auto"}:
        return "stdout" if containerized else "stdout+file"
    aliases = {
        "stdout": "stdout",
        "console": "stdout",
        "stderr": "stdout",
        "file": "file",
        "stdout+file": "stdout+file",
        "file+stdout": "stdout+file",
        "both": "stdout+file",
    }
    return aliases.get(normalized, "stdout" if containerized else "stdout+file")


class Settings:
    """Runtime settings for the application."""

    def __init__(self) -> None:
        backend_dir = Path(__file__).resolve().parents[2]
        repo_root = backend_dir.parent

        self.repo_root = repo_root
        self.backend_dir = backend_dir

        self.data_dir = _resolve_path(
            os.getenv("TRISHUL_DATA_DIR"),
            default=backend_dir / "data",
            base=repo_root,
        )
        self.config_dir = self.data_dir / "configs"
        self.log_dir = self.data_dir / "logs"
        self.secrets_file = self.config_dir / "secrets.json"
        self.bundles_dir = _resolve_path(
            os.getenv("TRISHUL_BUNDLES_DIR"),
            default=self.data_dir / "bundles",
            base=repo_root,
        )
        self.bundle_sets_dir = self.bundles_dir / "sets"
        self.bundle_pointer_file = self.bundles_dir / "active_bundle.json"
        self.tsmi_cache_dir = self.bundles_dir / "cache" / "tsmi"
        self.db_path = _resolve_path(
            os.getenv("TRISHUL_DB_PATH"),
            default=self.data_dir / "trishul_v2.sqlite3",
            base=repo_root,
        )
        self.frontend_dist_dir = _resolve_path(
            os.getenv("TRISHUL_FRONTEND_DIST"),
            default=repo_root / "frontend" / "dist",
            base=repo_root,
        )

        self.app_name = os.getenv("APP_NAME", "Trishul SNMP Suite")
        self.app_version = os.getenv("APP_VERSION", "2.1.0")
        self.app_author = os.getenv("APP_AUTHOR", "Sumit Dhaka")
        self.app_description = os.getenv(
            "APP_DESCRIPTION",
            "Bundle-first SNMP lab and operations shell",
        )
        self.session_timeout = int(os.getenv("SESSION_TIMEOUT", "3600"))
        self.log_level = os.getenv("LOG_LEVEL", "INFO")
        self.containerized = _env_flag(os.getenv("TRISHUL_CONTAINER")) or Path("/.dockerenv").exists()
        self.log_destination = _resolve_log_destination(
            os.getenv("LOG_DESTINATION"),
            containerized=self.containerized,
        )
        self.file_logging_enabled = self.log_destination in {"file", "stdout+file"}
        self.stdout_logging_enabled = self.log_destination in {"stdout", "stdout+file"}
        self.log_file = self.log_dir / "backend.log"
        self.bundled_mibs_dir = backend_dir / "mibs_bundled"

        self.database_url = os.getenv(
            "DATABASE_URL",
            f"sqlite:///{self.db_path.as_posix()}",
        )

    def _cleanup_stale_file_logs(self) -> None:
        if self.file_logging_enabled or not self.log_dir.exists():
            return

        stale_logs = [self.log_file, *sorted(self.log_dir.glob(f"{self.log_file.name}.*"))]
        for log_path in stale_logs:
            try:
                log_path.unlink()
            except FileNotFoundError:
                pass
            except IsADirectoryError:
                pass

        try:
            self.log_dir.rmdir()
        except OSError:
            pass

    def prepare_paths(self) -> None:
        paths = [
            self.data_dir,
            self.config_dir,
            self.bundles_dir,
            self.bundle_sets_dir,
            self.tsmi_cache_dir,
            self.db_path.parent,
        ]
        if self.file_logging_enabled:
            paths.append(self.log_dir)
        for path in paths:
            path.mkdir(parents=True, exist_ok=True)
        self._cleanup_stale_file_logs()


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.prepare_paths()
    return settings


def reset_settings_cache() -> None:
    get_settings.cache_clear()
