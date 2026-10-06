from __future__ import annotations

import pytest

pytestmark = pytest.mark.unit


def _activate_browser_bundle(isolated_db):
    from app.services.bundle_state import get_bundle
    from app.services.bundles import BundleCompileRequest, BundleService

    settings = isolated_db["settings"]
    BundleService(settings).compile_bundle(
        BundleCompileRequest(mib_names=["IF-MIB", "SNMPv2-MIB"], activate=True)
    )

    bundle = get_bundle()
    assert bundle is not None
    return bundle


def test_search_treats_blank_filters_as_unset(isolated_db):
    from app.services import browser_service

    bundle = _activate_browser_bundle(isolated_db)

    payload = browser_service.search_bundle(
        query="ifDescr",
        module="",
        type_filter="",
        limit=10,
        bundle=bundle,
    )

    assert payload["count"] >= 1
    assert any(result["name"] == "ifDescr" for result in payload["results"])


def test_search_bundle_includes_notifications_ranked_and_type_filtered(isolated_db):
    # B-2: search must find NOTIFICATION-TYPE nodes, ranked exact full_name >
    # exact name > name prefix > substring, with the UI's "NotificationType"
    # type spelling; the NotificationType filter returns only notifications.
    from app.services import browser_service

    bundle = _activate_browser_bundle(isolated_db)

    results = browser_service.search_bundle(
        query="linkDown", module=None, type_filter=None, limit=30, bundle=bundle
    )["results"]
    assert results[0]["full_name"] == "IF-MIB::linkDown"
    assert results[0]["type"] == "NotificationType"

    # A symbolic full_name query resolves directly to the notification.
    exact = browser_service.search_bundle(
        query="IF-MIB::linkDown", module=None, type_filter=None, limit=30, bundle=bundle
    )["results"]
    assert [item["full_name"] for item in exact] == ["IF-MIB::linkDown"]

    # Exact-name ranking: "ifDescr" (an object) still ranks before any
    # description/substring hit.
    obj = browser_service.search_bundle(
        query="ifDescr", module=None, type_filter=None, limit=30, bundle=bundle
    )["results"]
    assert obj[0]["full_name"] == "IF-MIB::ifDescr"

    # NotificationType-filtered search returns only notifications.
    filtered = browser_service.search_bundle(
        query="linkDown", module=None, type_filter="NotificationType", limit=30, bundle=bundle
    )["results"]
    assert all(item["type"] == "NotificationType" for item in filtered)
    assert {item["full_name"] for item in filtered} == {"IF-MIB::linkDown"}


def test_node_notification_members_keep_enum_metadata(isolated_db):
    from app.services import browser_service

    bundle = _activate_browser_bundle(isolated_db)

    payload = browser_service.get_node("IF-MIB::linkDown", module=None, bundle=bundle)

    enum_member = next(
        (item for item in payload["trap_objects"] if item["full_name"] == "IF-MIB::ifAdminStatus"),
        None,
    )
    assert enum_member is not None
    assert enum_member["input_type"] == "Integer"
    assert enum_member["syntax"] == "INTEGER"
    assert enum_member["enum_values"] == [
        {"label": "up", "value": 1},
        {"label": "down", "value": 2},
        {"label": "testing", "value": 3},
    ]


def test_resolve_and_search_cover_symbolic_numeric_and_type_filtered_paths(isolated_db):
    from app.services import browser_service

    bundle = _activate_browser_bundle(isolated_db)

    symbolic = browser_service.resolve("IF-MIB::ifDescr", bundle=bundle)
    assert symbolic["resolved"] is True
    assert symbolic["output"].startswith("1.3.6.1.2.1.2.2.1.2")

    numeric = browser_service.resolve(symbolic["output"], mode="symbolic", bundle=bundle)
    assert numeric == {
        "input": symbolic["output"],
        "output": "IF-MIB::ifDescr",
        "resolved": True,
    }

    fallback = browser_service.resolve("ifDescr", mode="symbolic", bundle=bundle)
    assert fallback["output"] == "IF-MIB::ifDescr"

    filtered = browser_service.search_bundle(
        query="if",
        module="IF-MIB",
        type_filter="MibTableColumn",
        limit=25,
        bundle=bundle,
    )
    assert filtered["count"] >= 1
    assert all(result["type"] == "MibTableColumn" for result in filtered["results"])

    assert browser_service.resolve("DEFINITELY-NOT-A-MIB-SYMBOL", bundle=bundle) == {
        "input": "DEFINITELY-NOT-A-MIB-SYMBOL",
        "output": "DEFINITELY-NOT-A-MIB-SYMBOL",
        "resolved": False,
    }


