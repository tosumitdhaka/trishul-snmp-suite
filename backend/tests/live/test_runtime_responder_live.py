from __future__ import annotations

import asyncio
import os
import socket

import pytest

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        os.getenv("TRISHUL_ENABLE_LIVE_SNMP_RUNTIME") != "1",
        reason="set TRISHUL_ENABLE_LIVE_SNMP_RUNTIME=1 to run live UDP runtime tests",
    ),
]


def _activate_runtime_bundle(isolated_db):
    from app.services.bundles import BundleCompileRequest, BundleService

    service = BundleService(isolated_db["settings"])
    result = service.compile_bundle(
        BundleCompileRequest(
            mib_names=["SNMPv2-MIB", "IF-MIB"],
            activate=True,
        )
    )
    return result["activation"]["bundle"]


def _pick_free_udp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def test_live_runtime_responder_and_manager_flow(isolated_db):
    from app.services.runtime import RuntimeService

    active_bundle = _activate_runtime_bundle(isolated_db)
    responder_port = _pick_free_udp_port()

    async def scenario():
        service = RuntimeService(isolated_db["settings"])
        try:
            started = await service.start_responder(
                host="127.0.0.1",
                port=responder_port,
                communities=["public"],
                objects=[
                    {
                        "target": "SNMPv2-MIB::sysDescr.0",
                        "value": {"type": "octet-string", "value": "Trishul live responder"},
                    },
                    {
                        "target": "SNMPv2-MIB::sysName.0",
                        "value": {"type": "octet-string", "value": "lab-agent"},
                    },
                    {
                        "target": "IF-MIB::ifIndex.1",
                        "value": {"type": "integer", "value": 1},
                    },
                    {
                        "target": "IF-MIB::ifDescr.1",
                        "value": {"type": "octet-string", "value": "eth0"},
                    },
                    {
                        "target": "IF-MIB::ifAdminStatus.1",
                        "value": {"type": "integer", "value": 1},
                    },
                    {
                        "target": "IF-MIB::ifOperStatus.1",
                        "value": {"type": "integer", "value": 1},
                    },
                    {
                        "target": "IF-MIB::ifIndex.2",
                        "value": {"type": "integer", "value": 2},
                    },
                    {
                        "target": "IF-MIB::ifDescr.2",
                        "value": {"type": "octet-string", "value": "eth1"},
                    },
                    {
                        "target": "IF-MIB::ifAdminStatus.2",
                        "value": {"type": "integer", "value": 1},
                    },
                    {
                        "target": "IF-MIB::ifOperStatus.2",
                        "value": {"type": "integer", "value": 1},
                    },
                ],
            )
            assert started["active_bundle"]["id"] == active_bundle["id"]
            assert started["responder"]["running"] is True

            get_result = await service.manager_get(
                host="127.0.0.1",
                port=responder_port,
                community="public",
                targets=["SNMPv2-MIB::sysName.0"],
            )
            assert get_result["response"]["error_status"] == "no_error"
            assert get_result["response"]["varbinds"][0]["value"]["value"] == "lab-agent"

            get_next_result = await service.manager_get_next(
                host="127.0.0.1",
                port=responder_port,
                community="public",
                targets=["IF-MIB::ifIndex"],
            )
            assert get_next_result["response"]["varbinds"][0]["symbolic"] == "IF-MIB::ifIndex.1"
            assert get_next_result["response"]["varbinds"][0]["value"]["value"] == 1

            get_bulk_result = await service.manager_get_bulk(
                host="127.0.0.1",
                port=responder_port,
                community="public",
                targets=["IF-MIB::ifIndex"],
                non_repeaters=0,
                max_repetitions=4,
            )
            assert get_bulk_result["response"]["error_status"] == "no_error"
            assert len(get_bulk_result["response"]["varbinds"]) >= 2
            assert get_bulk_result["response"]["varbinds"][0]["symbolic"] == "IF-MIB::ifIndex.1"

            walk_result = await service.manager_walk(
                host="127.0.0.1",
                port=responder_port,
                community="public",
                root="IF-MIB::ifDescr",
                bulk=False,
            )
            assert walk_result["operation"] == "walk"
            assert [item["symbolic"] for item in walk_result["varbinds"]] == [
                "IF-MIB::ifDescr.1",
                "IF-MIB::ifDescr.2",
            ]
        finally:
            await service.shutdown()

    asyncio.run(scenario())


def test_live_simulator_empty_defaults_custom_updates_and_restart(
    isolated_db, zero_length_simulator_bundle
):
    from app.services import simulator_service
    from app.services.runtime import RuntimeService
    from app.services.state_store import get_state_store

    settings = isolated_db["settings"]
    port = _pick_free_udp_port()

    async def scenario():
        runtime = RuntimeService(settings)
        state = get_state_store()

        async def read(target):
            result = await runtime.manager_get(
                host="127.0.0.1", port=port, community="public", targets=[target]
            )
            assert result["response"]["error_status"] == "no_error"
            return result["response"]["varbinds"][0]["value"]

        try:
            started = await simulator_service.start(
                port=port, community="public", settings=settings,
                state=state, runtime_service=runtime,
            )
            assert started["status"] == "started"
            assert (await read("ZERO-LENGTH-MIB::bridgeAddress.0"))["hex"] == ""
            assert (await read("ZERO-LENGTH-MIB::statusBits.0"))["hex"] == ""

            payload = {
                "SNMPv2-MIB::sysName.0": "custom-agent",
                "ZERO-LENGTH-MIB::bridgeAddress.0": {
                    "type": "octet-string", "value": "001122334455", "encoding": "hex"
                },
            }
            saved = await simulator_service.save_custom_data(
                payload, settings=settings, runtime_service=runtime
            )
            assert saved["status"] == "saved"
            assert (await read("SNMPv2-MIB::sysName.0"))["value"] == "custom-agent"
            assert (await read("ZERO-LENGTH-MIB::bridgeAddress.0"))["hex"] == "001122334455"

            # Restore an empty encoded override and verify it survives restart.
            payload["ZERO-LENGTH-MIB::bridgeAddress.0"]["value"] = ""
            payload["ZERO-LENGTH-MIB::bridgeAddress.0"]["encoding"] = "base64"
            await simulator_service.save_custom_data(
                payload, settings=settings, runtime_service=runtime
            )
            assert (await read("ZERO-LENGTH-MIB::bridgeAddress.0"))["hex"] == ""
            assert simulator_service.get_custom_data(settings=settings) == payload
            restarted = await simulator_service.restart(
                settings=settings, state=state, runtime_service=runtime
            )
            assert restarted["status"] == "started"
            assert (await read("SNMPv2-MIB::sysName.0"))["value"] == "custom-agent"
            assert (await read("ZERO-LENGTH-MIB::bridgeAddress.0"))["hex"] == ""
        finally:
            await runtime.shutdown()

    asyncio.run(scenario())
