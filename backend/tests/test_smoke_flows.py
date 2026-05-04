import json
from io import BytesIO

import pytest
from starlette.datastructures import UploadFile


SMOKE_MIB = """SMOKE-MIB DEFINITIONS ::= BEGIN
IMPORTS
    enterprises FROM SNMPv2-SMI;

smoke OBJECT IDENTIFIER ::= { enterprises 99997 }

END
"""


def _upload(filename: str, content: str) -> UploadFile:
    return UploadFile(filename=filename, file=BytesIO(content.encode()))


@pytest.mark.asyncio
async def test_core_smoke_login_simulator_traps_walk_and_mibs(isolated_settings, monkeypatch):
    from api.routers import mibs as mibs_router
    from api.routers import settings as settings_router
    from api.routers import simulator as simulator_router
    from api.routers import traps as traps_router
    from api.routers import walker as walker_router
    from services.sim_manager import SimulatorManager
    from services.walk_engine import WalkEngine

    sim_state = {"running": False, "pid": None, "port": None, "community": None}

    def _status(cls):
        return {
            "running": sim_state["running"],
            "pid": sim_state["pid"],
            "port": sim_state["port"],
            "community": sim_state["community"],
        }

    def _start(cls, port=None, community=None):
        sim_state.update(
            {
                "running": True,
                "pid": 4242,
                "port": port or 1061,
                "community": community or "public",
            }
        )
        return {"status": "started", "pid": 4242, "port": sim_state["port"], "community": sim_state["community"]}

    def _stop(cls):
        sim_state.update({"running": False, "pid": None})
        return {"status": "stopped"}

    async def _send_notification(*args, **kwargs):
        return (None, None, None, [])

    async def _create_target(*args, **kwargs):
        return object()

    monkeypatch.setattr(SimulatorManager, "status", classmethod(_status))
    monkeypatch.setattr(SimulatorManager, "start", classmethod(_start))
    monkeypatch.setattr(SimulatorManager, "stop", classmethod(_stop))
    monkeypatch.setattr("api.routers.traps.send_notification", _send_notification)
    monkeypatch.setattr("api.routers.traps.UdpTransportTarget.create", _create_target)
    monkeypatch.setattr(
        WalkEngine,
        "run_snmpwalk",
        staticmethod(lambda *args, **kwargs: ["IF-MIB::ifInOctets.1 = Counter32: 42"]),
    )

    login_payload = settings_router.login(
        settings_router.LoginRequest(username="admin", password="admin123")
    )
    assert "token" in login_payload

    start_response = await simulator_router.start_simulator(
        simulator_router.SimConfig(port=1061, community="public")
    )
    assert start_response["status"] == "started"

    stop_response = await simulator_router.stop_simulator()
    assert stop_response["status"] == "stopped"

    trap_send = await traps_router.send_trap(
        traps_router.TrapSendRequest(
            target="127.0.0.1",
            port=1162,
            community="public",
            oid="1.3.6.1.6.3.1.1.5.3",
            varbinds=[traps_router.TrapVarbind(oid="1.3.6.1.2.1.1.3.0", type="TimeTicks", value="123")],
        )
    )
    assert trap_send["status"] == "sent"

    sample_trap = {
        "timestamp": 12345.0,
        "time_str": "2026-05-04 00:00:00",
        "source": "127.0.0.1:1162",
        "trap_type": "linkDown",
        "varbinds": [{"oid": "1.3.6.1.2.1.1.3.0", "name": "sysUpTime.0", "value": "123", "resolved": True}],
        "resolved": True,
    }
    with open(isolated_settings.TRAPS_FILE, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(sample_trap) + "\n")

    trap_receive = traps_router.get_received_traps()
    assert trap_receive["data"][0]["trap_type"] == "linkDown"

    walk_response = walker_router.execute_walk(
        walker_router.WalkRequest(
            target="127.0.0.1",
            port=1061,
            community="public",
            oid="IF-MIB::ifTable",
            parse=True,
            use_mibs=True,
        )
    )
    assert walk_response["count"] == 1

    upload_response = await mibs_router.upload_mibs(files=[_upload("SMOKE-MIB.mib", SMOKE_MIB)])
    assert len(upload_response["results"]) == 1

    reload_response = await mibs_router.reload_mibs()
    assert reload_response["status"] == "reloaded"