def test_module_tree_oid_tree_and_node_breadcrumbs_cover_browser_navigation(isolated_db):
    from app.services import browser_service

    bundle = _activate_browser_bundle(isolated_db)

    modules = browser_service.get_modules(bundle=bundle)["modules"]
    assert modules == sorted(modules, key=lambda item: item["name"])
    if_mib = next(item for item in modules if item["name"] == "IF-MIB")
    assert if_mib["objects"] >= 1
    assert if_mib["notifications"] >= 1

    module_tree = browser_service.get_module_tree(
        module="IF-MIB",
        type_filter=None,
        bundle=bundle,
    )
    assert module_tree["count"] >= 1
    assert any(child["has_children"] for child in module_tree["modules"][0]["children"])

    oid_tree = browser_service.get_oid_tree(
        root_oid="1.3.6.1.2.1.2.2.1",
        depth=1,
        module="IF-MIB",
        type_filter="MibTableColumn",
        bundle=bundle,
    )
    assert oid_tree["root"]["full_name"] == "IF-MIB::ifEntry"
    assert "ifDescr" in {item["name"] for item in oid_tree["children"]}
    assert all(item["type"] == "MibTableColumn" for item in oid_tree["children"])
    assert oid_tree["total_descendants"] >= len(oid_tree["children"])

    node = browser_service.get_node("1.3.6.1.2.1.2.2.1.2", module=None, bundle=bundle)
    assert node["node"]["full_name"] == "IF-MIB::ifDescr"
    assert any(item["name"] == "ifEntry" for item in node["breadcrumb"])

    assert browser_service.get_oid_tree(
        root_oid="not-an-oid",
        depth=1,
        module=None,
        type_filter=None,
        bundle=bundle,
    ) == {"root": None, "children": [], "total_descendants": 0}


def test_node_to_record_emits_enums_and_units(isolated_db):
    from app.services.browser_service import _node_to_record

    bundle = _activate_browser_bundle(isolated_db)

    record = _node_to_record(bundle.resolve_node("IF-MIB", "ifOperStatus"))
    assert record["enums"] == {
        "up": 1,
        "down": 2,
        "testing": 3,
        "unknown": 4,
        "dormant": 5,
        "notPresent": 6,
        "lowerLayerDown": 7,
    }
    assert record["units"] is None

    class _StubNode:
        oid = (1, 3, 6, 1, 4, 1, 9)
        object_type = "OBJECT-TYPE"
        nodetype = None
        name = "stubGauge"
        module = "STUB-MIB"
        syntax = "Gauge32"
        max_access = "read-only"
        status = "current"
        description = ""
        index = None
        members = None
        constraints = None
        enums = None
        units = "bits/second"

    stub_record = _node_to_record(_StubNode())
    assert stub_record["enums"] is None
    assert stub_record["units"] == "bits/second"
    assert stub_record["name"] == "stubGauge"
    assert stub_record["constraints"] is None

    class _OldEnumNode:
        oid = (1, 3, 6, 1, 4, 1, 10)
        object_type = "OBJECT-TYPE"
        nodetype = "column"
        name = "oldStatus"
        module = "OLD-MIB"
        syntax = "INTEGER"
        max_access = "read-write"
        status = "current"
        description = ""
        index = None
        members = None
        enums = None
        units = None
        constraints = {"kind": "enum", "data": [["up", 1], ["down", 2]]}

    old_record = _node_to_record(_OldEnumNode())
    assert old_record["enums"] == {"up": 1, "down": 2}
    assert old_record["constraints"] == {"kind": "enum", "data": [["up", 1], ["down", 2]]}


