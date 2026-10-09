import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
TESTS_ROOT = Path(__file__).resolve().parent
for path in (BACKEND_ROOT, TESTS_ROOT):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))


from fixtures.db import isolated_db  # noqa: F401
from fixtures.simulator import zero_length_simulator_bundle  # noqa: F401
