from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.unit


class _SimulatorRuntimeStub:
    def __init__(self, *, responder: dict[str, object] | None = None) -> None:
        self.responder = responder or {
            "running": False,
            "port": None,
            "communities": [],
            "request_count": 0,
            "last_activity": None,
        }
        self.start_calls: list[dict[str, object]] = []
        self.stop_calls = 0
        self.set_object_calls: list[dict[str, object]] = []
        self.list_limits: list[int] = []
        self.clear_log_calls = 0

    async def get_state(self) -> dict[str, object]:
        return {"responder": dict(self.responder)}

    async def start_responder(self, **kwargs) -> None:
        self.start_calls.append(kwargs)

    async def stop_responder(self) -> None:
        self.stop_calls += 1

    async def set_responder_objects(self, *, objects, replace: bool) -> None:
        self.set_object_calls.append({"objects": objects, "replace": replace})

    async def list_simulator_activity(self, *, limit: int) -> dict[str, object]:
        self.list_limits.append(limit)
        return {"total": 1, "limit": limit, "items": [{"request_type": "GETNEXT"}]}

    async def clear_simulator_activity(self) -> dict[str, str]:
        self.clear_log_calls += 1
        return {"status": "cleared"}


def test_bundle_objects_are_generated_from_active_bundle_when_custom_data_is_absent(isolated_db):
    from app.services.bundle_state import set_bundle
    from app.services.bundles import BundleCompileRequest, BundleService
    from app.services.simulator_service import _bundle_objects
    from trishul_snmp.mib import load_bundle

    settings = isolated_db["settings"]
    bundle_service = BundleService(settings)
    result = bundle_service.compile_bundle(
        BundleCompileRequest(mib_names=["IF-MIB", "SNMPv2-MIB"], activate=True)
    )
    bundle = load_bundle(result["activation"]["bundle"]["storage_path"])
    set_bundle(bundle)

    objects = _bundle_objects(settings)
    assert len(objects) > 0

    for obj in objects:
        assert "target" in obj
        assert "value" in obj
        assert "type" in obj["value"]

    ifdescr_oid = None
    for mod_record in bundle.modules.values():
        if "ifDescr" in mod_record.objects:
            from trishul_snmp.mib.registry import oid_to_string

            ifdescr_oid = oid_to_string(mod_record.objects["ifDescr"].oid)
            break

    if ifdescr_oid:
        targets = {obj["target"] for obj in objects}
        assert f"{ifdescr_oid}.1" in targets
        assert f"{ifdescr_oid}.2" in targets

    sys_descr_oid = None
    for mod_record in bundle.modules.values():
        if "sysDescr" in mod_record.objects:
            from trishul_snmp.mib.registry import oid_to_string

            sys_descr_oid = oid_to_string(mod_record.objects["sysDescr"].oid)
            break

    if sys_descr_oid:
        targets = {obj["target"] for obj in objects}
        assert f"{sys_descr_oid}.0" in targets


def test_bundle_objects_are_empty_without_an_active_bundle(isolated_db):
    from app.services.bundle_state import set_bundle
    from app.services.simulator_service import _bundle_objects

    set_bundle(None)
    assert _bundle_objects(isolated_db["settings"]) == []


