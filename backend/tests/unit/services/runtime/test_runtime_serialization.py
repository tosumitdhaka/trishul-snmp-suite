from __future__ import annotations

import asyncio
import base64

import pytest

pytestmark = pytest.mark.unit


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


def test_serialize_varbind_carries_enum_label_and_units(isolated_db):
    from app.services.runtime import RuntimeService
    from trishul_snmp.types import IntegerValue, VarBind

    service = RuntimeService(isolated_db["settings"])

    enriched = service._serialize_varbind(
        VarBind(
            oid=(1, 3, 6, 1, 2, 1, 2, 2, 1, 7, 1),
            value=IntegerValue(1),
            display_value="up(1)",
            enum_label="up",
            units="bits/second",
        )
    )
    assert enriched["display_value"] == "up(1)"
    assert enriched["enum_label"] == "up"
    assert enriched["units"] == "bits/second"

    plain = service._serialize_varbind(
        VarBind(
            oid=(1, 3, 6, 1, 2, 1, 1, 3, 0),
            value=IntegerValue(321),
        )
    )
    assert plain["display_value"] == "321"
    assert plain["enum_label"] is None
    assert plain["units"] is None


def test_parse_runtime_objects_rejects_out_of_range_and_oversize_values(isolated_db):
    from app.services.runtime import RuntimeService, RuntimeServiceError
    from trishul_snmp.mib import load_bundle

    active_bundle = _activate_runtime_bundle(isolated_db)
    bundle = load_bundle(active_bundle["storage_path"])
    service = RuntimeService(isolated_db["settings"])

    with pytest.raises(
        RuntimeServiceError,
        match="sysServices: value 300 is outside the declared range 0..127",
    ):
        service._parse_runtime_objects(
            [
                {
                    "target": "SNMPv2-MIB::sysServices.0",
                    "value": {"type": "integer", "value": 300},
                }
            ],
            bundle=bundle,
        )

    with pytest.raises(
        RuntimeServiceError,
        match="ifAlias: value length 65 is outside the declared size 0..64",
    ):
        service._parse_runtime_objects(
            [
                {
                    "target": "IF-MIB::ifAlias.0",
                    "value": {"type": "octet-string", "value": "x" * 65},
                }
            ],
            bundle=bundle,
        )

    # In-range values still parse cleanly.
    parsed = service._parse_runtime_objects(
        [
            {
                "target": "SNMPv2-MIB::sysServices.0",
                "value": {"type": "integer", "value": 72},
            },
            {
                "target": "IF-MIB::ifAlias.0",
                "value": {"type": "octet-string", "value": "uplink"},
            },
        ],
        bundle=bundle,
    )
    assert [spec.target for spec in parsed] == [
        "SNMPv2-MIB::sysServices.0",
        "IF-MIB::ifAlias.0",
    ]


@pytest.mark.parametrize("value_type", ["octet-string", "opaque"])
@pytest.mark.parametrize("encoding", ["utf-8", "text", "hex", "base64"])
def test_empty_encoded_byte_values_are_valid(isolated_db, value_type, encoding):
    from app.services.runtime import RuntimeService

    service = RuntimeService(isolated_db["settings"])
    value = service._parse_value_spec(
        {"type": value_type, "value": "", "encoding": encoding}, bundle=None
    )
    assert value.value == b""
    # Serialized empty byte values must also survive notification replay.
    replay = service._replay_value_input(service._serialize_value(value))
    assert service._parse_value_spec(replay, bundle=None).value == b""


@pytest.mark.parametrize("encoding", ["hex", "base64"])
@pytest.mark.parametrize("value", [None, 0, False, {}, []])
def test_encoded_byte_values_still_require_strings(isolated_db, encoding, value):
    from app.services.runtime import RuntimeService, RuntimeServiceError

    with pytest.raises(RuntimeServiceError, match="value must be a string"):
        RuntimeService(isolated_db["settings"])._decode_value_bytes(value, encoding)


