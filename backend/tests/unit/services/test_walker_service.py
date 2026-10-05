from __future__ import annotations

import asyncio

import pytest

pytestmark = pytest.mark.unit


class _WalkerRuntimeStub:
    def __init__(self, *, result: dict[str, object] | None = None, error: Exception | None = None) -> None:
        self.result = result or {"varbinds": []}
        self.error = error
        self.calls: list[dict[str, object]] = []

    async def manager_walk(self, **kwargs) -> dict[str, object]:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.result


def test_walk_item_and_metric_helpers_handle_display_and_metric_edges():
    from app.services.walker_service import (
        _extract_value,
        _metric_value,
        _raw_value,
        _value_is_metric,
        _walk_compat_items,
        _walk_item,
    )

    entry_with_display = {
        "oid": "1.3.6.1.2.1.1.1.0",
        "value_type": "integer",
        "value": {"display": "friendly"},
        "display_value": "ignored",
    }
    assert _walk_item(entry_with_display, use_mibs=False) == {
        "oid": "1.3.6.1.2.1.1.1.0",
        "type": "integer",
        "value": "friendly",
        "enum_label": None,
        "units": None,
    }
    assert _extract_value({"value": {"display": "shown"}}) == "shown"
    assert _extract_value({"display_value": "fallback"}) == "fallback"
    assert _extract_value({"display_value": "preferred", "value": {"value": 3}}) == "preferred"
    assert _raw_value({"display_value": "preferred", "value": {"value": 3}}) == 3
    assert _raw_value({"value": {"display": "shown"}}) == "shown"

    entry_with_enums = {
        "oid": "1.3.6.1.2.1.2.2.1.7.1",
        "symbolic": "IF-MIB::ifAdminStatus.1",
        "value_type": "integer",
        "value": {"value": 1},
        "display_value": "up(1)",
        "enum_label": "up",
        "units": None,
    }
    assert _walk_item(entry_with_enums, use_mibs=True) == {
        "oid": "1.3.6.1.2.1.2.2.1.7.1",
        "symbolic": "IF-MIB::ifAdminStatus.1",
        "type": "integer",
        "value": 1,
        "enum_label": "up",
        "units": None,
    }

    compat_items = _walk_compat_items(
        [
            {"symbolic": "", "oid": "", "value_type": "integer", "value": {"value": 1}},
            {
                "symbolic": "IF-MIB::ifSpeed",
                "oid": "1.3.6.1.2.1.2.2.1.5.2",
                "value_type": "integer",
                "value": {"value": 123},
            },
            {
                "symbolic": "IF-MIB::ifAlias.2",
                "oid": "1.3.6.1.2.1.2.2.1.18.2",
                "value_type": "integer",
                "value": {"value": True},
            },
            {
                "symbolic": "SNMPv2-MIB::sysUpTime.0",
                "oid": "1.3.6.1.2.1.1.3.0",
                "value_type": "timeticks",
                "value": {"value": 250},
            },
        ],
        target_host="lab-agent",
        root_oid="IF-MIB::ifTable",
        use_mibs=True,
    )
    metric_names = {item["metric_name"] for item in compat_items}
    assert {"ifSpeed", "sysUpTime"} <= metric_names
    assert any(
        item["labels"]["snmp_index"] == "2"
        for item in compat_items
        if item["metric_name"] == "ifSpeed"
    )
    assert any(item["value"] == 2.5 for item in compat_items if item["metric_name"] == "sysUpTime")

    assert _value_is_metric("ifIndex", "integer", 1) is False
    assert _value_is_metric("ifSpeed", "octet-string", "123") is False
    assert _value_is_metric("ifSpeed", "counter32", "123") is True
    assert _value_is_metric("ifAdminStatus", "integer", 1) is False
    assert _value_is_metric("ifOperStatus", "integer", 1) is False
    assert _value_is_metric("ifPhysAddress", "octet-string", "00:11") is False

    assert _metric_value("counter32", None) is None
    assert _metric_value("counter32", True) is None
    assert _metric_value("counter32", "") is None
    assert _metric_value("counter32", "no digits") is None
    assert _metric_value("counter32", "speed 77 bps") == 77
    assert _metric_value("timeticks", 150) == 1.5