def test_default_value_for_syntax_uses_node_enum_metadata_and_type_rules():
    from types import SimpleNamespace

    from app.services.simulator_service import _default_value_for_syntax

    old_enum_node = SimpleNamespace(
        enums=None,
        constraints={"kind": "enum", "data": [["up", 1], ["down", 2], ["testing", 3]]},
    )
    result = _default_value_for_syntax("INTEGER", "anyStatusObject", index=1, node=old_enum_node)
    assert result == {"type": "integer", "value": 1}

    new_enum_node = SimpleNamespace(
        enums={"up": 1, "down": 2, "testing": 3},
        constraints=None,
    )
    result = _default_value_for_syntax("INTEGER", "anyStatusObject", index=1, node=new_enum_node)
    assert result == {"type": "integer", "value": 1}

    size_node = SimpleNamespace(
        enums=None,
        constraints={"kind": "size", "data": [[0, 255]]},
    )
    result = _default_value_for_syntax("DisplayString", "sysDescr", index=0, node=size_node)
    assert result["type"] == "octet-string"

    assert _default_value_for_syntax("Counter32", "ifInOctets", index=1)["type"] == "counter32"
    assert 1000 <= _default_value_for_syntax("Counter32", "ifInOctets", index=1)["value"] <= 999999
    assert _default_value_for_syntax("Counter64", "ifHCInOctets", index=1)["type"] == "counter64"
    assert _default_value_for_syntax("Gauge32", "ifSpeed", index=1)["type"] == "gauge32"
    assert 1 <= _default_value_for_syntax("Gauge32", "ifSpeed", index=1)["value"] <= 1000000000
    assert _default_value_for_syntax("Integer32", "ifMtu", index=1)["type"] == "integer"
    assert 1 <= _default_value_for_syntax("Integer32", "ifMtu", index=1)["value"] <= 100
    assert _default_value_for_syntax("TimeTicks", "ifLastChange", index=1)["type"] == "timeticks"
    assert 0 <= _default_value_for_syntax("TimeTicks", "ifLastChange", index=1)["value"] <= 5000000
    assert _default_value_for_syntax("IpAddress", "ifAgentAddress", index=1)["type"] == "ip-address"
    assert _default_value_for_syntax("OBJECT IDENTIFIER", "sysObjectID", index=0)["type"] == "object-identifier"
    assert _default_value_for_syntax("OctetString", "ifPhysAddress", index=1)["value"] == "00:11:22:33:44:01"
    assert _default_value_for_syntax("OctetString", "ifPhysAddress", index=2)["value"] == "00:11:22:33:44:02"


def test_runtime_objects_from_custom_data_and_load_custom_data_cover_coercion_paths(isolated_db):
    from app.services.simulator_service import (
        _coerce_custom_value,
        _runtime_objects_from_custom_data,
        load_custom_data,
    )

    class _Bundle:
        def resolve_node(self, module: str, symbol: str):
            mapping = {
                ("IF-MIB", "ifDescr"): SimpleNamespace(syntax="DisplayString"),
                ("IF-MIB", "ifHCInOctets"): SimpleNamespace(syntax="Counter64"),
            }
            return mapping.get((module, symbol))

    settings = isolated_db["settings"]
    custom_data_path = settings.config_dir / "custom_data.json"

    custom_data_path.write_text('{"1.3.6.1.2.1.1.5.0": "demo-agent"}\n')
    assert load_custom_data(settings) == {"1.3.6.1.2.1.1.5.0": "demo-agent"}

    custom_data_path.write_text('["not-a-dict"]\n')
    assert load_custom_data(settings) == {}

    custom_data_path.write_text("{invalid json\n")
    assert load_custom_data(settings) == {}

    objects, warnings = _runtime_objects_from_custom_data(
        {
            " IF-MIB::ifDescr.0 ": "edge-router",
            "IF-MIB::ifHCInOctets.0": "42",
            "1.3.6.1.2.1.1.6.0": {"type": "octet-string", "value": "lab-a"},
            "1.3.6.1.2.1.1.5.0": "fallback-name",
            " ": "skip",
        },
        bundle=_Bundle(),
    )
    assert warnings == []
    by_target = {item["target"]: item["value"] for item in objects}

    assert by_target["IF-MIB::ifDescr.0"] == {"type": "octet-string", "value": "edge-router"}
    assert by_target["IF-MIB::ifHCInOctets.0"] == {"type": "counter64", "value": 42}
    assert by_target["1.3.6.1.2.1.1.6.0"] == {"type": "octet-string", "value": "lab-a"}
    assert by_target["1.3.6.1.2.1.1.5.0"] == {"type": "octet-string", "value": "fallback-name"}

    oid_spec, oid_error = _coerce_custom_value("oid", ".1.3.6.1.2.1.1", "OBJECT IDENTIFIER")
    assert oid_error is None
    assert oid_spec == {
        "type": "object-identifier",
        "value": "1.3.6.1.2.1.1",
    }
    ip_spec, ip_error = _coerce_custom_value("ip", "127.0.0.1", "IpAddress")
    assert ip_error is None
    assert ip_spec == {
        "type": "ip-address",
        "value": "127.0.0.1",
    }
    bad_spec, bad_error = _coerce_custom_value("counter", "not-a-number", "Counter32")
    assert bad_spec is None
    assert "cannot be coerced" in bad_error