def test_runtime_parsing_and_replay_helpers_cover_supported_inputs(
    isolated_db,
    monkeypatch,
):
    from app.services.runtime import RuntimeService
    from trishul_snmp.mib import load_bundle

    active_bundle = _activate_runtime_bundle(isolated_db)
    bundle = load_bundle(active_bundle["storage_path"])
    service = RuntimeService(isolated_db["settings"])

    parsed_objects = service._parse_runtime_objects(
        [
            {
                "target": "SNMPv2-MIB::sysName.0",
                "value": {"type": "string", "value": "demo"},
            }
        ],
        bundle=bundle,
    )
    assert parsed_objects[0].target == "SNMPv2-MIB::sysName.0"
    assert service._serialize_runtime_object(parsed_objects[0])["value"]["value"] == "demo"

    parsed_rules = service._parse_runtime_rules(
        [
            {
                "target": "SNMPv2-MIB::sysName.0",
                "kind": "static",
                "value": {"type": "string", "value": "demo"},
            },
            {
                "target": "1.3.6.1.2.1.1.3.0",
                "kind": "random-int",
                "value_type": "integer",
                "minimum": 5,
                "maximum": 5,
            },
            {
                "target": "1.3.6.1.2.1.1.4.0",
                "kind": "counter",
                "value_type": "counter32",
                "start": 10,
                "step": 2,
                "wrap_at": 20,
            },
            {
                "target": "1.3.6.1.2.1.1.6.0",
                "kind": "timestamp",
                "value_type": "octet-string",
                "format": "unix-ms",
            },
            {
                "target": "1.3.6.1.2.1.1.7.0",
                "kind": "uptime",
                "base": 40,
            },
        ],
        bundle=bundle,
    )
    assert [item.kind for item in parsed_rules] == [
        "static",
        "random",
        "counter",
        "timestamp",
        "uptime",
    ]

    assert service._serialize_value(
        service._parse_value_spec(
            {"type": "opaque", "value": "4142", "encoding": "hex"},
            bundle=bundle,
        )
    )["hex"] == "4142"
    assert service._serialize_value(
        service._parse_value_spec(
            {"type": "oid", "value": "IF-MIB::ifDescr.1"},
            bundle=bundle,
        )
    )["value"] == "1.3.6.1.2.1.2.2.1.2.1"
    assert service._decode_value_bytes([65, 66], "utf-8") == b"AB"
    assert service._decode_value_bytes("0x4142", "hex") == b"AB"
    assert (
        service._decode_value_bytes(
            base64.b64encode(b"AB").decode("ascii"),
            "base64",
        )
        == b"AB"
    )
    assert service._decode_binary_payload("4142", encoding="hex") == b"AB"
    assert (
        service._normalize_numeric_rule_value_type("counter", default="integer")
        == "counter32"
    )
    assert service._normalize_timestamp_rule_value_type("counter64") == "counter64"
    assert service._normalize_timestamp_rule_format("unix-ms", default="unix") == "unix-ms"

    event_payload = {
        "direction": "received",
        "notification_oid": "1.3.6.1.6.3.1.1.5.3",
        "varbinds": [
            {
                "oid": "1.3.6.1.2.1.1.3.0",
                "value": {"type": "timeticks", "value": 12},
            },
            {
                "symbolic": "IF-MIB::ifDescr.1",
                "value": {"type": "octet-string", "hex": "65746830"},
            },
        ],
    }
    replay_varbinds = service._replay_varbind_inputs(event_payload)
    assert replay_varbinds == [
        {
            "target": "IF-MIB::ifDescr.1",
            "value": {"type": "octet-string", "value": "65746830", "encoding": "hex"},
        }
    ]
    assert (
        service._notification_target_from_event(
            {"notification_oid": "1.3.6.1.6.3.1.1.5.3"}
        )
        == "1.3.6.1.6.3.1.1.5.3"
    )
    assert service._replay_value_input({"type": "opaque", "hex": "deadbeef"}) == {
        "type": "opaque",
        "value": "deadbeef",
        "encoding": "hex",
    }
    assert service._serialize_socket_address(("127.0.0.1", 1162, 0, 0)) == {
        "host": "127.0.0.1",
        "port": 1162,
    }
    assert service._normalize_communities(["public", " ", "lab"]) == ("public", "lab")
    assert service._oid_to_str((1, 3, 6, 1)) == "1.3.6.1"

    monkeypatch.setattr(
        service.history_service,
        "record_event",
        lambda **kwargs: (_ for _ in ()).throw(RuntimeError("db down")),
    )
    persisted = service._persist_event(
        event_payload={"direction": "sent", "target_address": {}},
        bundle_set_id=None,
    )
    assert persisted["history_error"] == "db down"


