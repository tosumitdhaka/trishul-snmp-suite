from __future__ import annotations

import asyncio
import base64
import binascii
from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select

from app.core.config import Settings, get_settings
from app.core.logging import emit_backend_log
from app.db.session import create_session_factory
from app.models import BundleSet
from app.services.history import EventHistoryService, EventHistoryServiceError
from app.services.mib_metadata import constraint_violation, effective_constraints
from app.services.realtime import (
    broadcast_stats,
    broadcast_trap_event,
    schedule_simulator_log_broadcast,
    schedule_stats_broadcast,
)
from trishul_snmp.errors import (
    BundleValidationError,
    ProtocolError,
    TransportError,
    UnknownOidError,
    UnknownSymbolError,
)
from trishul_snmp import (
    CounterRule,
    InMemoryObjectSource,
    RandomNumericRule,
    SimulationRule,
    TimestampRule,
    UptimeRule,
)
from trishul_snmp.manager import V2cManager
from trishul_snmp.mib import MibBundle, load_bundle
from trishul_snmp.mib.render import enrich_varbinds
from trishul_snmp.notify import NotificationEvent, V2cNotificationListener, V2cNotifier, decode_notification
from trishul_snmp.responder import V2cResponder
from trishul_snmp.types import (
    Counter32Value,
    Counter64Value,
    EndOfMibViewValue,
    Gauge32Value,
    IntegerValue,
    IpAddressValue,
    NoSuchInstanceValue,
    NoSuchObjectValue,
    NullValue,
    ObjectIdentifierValue,
    OctetStringValue,
    OpaqueValue,
    Response,
    SnmpValueType,
    TimeTicksValue,
    VarBind,
)
from trishul_snmp.wire.message import (
    SNMP_V2C_VERSION,
    SnmpMessage,
    decode_message,
    encode_message,
)

EVENT_BUFFER_LIMIT = 200
_RULE_KIND_ALIASES = {
    "random-range": "random",
    "random_int": "random",
    "random-int": "random",
    "counter-increment": "counter",
}
_NUMERIC_RULE_VALUE_TYPES = {
    "integer",
    "counter32",
    "gauge32",
    "timeticks",
    "counter64",
}
_TIMESTAMP_RULE_FORMATS = {"iso8601", "unix", "unix-ms"}
_BYTE_ENCODINGS = {"utf-8", "text", "hex", "base64"}
_SNMP_VALUE_ALIASES = {
    "int": "integer",
    "integer32": "integer",
    "string": "octet-string",
    "octets": "octet-string",
    "octet_string": "octet-string",
    "octetstring": "octet-string",
    "oid": "object-identifier",
    "object_identifier": "object-identifier",
    "objectidentifier": "object-identifier",
    "ip": "ip-address",
    "ipaddress": "ip-address",
    "counter": "counter32",
    "gauge": "gauge32",
    "time-ticks": "timeticks",
    "ticks": "timeticks",
}
_SYS_UPTIME_INSTANCE_OID = (1, 3, 6, 1, 2, 1, 1, 3, 0)
_SNMP_TRAP_OID_INSTANCE_OID = (1, 3, 6, 1, 6, 3, 1, 1, 4, 1, 0)
_SIMULATOR_PDU_LABELS = {
    "GET": "GET",
    "GET_NEXT": "GETNEXT",
    "GET_BULK": "GETBULK",
    "SET": "SET",
}


class RuntimeServiceError(RuntimeError):
    """Raised when runtime control operations fail."""


@dataclass(slots=True)
class RuntimeObjectSpec:
    target: str
    oid: tuple[int, ...]
    value: SnmpValueType


@dataclass(slots=True)
class RuntimeBinding:
    host: str
    port: int
    communities: tuple[str, ...] | None
    bundle_set_id: int | None


@dataclass(slots=True)
class RuntimeRuleSpec:
    """Metadata wrapper around a tsnmp SimulationRule for serialization."""
    target: str
    oid: tuple[int, ...]
    kind: str
    definition: dict[str, Any]
    rule: SimulationRule | SnmpValueType


class _TimestampStringRule:
    """String-output timestamp rule for iso8601 and unix-ms formats not in tsnmp."""

    def __init__(self, *, format_name: str) -> None:
        self.format_name = format_name

    def get_value(self) -> SnmpValueType:
        now = datetime.now(timezone.utc)
        if self.format_name == "iso8601":
            text = now.isoformat()
        else:
            text = str(int(now.timestamp() * 1000))
        return OctetStringValue(text.encode("utf-8"))


def _community_allowed(
    communities: frozenset[str] | None,
    *,
    community: str,
) -> bool:
    return communities is None or community in communities


def _value_type_class(value_type: str):
    return {
        "integer": IntegerValue,
        "counter32": Counter32Value,
        "gauge32": Gauge32Value,
        "timeticks": TimeTicksValue,
        "counter64": Counter64Value,
    }[value_type]