def test_default_value_for_syntax_draws_random_values_inside_declared_range():
    from types import SimpleNamespace

    from app.services.simulator_service import _default_value_for_syntax

    ranged_node = SimpleNamespace(
        enums=None,
        constraints={"kind": "range", "data": [[10, 20]]},
    )
    for _ in range(25):
        result = _default_value_for_syntax("INTEGER", "scopedCounter", index=0, node=ranged_node)
        assert result["type"] == "integer"
        assert 10 <= result["value"] <= 20

    sized_node = SimpleNamespace(
        enums=None,
        constraints={"kind": "size", "data": [[0, 4]]},
    )
    result = _default_value_for_syntax("DisplayString", "ifAlias", index=1, node=sized_node)
    assert result["type"] == "octet-string"
    assert len(result["value"]) <= 4


def test_custom_value_validation_errors_are_explicit():
    from types import SimpleNamespace

    from app.services.simulator_service import (
        SimulatorError,
        _coerce_custom_value,
        _runtime_objects_from_custom_data,
    )

    ranged_node = SimpleNamespace(
        syntax="INTEGER",
        constraints={"kind": "range", "data": [[0, 100]]},
    )
    spec, error = _coerce_custom_value(
        "IF-MIB::node.0",
        "500",
        "INTEGER",
        constraints=ranged_node.constraints,
    )
    assert spec is None
    assert "outside the declared range 0..100" in error

    sized_node = SimpleNamespace(
        syntax="DisplayString",
        constraints={"kind": "size", "data": [[0, 4]]},
    )
    spec, error = _coerce_custom_value(
        "IF-MIB::name.0",
        "toolong",
        "DisplayString",
        constraints=sized_node.constraints,
    )
    assert spec is None
    assert "outside the declared size 0..4" in error

    in_range_spec, in_range_error = _coerce_custom_value(
        "IF-MIB::node.0",
        "50",
        "INTEGER",
        constraints=ranged_node.constraints,
    )
    assert in_range_error is None
    assert in_range_spec == {"type": "gauge32", "value": 50}

    class _Bundle:
        def resolve_node(self, module, symbol):
            del module, symbol
            return ranged_node

    # Startup path: invalid values warn-and-skip instead of blocking boot.
    skipped_objects, warnings = _runtime_objects_from_custom_data(
        {"IF-MIB::node.0": "500"},
        bundle=_Bundle(),
    )
    assert skipped_objects == []
    assert len(warnings) == 1
    assert "outside the declared range" in warnings[0]

    # Save/update path: the same value is rejected explicitly.
    with pytest.raises(SimulatorError, match="outside the declared range"):
        _runtime_objects_from_custom_data(
            {"IF-MIB::node.0": "500"},
            bundle=_Bundle(),
            reject_invalid=True,
        )


def test_default_value_for_syntax_resolves_type_level_constraints():
    from types import SimpleNamespace

    from app.services.simulator_service import _default_value_for_syntax

    class _TypeRecord:
        constraints = {"kind": "range", "data": [[5, 8]]}

    class _Bundle:
        def resolve_type(self, module, type_name):
            del module
            assert type_name == "NarrowGauge"
            return _TypeRecord()

    node = SimpleNamespace(
        module="STUB-MIB",
        syntax="NarrowGauge",
        enums=None,
        constraints=None,
    )
    for _ in range(25):
        result = _default_value_for_syntax(
            "NarrowGauge",
            "narrowThing",
            index=0,
            node=node,
            bundle=_Bundle(),
        )
        assert 5 <= result["value"] <= 8