def test_runtime_validation_and_replay_paths_raise_clear_errors(
    isolated_db,
    monkeypatch,
):
    from app.services.runtime import RuntimeService, RuntimeServiceError

    service = RuntimeService(isolated_db["settings"])

    invalid_cases = [
        (lambda: service._parse_runtime_objects([1], bundle=None), "Each object entry must be a JSON object"),
        (
            lambda: service._parse_runtime_objects(
                [{"target": "1.3.6.1.2.1.1.5.0", "value": 1}],
                bundle=None,
            ),
            "Each object entry must include a JSON object value payload",
        ),
        (lambda: service._parse_runtime_rules([1], bundle=None), "Each rule entry must be a JSON object"),
        (
            lambda: service._parse_runtime_rules(
                [{"target": "1.3.6.1.2.1.1.5.0", "kind": "static"}],
                bundle=None,
            ),
            "Static rules require a JSON value payload",
        ),
        (
            lambda: service._parse_runtime_rules(
                [
                    {
                        "target": "1.3.6.1.2.1.1.5.0",
                        "kind": "random",
                        "minimum": 5,
                        "maximum": 1,
                    }
                ],
                bundle=None,
            ),
            "random rules require maximum to be greater than or equal to minimum",
        ),
        (
            lambda: service._parse_value_spec({"type": "unsupported"}, bundle=None),
            "Unsupported SNMP value type",
        ),
        (lambda: service._decode_value_bytes({"bad": "value"}, "text"), "Text-encoded SNMP byte values"),
        (lambda: service._decode_value_bytes("xyz", "hex"), "Hex-encoded byte values"),
        (lambda: service._decode_value_bytes("***", "base64"), "Base64-encoded byte values"),
        (
            lambda: service._normalize_numeric_rule_value_type(
                "octet-string",
                default="integer",
            ),
            "Numeric rule value_type must be one of",
        ),
        (
            lambda: service._normalize_timestamp_rule_value_type("ip-address"),
            "timestamp rule value_type must be octet-string",
        ),
        (
            lambda: service._normalize_timestamp_rule_format(
                "bad-format",
                default="unix",
            ),
            "timestamp rule format must be one of",
        ),
        (
            lambda: service._notification_target_from_event({}),
            "Stored notification event is missing a notification target.",
        ),
        (
            lambda: service._replay_varbind_inputs({"varbinds": "bad"}),
            "Stored notification event has an invalid varbind payload.",
        ),
        (
            lambda: service._replay_value_input(None),
            "Stored notification event is missing a serialized value payload.",
        ),
        (
            lambda: service._replay_value_input({"type": "opaque"}),
            "Stored notification event is missing opaque hex data.",
        ),
        (
            lambda: service._require_target("", field_name="target"),
            "target must contain a non-empty OID or symbolic target",
        ),
        (
            lambda: service._coerce_text("", field_name="value"),
            "value must be a non-empty string",
        ),
        (
            lambda: service._coerce_int(True, field_name="value"),
            "value must be an integer",
        ),
        (
            lambda: service._coerce_uint(-1, field_name="value"),
            "value must be zero or greater",
        ),
        (
            lambda: service._coerce_oid("IF-MIB::ifDescr.1", bundle=None),
            "Symbolic object identifiers require an active bundle",
        ),
        (
            lambda: service._parse_numeric_oid("1..3"),
            "OID values must be dotted numeric strings",
        ),
        (
            lambda: service._decode_binary_payload("", encoding="hex"),
            "payload must be a non-empty string",
        ),
        (
            lambda: asyncio.run(service.list_notification_events(limit=0)),
            "limit must be at least 1",
        ),
        (
            lambda: asyncio.run(
                service.decode_notification_payload(
                    payload="4142",
                    encoding="hex",
                    source_host="127.0.0.1",
                )
            ),
            "source_host and source_port must be provided together",
        ),
    ]

    for invoke, message in invalid_cases:
        with pytest.raises(RuntimeServiceError, match=message):
            invoke()

    async def fake_send_trap(**kwargs):
        return {"operation": "trap", "target": kwargs["host"], "varbinds": kwargs["varbinds"]}

    async def fake_send_inform(**kwargs):
        return {"operation": "inform", "target": kwargs["host"], "varbinds": kwargs["varbinds"]}

    monkeypatch.setattr(service, "send_trap", fake_send_trap)
    monkeypatch.setattr(service, "send_inform", fake_send_inform)

    service.history_service.get_event = lambda event_id: {
        "id": event_id,
        "event": {
            "direction": "received",
            "pdu_type": "snmpv2-trap",
            "community": "public",
            "target": {"host": "198.51.100.7", "port": 20162, "timeout": 4.0, "retries": 2},
            "notification_name": "IF-MIB::linkDown",
            "uptime": 12,
            "varbinds": [
                {"oid": "1.3.6.1.2.1.1.3.0", "value": {"type": "timeticks", "value": 12}},
                {"symbolic": "IF-MIB::ifDescr.1", "value": {"type": "octet-string", "value": "eth0"}},
            ],
        },
    }
    replayed_trap = asyncio.run(service.replay_notification_event(event_id=5))
    assert replayed_trap["replayed_from_event_id"] == 5
    assert replayed_trap["operation"] == "trap"
    assert replayed_trap["varbinds"] == [
        {"target": "IF-MIB::ifDescr.1", "value": {"type": "octet-string", "value": "eth0"}}
    ]

    service.history_service.get_event = lambda event_id: {
        "id": event_id,
        "event": {
            "direction": "sent",
            "pdu_type": "inform-request",
            "community": "public",
            "target_address": {"host": "198.51.100.9", "port": 2162},
            "notification_oid": "1.3.6.1.6.3.1.1.5.4",
            "uptime": 5,
            "varbinds": [],
        },
    }
    replayed_inform = asyncio.run(
        service.replay_notification_event(
            event_id=6,
            host="203.0.113.8",
            port=3162,
            community="lab",
            timeout=3.0,
            retries=0,
        )
    )
    assert replayed_inform["operation"] == "inform"
    assert replayed_inform["target"] == "203.0.113.8"

    invalid_replay_events = [
        (
            {"event": {"pdu_type": "response"}},
            "Stored notification event cannot be replayed because its PDU type is unsupported.",
        ),
        (
            {"event": {"pdu_type": "snmpv2-trap", "community": "public", "target": {"port": 162}}},
            "Replay requires a target host.",
        ),
        (
            {
                "event": {
                    "pdu_type": "snmpv2-trap",
                    "target": {"host": "127.0.0.1", "port": "bad"},
                    "community": "public",
                }
            },
            "Replay target port must be a valid integer.",
        ),
        (
            {
                "event": {
                    "pdu_type": "snmpv2-trap",
                    "target": {"host": "127.0.0.1", "port": 70000},
                    "community": "public",
                }
            },
            "Replay target port must be between 1 and 65535.",
        ),
        (
            {"event": {"pdu_type": "snmpv2-trap", "target": {"host": "127.0.0.1", "port": 162}}},
            "Replay requires a community string.",
        ),
        (
            {
                "event": {
                    "pdu_type": "snmpv2-trap",
                    "target": {"host": "127.0.0.1", "port": 162, "timeout": "bad"},
                    "community": "public",
                }
            },
            "Replay timeout must be a valid number.",
        ),
        (
            {
                "event": {
                    "pdu_type": "snmpv2-trap",
                    "target": {"host": "127.0.0.1", "port": 162, "timeout": 0},
                    "community": "public",
                }
            },
            "Replay timeout must be greater than 0.",
        ),
        (
            {
                "event": {
                    "pdu_type": "snmpv2-trap",
                    "target": {"host": "127.0.0.1", "port": 162, "retries": "bad"},
                    "community": "public",
                }
            },
            "Replay retries must be a valid integer.",
        ),
        (
            {
                "event": {
                    "pdu_type": "snmpv2-trap",
                    "target": {"host": "127.0.0.1", "port": 162, "retries": -1},
                    "community": "public",
                }
            },
            "Replay retries must be zero or greater.",
        ),
        (
            {
                "event": {
                    "pdu_type": "snmpv2-trap",
                    "target": {"host": "127.0.0.1", "port": 162},
                    "community": "public",
                    "uptime": -1,
                }
            },
            "Stored notification event has an invalid uptime value.",
        ),
    ]

    for payload, message in invalid_replay_events:
        service.history_service.get_event = (
            lambda event_id, payload=payload: {"id": event_id, **payload}
        )
        with pytest.raises(RuntimeServiceError, match=message):
            asyncio.run(service.replay_notification_event(event_id=99))


