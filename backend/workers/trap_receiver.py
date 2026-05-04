"""
workers/trap_receiver.py
~~~~~~~~~~~~~~~~~~~~~~~~
SNMP trap receiver worker process.

Phase-9 addition: after writing each trap to the JSONL file,
send a compact UDP datagram to 127.0.0.1:WS_INTERNAL_PORT so the
main FastAPI process can broadcast a real-time {type:"trap"} push
to all connected WebSocket clients.

If the UDP send fails (e.g. main process not yet ready), it is
silently ignored -- the trap is always written to disk regardless.
"""

import argparse
import json
import logging
import os
import socket
import sys
import time
import asyncio
from datetime import datetime

from pysnmp.entity import engine, config
from pysnmp.entity.rfc3413 import ntfrcv
from pysnmp.carrier.asyncio.dgram import udp

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from core.config import settings
from core.stats_store import worker_increment
from core.process_startup import write_startup_status

STATS_FILE = str(settings.STATS_FILE)

logging.basicConfig(level=logging.INFO, format='%(message)s')
logger = logging.getLogger("trap_receiver")


class TrapReceiver:
    def __init__(self, port, community, mib_dir, output_file,
                 resolve_mibs=True, ws_port=19876, startup_status_file=None):
        self.port        = port
        self.community   = community
        self.mib_dir     = mib_dir
        self.output_file = output_file
        self.resolve_mibs = resolve_mibs
        self.ws_port     = ws_port          # UDP loopback port for WS push
        self.startup_status_file = startup_status_file

        # Reusable UDP socket for WS side-channel
        self._udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

        self.snmp_engine = engine.SnmpEngine()

        self.mib_service = None
        if self.resolve_mibs:
            try:
                from services.mib_service import get_mib_service
                self.mib_service = get_mib_service()
                logger.info("MIB resolution enabled")
            except Exception as e:
                logger.warning(f"Failed to load MIB service: {e}. Resolution disabled.")
                self.resolve_mibs = False

    def _resolve_oid(self, oid_str: str) -> dict:
        result = {"numeric": oid_str, "symbolic": oid_str, "resolved": False}
        if not self.resolve_mibs or not self.mib_service:
            return result
        try:
            symbolic = self.mib_service.resolve_oid(oid_str, mode="name")
            if symbolic != oid_str:
                result["symbolic"] = symbolic
                result["resolved"] = True
        except Exception as e:
            logger.debug(f"Resolution failed for {oid_str}: {e}")
        return result

    def _identify_trap_type(self, varbinds: list) -> str:
        for vb in varbinds:
            oid  = vb.get("oid", "")
            name = vb.get("name", "")
            if "1.3.6.1.6.3.1.1.4.1.0" in oid or "snmpTrapOID" in name:
                trap_oid = vb.get("value", "")
                if self.mib_service and trap_oid:
                    try:
                        trap_name = self.mib_service.resolve_oid(trap_oid, mode="name")
                        if "::" in trap_name:
                            return trap_name.split("::")[-1].split(".")[0]
                        return trap_name
                    except Exception as e:
                        logger.debug(f"Failed to resolve trap OID {trap_oid}: {e}")
                return trap_oid
        return "Unknown"

    def _send_ws_datagram(self, trap_record: dict) -> None:
        """
        Send a {type:"trap"} datagram to the main process UDP listener.
        Always fire-and-forget: trap is already on disk before this is called.
        """
        try:
            payload = json.dumps({
                "type": "trap",
                "trap": trap_record
            }).encode("utf-8")
            self._udp_sock.sendto(payload, ("127.0.0.1", self.ws_port))
        except Exception as e:
            logger.debug(f"[WS-UDP] send failed (non-fatal): {e}")

    def _callback(self, snmpEngine, stateReference, contextEngineId,
                  contextName, varBinds, cbCtx):
        transportDomain, transportAddress = \
            snmpEngine.message_dispatcher.get_transport_info(stateReference)

        trap_record = {
            "timestamp": time.time(),
            "time_str":  datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "source":    f"{transportAddress[0]}:{transportAddress[1]}",
            "varbinds":  [],
            "trap_type": None,
            "resolved":  self.resolve_mibs
        }

        for name, val in varBinds:
            numeric_oid = name.prettyPrint()
            oid_info    = self._resolve_oid(numeric_oid)
            trap_record["varbinds"].append({
                "oid":      numeric_oid,
                "name":     oid_info["symbolic"],
                "value":    val.prettyPrint(),
                "resolved": oid_info["resolved"]
            })

        trap_record["trap_type"] = self._identify_trap_type(trap_record["varbinds"])

        try:
            with open(self.output_file, "a") as f:
                f.write(json.dumps(trap_record) + "\n")
                f.flush()
            logger.info(f"\u2713 Trap received: {trap_record['trap_type']} from {trap_record['source']}")
        except Exception as e:
            logger.error(f"Write error: {e}")
            return   # don't send WS datagram if disk write failed

        # Persist cumulative stats
        worker_increment(STATS_FILE, "traps", "traps_received_total", 1)

        # Phase-9: notify main process via UDP loopback
        self._send_ws_datagram(trap_record)

    async def run(self):
        config.add_transport(
            self.snmp_engine,
            udp.DOMAIN_NAME + (1,),
            udp.UdpTransport().open_server_mode(('0.0.0.0', self.port))
        )
        config.add_v1_system(self.snmp_engine, 'my-area', self.community)
        ntfrcv.NotificationReceiver(self.snmp_engine, self._callback)
        logger.info(f"\U0001f3a7 Trap Receiver listening on UDP {self.port} "
                    f"(MIB resolution: {'ON' if self.resolve_mibs else 'OFF'}) "
                    f"WS-UDP port: {self.ws_port}")
        write_startup_status(
            self.startup_status_file,
            "ready",
            f"Trap receiver listening on UDP {self.port}.",
            port=self.port,
            resolve_mibs=self.resolve_mibs,
        )
        while True:
            await asyncio.sleep(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port",         type=int, default=1162)
    parser.add_argument("--community",    type=str, default="public")
    parser.add_argument("--mib-path",     type=str, required=True)
    parser.add_argument("--output",       type=str, required=True)
    parser.add_argument("--resolve-mibs", type=str, default="true",
                        choices=["true", "false"])
    parser.add_argument("--ws-port",      type=int, default=19876,
                        help="UDP loopback port for WebSocket push side-channel")
    parser.add_argument("--startup-status-file", type=str, default=None)
    args = parser.parse_args()

    resolve = args.resolve_mibs.lower() == "true"
    os.makedirs(os.path.dirname(args.output), exist_ok=True)

    receiver = TrapReceiver(
        args.port, args.community, args.mib_path, args.output,
        resolve_mibs=resolve,
        ws_port=args.ws_port,
        startup_status_file=args.startup_status_file,
    )
    try:
        asyncio.run(receiver.run())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        write_startup_status(args.startup_status_file, "error", str(e), port=args.port)
        raise