def test_node_to_record_resolves_type_level_textual_convention_constraints(isolated_db):
    # R-3: node records must carry TEXTUAL-CONVENTION constraints resolved
    # through the bundle (InterfaceIndex range, PhysAddress/OwnerString size),
    # not just the node's own (usually null) constraints.
    from types import SimpleNamespace

    from app.services import browser_service
    from app.services.browser_service import _node_to_record

    bundle = _activate_browser_bundle(isolated_db)

    # ifIndex is typed InterfaceIndex -> range 1..2147483647 at the type level.
    node_record = browser_service.get_node("IF-MIB::ifIndex", module=None, bundle=bundle)["node"]
    assert node_record["constraints"] == {"kind": "range", "data": [[1, 2147483647]]}

    # ifTestOwner is typed OwnerString -> size 0..255 at the type level.
    owner_record = browser_service.get_node("IF-MIB::ifTestOwner", module=None, bundle=bundle)["node"]
    assert owner_record["constraints"] == {"kind": "size", "data": [[0, 255]]}

    # A stub PhysAddress node whose type record declares a size bound resolves
    # it too (the reported ifPhysAddress -> PhysAddress size case).
    class _SizeType:
        constraints = {"kind": "size", "data": [[6, 6]]}

    class _StubBundle:
        def resolve_type(self, module, type_name):
            del module
            assert type_name == "PhysAddress"
            return _SizeType()

    phys_node = SimpleNamespace(
        module="STUB-MIB",
        syntax="PhysAddress",
        object_type="OBJECT-TYPE",
        nodetype="column",
        name="ifPhysAddress",
        max_access="read-only",
        status="current",
        description="",
        index=None,
        members=None,
        constraints=None,
        enums=None,
        units=None,
        oid=(1, 3, 6, 1, 2, 1, 2, 2, 1, 6),
    )
    phys_record = _node_to_record(phys_node, bundle=_StubBundle())
    assert phys_record["constraints"] == {"kind": "size", "data": [[6, 6]]}

    # Plain nodes (no type-level constraint) stay unchanged.
    plain_record = _node_to_record(phys_node)
    assert plain_record["constraints"] is None


def test_input_type_mapping_and_trap_catalog_cover_trap_sender_metadata(isolated_db):
    from app.services import browser_service
    from app.services.browser_service import _input_type_for_syntax

    bundle = _activate_browser_bundle(isolated_db)

    assert _input_type_for_syntax("OBJECT IDENTIFIER") == "OID"
    assert _input_type_for_syntax("IpAddress") == "IpAddress"
    assert _input_type_for_syntax("TimeTicks") == "TimeTicks"
    assert _input_type_for_syntax("Counter64") == "Counter"
    assert _input_type_for_syntax("Gauge32") == "Gauge"
    assert _input_type_for_syntax("TruthValue") == "Integer"
    assert _input_type_for_syntax("DisplayString") == "String"

    catalog = browser_service.get_trap_catalog(bundle=bundle)
    link_down = next(item for item in catalog["traps"] if item["full_name"] == "IF-MIB::linkDown")
    enum_member = next(item for item in link_down["objects"] if item["full_name"] == "IF-MIB::ifAdminStatus")

    assert link_down["oid"] == "1.3.6.1.6.3.1.1.5.3"
    assert enum_member["input_type"] == "Integer"
    assert enum_member["enum_values"][0] == {"label": "up", "value": 1}


def test_type_filtered_search_returns_only_requested_node_flavor(isolated_db):
    from types import SimpleNamespace

    from app.services import browser_service

    def _node(name: str, nodetype: str, index: int):
        return SimpleNamespace(
            name=name,
            module="TEST-MIB",
            oid=(1, 3, 6, 1, 4, 1, 999, 1 if nodetype == "scalar" else 2, index),
            object_type="OBJECT-TYPE",
            nodetype=nodetype,
            syntax="INTEGER",
            max_access="read-only",
            status="current",
            description="",
            index=None,
            members=[],
            constraints=None,
            enums=None,
            units=None,
        )

    class _Record:
        def __init__(self, nodes):
            self.objects = {n.name: n for n in nodes}
            self.notifications = {}

    class _ModuleBundle:
        def __init__(self, nodes):
            self.modules = {"TEST-MIB": _Record(nodes)}

    # 150 table columns share the raw OBJECT-TYPE class with the 30 scalars
    # the caller asked for; the MibScalar post-filter must return only the
    # scalars (single pass over the module, no fetch-window growth needed).
    nodes = [_node(f"colNode{i}", "column", i) for i in range(150)]
    nodes += [_node(f"scalarNode{i}", "scalar", i) for i in range(30)]

    payload = browser_service.search_bundle(
        query="Node",
        module=None,
        type_filter="MibScalar",
        limit=25,
        bundle=_ModuleBundle(nodes),
    )

    assert payload["count"] == 25
    assert all(result["type"] == "MibScalar" for result in payload["results"])
    assert all(result["name"].startswith("scalarNode") for result in payload["results"])