class RuntimeService:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.session_factory = create_session_factory(self.settings.database_url)
        self.history_service = EventHistoryService(self.settings)

        self._lock = asyncio.Lock()
        self._responder: V2cResponder | None = None
        self._responder_task: asyncio.Task[None] | None = None
        self._responder_binding: RuntimeBinding | None = None
        self._responder_source: InMemoryObjectSource | None = None
        self._responder_objects: list[RuntimeObjectSpec] = []
        self._responder_rules: list[RuntimeRuleSpec] = []
        self._responder_last_error: str | None = None
        self._responder_request_count = 0
        self._responder_last_activity: str | None = None

        self._listener: V2cNotificationListener | None = None
        self._listener_task: asyncio.Task[None] | None = None
        self._listener_binding: RuntimeBinding | None = None
        self._listener_last_error: str | None = None

        self._recent_events: deque[dict[str, Any]] = deque(maxlen=EVENT_BUFFER_LIMIT)
        self._simulator_activity: deque[dict[str, Any]] = deque(maxlen=EVENT_BUFFER_LIMIT)

    async def shutdown(self) -> None:
        await self._shutdown_responder()
        await self._shutdown_listener()

    async def get_state(self) -> dict[str, Any]:
        active_bundle = self._get_active_bundle_identity()
        async with self._lock:
            responder = self._serialize_binding_state(
                binding=self._responder_binding,
                running=self._responder is not None and self._responder_task is not None and not self._responder_task.done(),
                local_address=self._responder.local_address if self._responder is not None else None,
                last_error=self._responder_last_error,
                configured_objects=[self._serialize_runtime_object(spec) for spec in self._responder_objects],
                configured_rules=[self._serialize_runtime_rule(spec) for spec in self._responder_rules],
                active_bundle=active_bundle,
            )
            responder["request_count"] = self._responder_request_count
            responder["last_activity"] = self._responder_last_activity
            responder["restart_required"] = (
                responder["running"]
                and self._responder_binding is not None
                and self._responder_binding.bundle_set_id is not None
                and active_bundle is not None
                and self._responder_binding.bundle_set_id != active_bundle.get("id")
            )
            listener = self._serialize_binding_state(
                binding=self._listener_binding,
                running=self._listener is not None and self._listener_task is not None and not self._listener_task.done(),
                local_address=self._listener.local_address if self._listener is not None else None,
                last_error=self._listener_last_error,
                configured_objects=None,
                configured_rules=None,
                active_bundle=active_bundle,
            )
            last_event = self._recent_events[-1] if self._recent_events else None

        return {
            "active_bundle": active_bundle,
            "responder": responder,
            "notifications": {
                "listener": listener,
                "recent_event_count": len(self._recent_events),
                "last_event": last_event,
            },
        }

    async def get_responder_status(self) -> dict[str, Any]:
        """Lightweight responder scalars for the simulator status endpoint.

        Unlike :meth:`get_state`, this does not serialize the configured
        objects and rules (which the status payload discards anyway); it only
        carries the scalar fields the status endpoint actually consumes.
        """
        active_bundle = self._get_active_bundle_identity()
        async with self._lock:
            binding = self._responder_binding
            running = (
                self._responder is not None
                and self._responder_task is not None
                and not self._responder_task.done()
            )
            responder = self._serialize_binding_state(
                binding=binding,
                running=running,
                local_address=self._responder.local_address if self._responder is not None else None,
                last_error=self._responder_last_error,
                configured_objects=None,
                configured_rules=None,
                active_bundle=active_bundle,
            )
            responder["request_count"] = self._responder_request_count
            responder["last_activity"] = self._responder_last_activity
            responder["restart_required"] = (
                running
                and binding is not None
                and binding.bundle_set_id is not None
                and active_bundle is not None
                and binding.bundle_set_id != active_bundle.get("id")
            )
        return responder

    def _create_responder(
        self,
        *,
        host: str,
        port: int,
        communities: Sequence[str] | None,
        source: InMemoryObjectSource | None,
        objects: tuple[tuple[str, SnmpValueType], ...],
        bundle: MibBundle | None,
    ) -> V2cResponder:
        base_class = V2cResponder
        on_request = self._record_responder_request
        on_encode_error = self._record_responder_encode_error

        class ResponderWithActivity(base_class):
            def __init__(self, *, on_request=None, on_encode_error=None, **kwargs):
                super().__init__(**kwargs)
                self._on_request = on_request
                self._on_encode_error = on_encode_error

            async def handle_request(self):  # type: ignore[override]
                if not hasattr(self, "_server") or not hasattr(self, "_communities"):
                    return await super().handle_request()

                while True:
                    datagram = await self._server.receive()
                    try:
                        message = decode_message(datagram.data)
                    except ProtocolError:
                        continue
                    if message.version != SNMP_V2C_VERSION:
                        # The responder is v2c-only: answering an SNMPv1 request
                        # (including v1 GETBULK, which has no meaning in v1) with
                        # v2-only exception values would produce an invalid v1
                        # response, so v1 traffic is dropped at the boundary.
                        continue
                    if not _community_allowed(self._communities, community=message.community):
                        continue

                    try:
                        response = self._build_response_message(message)
                        if response is None:
                            continue
                        encoded = encode_message(response)
                    except ProtocolError:
                        # A simulated value that cannot be encoded must not
                        # terminate the service loop: record the failure so the
                        # operator can fix the offending object, then keep serving.
                        if self._on_encode_error is not None:
                            self._on_encode_error()
                        continue

                    await self._server.sendto(encoded, datagram.source_address)
                    if self._on_request is not None:
                        self._on_request(message, response)
                    return None

        return ResponderWithActivity(
            host=host,
            port=port,
            communities=communities,
            source=source,
            objects=objects,
            bundle=bundle,
            on_request=on_request,
            on_encode_error=on_encode_error,
        )

    async def start_responder(
        self,
        *,
        host: str = "0.0.0.0",
        port: int = 161,
        communities: Sequence[str] | None = None,
        objects: Sequence[dict[str, Any]] | None = None,
        rules: Sequence[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        bundle, active_bundle = self._load_active_bundle()
        prepared_objects = (
            self._parse_runtime_objects(objects, bundle=bundle)
            if objects is not None
            else await self._current_responder_objects()
        )
        prepared_rules = (
            self._parse_runtime_rules(rules, bundle=bundle)
            if rules is not None
            else await self._current_responder_rules()
        )

        normalized_communities = self._normalize_communities(communities)
        responder_source: InMemoryObjectSource | None = None
        responder: V2cResponder | None = None
        try:
            if prepared_rules:
                responder_source = InMemoryObjectSource(bundle=bundle)
                for spec in prepared_objects:
                    responder_source.set_object(spec.oid, spec.value)
                for spec in prepared_rules:
                    rule_or_value = spec.rule
                    responder_source.set_object(spec.oid, rule_or_value)
            responder = self._create_responder(
                host=host,
                port=port,
                communities=normalized_communities,
                source=responder_source,
                objects=() if responder_source is not None else self._runtime_object_inputs(prepared_objects),
                bundle=bundle,
            )
            try:
                await responder.open()
            except (OSError, ProtocolError, RuntimeError, TransportError, ValueError):
                # The only expected bind conflict is a responder already bound
                # to this exact address (restart-in-place). Free it and retry
                # the bind once; a failure on a NEW address leaves the running
                # responder untouched.
                if not await self._same_responder_address(host=host, port=port):
                    raise
                await self._shutdown_responder(clear_error=False)
                await responder.open()
        except (
            BundleValidationError,
            OSError,
            ProtocolError,
            RuntimeError,
            TransportError,
            UnknownSymbolError,
            ValueError,
        ) as exc:
            if responder is not None and hasattr(responder, "close"):
                try:
                    await responder.close()
                except (OSError, TransportError):
                    pass
            raise RuntimeServiceError(str(exc)) from exc

        # The new responder is bound and ready — swap out the previous one so a
        # restart on a different address does not leave the old responder
        # serving stale objects on the old port.
        await self._shutdown_responder(clear_error=False)
        task = asyncio.create_task(
            self._run_responder(responder),
            name="trishul-runtime-responder",
        )
        async with self._lock:
            self._responder = responder
            self._responder_task = task
            self._responder_binding = RuntimeBinding(
                host=host,
                port=port,
                communities=normalized_communities,
                bundle_set_id=active_bundle["id"] if active_bundle is not None else None,
            )
            self._responder_source = responder_source
            self._responder_objects = list(prepared_objects)
            self._responder_rules = list(prepared_rules)
            self._responder_last_error = None
            self._responder_request_count = 0
            self._responder_last_activity = None

        state = await self.get_state()
        self._append_simulator_activity(
            {
                "level": "success",
                "message": f"Simulator started on UDP {port}",
                "request_type": "LIFECYCLE",
            }
        )
        return {
            "active_bundle": state["active_bundle"],
            "responder": state["responder"],
        }

    def _record_responder_request(self, request: SnmpMessage, response: SnmpMessage) -> None:
        self._responder_request_count += 1
        self._responder_last_activity = datetime.now(timezone.utc).isoformat()
        activity = self._build_simulator_activity_entry(request, response)
        self._append_simulator_activity(activity)
        self._emit_runtime_log(str(activity.get("message") or "Simulator request served."))
        schedule_stats_broadcast(settings=self.settings)

    def _record_responder_encode_error(self) -> None:
        message = (
            "Simulator response could not be encoded for a requested OID "
            "(invalid value in the configured objects); the request was dropped."
        )
        self._responder_last_error = message
        self._append_simulator_activity(
            {
                "level": "error",
                "message": message,
                "request_type": "REQUEST",
            }
        )
        self._emit_runtime_log(message, level="ERROR")

    async def _same_responder_address(self, *, host: str, port: int) -> bool:
        async with self._lock:
            binding = self._responder_binding
            return (
                binding is not None
                and binding.port == port
                and (binding.host == host or host in ("0.0.0.0", ""))
            )

    async def _same_listener_address(self, *, host: str, port: int) -> bool:
        async with self._lock:
            binding = self._listener_binding
            return (
                binding is not None
                and binding.port == port
                and (binding.host == host or host in ("0.0.0.0", ""))
            )

    async def stop_responder(self) -> dict[str, Any]:
        was_running = False
        async with self._lock:
            was_running = self._responder is not None and self._responder_task is not None and not self._responder_task.done()
        await self._shutdown_responder()
        state = await self.get_state()
        if was_running:
            self._append_simulator_activity(
                {
                    "level": "info",
                    "message": "Simulator stopped.",
                    "request_type": "LIFECYCLE",
                }
            )
        return {
            "active_bundle": state["active_bundle"],
            "responder": state["responder"],
        }

    async def set_responder_objects(
        self,
        *,
        objects: Sequence[dict[str, Any]],
        replace: bool = True,
    ) -> dict[str, Any]:
        bundle, active_bundle = self._load_active_bundle()
        prepared_objects = self._parse_runtime_objects(objects, bundle=bundle)

        async with self._lock:
            if self._responder_binding is not None and self._responder_binding.bundle_set_id is not None:
                if active_bundle is not None and active_bundle["id"] != self._responder_binding.bundle_set_id:
                    raise RuntimeServiceError(
                        "Responder is bound to an older active bundle. Restart it before changing objects."
                    )

            if replace:
                self._responder_objects = list(prepared_objects)
            else:
                self._responder_objects.extend(prepared_objects)

            responder = self._responder
            responder_source = self._responder_source
            configured_objects = list(self._responder_objects)

        if responder_source is not None:
            if replace:
                for spec in prepared_objects:
                    responder_source.set_object(spec.oid, spec.value)
            else:
                for spec in prepared_objects:
                    responder_source.set_object(spec.oid, spec.value)
        elif responder is not None:
            try:
                if replace:
                    responder.clear_objects()
                responder.set_objects(self._runtime_object_inputs(prepared_objects))
            except (ProtocolError, RuntimeError, UnknownSymbolError, ValueError) as exc:
                raise RuntimeServiceError(str(exc)) from exc

        state = await self.get_state()
        state["responder"]["configured_object_count"] = len(configured_objects)
        state["responder"]["configured_objects"] = [
            self._serialize_runtime_object(spec) for spec in configured_objects
        ]
        self._append_simulator_activity(
            {
                "level": "info",
                "message": f"Simulator object set updated ({len(configured_objects)} configured OIDs).",
                "request_type": "CONFIG",
                "oid_count": len(configured_objects),
            }
        )
        return {
            "active_bundle": state["active_bundle"],
            "responder": state["responder"],
        }

    async def manager_get(
        self,
        *,
        host: str,
        port: int = 161,
        community: str,
        timeout: float = 2.0,
        retries: int = 1,
        targets: Sequence[str],
    ) -> dict[str, Any]:
        return await self._run_manager_response(
            operation="get",
            host=host,
            port=port,
            community=community,
            timeout=timeout,
            retries=retries,
            targets=targets,
        )

    async def manager_get_next(
        self,
        *,
        host: str,
        port: int = 161,
        community: str,
        timeout: float = 2.0,
        retries: int = 1,
        targets: Sequence[str],
    ) -> dict[str, Any]:
        return await self._run_manager_response(
            operation="get-next",
            host=host,
            port=port,
            community=community,
            timeout=timeout,
            retries=retries,
            targets=targets,
        )

    async def manager_get_bulk(
        self,
        *,
        host: str,
        port: int = 161,
        community: str,
        timeout: float = 2.0,
        retries: int = 1,
        targets: Sequence[str],
        non_repeaters: int = 0,
        max_repetitions: int = 10,
    ) -> dict[str, Any]:
        return await self._run_manager_response(
            operation="get-bulk",
            host=host,
            port=port,
            community=community,
            timeout=timeout,
            retries=retries,
            targets=targets,
            non_repeaters=non_repeaters,
            max_repetitions=max_repetitions,
        )

    async def manager_walk(
        self,
        *,
        host: str,
        port: int = 161,
        community: str,
        timeout: float = 2.0,
        retries: int = 1,
        root: str,
        bulk: bool = True,
        max_repetitions: int = 10,
    ) -> dict[str, Any]:
        normalized_root = self._require_target(root, field_name="root")
        bundle, active_bundle = self._load_active_bundle()

        try:
            async with V2cManager(
                host=host,
                port=port,
                community=community,
                timeout=timeout,
                retries=retries,
                bundle=bundle,
            ) as manager:
                if bulk:
                    varbinds = await manager.bulkwalk(
                        normalized_root,
                        max_repetitions=max_repetitions,
                    )
                else:
                    varbinds = await manager.walk(
                        normalized_root,
                        bulk=False,
                        max_repetitions=max_repetitions,
                    )
        except (
            BundleValidationError,
            OSError,
            ProtocolError,
            RuntimeError,
            TransportError,
            UnknownSymbolError,
            ValueError,
        ) as exc:
            raise RuntimeServiceError(str(exc)) from exc

        return {
            "operation": "bulkwalk" if bulk else "walk",
            "active_bundle": active_bundle,
            "target": self._serialize_target(
                host=host,
                port=port,
                community=community,
                timeout=timeout,
                retries=retries,
            ),
            "root": normalized_root,
            "count": len(varbinds),
            "varbinds": [self._serialize_varbind(varbind) for varbind in varbinds],
        }

    async def start_listener(
        self,
        *,
        host: str = "0.0.0.0",
        port: int = 162,
        communities: Sequence[str] | None = None,
    ) -> dict[str, Any]:
        bundle, active_bundle = self._load_active_bundle()

        normalized_communities = self._normalize_communities(communities)

        # Bind the new listener socket first so a failed bind does not tear
        # down a running receiver; the existing listener is only swapped out
        # once the new socket is open.
        listener: V2cNotificationListener | None = None
        try:
            listener = V2cNotificationListener(
                host=host,
                port=port,
                communities=normalized_communities,
                bundle=bundle,
            )
            try:
                await listener.open()
            except (OSError, ProtocolError, RuntimeError, TransportError, ValueError):
                # The only expected conflict is a listener already bound to
                # this exact address (restart-in-place). Free it and retry once.
                if not await self._same_listener_address(host=host, port=port):
                    raise
                await self._shutdown_listener(clear_error=False)
                await listener.open()
        except (
            BundleValidationError,
            OSError,
            ProtocolError,
            RuntimeError,
            TransportError,
            UnknownSymbolError,
            ValueError,
        ) as exc:
            if listener is not None and hasattr(listener, "close"):
                try:
                    await listener.close()
                except (OSError, TransportError):
                    pass
            raise RuntimeServiceError(str(exc)) from exc

        await self._shutdown_listener(clear_error=False)
        task = asyncio.create_task(
            self._run_listener(listener),
            name="trishul-runtime-listener",
        )
        async with self._lock:
            self._listener = listener
            self._listener_task = task
            self._listener_binding = RuntimeBinding(
                host=host,
                port=port,
                communities=normalized_communities,
                bundle_set_id=active_bundle["id"] if active_bundle is not None else None,
            )
            self._listener_last_error = None

        state = await self.get_state()
        return {
            "active_bundle": state["active_bundle"],
            "listener": state["notifications"]["listener"],
        }

    async def stop_listener(self) -> dict[str, Any]:
        await self._shutdown_listener()
        state = await self.get_state()
        return {
            "active_bundle": state["active_bundle"],
            "listener": state["notifications"]["listener"],
        }

    async def send_trap(
        self,
        *,
        host: str,
        port: int = 162,
        community: str,
        notification: str,
        timeout: float = 2.0,
        retries: int = 1,
        uptime: int = 0,
        varbinds: Sequence[dict[str, Any]] = (),
    ) -> dict[str, Any]:
        bundle, active_bundle = self._load_active_bundle()
        normalized_notification = self._require_target(notification, field_name="notification")
        parsed_varbinds = self._parse_runtime_objects(varbinds, bundle=bundle)

        try:
            async with V2cNotifier(
                host=host,
                port=port,
                community=community,
                timeout=timeout,
                retries=retries,
                bundle=bundle,
            ) as notifier:
                request_id = await notifier.send_trap(
                    normalized_notification,
                    varbinds=self._runtime_object_inputs(parsed_varbinds),
                    uptime=uptime,
                )
        except (
            BundleValidationError,
            OSError,
            ProtocolError,
            RuntimeError,
            TransportError,
            UnknownSymbolError,
            ValueError,
        ) as exc:
            raise RuntimeServiceError(str(exc)) from exc

        event = await self._record_sent_event(
            operation="trap",
            bundle=bundle,
            active_bundle=active_bundle,
            host=host,
            port=port,
            community=community,
            timeout=timeout,
            retries=retries,
            notification=normalized_notification,
            uptime=uptime,
            parsed_varbinds=parsed_varbinds,
            request_id=request_id,
        )

        return {
            "operation": "trap",
            "active_bundle": active_bundle,
            "target": self._serialize_target(
                host=host,
                port=port,
                community=community,
                timeout=timeout,
                retries=retries,
            ),
            "notification": normalized_notification,
            "uptime": uptime,
            "request_id": request_id,
            "varbinds": [self._serialize_runtime_object(spec) for spec in parsed_varbinds],
            "event": event,
        }

    async def send_inform(
        self,
        *,
        host: str,
        port: int = 162,
        community: str,
        notification: str,
        timeout: float = 2.0,
        retries: int = 1,
        uptime: int = 0,
        varbinds: Sequence[dict[str, Any]] = (),
    ) -> dict[str, Any]:
        bundle, active_bundle = self._load_active_bundle()
        normalized_notification = self._require_target(notification, field_name="notification")
        parsed_varbinds = self._parse_runtime_objects(varbinds, bundle=bundle)

        try:
            async with V2cNotifier(
                host=host,
                port=port,
                community=community,
                timeout=timeout,
                retries=retries,
                bundle=bundle,
            ) as notifier:
                response = await notifier.send_inform(
                    normalized_notification,
                    varbinds=self._runtime_object_inputs(parsed_varbinds),
                    uptime=uptime,
                )
        except (
            BundleValidationError,
            OSError,
            ProtocolError,
            RuntimeError,
            TransportError,
            UnknownSymbolError,
            ValueError,
        ) as exc:
            raise RuntimeServiceError(str(exc)) from exc

        event = await self._record_sent_event(
            operation="inform",
            bundle=bundle,
            active_bundle=active_bundle,
            host=host,
            port=port,
            community=community,
            timeout=timeout,
            retries=retries,
            notification=normalized_notification,
            uptime=uptime,
            parsed_varbinds=parsed_varbinds,
            response=response,
        )

        return {
            "operation": "inform",
            "active_bundle": active_bundle,
            "target": self._serialize_target(
                host=host,
                port=port,
                community=community,
                timeout=timeout,
                retries=retries,
            ),
            "notification": normalized_notification,
            "uptime": uptime,
            "response": self._serialize_response(response),
            "varbinds": [self._serialize_runtime_object(spec) for spec in parsed_varbinds],
            "event": event,
        }

    async def replay_notification_event(
        self,
        *,
        event_id: int,
        host: str | None = None,
        port: int | None = None,
        community: str | None = None,
        timeout: float | None = None,
        retries: int | None = None,
    ) -> dict[str, Any]:
        try:
            stored_event = self.history_service.get_event(event_id)
        except EventHistoryServiceError as exc:
            raise RuntimeServiceError(str(exc)) from exc

        event_payload = stored_event.get("event")
        if not isinstance(event_payload, dict):
            raise RuntimeServiceError("Stored notification event payload is unavailable.")

        pdu_type = str(event_payload.get("pdu_type") or "").strip().lower()
        if pdu_type == "inform-request":
            operation = "inform"
        elif pdu_type == "snmpv2-trap":
            operation = "trap"
        else:
            raise RuntimeServiceError(
                "Stored notification event cannot be replayed because its PDU type is unsupported."
            )

        target = event_payload.get("target")
        if not isinstance(target, dict):
            target = {}
        target_address = event_payload.get("target_address")
        if not isinstance(target_address, dict):
            target_address = {}

        resolved_host = host or target.get("host") or target_address.get("host")
        if not isinstance(resolved_host, str) or not resolved_host.strip():
            raise RuntimeServiceError(
                "Replay requires a target host. Provide one or replay a sent event with a stored target."
            )

        stored_port = target.get("port")
        if stored_port is None:
            stored_port = target_address.get("port")
        try:
            resolved_port = int(port if port is not None else stored_port if stored_port is not None else 162)
        except (TypeError, ValueError) as exc:
            raise RuntimeServiceError("Replay target port must be a valid integer.") from exc
        if resolved_port < 1 or resolved_port > 65535:
            raise RuntimeServiceError("Replay target port must be between 1 and 65535.")

        resolved_community = community or target.get("community") or event_payload.get("community")
        if not isinstance(resolved_community, str) or not resolved_community.strip():
            raise RuntimeServiceError(
                "Replay requires a community string. Provide one or replay an event with a stored community."
            )

        stored_timeout = target.get("timeout")
        try:
            resolved_timeout = float(timeout if timeout is not None else stored_timeout if stored_timeout is not None else 2.0)
        except (TypeError, ValueError) as exc:
            raise RuntimeServiceError("Replay timeout must be a valid number.") from exc
        if resolved_timeout <= 0:
            raise RuntimeServiceError("Replay timeout must be greater than 0.")

        stored_retries = target.get("retries")
        try:
            resolved_retries = int(retries if retries is not None else stored_retries if stored_retries is not None else 1)
        except (TypeError, ValueError) as exc:
            raise RuntimeServiceError("Replay retries must be a valid integer.") from exc
        if resolved_retries < 0:
            raise RuntimeServiceError("Replay retries must be zero or greater.")

        raw_uptime = event_payload.get("uptime")
        if raw_uptime is None:
            resolved_uptime = 0
        else:
            try:
                resolved_uptime = int(raw_uptime)
            except (TypeError, ValueError) as exc:
                raise RuntimeServiceError("Stored notification event has an invalid uptime value.") from exc
            if resolved_uptime < 0:
                raise RuntimeServiceError("Stored notification event has an invalid uptime value.")

        notification_target = self._notification_target_from_event(event_payload)
        replay_varbinds = self._replay_varbind_inputs(event_payload)

        if operation == "inform":
            result = await self.send_inform(
                host=resolved_host.strip(),
                port=resolved_port,
                community=resolved_community.strip(),
                notification=notification_target,
                timeout=resolved_timeout,
                retries=resolved_retries,
                uptime=resolved_uptime,
                varbinds=replay_varbinds,
            )
        else:
            result = await self.send_trap(
                host=resolved_host.strip(),
                port=resolved_port,
                community=resolved_community.strip(),
                notification=notification_target,
                timeout=resolved_timeout,
                retries=resolved_retries,
                uptime=resolved_uptime,
                varbinds=replay_varbinds,
            )

        result["replayed_from_event_id"] = event_id
        result["replayed_from_direction"] = event_payload.get("direction")
        return result

    async def list_notification_events(self, *, limit: int = 50) -> dict[str, Any]:
        if limit < 1:
            raise RuntimeServiceError("limit must be at least 1")

        async with self._lock:
            items = list(self._recent_events)

        sliced = list(reversed(items[-limit:]))
        return {
            "total": len(items),
            "limit": limit,
            "items": sliced,
        }

    async def list_simulator_activity(self, *, limit: int = 100) -> dict[str, Any]:
        if limit < 1:
            raise RuntimeServiceError("limit must be at least 1")

        async with self._lock:
            items = list(self._simulator_activity)

        sliced = items[-limit:]
        return {
            "total": len(items),
            "limit": limit,
            "items": sliced,
        }

    async def clear_simulator_activity(self) -> dict[str, Any]:
        async with self._lock:
            self._simulator_activity.clear()
        return {"status": "cleared"}

    async def reset_responder_counters(self) -> dict[str, Any]:
        async with self._lock:
            self._responder_request_count = 0
            self._responder_last_activity = None
        return {"status": "reset"}

    async def decode_notification_payload(
        self,
        *,
        payload: str,
        encoding: str = "hex",
        source_host: str | None = None,
        source_port: int | None = None,
    ) -> dict[str, Any]:
        bundle, active_bundle = self._load_active_bundle()
        data = self._decode_binary_payload(payload, encoding=encoding)

        if (source_host is None) != (source_port is None):
            raise RuntimeServiceError("source_host and source_port must be provided together")

        source_address = None if source_host is None else (source_host, source_port)
        try:
            event = decode_notification(
                data,
                bundle=bundle,
                source_address=source_address,
            )
        except (BundleValidationError, ProtocolError, RuntimeError, UnknownSymbolError, ValueError) as exc:
            raise RuntimeServiceError(str(exc)) from exc

        serialized_event = self._serialize_event(
            event,
            direction="decoded",
        )
        decorated_event = self._persist_event(
            event_payload=serialized_event,
            bundle_set_id=active_bundle["id"] if active_bundle is not None else None,
            payload_hex=data.hex(),
        )
        async with self._lock:
            self._recent_events.append(decorated_event)

        return {
            "active_bundle": active_bundle,
            "event": decorated_event,
        }

    async def _run_responder(self, responder: V2cResponder) -> None:
        try:
            await responder.serve_forever()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            async with self._lock:
                if self._responder is responder:
                    self._responder_last_error = str(exc)
        finally:
            async with self._lock:
                if self._responder is responder:
                    self._responder = None
                    self._responder_task = None
                    self._responder_source = None

    async def _run_listener(self, listener: V2cNotificationListener) -> None:
        try:
            async for event in listener:
                event_payload = self._serialize_event(
                    event,
                    direction="received",
                )
                try:
                    from app.services.state_store import _TRAP_RESOLVE_MIBS_KEY
                    from app.services.state_store import get_state_store

                    snap = get_state_store().snapshot()
                    resolve_mibs = bool(snap.get(_TRAP_RESOLVE_MIBS_KEY, True))
                except Exception:
                    resolve_mibs = True
                event_payload["resolve_mibs"] = resolve_mibs
                decorated_event = self._persist_event(
                    event_payload=event_payload,
                    bundle_set_id=self._listener_binding.bundle_set_id if self._listener_binding is not None else None,
                )
                async with self._lock:
                    self._recent_events.append(decorated_event)
                try:
                    from app.services.bundle_state import get_bundle
                    from app.services.traps_service import _format_trap_event
                    trap_payload = _format_trap_event(
                        decorated_event, resolve_mibs=resolve_mibs, bundle=get_bundle()
                    )
                except Exception as exc:
                    self._emit_runtime_log(f"Failed to build live trap payload: {exc}", level="ERROR")
                else:
                    await broadcast_trap_event(trap_payload, settings=self.settings)
                await broadcast_stats(settings=self.settings)
                source = event_payload.get("source_address") or {}
                notification = event_payload.get("notification_name") or event_payload.get("notification_oid") or "trap"
                self._emit_runtime_log(
                    (
                        f"Received trap \"{notification}\" from "
                        f"{source.get('host') or '-'}:{source.get('port') or '-'} "
                        f"varbinds={len(event_payload.get('varbinds') or [])}"
                    ),
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            async with self._lock:
                if self._listener is listener:
                    self._listener_last_error = str(exc)
            self._emit_runtime_log(f"Trap listener error: {exc}", level="ERROR")
        finally:
            async with self._lock:
                if self._listener is listener:
                    self._listener = None
                    self._listener_task = None

    async def _shutdown_responder(self, *, clear_error: bool = True) -> None:
        async with self._lock:
            responder = self._responder
            task = self._responder_task
            self._responder = None
            self._responder_task = None
            self._responder_source = None
            if clear_error:
                self._responder_last_error = None

        if responder is not None:
            try:
                await responder.close()
            except (OSError, TransportError):
                pass
        if task is not None:
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def _shutdown_listener(self, *, clear_error: bool = True) -> None:
        async with self._lock:
            listener = self._listener
            task = self._listener_task
            self._listener = None
            self._listener_task = None
            if clear_error:
                self._listener_last_error = None

        if listener is not None:
            try:
                await listener.close()
            except (OSError, TransportError):
                pass
        if task is not None:
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def _current_responder_objects(self) -> list[RuntimeObjectSpec]:
        async with self._lock:
            return list(self._responder_objects)

    async def _current_responder_rules(self) -> list[RuntimeRuleSpec]:
        async with self._lock:
            return list(self._responder_rules)

    def _get_active_bundle_record(self) -> BundleSet | None:
        with self.session_factory() as session:
            stmt = (
                select(BundleSet)
                .order_by(BundleSet.is_active.desc(), BundleSet.id.desc())
                .limit(1)
            )
            return session.scalars(stmt).first()

    def _get_active_bundle_identity(self) -> dict[str, Any] | None:
        bundle = self._get_active_bundle_record()
        if bundle is None:
            return None
        return {
            "id": bundle.id,
            "bundle_key": bundle.bundle_key,
            "label": bundle.label,
            "status": bundle.status,
            "storage_path": bundle.storage_path,
        }

    def _load_active_bundle(self) -> tuple[MibBundle | None, dict[str, Any] | None]:
        bundle_record = self._get_active_bundle_record()
        if bundle_record is None:
            return None, None

        try:
            bundle = load_bundle(Path(bundle_record.storage_path))
        except BundleValidationError as exc:
            raise RuntimeServiceError(str(exc)) from exc

        return (
            bundle,
            {
                "id": bundle_record.id,
                "bundle_key": bundle_record.bundle_key,
                "label": bundle_record.label,
                "status": bundle_record.status,
                "storage_path": bundle_record.storage_path,
            },
        )

    async def _run_manager_response(
        self,
        *,
        operation: str,
        host: str,
        port: int,
        community: str,
        timeout: float,
        retries: int,
        targets: Sequence[str],
        non_repeaters: int = 0,
        max_repetitions: int = 10,
    ) -> dict[str, Any]:
        normalized_targets = [self._require_target(target, field_name="targets") for target in targets]
        bundle, active_bundle = self._load_active_bundle()

        try:
            async with V2cManager(
                host=host,
                port=port,
                community=community,
                timeout=timeout,
                retries=retries,
                bundle=bundle,
            ) as manager:
                if operation == "get":
                    response = await manager.get(*normalized_targets)
                elif operation == "get-next":
                    response = await manager.get_next(*normalized_targets)
                elif operation == "get-bulk":
                    response = await manager.get_bulk(
                        *normalized_targets,
                        non_repeaters=non_repeaters,
                        max_repetitions=max_repetitions,
                    )
                else:
                    raise RuntimeServiceError(f"Unsupported manager operation: {operation}")
        except (
            BundleValidationError,
            OSError,
            ProtocolError,
            RuntimeError,
            TransportError,
            UnknownSymbolError,
            ValueError,
        ) as exc:
            raise RuntimeServiceError(str(exc)) from exc

        return {
            "operation": operation,
            "active_bundle": active_bundle,
            "target": self._serialize_target(
                host=host,
                port=port,
                community=community,
                timeout=timeout,
                retries=retries,
            ),
            "targets": normalized_targets,
            "response": self._serialize_response(response),
        }

    def _parse_runtime_objects(
        self,
        specs: Sequence[dict[str, Any]],
        *,
        bundle: MibBundle | None,
    ) -> list[RuntimeObjectSpec]:
        parsed: list[RuntimeObjectSpec] = []
        for spec in specs:
            if not isinstance(spec, dict):
                raise RuntimeServiceError("Each object entry must be a JSON object")
            target = self._require_target(spec.get("target"), field_name="target")
            value = spec.get("value")
            if not isinstance(value, dict):
                raise RuntimeServiceError("Each object entry must include a JSON object value payload")
            oid = self._coerce_oid(target, bundle=bundle)
            try:
                parsed_value = self._parse_value_spec(value, bundle=bundle)
            except RuntimeServiceError as exc:
                raise RuntimeServiceError(f"{target}: {exc}") from exc
            self._validate_object_constraints(oid=oid, value=parsed_value, bundle=bundle)
            parsed.append(
                RuntimeObjectSpec(
                    target=target,
                    oid=oid,
                    value=parsed_value,
                )
            )
        return parsed

    def _validate_object_constraints(
        self,
        *,
        oid: tuple[int, ...] | None,
        value: SnmpValueType,
        bundle: MibBundle | None,
    ) -> None:
        """Reject integer/string values outside the node's declared constraints."""
        if bundle is None or oid is None:
            return
        constraints, name = self._constraints_for_oid(oid, bundle)
        if constraints is None:
            return
        if isinstance(value, (IntegerValue, Counter32Value, Counter64Value, Gauge32Value, TimeTicksValue)):
            candidate = value.value
        elif isinstance(value, OctetStringValue):
            candidate = value.value
        else:
            return
        message = constraint_violation(candidate, constraints)
        if message is not None:
            raise RuntimeServiceError(f"{name}: {message}")

    def _constraints_for_oid(
        self,
        oid: tuple[int, ...],
        bundle: MibBundle,
    ) -> tuple[dict[str, Any] | None, str]:
        try:
            match = bundle.lookup(oid)
            node = bundle.resolve_node(match.module, match.symbol)
        except Exception:
            return None, self._oid_to_str(oid) or "unknown object"
        if node is None:
            return None, self._oid_to_str(oid) or "unknown object"
        return effective_constraints(node, bundle=bundle), f"{match.module}::{match.symbol}"

    def _parse_runtime_rules(
        self,
        specs: Sequence[dict[str, Any]],
        *,
        bundle: MibBundle | None,
    ) -> list[RuntimeRuleSpec]:
        parsed: list[RuntimeRuleSpec] = []
        for spec in specs:
            if not isinstance(spec, dict):
                raise RuntimeServiceError("Each rule entry must be a JSON object")

            target = self._require_target(spec.get("target"), field_name="target")
            oid = self._coerce_oid(target, bundle=bundle)
            raw_kind = self._coerce_text(spec.get("kind"), field_name="kind").lower()
            kind = _RULE_KIND_ALIASES.get(raw_kind, raw_kind)

            if kind == "static":
                value_spec = spec.get("value")
                if not isinstance(value_spec, dict):
                    raise RuntimeServiceError("Static rules require a JSON value payload")
                rule_or_value = self._parse_value_spec(value_spec, bundle=bundle)
                definition = {
                    "target": target,
                    "kind": "static",
                    "value": value_spec,
                }
            elif kind == "random":
                value_type = self._normalize_numeric_rule_value_type(spec.get("value_type"), default="integer")
                minimum = self._coerce_int(spec.get("minimum"), field_name="minimum")
                maximum = self._coerce_int(spec.get("maximum"), field_name="maximum")
                if maximum < minimum:
                    raise RuntimeServiceError("random rules require maximum to be greater than or equal to minimum")
                rule_or_value = RandomNumericRule(
                    min=minimum,
                    max=maximum,
                    value_type=_value_type_class(value_type),
                )
                definition = {
                    "target": target,
                    "kind": "random",
                    "value_type": value_type,
                    "minimum": minimum,
                    "maximum": maximum,
                }
            elif kind == "counter":
                value_type = self._normalize_numeric_rule_value_type(spec.get("value_type"), default="counter32")
                start = self._coerce_uint(spec.get("start", 0), field_name="start")
                step = self._coerce_uint(spec.get("step", 1), field_name="step")
                wrap_at_raw = spec.get("wrap_at")
                wrap_at = None
                if wrap_at_raw is not None:
                    wrap_at = self._coerce_uint(wrap_at_raw, field_name="wrap_at")
                rule_or_value = CounterRule(
                    start=start,
                    increment=step,
                    value_type=_value_type_class(value_type),
                )
                definition = {
                    "target": target,
                    "kind": "counter",
                    "value_type": value_type,
                    "start": start,
                    "step": step,
                    "wrap_at": wrap_at,
                }
            elif kind == "timestamp":
                value_type = self._normalize_timestamp_rule_value_type(spec.get("value_type"))
                default_format = "iso8601" if value_type == "octet-string" else "unix"
                format_name = self._normalize_timestamp_rule_format(spec.get("format"), default=default_format)
                if value_type == "octet-string":
                    rule_or_value = _TimestampStringRule(format_name=format_name)
                else:
                    rule_or_value = TimestampRule(value_type=_value_type_class(value_type))
                definition = {
                    "target": target,
                    "kind": "timestamp",
                    "value_type": value_type,
                    "format": format_name,
                }
            elif kind == "uptime":
                value_type = self._normalize_numeric_rule_value_type(spec.get("value_type"), default="timeticks")
                base = self._coerce_uint(spec.get("base", 0), field_name="base")
                rule_or_value = UptimeRule()
                definition = {
                    "target": target,
                    "kind": "uptime",
                    "value_type": value_type,
                    "base": base,
                }
            else:
                raise RuntimeServiceError(
                    "Unsupported rule kind. Expected one of: static, random, counter, timestamp, uptime"
                )

            parsed.append(
                RuntimeRuleSpec(
                    target=target,
                    oid=oid,
                    kind=kind,
                    definition=definition,
                    rule=rule_or_value,
                )
            )

        return parsed

    def _parse_value_spec(self, spec: dict[str, Any], *, bundle: MibBundle | None) -> SnmpValueType:
        raw_type = spec.get("type")
        if not isinstance(raw_type, str) or not raw_type.strip():
            raise RuntimeServiceError("Value payload must include a non-empty type")

        value_type = _SNMP_VALUE_ALIASES.get(raw_type.strip().lower(), raw_type.strip().lower())
        value = spec.get("value")
        encoding = spec.get("encoding")
        if encoding is not None:
            if not isinstance(encoding, str) or encoding.strip().lower() not in _BYTE_ENCODINGS:
                raise RuntimeServiceError(
                    "encoding must be one of: utf-8, text, hex, base64"
                )
            encoding = encoding.strip().lower()

        if value_type == "integer":
            return IntegerValue(self._coerce_int(value, field_name="value"))
        if value_type == "octet-string":
            return OctetStringValue(self._decode_value_bytes(value, encoding or "utf-8"))
        if value_type == "null":
            return NullValue()
        if value_type == "object-identifier":
            return ObjectIdentifierValue(self._coerce_oid(value, bundle=bundle))
        if value_type == "ip-address":
            return IpAddressValue(self._coerce_text(value, field_name="value"))
        if value_type == "counter32":
            return Counter32Value(self._coerce_uint(value, field_name="value"))
        if value_type == "gauge32":
            return Gauge32Value(self._coerce_uint(value, field_name="value"))
        if value_type == "timeticks":
            return TimeTicksValue(self._coerce_uint(value, field_name="value"))
        if value_type == "opaque":
            return OpaqueValue(self._decode_value_bytes(value, encoding or "hex"))
        if value_type == "counter64":
            return Counter64Value(self._coerce_uint(value, field_name="value"))

        raise RuntimeServiceError(
            "Unsupported SNMP value type. Expected one of: "
            "integer, octet-string, null, object-identifier, ip-address, "
            "counter32, gauge32, timeticks, opaque, counter64"
        )

    def _decode_value_bytes(self, value: Any, encoding: str) -> bytes:
        normalized_encoding = encoding.strip().lower()
        if normalized_encoding in {"utf-8", "text"}:
            if isinstance(value, str):
                return value.encode("utf-8")
            if isinstance(value, (bytes, bytearray)):
                return bytes(value)
            if isinstance(value, list):
                try:
                    return bytes(value)
                except ValueError as exc:
                    raise RuntimeServiceError("Byte array values must contain integers from 0 to 255") from exc
            raise RuntimeServiceError("Text-encoded SNMP byte values must be a string or byte array")

        # Empty octet strings are valid SNMP values (including SIZE (0 | 6)
        # physical addresses). Encoded byte values require a string, but
        # must not inherit the non-empty check used for IPs and targets.
        if normalized_encoding in {"hex", "base64"} and not isinstance(value, str):
            raise RuntimeServiceError("value must be a string")

        if normalized_encoding == "hex":
            text = value.strip().replace(" ", "")
            if text.startswith("0x"):
                text = text[2:]
            try:
                return bytes.fromhex(text)
            except ValueError as exc:
                raise RuntimeServiceError("Hex-encoded byte values must contain valid hexadecimal text") from exc

        if normalized_encoding == "base64":
            text = value.strip()
            try:
                return base64.b64decode(text, validate=True)
            except binascii.Error as exc:
                raise RuntimeServiceError("Base64-encoded byte values must contain valid base64 text") from exc

        raise RuntimeServiceError("Unsupported byte encoding")

    def _normalize_numeric_rule_value_type(self, value: Any, *, default: str) -> str:
        if value is None:
            return default
        if not isinstance(value, str) or not value.strip():
            raise RuntimeServiceError("rule value_type must be a non-empty string")
        normalized = _SNMP_VALUE_ALIASES.get(value.strip().lower(), value.strip().lower())
        if normalized not in _NUMERIC_RULE_VALUE_TYPES:
            raise RuntimeServiceError(
                "Numeric rule value_type must be one of: integer, counter32, gauge32, timeticks, counter64"
            )
        return normalized

    def _normalize_timestamp_rule_value_type(self, value: Any) -> str:
        if value is None:
            return "octet-string"
        if not isinstance(value, str) or not value.strip():
            raise RuntimeServiceError("timestamp rule value_type must be a non-empty string")
        normalized = _SNMP_VALUE_ALIASES.get(value.strip().lower(), value.strip().lower())
        if normalized == "octet-string" or normalized in _NUMERIC_RULE_VALUE_TYPES:
            return normalized
        raise RuntimeServiceError(
            "timestamp rule value_type must be octet-string, integer, counter32, gauge32, timeticks, or counter64"
        )

    def _normalize_timestamp_rule_format(self, value: Any, *, default: str) -> str:
        if value is None:
            return default
        if not isinstance(value, str) or not value.strip():
            raise RuntimeServiceError("timestamp rule format must be a non-empty string")
        normalized = value.strip().lower()
        if normalized not in _TIMESTAMP_RULE_FORMATS:
            raise RuntimeServiceError("timestamp rule format must be one of: iso8601, unix, unix-ms")
        return normalized

    def _decode_binary_payload(self, payload: str, *, encoding: str) -> bytes:
        if not isinstance(payload, str) or not payload.strip():
            raise RuntimeServiceError("payload must be a non-empty string")
        return self._decode_value_bytes(payload, encoding.strip().lower())

    def _runtime_object_inputs(
        self,
        specs: Sequence[RuntimeObjectSpec],
    ) -> tuple[tuple[str, SnmpValueType], ...]:
        return tuple((spec.target, spec.value) for spec in specs)

    def _serialize_binding_state(
        self,
        *,
        binding: RuntimeBinding | None,
        running: bool,
        local_address: tuple[str, int] | tuple[str, int, int, int] | None,
        last_error: str | None,
        configured_objects: list[dict[str, Any]] | None,
        configured_rules: list[dict[str, Any]] | None,
        active_bundle: dict[str, Any] | None,
    ) -> dict[str, Any]:
        bundle_set_id = binding.bundle_set_id if binding is not None else None
        stale_bundle = (
            bundle_set_id is not None
            and active_bundle is not None
            and bundle_set_id != active_bundle["id"]
        )
        return {
            "running": running,
            "host": binding.host if binding is not None else None,
            "port": binding.port if binding is not None else None,
            "communities": list(binding.communities) if binding is not None and binding.communities is not None else None,
            "bundle_set_id": bundle_set_id,
            "stale_bundle": stale_bundle,
            "local_address": self._serialize_socket_address(local_address),
            "last_error": last_error,
            "configured_object_count": len(configured_objects) if configured_objects is not None else None,
            "configured_objects": configured_objects,
            "configured_rule_count": len(configured_rules) if configured_rules is not None else None,
            "configured_rules": configured_rules,
        }

    def _serialize_target(
        self,
        *,
        host: str,
        port: int,
        community: str,
        timeout: float,
        retries: int,
    ) -> dict[str, Any]:
        return {
            "host": host,
            "port": port,
            "community": community,
            "timeout": timeout,
            "retries": retries,
        }

    def _serialize_runtime_object(self, spec: RuntimeObjectSpec) -> dict[str, Any]:
        return {
            "target": spec.target,
            "value": self._serialize_value(spec.value),
        }

    def _serialize_runtime_rule(self, spec: RuntimeRuleSpec) -> dict[str, Any]:
        payload = dict(spec.definition)
        payload["resolved_oid"] = self._oid_to_str(spec.oid)
        return payload

    def _serialize_response(self, response: Response) -> dict[str, Any]:
        return {
            "request_id": response.request_id,
            "error_status": response.error_status.label,
            "error_status_code": int(response.error_status),
            "error_index": response.error_index,
            "varbinds": [self._serialize_varbind(varbind) for varbind in response.varbinds],
        }

    def _serialize_varbind(self, varbind: VarBind) -> dict[str, Any]:
        match = varbind.match
        return {
            "oid": self._oid_to_str(varbind.oid),
            "value_type": varbind.value_type,
            "value": self._serialize_value(varbind.value),
            "symbolic": varbind.display_name or (match.symbolic if match is not None else None),
            "display_value": varbind.display_value or varbind.value.to_display_string(),
            "enum_label": varbind.enum_label,
            "units": varbind.units,
            "match": None
            if match is None
            else {
                "module": match.module,
                "symbol": match.symbol,
                "symbolic": match.symbolic,
                "oid": self._oid_to_str(match.oid),
                "matched_oid": self._oid_to_str(match.matched_oid),
                "suffix": list(match.suffix),
                "class_name": match.class_name,
                "object_type": match.object_type,
                "nodetype": match.nodetype,
            },
        }

    def _serialize_value(self, value: SnmpValueType) -> dict[str, Any]:
        serialized: dict[str, Any] = {
            "type": value.type_name,
            "display": value.to_display_string(),
        }

        if isinstance(value, (IntegerValue, Counter32Value, Counter64Value, Gauge32Value, TimeTicksValue)):
            serialized["value"] = value.value
        elif isinstance(value, OctetStringValue):
            serialized["value"] = value.to_display_string()
            serialized["hex"] = value.value.hex()
        elif isinstance(value, OpaqueValue):
            serialized["value"] = value.value.hex()
            serialized["hex"] = value.value.hex()
        elif isinstance(value, ObjectIdentifierValue):
            serialized["value"] = self._oid_to_str(value.value)
        elif isinstance(value, IpAddressValue):
            serialized["value"] = value.value
        elif isinstance(value, (NullValue, NoSuchObjectValue, NoSuchInstanceValue, EndOfMibViewValue)):
            serialized["value"] = None
        else:
            serialized["value"] = None

        return serialized

    def _serialize_event(
        self,
        event: NotificationEvent,
        *,
        direction: str,
        received_at: str | None = None,
    ) -> dict[str, Any]:
        timestamp = received_at or datetime.now(timezone.utc).isoformat()
        return {
            "received_at": timestamp,
            "direction": direction,
            "request_id": event.request_id,
            "community": event.community,
            "pdu_type": event.pdu_type,
            "is_inform": event.is_inform,
            "source_address": self._serialize_socket_address(event.source_address),
            "target_address": None,
            "notification_oid": self._oid_to_str(event.notification_oid),
            "notification_name": event.notification_name,
            "notification_description": event.notification_description,
            "uptime": event.uptime,
            "varbinds": [self._serialize_varbind(varbind) for varbind in event.varbinds],
            "member_bindings": [
                {
                    "module": binding.member.module,
                    "symbol": binding.member.object,
                    "symbolic": binding.member.symbolic,
                    "varbind": self._serialize_varbind(binding.varbind) if binding.varbind is not None else None,
                }
                for binding in event.member_bindings
            ],
        }

    def _build_simulator_activity_entry(self, request: SnmpMessage, response: SnmpMessage) -> dict[str, Any]:
        request_varbinds = tuple(request.pdu.varbinds)
        response_varbinds = tuple(response.pdu.varbinds)
        requested_oids = [self._oid_to_str(item.oid) for item in request_varbinds]
        returned_oids = [
            self._oid_to_str(item.oid)
            for item in response_varbinds
            if not isinstance(item.value, EndOfMibViewValue)
        ]
        request_type = _SIMULATOR_PDU_LABELS.get(request.pdu.pdu_type.name, request.pdu.pdu_type.name)
        request_count = len(requested_oids)
        oid_count = len(returned_oids) or len(response_varbinds)
        first_requested = requested_oids[0] if requested_oids else None
        first_returned = returned_oids[0] if returned_oids else (
            self._oid_to_str(response_varbinds[0].oid) if response_varbinds else None
        )
        target = ""
        if first_requested and first_returned and first_requested != first_returned:
            target = f" from {first_requested} -> {first_returned}"
        elif first_requested:
            target = f" for {first_requested}"
        extra = ""
        if request_count > 1:
            extra = f" (+{request_count - 1} more requested)"
        now = datetime.now()
        oid_label = "OID" if oid_count == 1 else "OIDs"
        return {
            "time": now.strftime("%H:%M:%S"),
            "level": "info",
            "message": f"Simulator {request_type} simulated {oid_count} {oid_label}{target}{extra}",
            "request_type": request_type,
            "oid_count": oid_count,
            "request_count": request_count,
            "requested_oids": requested_oids,
            "returned_oids": returned_oids,
            "first_requested_oid": first_requested,
            "first_returned_oid": first_returned,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

    def _append_simulator_activity(self, entry: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(entry)
        timestamp = str(normalized.get("timestamp") or datetime.now(timezone.utc).isoformat())
        normalized["timestamp"] = timestamp
        normalized.setdefault("time", datetime.fromisoformat(timestamp).strftime("%H:%M:%S"))
        normalized.setdefault("level", "info")
        normalized.setdefault("message", "")
        self._simulator_activity.append(normalized)
        schedule_simulator_log_broadcast(normalized, settings=self.settings)
        return normalized

    async def _record_sent_event(
        self,
        *,
        operation: str,
        bundle: MibBundle | None,
        active_bundle: dict[str, Any] | None,
        host: str,
        port: int,
        community: str,
        timeout: float,
        retries: int,
        notification: str,
        uptime: int,
        parsed_varbinds: Sequence[RuntimeObjectSpec],
        request_id: int | None = None,
        response: Response | None = None,
    ) -> dict[str, Any]:
        event_payload = self._serialize_sent_event(
            operation=operation,
            bundle=bundle,
            host=host,
            port=port,
            community=community,
            timeout=timeout,
            retries=retries,
            notification=notification,
            uptime=uptime,
            parsed_varbinds=parsed_varbinds,
            request_id=request_id,
            response=response,
        )
        decorated_event = self._persist_event(
            event_payload=event_payload,
            bundle_set_id=active_bundle["id"] if active_bundle is not None else None,
        )
        async with self._lock:
            self._recent_events.append(decorated_event)
        schedule_stats_broadcast(settings=self.settings)
        return decorated_event

    def _serialize_sent_event(
        self,
        *,
        operation: str,
        bundle: MibBundle | None,
        host: str,
        port: int,
        community: str,
        timeout: float,
        retries: int,
        notification: str,
        uptime: int,
        parsed_varbinds: Sequence[RuntimeObjectSpec],
        request_id: int | None = None,
        response: Response | None = None,
    ) -> dict[str, Any]:
        notification_oid = self._coerce_oid(notification, bundle=bundle)
        notification_name = notification if "::" in notification else self._oid_to_str(notification_oid)
        notification_description = None
        declared_members = ()

        runtime_varbinds = tuple(
            VarBind(
                oid=spec.oid,
                value=spec.value,
            )
            for spec in parsed_varbinds
        )

        if bundle is not None:
            try:
                match = bundle.lookup(notification_oid)
            except UnknownOidError:
                match = None

            if match is not None and match.matched_oid == notification_oid and not match.suffix:
                notification_name = bundle.display_symbolic_from_match(match)
                node = bundle.resolve_node(match.module, match.symbol)
                if node is not None:
                    notification_description = node.description
                    declared_members = tuple(node.members or ())

            enriched_varbinds = enrich_varbinds(bundle, runtime_varbinds)
        else:
            enriched_varbinds = runtime_varbinds

        payload_varbinds = tuple(
            varbind
            for varbind in enriched_varbinds
            if varbind.oid not in {_SYS_UPTIME_INSTANCE_OID, _SNMP_TRAP_OID_INSTANCE_OID}
        )

        event_payload = {
            "received_at": datetime.now(timezone.utc).isoformat(),
            "direction": "sent",
            "operation": operation,
            "request_id": request_id if request_id is not None else response.request_id if response is not None else None,
            "community": community,
            "pdu_type": "inform-request" if operation == "inform" else "snmpv2-trap",
            "is_inform": operation == "inform",
            "source_address": None,
            "target_address": self._serialize_socket_address((host, port)),
            "target": self._serialize_target(
                host=host,
                port=port,
                community=community,
                timeout=timeout,
                retries=retries,
            ),
            "notification_oid": self._oid_to_str(notification_oid),
            "notification_name": notification_name,
            "notification_description": notification_description,
            "uptime": uptime,
            "varbinds": [self._serialize_varbind(varbind) for varbind in enriched_varbinds],
            "member_bindings": [
                {
                    "module": member.module,
                    "symbol": member.object,
                    "symbolic": member.symbolic,
                    "varbind": self._serialize_varbind(payload_varbinds[index])
                    if index < len(payload_varbinds)
                    else None,
                }
                for index, member in enumerate(declared_members)
            ],
        }
        if response is not None:
            event_payload["response"] = self._serialize_response(response)
        return event_payload

    def _notification_target_from_event(self, event_payload: dict[str, Any]) -> str:
        notification_name = event_payload.get("notification_name")
        if isinstance(notification_name, str) and notification_name.strip():
            return notification_name.strip()

        notification_oid = event_payload.get("notification_oid")
        if isinstance(notification_oid, str) and notification_oid.strip():
            return notification_oid.strip()

        raise RuntimeServiceError("Stored notification event is missing a notification target.")

    def _replay_varbind_inputs(self, event_payload: dict[str, Any]) -> list[dict[str, Any]]:
        raw_varbinds = event_payload.get("varbinds")
        if raw_varbinds is None:
            return []
        if not isinstance(raw_varbinds, list):
            raise RuntimeServiceError("Stored notification event has an invalid varbind payload.")

        filter_auto_varbinds = str(event_payload.get("direction") or "").strip().lower() != "sent"
        parsed_varbinds: list[dict[str, Any]] = []
        for item in raw_varbinds:
            if not isinstance(item, dict):
                raise RuntimeServiceError("Stored notification event has an invalid varbind payload.")

            target = item.get("oid") or item.get("symbolic")
            if not isinstance(target, str) or not target.strip():
                raise RuntimeServiceError("Stored notification event is missing a varbind target.")
            if filter_auto_varbinds and self._is_auto_notification_varbind(target):
                continue

            parsed_varbinds.append(
                {
                    "target": target.strip(),
                    "value": self._replay_value_input(item.get("value")),
                }
            )

        return parsed_varbinds

    def _replay_value_input(self, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise RuntimeServiceError("Stored notification event is missing a serialized value payload.")

        value_type = payload.get("type")
        if not isinstance(value_type, str) or not value_type.strip():
            raise RuntimeServiceError("Stored notification event is missing a serialized value type.")

        normalized_type = value_type.strip().lower()
        if normalized_type == "octet-string":
            if isinstance(payload.get("hex"), str):
                return {
                    "type": "octet-string",
                    "value": payload["hex"],
                    "encoding": "hex",
                }
            return {
                "type": "octet-string",
                "value": payload.get("value", ""),
            }

        if normalized_type == "opaque":
            hex_value = payload.get("hex")
            if not isinstance(hex_value, str):
                raise RuntimeServiceError("Stored notification event is missing opaque hex data.")
            return {
                "type": "opaque",
                "value": hex_value,
                "encoding": "hex",
            }

        return {
            "type": normalized_type,
            "value": payload.get("value"),
        }

    def _is_auto_notification_varbind(self, target: Any) -> bool:
        try:
            oid = self._coerce_oid(target, bundle=None)
        except RuntimeServiceError:
            return False
        return oid in {_SYS_UPTIME_INSTANCE_OID, _SNMP_TRAP_OID_INSTANCE_OID}

    def _persist_event(
        self,
        *,
        event_payload: dict[str, Any],
        bundle_set_id: int | None,
        payload_hex: str | None = None,
    ) -> dict[str, Any]:
        source_address = event_payload.get("source_address") or {}
        target_address = event_payload.get("target_address") or {}
        try:
            return self.history_service.record_event(
                direction=str(event_payload.get("direction") or "received"),
                pdu_type=str(event_payload.get("pdu_type") or ""),
                event=event_payload,
                bundle_set_id=bundle_set_id,
                request_id=event_payload.get("request_id"),
                community=event_payload.get("community"),
                source_host=source_address.get("host"),
                source_port=source_address.get("port"),
                target_host=target_address.get("host"),
                target_port=target_address.get("port"),
                notification_oid=event_payload.get("notification_oid"),
                notification_name=event_payload.get("notification_name"),
                notification_description=event_payload.get("notification_description"),
                uptime=event_payload.get("uptime"),
                payload_hex=payload_hex,
            )
        except Exception as exc:
            fallback = dict(event_payload)
            fallback["history_error"] = str(exc)
            return fallback

    def _emit_runtime_log(self, message: str, *, level: str = "INFO") -> None:
        emit_backend_log(
            message,
            level=level,
            logger_name="app.runtime",
            settings=self.settings,
        )

    def _serialize_socket_address(
        self,
        address: tuple[str, int] | tuple[str, int, int, int] | None,
    ) -> dict[str, Any] | None:
        if address is None:
            return None
        return {
            "host": address[0],
            "port": address[1],
        }

    def _normalize_communities(self, communities: Sequence[str] | None) -> tuple[str, ...] | None:
        if not communities:
            return None
        normalized = tuple(value.strip() for value in communities if isinstance(value, str) and value.strip())
        return normalized or None

    def _require_target(self, value: Any, *, field_name: str) -> str:
        if not isinstance(value, str) or not value.strip():
            raise RuntimeServiceError(f"{field_name} must contain a non-empty OID or symbolic target")
        return value.strip()

    def _coerce_text(self, value: Any, *, field_name: str) -> str:
        if not isinstance(value, str) or not value.strip():
            raise RuntimeServiceError(f"{field_name} must be a non-empty string")
        return value.strip()

    def _coerce_int(self, value: Any, *, field_name: str) -> int:
        if not isinstance(value, int) or isinstance(value, bool):
            raise RuntimeServiceError(f"{field_name} must be an integer")
        return value

    def _coerce_uint(self, value: Any, *, field_name: str) -> int:
        integer = self._coerce_int(value, field_name=field_name)
        if integer < 0:
            raise RuntimeServiceError(f"{field_name} must be zero or greater")
        return integer

    def _coerce_oid(self, value: Any, *, bundle: MibBundle | None) -> tuple[int, ...]:
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                raise RuntimeServiceError("value must contain a non-empty object identifier")
            if "::" in stripped:
                if bundle is None:
                    raise RuntimeServiceError("Symbolic object identifiers require an active bundle")
                try:
                    return bundle.resolve(stripped)
                except UnknownSymbolError as exc:
                    raise RuntimeServiceError(str(exc)) from exc
            return self._parse_numeric_oid(stripped)

        if isinstance(value, (list, tuple)):
            try:
                return tuple(int(part) for part in value)
            except (TypeError, ValueError) as exc:
                raise RuntimeServiceError("Object identifier arrays must contain integers") from exc

        raise RuntimeServiceError("value must be a dotted OID string, symbolic target, or integer array")

    def _parse_numeric_oid(self, value: str) -> tuple[int, ...]:
        stripped = value.lstrip(".")
        parts = stripped.split(".")
        if not stripped or any(not part for part in parts):
            raise RuntimeServiceError("OID values must be dotted numeric strings")
        try:
            return tuple(int(part) for part in parts)
        except ValueError as exc:
            raise RuntimeServiceError("OID values must be dotted numeric strings") from exc

    def _oid_to_str(self, value: Sequence[int] | None) -> str | None:
        if value is None:
            return None
        return ".".join(str(part) for part in value)


_runtime_service: RuntimeService | None = None


def get_runtime_service(settings: Settings | None = None) -> RuntimeService:
    global _runtime_service
    if _runtime_service is None:
        _runtime_service = RuntimeService(settings=settings)
    return _runtime_service


async def shutdown_runtime_service() -> None:
    global _runtime_service
    if _runtime_service is None:
        return
    service = _runtime_service
    _runtime_service = None
    await service.shutdown()


def reset_runtime_service() -> None:
    global _runtime_service
    _runtime_service = None
