"""
services/trap_manager.py
~~~~~~~~~~~~~~~~~~~~~~~~
Manages the trap_receiver subprocess lifecycle.
WebSocket clients are notified on every lifecycle change.

Bug fixes applied:
  BUG-9  : get_status() uses self._port instead of hardcoded 1162
  BUG-10 : clear_traps() uses context manager (no file handle leak)
  Phase-9: broadcast status after start / stop
  Phase-10: get_status() now returns uptime_seconds computed from _start_time
"""

import asyncio
import os
import sys
import json
import logging
import subprocess
from datetime import datetime, timezone
from typing import Optional
from core.config import settings
from core import stats_store
from core.process_startup import (
    cleanup_startup_status_path,
    create_startup_status_path,
    wait_for_startup_status,
)

logger = logging.getLogger(__name__)


class TrapManager:
    def __init__(self):
        self.process: Optional[subprocess.Popen] = None
        self.log_file  = str(settings.TRAPS_FILE)
        self.mib_path  = str(settings.MIB_DIR)
        self.resolve_mibs = True
        self._port: int = settings.TRAP_PORT
        self._community: str = settings.COMMUNITY
        self._start_time: Optional[datetime] = None

        os.makedirs(os.path.dirname(self.log_file), exist_ok=True)

    # -----------------------------------------------------------------------
    # Internal helpers
    # -----------------------------------------------------------------------

    def _try_broadcast_status(self) -> None:
        """
        Fire-and-forget WS status broadcast.
        Safe to call from sync code: schedules a coroutine on the running
        event loop without blocking.
        """
        try:
            from core.ws_manager import manager
            from services.sim_manager import SimulatorManager
            payload = {
                "type":      "status",
                "simulator": SimulatorManager.status(),
                "traps":     self.get_status(),
            }
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.ensure_future(manager.broadcast(payload))
        except Exception as e:
            logger.debug(f"[WS] trap_manager broadcast failed: {e}")

    # -----------------------------------------------------------------------
    # Public API
    # -----------------------------------------------------------------------

    def start(self, port: int = None, community: str = None, resolve_mibs: bool = True):
        if self.process and self.process.poll() is None:
            return {"status": "already_running", "pid": self.process.pid}

        if port is not None:
            self._port = port
        if community is not None:
            self._community = community
        self.resolve_mibs = resolve_mibs

        cmd = [
            sys.executable, "workers/trap_receiver.py",
            "--port",          str(self._port),
            "--community",     self._community,
            "--mib-path",      self.mib_path,
            "--output",        self.log_file,
            "--resolve-mibs",  "true" if resolve_mibs else "false",
            "--ws-port",       str(settings.WS_INTERNAL_PORT),
        ]
        status_path = create_startup_status_path("trap_receiver")
        cmd.extend(["--startup-status-file", str(status_path)])

        process = subprocess.Popen(
            cmd,
            cwd=str(settings.BASE_DIR),
            stdout=sys.stdout,
            stderr=sys.stderr
        )
        startup = wait_for_startup_status(process, status_path)
        cleanup_startup_status_path(status_path)

        if startup.get("status") != "ready":
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
            logger.error(
                "Trap receiver failed to start on UDP %s: %s",
                self._port,
                startup.get("message", "Unknown startup error"),
            )
            return {
                "status": "failed",
                "port": self._port,
                "resolve_mibs": resolve_mibs,
                "error": startup.get("message", "Trap receiver failed to start."),
                "details": startup,
            }

        self.process = process

        self._start_time = datetime.now(timezone.utc)
        stats_store.increment("traps", "receiver_start_count")
        logger.info(f"Trap receiver started: pid={self.process.pid} port={self._port}")

        self._try_broadcast_status()
        return {"status": "started", "pid": self.process.pid, "port": self._port, "resolve_mibs": resolve_mibs}

    def stop(self):
        if self.process:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.process.kill()

            self.process = None

            elapsed = 0
            if self._start_time:
                elapsed = int((datetime.now(timezone.utc) - self._start_time).total_seconds())
                self._start_time = None

            s = stats_store.load()
            stats_store.update_module("traps", {
                "receiver_stop_count":  s["traps"]["receiver_stop_count"] + 1,
                "receiver_run_seconds": s["traps"]["receiver_run_seconds"] + elapsed,
            })

            self._try_broadcast_status()
            return {"status": "stopped"}
        return {"status": "not_running"}

    def get_status(self):
        running = self.process is not None and self.process.poll() is None
        uptime_seconds = None
        if running and self._start_time:
            uptime_seconds = int((datetime.now(timezone.utc) - self._start_time).total_seconds())
        return {
            "running":        running,
            "pid":            self.process.pid if running else None,
            "port":           self._port,
            "resolve_mibs":   self.resolve_mibs if running else None,
            "uptime_seconds": uptime_seconds,
        }

    def get_traps(self, limit: int = 50):
        data = []
        if not os.path.exists(self.log_file):
            return []
        try:
            with open(self.log_file, 'r') as f:
                lines = f.readlines()
            for line in reversed(lines[-limit:]):
                if line.strip():
                    try:
                        data.append(json.loads(line))
                    except Exception:
                        pass
        except Exception:
            pass
        return data

    def clear_traps(self):
        with open(self.log_file, 'w'):
            pass
        stats_store.increment("traps", "traps_cleared_count")


trap_manager = TrapManager()
