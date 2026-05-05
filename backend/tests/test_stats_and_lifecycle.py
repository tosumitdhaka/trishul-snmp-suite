from multiprocessing import Process

import pytest
from fastapi import HTTPException


def _worker_bump(stats_file: str, loops: int) -> None:
    import sys
    from pathlib import Path

    backend_root = Path(__file__).resolve().parents[1]
    if str(backend_root) not in sys.path:
        sys.path.insert(0, str(backend_root))

    from core.stats_store import worker_increment

    for _ in range(loops):
        worker_increment(stats_file, "traps", "traps_received_total", 1)


def test_stats_store_handles_concurrent_api_and_worker_writes(isolated_settings):
    from core import stats_store

    loops = 200
    process = Process(target=_worker_bump, args=(str(isolated_settings.STATS_FILE), loops))
    process.start()

    for _ in range(loops):
        stats_store.increment("traps", "traps_received_total", 1)

    process.join(timeout=10)
    assert process.exitcode == 0

    stats = stats_store.load()
    assert stats["traps"]["traps_received_total"] == loops * 2


@pytest.mark.asyncio
async def test_simulator_start_failure_returns_500(monkeypatch):
    from api.routers.simulator import SimConfig, start_simulator
    from services.sim_manager import SimulatorManager

    monkeypatch.setattr(
        SimulatorManager,
        "status",
        classmethod(lambda cls: {"running": False, "pid": None, "port": None, "community": None}),
    )
    monkeypatch.setattr(
        SimulatorManager,
        "start",
        classmethod(lambda cls, port=None, community=None: {"status": "failed", "error": "bind: address already in use"}),
    )

    with pytest.raises(HTTPException) as exc:
        await start_simulator(SimConfig(port=1061, community="public"))
    assert exc.value.status_code == 500
    assert "address already in use" in exc.value.detail


def test_trap_receiver_start_failure_returns_500(monkeypatch):
    from api.routers.traps import TrapStartRequest, start_receiver
    from services.trap_manager import trap_manager

    monkeypatch.setattr(
        trap_manager,
        "start",
        lambda port, community, resolve_mibs: {"status": "failed", "error": "bind: address already in use"},
    )

    with pytest.raises(HTTPException) as exc:
        start_receiver(TrapStartRequest(port=1162, community="public", resolve_mibs=True))
    assert exc.value.status_code == 500
    assert "address already in use" in exc.value.detail


def test_simulator_activity_entry_summarizes_requests():
    from workers.snmp_simulator import build_activity_entry
    from pysnmp.proto.api import v2c

    request = [(v2c.ObjectIdentifier((1, 3, 6, 1, 2, 1, 1, 1, 0)), None)]
    response = [(v2c.ObjectIdentifier((1, 3, 6, 1, 2, 1, 1, 1, 0)), v2c.OctetString("demo"))]

    entry = build_activity_entry("GET", request, response)

    assert entry["level"] == "info"
    assert entry["request_type"] == "GET"
    assert "GET served 1 OID" in entry["message"]
    assert "1.3.6.1.2.1.1.1.0" in entry["message"]


def test_mock_controller_emits_simulator_activity_logs(isolated_settings):
    from workers import snmp_simulator
    from pysnmp.proto.api import v2c

    snmp_simulator.STATS_FILE = str(isolated_settings.STATS_FILE)
    emitted = []
    controller = snmp_simulator.MockController(
        {(1, 3, 6, 1, 2, 1, 1, 1, 0): v2c.OctetString("demo")},
        emit_activity=emitted.append,
    )

    controller.read_variables((v2c.ObjectIdentifier((1, 3, 6, 1, 2, 1, 1, 1, 0)), None))

    assert len(emitted) == 1
    assert emitted[0]["request_type"] == "GET"
    assert emitted[0]["oid_count"] == 1
    assert "1.3.6.1.2.1.1.1.0" in emitted[0]["message"]
