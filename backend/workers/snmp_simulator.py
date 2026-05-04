import sys
import os
import random
import json
import logging
import asyncio
import argparse
from datetime import datetime, timezone

# Add parent directory to path so app modules (core.config, stats_store) are importable
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pysnmp.entity import engine, config
from pysnmp.entity.rfc3413 import cmdrsp, context
from pysnmp.carrier.asyncio.dgram import udp
from pysnmp.smi import builder, compiler
from pysnmp.proto.api import v2c
from core.config import settings
from core.stats_store import worker_set_field, worker_update_stats
from core.process_startup import write_startup_status

logging.basicConfig(level=logging.INFO, format='%(message)s')
logger = logging.getLogger(__name__)

HIDE_DEPRECATED     = True
HIDE_NOT_ACCESSIBLE = True
SYSTEM_MIB_DIR      = "/usr/share/snmp/mibs"

# Single source of truth for stats file path — Option B: use settings
STATS_FILE = str(settings.STATS_FILE)


class MibDataGenerator:
    def get_value(self, syntax_obj, custom_val=None):
        # 1. Custom Value
        if custom_val is not None:
            try:
                type_name = syntax_obj.__class__.__name__
                if "Integer"  in type_name: return v2c.Integer32(int(custom_val))
                elif "Unsigned" in type_name: return v2c.Unsigned32(int(custom_val))
                elif "Gauge"    in type_name: return v2c.Gauge32(int(custom_val))
                elif "Counter64" in type_name: return v2c.Counter64(int(custom_val))
                elif "Counter"  in type_name: return v2c.Counter32(int(custom_val))
                elif "String"   in type_name: return v2c.OctetString(str(custom_val))
                elif "IpAddress" in type_name: return v2c.IpAddress(str(custom_val))
                elif any(x in type_name for x in ["Oid", "ObjectIdentifier", "AutonomousType"]):
                    return v2c.ObjectIdentifier(str(custom_val))
                if str(custom_val).isdigit(): return v2c.Integer32(int(custom_val))
            except Exception as e:
                logger.warning(f"Failed to apply custom value '{custom_val}': {e}")

        # 2. Random Fallback
        try:
            type_name = syntax_obj.__class__.__name__
            if any(x in type_name for x in ["Oid", "ObjectIdentifier", "AutonomousType"]):
                return v2c.ObjectIdentifier(f"1.3.6.1.2.1.{random.randint(1,100)}")
            elif "Integer"   in type_name: return v2c.Integer32(random.randint(1, 100))
            elif "Unsigned"  in type_name: return v2c.Unsigned32(random.randint(1, 10000))
            elif "Gauge"     in type_name: return v2c.Gauge32(random.randint(1, 100))
            elif "Counter64" in type_name: return v2c.Counter64(random.randint(1000000, 999999999))
            elif "Counter"   in type_name: return v2c.Counter32(random.randint(1000, 999999))
            elif "TimeTicks" in type_name: return v2c.TimeTicks(random.randint(0, 5000000))
            elif "IpAddress" in type_name: return v2c.IpAddress("127.0.0.1")
            elif "PhysAddress" in type_name or "MacAddress" in type_name:
                return v2c.OctetString(bytes([random.randint(0, 255) for _ in range(6)]))
            elif "String"    in type_name: return v2c.OctetString(f"Sim-{random.randint(1,99)}")
            else: return v2c.Integer32(0)
        except:
            return v2c.Integer32(0)


class MockController:
    def __init__(self, data_dict):
        self.db = data_dict
        self.sorted_oids = sorted(self.db.keys())

    def read_variables(self, *var_binds, **kwargs):
        """Handle SNMP GET requests."""
        logger.debug(f"RX GET: {var_binds}")
        n = len(var_binds)
        # Single atomic write: increment counters + set last_request_at timestamp
        worker_update_stats(STATS_FILE, "simulator",
            increments={"snmp_requests_served": 1, "total_oids_simulated": n},
            sets={"last_request_at": datetime.now(timezone.utc).isoformat()},
        )
        rsp = []
        for oid, val in var_binds:
            key = tuple(oid)
            rsp.append((
                v2c.ObjectIdentifier(oid),
                self.db[key] if key in self.db else v2c.NoSuchObject()
            ))
        return rsp

    def read_next_variables(self, *var_binds, **kwargs):
        """Handle SNMP GETNEXT/WALK requests."""
        logger.debug(f"RX WALK/NEXT: {var_binds}")
        n = len(var_binds)
        # Single atomic write: increment counters + set last_request_at timestamp
        worker_update_stats(STATS_FILE, "simulator",
            increments={"snmp_requests_served": 1, "total_oids_simulated": n},
            sets={"last_request_at": datetime.now(timezone.utc).isoformat()},
        )
        rsp = []
        for oid, val in var_binds:
            current_oid = tuple(oid)
            next_oid = None
            for db_oid in self.sorted_oids:
                if db_oid > current_oid:
                    next_oid = db_oid
                    break
            rsp.append((
                v2c.ObjectIdentifier(next_oid if next_oid else oid),
                self.db[next_oid] if next_oid else v2c.EndOfMibView()
            ))
        return rsp