def test_compat_items_keep_raw_values_when_display_is_present():
    from app.services.walker_service import _walk_compat_items

    compat_items = _walk_compat_items(
        [
            {
                "symbolic": "IF-MIB::ifSpeed.2",
                "oid": "1.3.6.1.2.1.2.2.1.5.2",
                "value_type": "integer",
                "value": {"value": 123},
                "display_value": "123",
            },
            {
                "symbolic": "IF-MIB::ifAdminStatus.2",
                "oid": "1.3.6.1.2.1.2.2.1.7.2",
                "value_type": "integer",
                "value": {"value": 1},
                "display_value": "up(1)",
            },
        ],
        target_host="lab-agent",
        root_oid="IF-MIB::ifTable",
        use_mibs=True,
    )
    if_speed = next(item for item in compat_items if item["metric_name"] == "ifSpeed")
    assert if_speed["value"] == 123
    if_status = next(item for item in compat_items if "ifAdminStatus" in item["labels"])
    assert if_status["labels"]["ifAdminStatus"] == 1
    assert if_status["labels"]["snmp_index"] == "2"


def test_execute_covers_raw_parsed_grouped_and_label_modes(isolated_db, monkeypatch):
    from app.services import walker_service
    from app.services.state_store import StateStore, _WALK_OIDS_RETURNED_KEY, _WALKS_EXECUTED_KEY

    settings = isolated_db["settings"]
    state = StateStore(isolated_db["session_factory"])
    broadcasts: list[object] = []

    async def fake_broadcast_stats(*, settings):
        broadcasts.append(settings)

    monkeypatch.setattr(walker_service, "broadcast_stats", fake_broadcast_stats)

    runtime = _WalkerRuntimeStub(
        result={
            "varbinds": [
                {
                    "oid": "1.3.6.1.2.1.1.3.0",
                    "symbolic": "SNMPv2-MIB::sysUpTime.0",
                    "value_type": "timeticks",
                    "value": {"value": 250},
                },
                {
                    "oid": "1.3.6.1.2.1.2.2.1.5.2",
                    "symbolic": "IF-MIB::ifSpeed.2",
                    "value_type": "integer",
                    "value": {"value": 123},
                },
            ]
        }
    )

    raw = asyncio.run(
        walker_service.execute(
            target="127.0.0.1",
            port=161,
            community="public",
            oid="IF-MIB::ifTable",
            parse=False,
            use_mibs=True,
            json_format="grouped",
            settings=settings,
            state=state,
            runtime_service=runtime,
        )
    )
    assert raw["mode"] == "raw"
    assert raw["json_format"] == "grouped"
    assert raw["count"] == 2
    assert raw["data"][0].startswith("SNMPv2-MIB::sysUpTime.0 = ")

    parsed_grouped = asyncio.run(
        walker_service.execute(
            target="127.0.0.1",
            port=161,
            community="public",
            oid="IF-MIB::ifTable",
            parse=True,
            use_mibs=True,
            json_format="grouped",
            settings=settings,
            state=state,
            runtime_service=runtime,
        )
    )
    assert parsed_grouped["mode"] == "parsed"
    assert {item["metric_name"] for item in parsed_grouped["data"]} == {"sysUpTime", "ifSpeed"}

    parsed_oid = asyncio.run(
        walker_service.execute(
            target="127.0.0.1",
            port=161,
            community="public",
            oid="1.3.6.1.2.1.1",
            parse=True,
            use_mibs=False,
            json_format="current",
            settings=settings,
            state=state,
            runtime_service=runtime,
        )
    )
    assert parsed_oid["mode"] == "parsed"
    assert parsed_oid["json_format"] == "flat"
    assert parsed_oid["data"][0]["oid"] == "1.3.6.1.2.1.1.3.0"
    assert "symbolic" not in parsed_oid["data"][0]

    fallback_runtime = _WalkerRuntimeStub(
        result={
            "varbinds": [
                {
                    "oid": "1.3.6.1.2.1.2.2.1.18.2",
                    "symbolic": "IF-MIB::ifAlias.2",
                    "value_type": "octet-string",
                    "value": {"value": "uplink"},
                }
            ]
        }
    )
    label_mode = asyncio.run(
        walker_service.execute(
            target="127.0.0.1",
            port=161,
            community="public",
            oid="IF-MIB::ifTable",
            parse=True,
            use_mibs=True,
            json_format="grouped",
            settings=settings,
            state=state,
            runtime_service=fallback_runtime,
        )
    )
    assert label_mode["mode"] == "label"
    assert label_mode["count"] == 1
    assert label_mode["data"] == label_mode["rawLines"]

    assert state.counter(_WALKS_EXECUTED_KEY) == 4
    assert state.counter(_WALK_OIDS_RETURNED_KEY) == 7
    assert broadcasts == [settings, settings, settings, settings]


def _activate_walker_bundle(isolated_db):
    from app.services.bundle_state import get_bundle
    from app.services.bundles import BundleCompileRequest, BundleService

    BundleService(isolated_db["settings"]).compile_bundle(
        BundleCompileRequest(mib_names=["IF-MIB", "SNMPv2-MIB"], activate=True)
    )
    bundle = get_bundle()
    assert bundle is not None
    return bundle


