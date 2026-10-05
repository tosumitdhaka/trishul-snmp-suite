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