def load_custom_data(path):
    if os.path.exists(path):
        try:
            with open(path, 'r') as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def compile_and_generate_data(mib_dir, custom_data_path):
    mibBuilder = builder.MibBuilder()

    sources = [
        f'file://{os.path.abspath(mib_dir)}',
        f'file://{SYSTEM_MIB_DIR}',
        f'file://{SYSTEM_MIB_DIR}/ietf',
        f'file://{SYSTEM_MIB_DIR}/iana',
    ]
    compiler.add_mib_compiler(mibBuilder, sources=sources)

    mibs_to_load = []
    if os.path.exists(mib_dir):
        for f in os.listdir(mib_dir):
            if f.endswith((".mib", ".my", ".txt")):
                mibs_to_load.append(f.split('.')[0])

    if not mibs_to_load:
        logger.warning(f"No MIBs found in {mib_dir}")
    else:
        loaded_count = 0
        for mib_name in mibs_to_load:
            try:
                mibBuilder.load_modules(mib_name)
                loaded_count += 1
                logger.info(f"\u2713 Loaded MIB: {mib_name}")
            except Exception as e:
                logger.warning(f"\u2717 Skipped MIB {mib_name}: {str(e)[:100]}")
        logger.info(f"Loaded {loaded_count}/{len(mibs_to_load)} MIBs")

    custom_data = load_custom_data(custom_data_path)
    generator   = MibDataGenerator()
    data_store  = {}

    if hasattr(mibBuilder, 'mibSymbols'):
        for module_name, symbols in mibBuilder.mibSymbols.items():
            for symbol_name, symbol_obj in symbols.items():
                if not hasattr(symbol_obj, 'name') or not hasattr(symbol_obj, 'getSyntax'):
                    continue
                if HIDE_DEPRECATED and hasattr(symbol_obj, 'getStatus'):
                    if symbol_obj.getStatus() in ['deprecated', 'obsolete']:
                        continue
                if HIDE_NOT_ACCESSIBLE and hasattr(symbol_obj, 'getMaxAccess'):
                    if symbol_obj.getMaxAccess() == 'not-accessible':
                        continue
                base_oid = tuple(symbol_obj.name)
                if symbol_obj.__class__.__name__ == 'MibScalar':
                    key_str = f"{module_name}::{symbol_name}.0"
                    val = generator.get_value(symbol_obj.getSyntax(), custom_data.get(key_str))
                    data_store[base_oid + (0,)] = val
                elif symbol_obj.__class__.__name__ == 'MibTableColumn':
                    for i in [1, 2]:
                        key_str = f"{module_name}::{symbol_name}.{i}"
                        val = generator.get_value(symbol_obj.getSyntax(), custom_data.get(key_str))
                        data_store[base_oid + (i,)] = val

    # Inject custom rows
    for key, val in custom_data.items():
        if "::" not in key or "." not in key:
            continue
        try:
            module_obj_part, index_part = key.split(".", 1)
            module_name, obj_name = module_obj_part.split("::")
            index_tuple = tuple(int(x) for x in index_part.split("."))
            if module_name in mibBuilder.mibSymbols and obj_name in mibBuilder.mibSymbols[module_name]:
                symbol_obj = mibBuilder.mibSymbols[module_name][obj_name]
                if HIDE_NOT_ACCESSIBLE and hasattr(symbol_obj, 'getMaxAccess'):
                    if symbol_obj.getMaxAccess() == 'not-accessible':
                        continue
                base_oid  = tuple(symbol_obj.name)
                snmp_val  = generator.get_value(symbol_obj.getSyntax(), val)
                data_store[base_oid + index_tuple] = snmp_val
        except Exception:
            pass

    oid_count = len(data_store)
    logger.info(f"Generated {oid_count} OID instances.")

    # Persist oids_loaded stat
    worker_set_field(STATS_FILE, "simulator", "oids_loaded", oid_count)

    return data_store


async def run_simulator(port, community, mib_dir, data_path, startup_status_file=None):
    mock_data  = compile_and_generate_data(mib_dir, data_path)
    snmpEngine = engine.SnmpEngine()

    config.add_transport(snmpEngine, udp.DOMAIN_NAME, udp.UdpTransport().open_server_mode(('0.0.0.0', port)))
    config.add_v1_system(snmpEngine, 'my-area', community)
    config.add_vacm_user(snmpEngine, 2, 'my-area', 'noAuthNoPriv', (1, 3, 6), (1, 3, 6))

    snmpContext = context.SnmpContext(snmpEngine)
    snmpContext.unregister_context_name(v2c.OctetString(''))
    snmpContext.register_context_name(v2c.OctetString(''), MockController(mock_data))

    cmdrsp.GetCommandResponder(snmpEngine, snmpContext)
    cmdrsp.NextCommandResponder(snmpEngine, snmpContext)

    logger.info(f"\u2705 SIMULATOR RUNNING on UDP {port}")
    write_startup_status(startup_status_file, "ready", f"Simulator listening on UDP {port}.", port=port)

    while True:
        await asyncio.sleep(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument("--port",      type=int, default=1061)
    parser.add_argument("--community", type=str, default="public")
    parser.add_argument("--mib-dir",   type=str, required=True)
    parser.add_argument("--data-file", type=str, required=True)
    parser.add_argument("--startup-status-file", type=str, default=None)
    args = parser.parse_args()

    try:
        asyncio.run(
            run_simulator(
                args.port,
                args.community,
                args.mib_dir,
                args.data_file,
                startup_status_file=args.startup_status_file,
            )
        )
    except KeyboardInterrupt:
        pass
    except Exception as e:
        write_startup_status(args.startup_status_file, "error", str(e), port=args.port)
        raise