def test_type_filtered_search_reports_partial_results_when_exhausted(isolated_db):
    from types import SimpleNamespace

    from app.services import browser_service

    def _node(name: str, nodetype: str):
        return SimpleNamespace(
            name=name,
            module="TEST-MIB",
            oid=(1, 3, 6, 1, 4, 1, 999, 1 if nodetype == "scalar" else 2, 0),
            object_type="OBJECT-TYPE",
            nodetype=nodetype,
            syntax="INTEGER",
            max_access="read-only",
            status="current",
            description="",
            index=None,
            members=[],
            constraints=None,
            enums=None,
            units=None,
        )

    class _Record:
        def __init__(self, nodes):
            self.objects = {n.name: n for n in nodes}
            self.notifications = {}

    class _ModuleBundle:
        def __init__(self, nodes):
            self.modules = {"TEST-MIB": _Record(nodes)}

    nodes = [_node(f"colNode{i}", "column") for i in range(40)]
    nodes += [_node(f"scalarNode{i}", "scalar") for i in range(3)]

    payload = browser_service.search_bundle(
        query="Node",
        module=None,
        type_filter="MibScalar",
        limit=25,
        bundle=_ModuleBundle(nodes),
    )

    # Only 3 true matches exist; the result set is capped below the limit.
    assert payload["count"] == 3
    assert all(result["type"] == "MibScalar" for result in payload["results"])
    assert all(result["name"].startswith("scalarNode") for result in payload["results"])


def test_module_identity_nodes_get_their_own_ui_label(isolated_db):
    from app.services import browser_service

    bundle = _activate_browser_bundle(isolated_db)

    # IF-MIB::ifMIB is a MODULE-IDENTITY node (previously mislabeled
    # "ModuleCompliance").
    payload = browser_service.get_node("IF-MIB::ifMIB", module=None, bundle=bundle)
    assert payload["node"]["type"] == "ModuleIdentity"

    # The type-filtered search path maps the new label back to the raw token.
    filtered = browser_service.search_bundle(
        query="ifMIB",
        module="IF-MIB",
        type_filter="ModuleIdentity",
        limit=10,
        bundle=bundle,
    )
    assert any(result["type"] == "ModuleIdentity" for result in filtered["results"])


def test_module_tree_count_reports_total_objects_not_top_level_roots(isolated_db):
    from app.services import browser_service

    bundle = _activate_browser_bundle(isolated_db)
    tree = browser_service.get_module_tree(module=None, type_filter=None, bundle=bundle)

    total_nodes = 0
    for module in tree["modules"]:
        total_nodes += len(list(bundle.iter_objects(module=module["name"])))
        total_nodes += len(list(bundle.iter_notifications(module=module["name"])))

    top_level = sum(len(module["children"]) for module in tree["modules"])
    assert tree["count"] == total_nodes
    assert tree["count"] > top_level
    # Per-module rows carry the same object count the badge renders.
    for module in tree["modules"]:
        module_total = len(list(bundle.iter_objects(module=module["name"])))
        module_total += len(list(bundle.iter_notifications(module=module["name"])))
        assert module["object_count"] == module_total


def test_lookup_misses_stay_graceful_but_real_errors_surface(isolated_db):
    from app.services import browser_service

    bundle = _activate_browser_bundle(isolated_db)

    # Malformed and unknown OIDs resolve to "unresolved", never a 500.
    for bad in ("1.2.abc", "garbage", "999.999"):
        result = browser_service.resolve(bad, bundle=bundle)
        assert result["resolved"] is False

    # A genuine backend error inside lookup must propagate instead of being
    # swallowed by a catch-all (BRW-04).
    class _ExplodingBundle:
        def lookup(self, _value):
            raise RuntimeError("storage exploded")

    with pytest.raises(RuntimeError, match="storage exploded"):
        browser_service.resolve("1.3.6.1", bundle=_ExplodingBundle())


def test_oid_tree_has_children_flags_are_precise_after_single_pass_scan(isolated_db):
    from app.services import browser_service

    bundle = _activate_browser_bundle(isolated_db)

    tree = browser_service.get_oid_tree(
        root_oid="1.3.6.1.2.1.2", depth=1, module="IF-MIB", type_filter=None, bundle=bundle
    )
    children = {child["name"]: child for child in tree["children"]}
    # ifTable nests (rows/columns below it); ifNumber is a plain scalar.
    assert children["ifTable"]["has_children"] is True
    assert children["ifNumber"]["has_children"] is False
    # Descendants include the direct children themselves.
    assert tree["total_descendants"] >= len(tree["children"])