def _build_v2c_get_datagram(*, version: int = 1, community: str = "public") -> bytes:
    from trishul_snmp.wire.message import SnmpMessage, encode_message
    from trishul_snmp.wire.pdu import Pdu, PduType, build_null_varbinds

    return encode_message(
        SnmpMessage(
            version=version,
            community=community,
            pdu=Pdu(
                pdu_type=PduType.GET,
                request_id=7,
                error_status=0,
                error_index=0,
                varbinds=build_null_varbinds(((1, 3, 6, 1, 2, 1, 1, 5, 0),)),
            ),
        )
    )


def _stub_responder_server(service, datagrams):
    from types import SimpleNamespace

    responder = service._create_responder(
        host="127.0.0.1",
        port=0,
        communities=["public"],
        source=None,
        objects=(),
        bundle=None,
    )
    sent: list[object] = []

    class _FakeDatagram:
        source_address = ("127.0.0.1", 50001)

        def __init__(self, data):
            self.data = data

    received = [_FakeDatagram(item) for item in datagrams]

    async def fake_receive():
        if not received:
            raise RuntimeError("no more datagrams")
        return received.pop(0)

    async def fake_sendto(encoded, address):
        sent.append((encoded, address))

    responder._server = SimpleNamespace(receive=fake_receive, sendto=fake_sendto)
    responder._communities = ["public"]
    return responder, sent


