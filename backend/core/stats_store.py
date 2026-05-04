"""
core/stats_store.py
~~~~~~~~~~~~~~~~~~~
Lightweight, file-backed stats store shared by all backend modules.

All modules (simulator, traps, walker, mibs) write events here via
increment(), set_field(), or update_module(). The /api/stats router
reads from here to serve dashboard-facing stats.

File location: data/configs/stats.json  (volume-mounted, persists across restarts)

Thread safety:
  - API process: _lock (threading.Lock) guards all reads + writes.
  - Worker subprocesses (snmp_simulator, trap_receiver): they write directly
    to the JSON file using atomic rename (tempfile + os.replace) via
    worker_increment() / worker_set_field() to avoid partial-write corruption.
  - Cross-process safety relies on os.replace() being atomic on POSIX.
"""

import json
import os
import tempfile
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
from threading import Lock
from typing import Any
from core.config import settings

try:
    import fcntl
except ImportError:  # pragma: no cover - Linux containers are the supported runtime
    fcntl = None

_lock = Lock()

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
# All keys that every module tracks. New keys added here will automatically
# appear in existing stats.json files on the next load() (merge-with-defaults).
#
# NOT included (runtime-enriched only, never persisted):
#   mibs: loaded_mibs, failed_mibs, total_mibs  <- from mib_service.get_status()
#   simulator: running, pid, port, community     <- from SimulatorManager.status()
#   traps: running, pid                          <- from trap_manager.get_status()
# ---------------------------------------------------------------------------

DEFAULT_STATS: dict = {
    "simulator": {
        "start_count": 0,
        "stop_count": 0,
        "restart_count": 0,
        "oids_loaded": 0,            # OID instances generated on last start
        "total_oids_simulated": 0,   # cumulative OIDs served (GET + GETNEXT)
        "snmp_requests_served": 0,   # cumulative SNMP requests handled
        "simulator_run_seconds": 0,  # cumulative seconds simulator was running
        "last_request_at": None,     # ISO timestamp of last SNMP request handled
    },
    "traps": {
        "receiver_start_count": 0,
        "receiver_stop_count": 0,
        "traps_received_total": 0,   # cumulative traps received (worker)
        "traps_sent_total": 0,       # cumulative traps sent via POST /traps/send
        "traps_cleared_count": 0,
        "receiver_run_seconds": 0,   # cumulative seconds receiver was running
    },
    "walker": {
        "walks_executed": 0,
        "walks_failed": 0,
        "oids_returned": 0,          # OID count from last successful walk
    },
    "mibs": {
        "reload_count": 0,
        "upload_count": 0,           # cumulative files uploaded
        "delete_count": 0,
    },
}

VALID_MODULES = set(DEFAULT_STATS.keys())


# ---------------------------------------------------------------------------
# Internal helpers  (call only while _lock is held)
# ---------------------------------------------------------------------------

def _load_from_path_unsafe(stats_path: Path) -> dict:
    """Load stats.json and merge with DEFAULT_STATS. No lock acquired."""
    if not stats_path.exists():
        return deepcopy(DEFAULT_STATS)
    try:
        with open(stats_path, "r") as f:
            on_disk = json.load(f)
        merged = deepcopy(DEFAULT_STATS)
        for module, values in on_disk.items():
            if module in merged and isinstance(values, dict):
                merged[module].update(values)
        return merged
    except Exception:
        return deepcopy(DEFAULT_STATS)