def test_get_status_start_and_stop_persist_state_and_broadcast(isolated_db, monkeypatch):
    from app.services import simulator_service
    from app.services.state_store import (
        StateStore,
        _SIMULATOR_COMMUNITY_KEY,
        _SIMULATOR_PORT_KEY,
        _SIMULATOR_STARTED_AT_KEY,
    )

    settings = isolated_db["settings"]
    state = StateStore(isolated_db["session_factory"])
    runtime = _SimulatorRuntimeStub()
    broadcasts: list[tuple[str, object]] = []

    state.set_value(_SIMULATOR_PORT_KEY, 3161)
    state.set_value(_SIMULATOR_COMMUNITY_KEY, "private")

    status = asyncio.run(simulator_service.get_status(state=state, runtime_service=runtime))
    assert status["running"] is False
    assert status["port"] == 3161
    assert status["community"] == "private"
    assert status["pid"] is None
    assert status["uptime_seconds"] is None

    monkeypatch.setattr(
        simulator_service,
        "_bundle_objects",
        lambda runtime_settings: [{"target": "1.3.6.1.2.1.1.1.0", "value": {"type": "octet-string", "value": "base"}}],
    )
    monkeypatch.setattr(
        simulator_service,
        "load_custom_data",
        lambda runtime_settings: {"1.3.6.1.2.1.1.1.0": "override", "1.3.6.1.2.1.1.5.0": "agent-name"},
    )
    monkeypatch.setattr(
        simulator_service,
        "_runtime_objects_from_custom_data",
        lambda payload, bundle=None, **kwargs: (
            [
                {"target": "1.3.6.1.2.1.1.1.0", "value": {"type": "octet-string", "value": "override"}},
                {"target": "1.3.6.1.2.1.1.5.0", "value": {"type": "octet-string", "value": "agent-name"}},
            ],
            [],
        ),
    )

    async def fake_broadcast_status(*, settings):
        broadcasts.append(("status", settings))

    async def fake_broadcast_stats(*, settings):
        broadcasts.append(("stats", settings))

    monkeypatch.setattr(simulator_service, "broadcast_status", fake_broadcast_status)
    monkeypatch.setattr(simulator_service, "broadcast_stats", fake_broadcast_stats)

    started = asyncio.run(
        simulator_service.start(
            port=2161,
            community="public",
            settings=settings,
            state=state,
            runtime_service=runtime,
        )
    )
    assert started == {
        "status": "started",
        "message": "Simulator started successfully.",
        "port": 2161,
        "community": "public",
    }
    assert runtime.start_calls[0]["host"] == "0.0.0.0"
    assert runtime.start_calls[0]["port"] == 2161
    assert runtime.start_calls[0]["communities"] == ["public"]
    assert {item["target"] for item in runtime.start_calls[0]["objects"]} == {
        "1.3.6.1.2.1.1.1.0",
        "1.3.6.1.2.1.1.5.0",
    }
    assert state.snapshot()[_SIMULATOR_PORT_KEY] == 2161
    assert state.snapshot()[_SIMULATOR_COMMUNITY_KEY] == "public"
    assert state.snapshot()[_SIMULATOR_STARTED_AT_KEY] is not None

    stopped = asyncio.run(
        simulator_service.stop(
            settings=settings,
            state=state,
            runtime_service=runtime,
        )
    )
    assert stopped == {
        "status": "stopped",
        "message": "Simulator stopped successfully.",
    }
    assert runtime.stop_calls == 1
    assert state.snapshot()[_SIMULATOR_STARTED_AT_KEY] is None
    assert broadcasts == [
        ("status", settings),
        ("stats", settings),
        ("status", settings),
        ("stats", settings),
    ]


def test_restart_reuses_current_port_and_community(isolated_db, monkeypatch):
    from app.services import simulator_service

    settings = isolated_db["settings"]
    state = object()
    runtime = object()
    captured: dict[str, object] = {}

    async def fake_get_status(*, state, runtime_service):
        captured["status"] = (state, runtime_service)
        return {"port": 4161, "community": "private"}

    async def fake_stop(*, settings, state, runtime_service):
        captured["stop"] = (settings, state, runtime_service)
        return {"status": "stopped"}

    async def fake_start(*, port, community, settings, state, runtime_service):
        captured["start"] = (port, community, settings, state, runtime_service)
        return {"status": "started", "port": port, "community": community}

    monkeypatch.setattr(simulator_service, "get_status", fake_get_status)
    monkeypatch.setattr(simulator_service, "stop", fake_stop)
    monkeypatch.setattr(simulator_service, "start", fake_start)

    payload = asyncio.run(
        simulator_service.restart(
            settings=settings,
            state=state,
            runtime_service=runtime,
        )
    )
    assert payload == {"status": "started", "port": 4161, "community": "private"}
    assert captured["status"] == (state, runtime)
    assert captured["stop"] == (settings, state, runtime)
    assert captured["start"] == (4161, "private", settings, state, runtime)