def test_responder_survives_encode_failure_and_records_last_error(isolated_db):
    from app.services.runtime import RuntimeService
    from trishul_snmp.errors import ProtocolError

    service = RuntimeService(isolated_db["settings"])
    responder, _sent = _stub_responder_server(service, [_build_v2c_get_datagram()])

    def broken_build(message):
        del message
        raise ProtocolError("value cannot be encoded")

    responder._build_response_message = broken_build

    # The encode failure must not terminate the service loop; the fake server
    # exhausting its datagrams ends the loop instead.
    with pytest.raises(RuntimeError, match="no more datagrams"):
        asyncio.run(responder.handle_request())
    assert "could not be encoded" in (service._responder_last_error or "")


def test_responder_drops_snmpv1_traffic_at_the_boundary(isolated_db):
    from app.services.runtime import RuntimeService

    service = RuntimeService(isolated_db["settings"])
    responder, sent = _stub_responder_server(service, [_build_v2c_get_datagram(version=0)])

    with pytest.raises(RuntimeError, match="no more datagrams"):
        asyncio.run(responder.handle_request())
    assert sent == []


def test_start_responder_resets_request_counters_and_last_activity(isolated_db, monkeypatch):
    from app.services import runtime as runtime_module
    from app.services.runtime import RuntimeService

    _activate_runtime_bundle(isolated_db)

    class FakeResponder:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.local_address = (kwargs.get("host") or "127.0.0.1", kwargs.get("port") or 0)
            self.closed = False

        async def open(self):
            return None

        async def close(self):
            self.closed = True

        async def serve_forever(self):
            while not self.closed:
                await asyncio.sleep(0.05)

    monkeypatch.setattr(runtime_module, "V2cResponder", FakeResponder)

    async def scenario():
        service = RuntimeService(isolated_db["settings"])
        service._responder_request_count = 42
        service._responder_last_activity = "2026-10-05T00:00:00+00:00"
        await service.start_responder(
            host="127.0.0.1",
            port=1163,
            communities=["public"],
            objects=[
                {
                    "target": "SNMPv2-MIB::sysName.0",
                    "value": {"type": "octet-string", "value": "demo"},
                }
            ],
        )
        assert service._responder_request_count == 0
        assert service._responder_last_activity is None
        await service.stop_responder()

    asyncio.run(scenario())