def _save_to_path_unsafe(stats_path: Path, stats: dict) -> None:
    """Write stats atomically via tempfile + os.replace. No lock acquired."""
    os.makedirs(stats_path.parent, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        dir=stats_path.parent, prefix="stats_", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(stats, f, indent=2, default=str)
        os.replace(tmp_path, stats_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


@contextmanager
def _stats_file_lock(stats_path: Path):
    """
    Cross-process lock for stats.json mutations.

    API routes and worker subprocesses both acquire the same lock file before
    a read-modify-write cycle so increments cannot silently overwrite each other.
    """
    lock_path = stats_path.parent / f".{stats_path.name}.lock"
    os.makedirs(lock_path.parent, exist_ok=True)
    with open(lock_path, "a+", encoding="utf-8") as lock_handle:
        if fcntl is not None:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)


# ---------------------------------------------------------------------------
# Public API  (routers + services inside the API process)
# ---------------------------------------------------------------------------

def load() -> dict:
    """Return a full copy of current stats merged with defaults."""
    with _lock:
        with _stats_file_lock(settings.STATS_FILE):
            return _load_from_path_unsafe(settings.STATS_FILE)


def save(stats: dict) -> None:
    """Overwrite entire stats file. Prefer update_module() for partial updates."""
    with _lock:
        with _stats_file_lock(settings.STATS_FILE):
            _save_to_path_unsafe(settings.STATS_FILE, stats)


def increment(module: str, key: str, by: int = 1) -> None:
    """Atomically increment a single integer counter."""
    with _lock:
        with _stats_file_lock(settings.STATS_FILE):
            stats = _load_from_path_unsafe(settings.STATS_FILE)
            stats.setdefault(module, {})
            stats[module][key] = stats[module].get(key, 0) + by
            _save_to_path_unsafe(settings.STATS_FILE, stats)


def set_field(module: str, key: str, value: Any) -> None:
    """Atomically set a single field."""
    with _lock:
        with _stats_file_lock(settings.STATS_FILE):
            stats = _load_from_path_unsafe(settings.STATS_FILE)
            stats.setdefault(module, {})
            stats[module][key] = value
            _save_to_path_unsafe(settings.STATS_FILE, stats)


def update_module(module: str, updates: dict) -> None:
    """
    Atomically apply multiple field updates for one module in a single
    read-modify-write cycle. Preferred when updating counter + runtime
    value together (e.g. stop_count + simulator_run_seconds).
    """
    with _lock:
        with _stats_file_lock(settings.STATS_FILE):
            stats = _load_from_path_unsafe(settings.STATS_FILE)
            stats.setdefault(module, {})
            stats[module].update(updates)
            _save_to_path_unsafe(settings.STATS_FILE, stats)


def reset() -> None:
    """Reset all stats to zero defaults."""
    with _lock:
        with _stats_file_lock(settings.STATS_FILE):
            _save_to_path_unsafe(settings.STATS_FILE, deepcopy(DEFAULT_STATS))


# ---------------------------------------------------------------------------
# Worker-safe helpers  (subprocess workers: snmp_simulator, trap_receiver)
# ---------------------------------------------------------------------------
# Workers run as separate processes and cannot share the in-process _lock.
# They use the same atomic-rename pattern. Cross-process safety relies on
# os.replace() being atomic on POSIX (Linux/macOS).

def _worker_load(stats_file: str) -> dict:
    """Load stats from file in worker context. Returns DEFAULT_STATS copy on any error."""
    return _load_from_path_unsafe(Path(stats_file))


def _worker_save(stats_file: str, stats: dict) -> None:
    """Atomically write stats in worker context."""
    _save_to_path_unsafe(Path(stats_file), stats)


def worker_increment(stats_file: str, module: str, key: str, by: int = 1) -> None:
    """Increment a counter from a worker subprocess."""
    try:
        path = Path(stats_file)
        with _stats_file_lock(path):
            stats = _worker_load(stats_file)
            stats.setdefault(module, {})
            stats[module][key] = stats[module].get(key, 0) + by
            _worker_save(stats_file, stats)
    except Exception:
        pass  # never crash a worker over stats


def worker_set_field(stats_file: str, module: str, key: str, value: Any) -> None:
    """Set a single field from a worker subprocess."""
    try:
        path = Path(stats_file)
        with _stats_file_lock(path):
            stats = _worker_load(stats_file)
            stats.setdefault(module, {})
            stats[module][key] = value
            _worker_save(stats_file, stats)
    except Exception:
        pass


def worker_update_module(stats_file: str, module: str, updates: dict) -> None:
    """Atomically apply multiple field updates from a worker subprocess."""
    try:
        path = Path(stats_file)
        with _stats_file_lock(path):
            stats = _worker_load(stats_file)
            stats.setdefault(module, {})
            stats[module].update(updates)
            _worker_save(stats_file, stats)
    except Exception:
        pass


def worker_update_stats(
    stats_file: str,
    module: str,
    increments: dict = None,
    sets: dict = None,
) -> None:
    """
    Increment counters and/or set fields in a single atomic read-modify-write.
    Worker-safe.  Use this instead of multiple worker_increment() calls to
    reduce file I/O and keep all related fields consistent.

    Args:
        increments: dict of {key: delta} -- added to existing values
        sets:       dict of {key: value} -- written as absolute values
    """
    try:
        path = Path(stats_file)
        with _stats_file_lock(path):
            stats = _worker_load(stats_file)
            stats.setdefault(module, {})
            if increments:
                for k, v in increments.items():
                    stats[module][k] = stats[module].get(k, 0) + v
            if sets:
                stats[module].update(sets)
            _worker_save(stats_file, stats)
    except Exception:
        pass  # never crash a worker over stats
