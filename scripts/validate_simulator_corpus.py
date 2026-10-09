#!/usr/bin/env python3
"""Validate generated defaults and optionally exercise a compiled corpus over UDP.

Run against an offline-compiled bundle; compilation failures can be attached
to the report so uncompiled source modules are never counted as validated.
All runtime data is isolated in a temporary directory.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter
import json
import os
from pathlib import Path
import random
import socket
import subprocess
import sys
import tempfile
import types

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--compile-report", type=Path)
    parser.add_argument("--baseline-ref", help="Compare defaults from a local Git ref.")
    parser.add_argument("--seeds", type=int, default=3)
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args()
    if args.seeds < 1:
        parser.error("--seeds must be at least 1")

    with tempfile.TemporaryDirectory(prefix="trishul-simulator-corpus-") as data_dir:
        os.environ["TRISHUL_DATA_DIR"] = data_dir
        os.environ.pop("DATABASE_URL", None)
        os.environ.pop("TRISHUL_DB_PATH", None)

        from app.core.config import get_settings
        from app.db.migrations import upgrade_database
        from app.models import BundleSet
        from app.services.bundle_state import set_bundle
        from app.services.runtime import get_runtime_service
        from app.services import simulator_service
        from app.services.state_store import get_state_store
        from trishul_snmp.mib import load_bundle

        settings = get_settings()
        upgrade_database()
        bundle_path = args.bundle.resolve()
        bundle = load_bundle(bundle_path)
        set_bundle(bundle)
        runtime = get_runtime_service()
        with runtime.session_factory() as session:
            session.add(BundleSet(
                bundle_key="corpus-validation", storage_path=str(bundle_path),
                status="active", is_active=True,
            ))
            session.commit()

        def audit(generator):
            failures = []
            total = 0
            counts = Counter()
            for seed in range(args.seeds):
                random.seed(seed)
                objects = generator(settings)
                total += len(objects)
                counts.update(obj["value"]["type"] for obj in objects)
                for obj in objects:
                    try:
                        runtime._parse_runtime_objects([obj], bundle=bundle)
                    except Exception as exc:
                        failures.append({"seed": seed, **obj, "error": str(exc)})
            return {
                "objects_per_seed": len(objects), "validated_objects": total,
                "value_types": dict(counts), "failure_count": len(failures),
                "failure_samples": failures[:30],
            }

        report = {
            "bundle": str(bundle_path), "seeds": args.seeds,
            "modules": len(bundle.modules),
            "mib_nodes": sum(len(module.objects) for module in bundle.modules.values()),
        }
        if args.compile_report:
            rows = json.loads(args.compile_report.read_text())
            report["compilation"] = {
                "statuses": dict(Counter(row["status"] for row in rows)),
                "excluded_modules": [row for row in rows if row["status"] not in {"compiled", "cached"}],
            }
        if args.baseline_ref:
            source = subprocess.check_output(
                ["git", "show", f"{args.baseline_ref}:backend/app/services/simulator_service.py"],
                cwd=ROOT, text=True,
            )
            baseline = types.ModuleType("simulator_baseline")
            exec(compile(source, "simulator_baseline.py", "exec"), baseline.__dict__)
            report["baseline_ref"] = args.baseline_ref
            report["baseline"] = audit(baseline._bundle_objects)
        report["current"] = audit(simulator_service._bundle_objects)
        if args.live and not report["current"]["failure_count"]:
            async def smoke():
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                    sock.bind(("127.0.0.1", 0))
                    port = sock.getsockname()[1]
                state = get_state_store()

                async def read(target):
                    result = await runtime.manager_get(
                        host="127.0.0.1", port=port, community="public", targets=[target],
                    )
                    assert result["response"]["error_status"] == "no_error", result
                    return result["response"]["varbinds"][0]["value"]

                try:
                    await simulator_service.start(
                        port=port, community="public", settings=settings,
                        state=state, runtime_service=runtime,
                    )
                    target = "CIENA-CES-MPLS-MIB::cienaCesMplsPwVifIndex.1"
                    if bundle.resolve_node("CIENA-CES-MPLS-MIB", "cienaCesMplsPwVifIndex"):
                        value = await read(target)
                        assert value["type"] == "gauge32", value
                        assert 32769 <= value["value"] <= 2147483647, value
                        # Exercise the real plain-value custom update path.
                        payload = {target: 32770, "SNMPv2-MIB::sysName.0": "corpus-agent"}
                    else:
                        payload = {"SNMPv2-MIB::sysName.0": "corpus-agent"}
                    await simulator_service.save_custom_data(payload, settings=settings, runtime_service=runtime)
                    assert (await read("SNMPv2-MIB::sysName.0"))["value"] == "corpus-agent"
                    if target in payload:
                        assert (await read(target))["value"] == 32770
                    await simulator_service.restart(settings=settings, state=state, runtime_service=runtime)
                    assert simulator_service.get_custom_data(settings=settings) == payload
                    assert (await read("SNMPv2-MIB::sysName.0"))["value"] == "corpus-agent"
                    if target in payload:
                        assert (await read(target))["value"] == 32770
                    return {"passed": True, "checks": ["startup", "UDP GET", "custom update", "persisted restart"]}
                finally:
                    await runtime.shutdown()

            try:
                report["live"] = asyncio.run(smoke())
            except Exception as exc:
                report["live"] = {"passed": False, "error": str(exc)}
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({key: value for key, value in report.items() if key != "compilation"}, indent=2))
        print(f"Report: {args.report}")
        return int(bool(report["current"]["failure_count"] or report.get("live", {}).get("passed") is False))


if __name__ == "__main__":
    raise SystemExit(main())
