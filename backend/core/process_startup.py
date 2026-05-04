import json
import os
import tempfile
import time
from pathlib import Path
from typing import Optional

from core.config import settings


def create_startup_status_path(prefix: str) -> Path:
    os.makedirs(settings.CONFIG_DIR, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(
        dir=settings.CONFIG_DIR,
        prefix=f"{prefix}_startup_",
        suffix=".json",
    )
    os.close(fd)
    path = Path(temp_path)
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    return path


def write_startup_status(path: Optional[str], status: str, message: str, **extra) -> None:
    if not path:
        return
    payload = {"status": status, "message": message, **extra}
    status_path = Path(path)
    os.makedirs(status_path.parent, exist_ok=True)
    status_path.write_text(json.dumps(payload))


def read_startup_status(path: Optional[Path]) -> Optional[dict]:
    if not path or not path.exists() or path.stat().st_size == 0:
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def wait_for_startup_status(process, status_path: Path, timeout_seconds: float = 3.0) -> dict:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        payload = read_startup_status(status_path)
        if payload:
            return payload
        exit_code = process.poll()
        if exit_code is not None:
            return {
                "status": "error",
                "message": f"Process exited before reporting ready state (exit code {exit_code}).",
                "exit_code": exit_code,
            }
        time.sleep(0.05)
    return {"status": "error", "message": "Timed out waiting for worker startup readiness."}


def cleanup_startup_status_path(path: Optional[Path]) -> None:
    if not path:
        return
    try:
        Path(path).unlink()
    except FileNotFoundError:
        pass