def test_start_responder_failure_on_new_port_keeps_running_responder(isolated_db, monkeypatch):
    from app.services import runtime as runtime_module
    from app.services.runtime import RuntimeService, RuntimeServiceError

    _activate_runtime_bundle(isolated_db)

    class FlakyResponder:
        instances: list["FlakyResponder"] = []

        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.closed = False
            self.local_address = (kwargs.get("host") or "127.0.0.1", kwargs.get("port") or 0)
            FlakyResponder.instances.append(self)

        async def open(self):
            if len(FlakyResponder.instances) > 1:
                raise OSError("address already in use")
            return None

        async def close(self):
            self.closed = True

        async def serve_forever(self):
            while not self.closed:
                await asyncio.sleep(0.05)

    monkeypatch.setattr(runtime_module, "V2cResponder", FlakyResponder)

    async def scenario():
        service = RuntimeService(isolated_db["settings"])
        await service.start_responder(
            host="127.0.0.1",
            port=2161,
            communities=["public"],
            objects=[],
        )
        running = service._responder
        assert running is not None

        with pytest.raises(RuntimeServiceError, match="address already in use"):
            await service.start_responder(
                host="127.0.0.1",
                port=2162,
                communities=["public"],
                objects=[],
            )

        # A failed bind on a NEW address must not tear down the running responder.
        assert service._responder is running
        assert not running.closed
        await service.stop_responder()

    asyncio.run(scenario())


def test_start_responder_swap_stops_old_responder_on_new_port(isolated_db, monkeypatch):
    from app.services import runtime as runtime_module
    from app.services.runtime import RuntimeService

    _activate_runtime_bundle(isolated_db)

    class SwapResponder:
        instances: list["SwapResponder"] = []

        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.closed = False
            self.local_address = (kwargs.get("host") or "127.0.0.1", kwargs.get("port") or 0)
            SwapResponder.instances.append(self)

        async def open(self):
            return None

        async def close(self):
            self.closed = True

        async def serve_forever(self):
            while not self.closed:
                await asyncio.sleep(0.05)

    monkeypatch.setattr(runtime_module, "V2cResponder", SwapResponder)

    async def scenario():
        service = RuntimeService(isolated_db["settings"])
        await service.start_responder(
            host="127.0.0.1",
            port=3161,
            communities=["public"],
            objects=[],
        )
        first = service._responder
        assert first is not None

        # A successful start on a NEW address must swap the old responder out.
        await service.start_responder(
            host="127.0.0.1",
            port=3162,
            communities=["public"],
            objects=[],
        )
        second = service._responder
        assert second is not None
        assert second is not first
        assert first.closed
        assert service._responder_binding.port == 3162
        assert service._responder_binding.host == "127.0.0.1"

        # stop_responder stops exactly one responder (the new one).
        assert len(SwapResponder.instances) == 2
        assert not second.closed
        await service.stop_responder()
        assert second.closed
        assert service._responder is None

    asyncio.run(scenario())


