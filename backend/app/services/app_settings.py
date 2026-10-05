from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import urlparse

from app.core.config import Settings, get_settings
from app.db.session import create_session_factory
from app.models import AppSetting

_REMOTE_SOURCE_PLACEHOLDER = "@mib@"

# Simple per-database resolved-values cache (SET-05). Settings change rarely
# but are read on every authenticated request, so cache the resolved values
# and invalidate the entry whenever update_settings persists a change.
_SETTINGS_READ_CACHE: dict[str, dict[str, Any]] = {}


def reset_settings_read_cache() -> None:
    """Drop every cached settings snapshot (used by tests and restart flows)."""
    _SETTINGS_READ_CACHE.clear()


def validate_remote_sources(entries: list[str]) -> tuple[list[str], str | None]:
    """Validate approved remote MIB source URL templates.

    Each entry must be a non-empty HTTP(S) URL template containing the
    ``@mib@`` placeholder, matching how tsmi's HttpReader consumes them.
    Blank lines are dropped. Returns ``(normalized_entries, None)`` on success
    or ``([], error_message)`` for the first invalid entry.
    """
    normalized: list[str] = []
    for entry in entries:
        value = str(entry).strip()
        if not value:
            continue
        if _REMOTE_SOURCE_PLACEHOLDER not in value:
            return [], (
                f"Remote source '{value}' must include the '@mib@' placeholder."
            )
        parsed = urlparse(value)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return [], f"Remote source '{value}' must be an http(s) URL."
        normalized.append(value)
    return normalized, None


class AppSettingsServiceError(RuntimeError):
    """Raised when application settings operations fail."""


class AppSettingsService:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.session_factory = create_session_factory(self.settings.database_url)
        self._definitions = {
            "session_timeout_seconds": {
                "label": "Session timeout",
                "description": "Expire authenticated shell sessions after inactivity.",
                "category": "auth",
                "type": "integer",
                "default": self.settings.session_timeout,
                "min": 60,
                "max": 86400,
                "step": 1,
            },
            "overview_refresh_interval_seconds": {
                "label": "Overview refresh interval",
                "description": "Poll the Overview dashboard for runtime and history changes.",
                "category": "overview",
                "type": "integer",
                "default": 5,
                "min": 2,
                "max": 300,
                "step": 1,
            },
            "overview_event_limit": {
                "label": "Overview recent event limit",
                "description": "Number of recent notification events rendered on the Overview dashboard.",
                "category": "overview",
                "type": "integer",
                "default": 8,
                "min": 1,
                "max": 25,
                "step": 1,
            },
            "diagnostics_item_limit": {
                "label": "Diagnostics item limit",
                "description": "Maximum recent events, compile runs, and log files shown in System diagnostics.",
                "category": "diagnostics",
                "type": "integer",
                "default": 5,
                "min": 1,
                "max": 20,
                "step": 1,
            },
        }

    def list_settings(self) -> dict[str, Any]:
        with self.session_factory() as session:
            values = self._resolved_values(session)
            return {
                "items": [self._item_payload(key, values[key]) for key in self._definitions],
                "values": values,
            }

    def get_values(self) -> dict[str, Any]:
        return self.list_settings()["values"]

    def get_int(self, key: str) -> int:
        with self.session_factory() as session:
            values = self._resolved_values(session)
            if key not in values:
                raise AppSettingsServiceError(f"Unknown application setting: {key}")
            return int(values[key])

    def update_settings(self, updates: Mapping[str, Any]) -> dict[str, Any]:
        if not updates:
            return self.list_settings()

        with self.session_factory() as session:
            for key, raw_value in updates.items():
                if key not in self._definitions:
                    raise AppSettingsServiceError(f"Unknown application setting: {key}")
                normalized_value = self._normalize_value(key, raw_value)
                row = session.get(AppSetting, key)
                if row is None:
                    row = AppSetting(key=key, value_json=normalized_value)
                    session.add(row)
                else:
                    row.value_json = normalized_value
            session.commit()
            _SETTINGS_READ_CACHE.pop(self.settings.database_url, None)
            values = self._resolved_values(session)
            return {
                "items": [self._item_payload(key, values[key]) for key in self._definitions],
                "values": values,
            }

    def _resolved_values(self, session) -> dict[str, Any]:
        cache_key = self.settings.database_url
        cached = _SETTINGS_READ_CACHE.get(cache_key)
        if cached is not None:
            return dict(cached)
        values: dict[str, Any] = {}
        for key, definition in self._definitions.items():
            row = session.get(AppSetting, key)
            if row is None or row.value_json is None:
                values[key] = definition["default"]
                continue
            try:
                values[key] = self._normalize_value(key, row.value_json)
            except AppSettingsServiceError:
                values[key] = definition["default"]
        _SETTINGS_READ_CACHE[cache_key] = dict(values)
        return values

    def _item_payload(self, key: str, value: Any) -> dict[str, Any]:
        definition = self._definitions[key]
        return {
            "key": key,
            "label": definition["label"],
            "description": definition["description"],
            "category": definition["category"],
            "type": definition["type"],
            "default": definition["default"],
            "value": value,
            "constraints": {
                "min": definition["min"],
                "max": definition["max"],
                "step": definition["step"],
            },
        }

    def _normalize_value(self, key: str, value: Any) -> int:
        definition = self._definitions[key]
        if definition["type"] != "integer":
            raise AppSettingsServiceError(f"Unsupported application setting type for {key}.")

        if not isinstance(value, int) or isinstance(value, bool):
            raise AppSettingsServiceError(f"{key} must be an integer.")
        minimum = int(definition["min"])
        maximum = int(definition["max"])
        if value < minimum or value > maximum:
            raise AppSettingsServiceError(f"{key} must be between {minimum} and {maximum}.")
        return value