def test_compat_items_decode_integer_indexed_table_instance_keys(isolated_db):
    from app.services.walker_service import _walk_compat_items

    _activate_walker_bundle(isolated_db)

    items = _walk_compat_items(
        [
            {
                "symbolic": "IF-MIB::ifSpeed.2",
                "oid": "1.3.6.1.2.1.2.2.1.5.2",
                "value_type": "integer",
                "value": {"value": 123},
            },
            {
                "symbolic": "IF-MIB::ifSpeed.7",
                "oid": "1.3.6.1.2.1.2.2.1.5.7",
                "value_type": "integer",
                "value": {"value": 456},
            },
        ],
        target_host="lab-agent",
        root_oid="IF-MIB::ifSpeed",
        use_mibs=True,
    )
    by_index = {item["labels"]["snmp_index"]: item for item in items}
    assert set(by_index) == {"2", "7"}
    assert by_index["2"]["value"] == 123
    assert by_index["7"]["value"] == 456


def test_compat_items_decode_string_indexed_table_instance_keys(isolated_db, monkeypatch):
    from app.services import walker_service
    from trishul_snmp.errors import UnknownOidError

    # Starter IF-MIB string-indexed columns are label-only (no metrics), so use
    # a controlled stub table: integer index + octet-string index + a counter.
    class _FakeNode:
        def __init__(self, oid, name, module, nodetype, *, syntax=None, index=None):
            self.oid = oid
            self.name = name
            self.module = module
            self.nodetype = nodetype
            self.syntax = syntax
            self.index = index

    class _FakeMatch:
        def __init__(self, module, symbol, oid):
            self.module = module
            self.symbol = symbol
            self.oid = oid

    class _FakeBundle:
        def __init__(self):
            self.nodes = {
                "stubTable": _FakeNode((1, 3, 6, 1, 4, 1, 99999, 1), "stubTable", "STUB-MIB", "table"),
                "stubEntry": _FakeNode(
                    (1, 3, 6, 1, 4, 1, 99999, 1, 1),
                    "stubEntry",
                    "STUB-MIB",
                    "row",
                    index=("stubIndex", "stubName"),
                ),
                "stubValue": _FakeNode(
                    (1, 3, 6, 1, 4, 1, 99999, 1, 3),
                    "stubValue",
                    "STUB-MIB",
                    "column",
                    syntax="Counter32",
                ),
                "stubIndex": _FakeNode(
                    (1, 3, 6, 1, 4, 1, 99999, 1, 1, 1),
                    "stubIndex",
                    "STUB-MIB",
                    "column",
                    syntax="Integer32",
                ),
                "stubName": _FakeNode(
                    (1, 3, 6, 1, 4, 1, 99999, 1, 1, 2),
                    "stubName",
                    "STUB-MIB",
                    "column",
                    syntax="DisplayString",
                ),
            }
            self.by_oid = {node.oid: node for node in self.nodes.values()}

        def resolve(self, target):
            symbol = str(target).split("::", 1)[1].split(".", 1)[0]
            return self.nodes[symbol].oid

        def lookup(self, oid):
            if isinstance(oid, str):
                oid = tuple(int(part) for part in oid.strip().lstrip(".").split("."))
            node = self.by_oid.get(oid)
            if node is None:
                raise UnknownOidError(str(oid))
            return _FakeMatch(node.module, node.name, node.oid)

        def resolve_node(self, module, symbol):
            node = self.nodes.get(symbol)
            if node is None or node.module != module:
                return None
            return node

    fake_bundle = _FakeBundle()
    monkeypatch.setattr("app.services.bundle_state.get_bundle", lambda: fake_bundle)

    items = walker_service._walk_compat_items(
        [
            {
                "symbolic": "STUB-MIB::stubValue.2.public",
                "oid": "1.3.6.1.4.1.99999.1.3.2.112.117.98.108.105.99",
                "value_type": "counter32",
                "value": {"value": 100},
            },
            {
                "symbolic": "STUB-MIB::stubValue.3.lab",
                "oid": "1.3.6.1.4.1.99999.1.3.3.108.97.98",
                "value_type": "counter32",
                "value": {"value": 200},
            },
        ],
        target_host="lab-agent",
        root_oid="STUB-MIB::stubValue",
        use_mibs=True,
    )
    by_index = {item["labels"]["snmp_index"]: item for item in items}
    assert set(by_index) == {"2.public", "3.lab"}
    assert by_index["2.public"]["value"] == 100
    assert by_index["3.lab"]["value"] == 200