def test_start_listener_failure_on_new_port_keeps_running_listener(isolated_db, monkeypatch):
    from app.services import runtime as runtime_module
    from app.services.runtime import RuntimeService, RuntimeServiceError

    _activate_runtime_bundle(isolated_db)

    class FlakyListener:
        instances: list["FlakyListener"] = []

        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.closed = False
            self.local_address = (kwargs.get("host") or "127.0.0.1", kwargs.get("port") or 0)
            FlakyListener.instances.append(self)

        async def open(self):
            if len(FlakyListener.instances) > 1:
                raise OSError("address already in use")
            return None

        async def close(self):
            self.closed = True

        def __aiter__(self):
            return self

        async def __anext__(self):
            while not self.closed:
                await asyncio.sleep(0.05)
            raise StopAsyncIteration

    monkeypatch.setattr(runtime_module, "V2cNotificationListener", FlakyListener)

    async def scenario():
        service = RuntimeService(isolated_db["settings"])
        await service.start_listener(host="127.0.0.1", port=2163, communities=["public"])
        running = service._listener
        assert running is not None

        with pytest.raises(RuntimeServiceError, match="address already in use"):
            await service.start_listener(host="127.0.0.1", port=2164, communities=["public"])

        assert service._listener is running
        assert not running.closed
        await service.stop_listener()

    asyncio.run(scenario())


def test_responder_state_reports_restart_required_when_bundle_changed(isolated_db, monkeypatch):
    from app.services import runtime as runtime_module
    from app.services.runtime import RuntimeBinding, RuntimeService

    active_bundle = _activate_runtime_bundle(isolated_db)

    class FakeResponder:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.local_address = (kwargs.get("host") or "127.0.0.1", kwargs.get("port") or 0)
            self.closed = False

        async def open(self):
            return None

        async def close(self):
            self.closed = True

        async def serve_forever(self):
            while not self.closed:
                await asyncio.sleep(0.05)

    monkeypatch.setattr(runtime_module, "V2cResponder", FakeResponder)

    async def scenario():
        service = RuntimeService(isolated_db["settings"])
        await service.start_responder(
            host="127.0.0.1",
            port=1165,
            communities=["public"],
            objects=[],
        )
        state = await service.get_state()
        assert state["responder"]["restart_required"] is False

        # The active bundle changed underneath the responder (recompile/activate).
        async with service._lock:
            service._responder_binding = RuntimeBinding(
                host="127.0.0.1",
                port=1165,
                communities=("public",),
                bundle_set_id=active_bundle["id"] + 999,
            )
        state = await service.get_state()
        assert state["responder"]["restart_required"] is True
        await service.stop_responder()

    asyncio.run(scenario())


def test_get_responder_status_is_lightweight_and_reports_restart_required(isolated_db, monkeypatch):
    """SIM-13: the status endpoint must not pay for full object/rule serialization."""
    from app.services import runtime as runtime_module
    from app.services.runtime import RuntimeBinding, RuntimeService

    active_bundle = _activate_runtime_bundle(isolated_db)

    class FakeResponder:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.local_address = (kwargs.get("host") or "127.0.0.1", kwargs.get("port") or 0)
            self.closed = False

        async def open(self):
            return None

        async def close(self):
            self.closed = True

        async def serve_forever(self):
            while not self.closed:
                await asyncio.sleep(0.05)

    monkeypatch.setattr(runtime_module, "V2cResponder", FakeResponder)

    async def scenario():
        service = RuntimeService(isolated_db["settings"])
        await service.start_responder(
            host="127.0.0.1",
            port=1165,
            communities=["public"],
            objects=[{"target": "1.3.6.1.2.1.1.1.0", "value": {"type": "octet-string", "value": "x"}}],
        )
        status = await service.get_responder_status()
        # Scalars the simulator status payload consumes.
        assert status["running"] is True
        assert status["port"] == 1165
        assert status["communities"] == ["public"]
        assert status["request_count"] == 0
        assert status["restart_required"] is False
        # The lightweight view must not serialize every configured object/rule.
        assert status["configured_objects"] is None
        assert status["configured_rules"] is None
        assert status["configured_object_count"] is None
        await service.stop_responder()

    asyncio.run(scenario())
