"""
services/sim_manager.py
~~~~~~~~~~~~~~~~~~~~~~~
Manages the snmp_simulator subprocess lifecycle.

Bug fixes:
  BUG-8  : restart() now passes saved _port/_community to start(),
            so it doesn't silently revert to defaults.
  BUG-12 : single consolidated restart() — stop then start with saved config.
"""

import subprocess
import sys
import os
import logging
from core.config import settings
from core.process_startup import (
    cleanup_startup_status_path,
    create_startup_status_path,
    wait_for_startup_status,
)

logger = logging.getLogger(__name__)


class SimulatorManager:
    _process = None
    _port: int = settings.SNMP_PORT
    _community: str = settings.COMMUNITY

    @classmethod
    def start(cls, port=None, community=None):
        if cls._process and cls._process.poll() is None:
            return {"status": "already_running", "pid": cls._process.pid}

        # BUG-8: only override saved values when caller explicitly provides them
        if port is not None:
            cls._port = port
        if community is not None:
            cls._community = community

        mib_dir   = str(settings.MIB_DIR)
        data_file = str(settings.CUSTOM_DATA_FILE)

        cmd = [
            sys.executable,
            os.path.join(str(settings.BASE_DIR), "workers", "snmp_simulator.py"),
            "--port",      str(cls._port),
            "--community", cls._community,
            "--mib-dir",   mib_dir,
            "--data-file", data_file,
        ]
        status_path = create_startup_status_path("simulator")
        cmd.extend(["--startup-status-file", str(status_path)])

        process = subprocess.Popen(cmd, stdout=sys.stdout, stderr=sys.stderr)
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
                "Simulator failed to start on UDP %s: %s",
                cls._port,
                startup.get("message", "Unknown startup error"),
            )
            return {
                "status": "failed",
                "port": cls._port,
                "community": cls._community,
                "error": startup.get("message", "Simulator failed to start."),
                "details": startup,
            }

        cls._process = process
        logger.info(f"Simulator started: pid={cls._process.pid} port={cls._port} community={cls._community}")
        return {
            "status":    "started",
            "pid":       cls._process.pid,
            "port":      cls._port,
            "community": cls._community,
        }

    @classmethod
    def stop(cls):
        if cls._process:
            if cls._process.poll() is None:
                cls._process.terminate()
                try:
                    cls._process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    cls._process.kill()
            cls._process = None
            return {"status": "stopped"}
        return {"status": "not_running"}

    @classmethod
    def restart(cls):
        """BUG-12: single restart path — stop then start with preserved config."""
        cls.stop()
        import time
        time.sleep(0.5)
        # start() reuses cls._port / cls._community — no args needed
        return cls.start()

    @classmethod
    def status(cls):
        running = cls._process is not None and cls._process.poll() is None
        return {
            "running":   running,
            "pid":       cls._process.pid if running else None,
            "port":      cls._port        if running else None,
            "community": cls._community   if running else None,
        }