def test_compat_items_fall_back_for_integer_tc_index_column_without_string_markers(
    isolated_db, monkeypatch
):
    from app.services import walker_service
    from trishul_snmp.errors import UnknownOidError

    class _FakeNode:
        def __init__(self, oid, name, module, nodetype, *, syntax=None, index=None):
            self.oid = oid
            self.name = name
            self.module = module
            self.nodetype = nodetype
            self.syntax = syntax
            self.index = index

    class _FakeMatch:
        def __init__(self, module, symbol, oid):
            self.module = module
            self.symbol = symbol
            self.oid = oid

    class _FakeBundle:
        def __init__(self):
            self.nodes = {
                "stubEntry": _FakeNode(
                    (1, 3, 6, 1, 4, 1, 99998, 1),
                    "stubEntry",
                    "STUB-MIB",
                    "row",
                    index=("stubAddrType",),
                ),
                "stubValue": _FakeNode(
                    (1, 3, 6, 1, 4, 1, 99998, 3),
                    "stubValue",
                    "STUB-MIB",
                    "column",
                    syntax="Counter32",
                ),
                "stubAddrType": _FakeNode(
                    (1, 3, 6, 1, 4, 1, 99998, 1, 1),
                    "stubAddrType",
                    "STUB-MIB",
                    "column",
                    syntax="InetAddressType",
                ),
            }
            self.by_oid = {node.oid: node for node in self.nodes.values()}

        def resolve(self, target):
            symbol = str(target).split("::", 1)[1].split(".", 1)[0]
            return self.nodes[symbol].oid

        def lookup(self, oid):
            if isinstance(oid, str):
                oid = tuple(int(part) for part in oid.strip().lstrip(".").split("."))
            node = self.by_oid.get(oid)
            if node is None:
                raise UnknownOidError(str(oid))
            return _FakeMatch(node.module, node.name, node.oid)

        def resolve_node(self, module, symbol):
            node = self.nodes.get(symbol)
            if node is None or node.module != module:
                return None
            return node

    monkeypatch.setattr("app.services.bundle_state.get_bundle", lambda: _FakeBundle())

    # InetAddressType is an integer TC whose name lacks the string markers;
    # decoding must fall back to the heuristic instead of emitting garbage.
    items = walker_service._walk_compat_items(
        [
            {
                "symbolic": "STUB-MIB::stubValue.3",
                "oid": "1.3.6.1.4.1.99998.3.3",
                "value_type": "counter32",
                "value": {"value": 100},
            },
            {
                "symbolic": "STUB-MIB::stubValue.7",
                "oid": "1.3.6.1.4.1.99998.3.7",
                "value_type": "counter32",
                "value": {"value": 200},
            },
        ],
        target_host="lab-agent",
        root_oid="STUB-MIB::stubValue",
        use_mibs=True,
    )
    by_index = {item["labels"]["snmp_index"]: item for item in items}
    assert set(by_index) == {"3", "7"}


def test_compat_items_fall_back_to_heuristic_when_root_is_not_a_column(isolated_db):
    from app.services.walker_service import _walk_compat_items

    _activate_walker_bundle(isolated_db)

    items = _walk_compat_items(
        [
            {
                "symbolic": "IF-MIB::ifSpeed.2",
                "oid": "1.3.6.1.2.1.2.2.1.5.2",
                "value_type": "integer",
                "value": {"value": 123},
            }
        ],
        target_host="lab-agent",
        root_oid="IF-MIB::ifTable",
        use_mibs=True,
    )
    assert items[0]["labels"]["snmp_index"] == "2"

    unresolved = _walk_compat_items(
        [
            {
                "symbolic": "NO-SUCH-MIB::noSuchObject.1",
                "oid": "1.3.6.1.4.1.99999.1",
                "value_type": "integer",
                "value": {"value": 5},
            }
        ],
        target_host="lab-agent",
        root_oid="NO-SUCH-MIB::noSuchObject",
        use_mibs=True,
    )
    assert unresolved[0]["labels"]["snmp_index"] == "1"


def test_execute_translates_runtime_errors(isolated_db):
    from app.services.runtime import RuntimeServiceError
    from app.services.state_store import StateStore
    from app.services.walker_service import WalkerError, execute

    runtime = _WalkerRuntimeStub(error=RuntimeServiceError("walk failed"))

    with pytest.raises(WalkerError, match="walk failed"):
        asyncio.run(
            execute(
                target="127.0.0.1",
                port=161,
                community="public",
                oid="1.3.6.1.2.1.1",
                parse=False,
                use_mibs=False,
                json_format="oid",
                settings=isolated_db["settings"],
                state=StateStore(isolated_db["session_factory"]),
                runtime_service=runtime,
            )
        )