def test_save_custom_data_persists_payload_and_refreshes_runtime(isolated_db, monkeypatch):
    from app.services import simulator_service

    settings = isolated_db["settings"]
    runtime = _SimulatorRuntimeStub()
    payload = {
        "1.3.6.1.2.1.1.1.0": "override",
        "1.3.6.1.2.1.1.5.0": "agent-name",
    }
    broadcasts: list[object] = []

    monkeypatch.setattr(
        simulator_service,
        "_bundle_objects",
        lambda runtime_settings: [{"target": "1.3.6.1.2.1.1.1.0", "value": {"type": "octet-string", "value": "base"}}],
    )
    monkeypatch.setattr(
        simulator_service,
        "_runtime_objects_from_custom_data",
        lambda custom_payload, bundle=None, **kwargs: (
            [
                {"target": "1.3.6.1.2.1.1.1.0", "value": {"type": "octet-string", "value": "override"}},
                {"target": "1.3.6.1.2.1.1.5.0", "value": {"type": "octet-string", "value": "agent-name"}},
            ],
            [],
        ),
    )

    async def fake_broadcast_stats(*, settings):
        broadcasts.append(settings)

    monkeypatch.setattr(simulator_service, "broadcast_stats", fake_broadcast_stats)

    saved = asyncio.run(
        simulator_service.save_custom_data(
            payload,
            settings=settings,
            runtime_service=runtime,
        )
    )
    assert saved == {
        "status": "saved",
        "message": "Custom data stored (2 overrides).",
    }
    assert runtime.set_object_calls[0]["replace"] is True
    assert {item["target"] for item in runtime.set_object_calls[0]["objects"]} == {
        "1.3.6.1.2.1.1.1.0",
        "1.3.6.1.2.1.1.5.0",
    }
    assert simulator_service.get_custom_data(settings=settings) == payload
    assert broadcasts == [settings]


def test_simulator_service_translates_runtime_errors_for_lifecycle_and_logs(isolated_db, monkeypatch):
    from app.services import simulator_service
    from app.services.runtime import RuntimeServiceError
    from app.services.simulator_service import SimulatorError
    from app.services.state_store import StateStore

    settings = isolated_db["settings"]
    state = StateStore(isolated_db["session_factory"])

    class _FailingStartRuntime(_SimulatorRuntimeStub):
        async def start_responder(self, **kwargs) -> None:
            del kwargs
            raise RuntimeServiceError("start failed")

    class _FailingStopRuntime(_SimulatorRuntimeStub):
        async def stop_responder(self) -> None:
            raise RuntimeServiceError("stop failed")

    class _FailingSetRuntime(_SimulatorRuntimeStub):
        async def set_responder_objects(self, *, objects, replace: bool) -> None:
            del objects, replace
            raise RuntimeServiceError("save failed")

        async def list_simulator_activity(self, *, limit: int) -> dict[str, object]:
            del limit
            raise RuntimeServiceError("list failed")

        async def clear_simulator_activity(self) -> dict[str, str]:
            raise RuntimeServiceError("clear failed")

    monkeypatch.setattr(simulator_service, "_bundle_objects", lambda runtime_settings: [])
    monkeypatch.setattr(simulator_service, "load_custom_data", lambda runtime_settings: {})

    with pytest.raises(SimulatorError, match="start failed"):
        asyncio.run(
            simulator_service.start(
                port=2161,
                community="public",
                settings=settings,
                state=state,
                runtime_service=_FailingStartRuntime(),
            )
        )

    with pytest.raises(SimulatorError, match="stop failed"):
        asyncio.run(
            simulator_service.stop(
                settings=settings,
                state=state,
                runtime_service=_FailingStopRuntime(),
            )
        )

    with pytest.raises(SimulatorError, match="Custom data must be a JSON object"):
        asyncio.run(
            simulator_service.save_custom_data(
                ["bad"],
                settings=settings,
                runtime_service=_SimulatorRuntimeStub(),
            )
        )

    monkeypatch.setattr(simulator_service, "_runtime_objects_from_custom_data", lambda payload, bundle=None, **kwargs: ([], []))
    with pytest.raises(SimulatorError, match="save failed"):
        asyncio.run(
            simulator_service.save_custom_data(
                {},
                settings=settings,
                runtime_service=_FailingSetRuntime(),
            )
        )

    with pytest.raises(SimulatorError, match="list failed"):
        asyncio.run(simulator_service.get_logs(limit=50, runtime_service=_FailingSetRuntime()))

    with pytest.raises(SimulatorError, match="clear failed"):
        asyncio.run(simulator_service.clear_logs(runtime_service=_FailingSetRuntime()))
