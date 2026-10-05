from __future__ import annotations

from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.unit


def _node(**kwargs) -> SimpleNamespace:
    attrs = {"enums": None, "constraints": None}
    attrs.update(kwargs)
    return SimpleNamespace(**attrs)


def test_enum_map_prefers_enums_field_over_constraints():
    from app.services.mib_metadata import enum_map, enum_values, first_enum_value

    node = _node(
        enums={"up": 1, "down": 2},
        constraints={"kind": "enum", "data": [["up", 1], ["down", 2]]},
    )
    assert enum_map(node) == {"up": 1, "down": 2}
    assert enum_values(node) == [
        {"label": "up", "value": 1},
        {"label": "down", "value": 2},
    ]
    assert first_enum_value(node) == 1


def test_enum_map_falls_back_to_enum_constraints():
    from app.services.mib_metadata import enum_map, enum_values, first_enum_value

    node = _node(
        constraints={"kind": "enum", "data": [["up", 1], ["down", 2], ["testing", 3]]}
    )
    assert enum_map(node) == {"up": 1, "down": 2, "testing": 3}
    assert enum_values(node)[0] == {"label": "up", "value": 1}
    assert first_enum_value(node) == 1


def test_enum_map_supports_bits_constraints():
    from app.services.mib_metadata import enum_map, enum_values

    node = _node(constraints={"kind": "bits", "data": [["bit0", 0], ["bit1", 1]]})
    assert enum_map(node) == {"bit0": 0, "bit1": 1}
    assert enum_values(node) == [
        {"label": "bit0", "value": 0},
        {"label": "bit1", "value": 1},
    ]


def test_enum_map_ignores_range_constraints():
    from app.services.mib_metadata import enum_map, enum_values, first_enum_value

    node = _node(constraints={"kind": "range", "data": [[0, 127]]})
    assert enum_map(node) is None
    assert enum_values(node) == []
    assert first_enum_value(node) is None


def test_enum_map_is_none_without_enum_data():
    from app.services.mib_metadata import enum_map, enum_values, first_enum_value

    assert enum_map(_node()) is None
    assert enum_values(_node()) == []
    assert first_enum_value(_node()) is None
    assert enum_map(None) is None
    assert enum_values(None) == []