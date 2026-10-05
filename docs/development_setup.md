# Development Setup

This repo targets the `2.1.0` runtime built from:

- `backend/app` — FastAPI application with flat service architecture
- `frontend/` — static operator shell built into `frontend/dist`
- SQLite-backed product state via Alembic
- compiled bundle artifacts via `trishul-smi`
- in-process SNMP runtime via `trishul-snmp`

## Prerequisites

- Docker for containerized verification
- Python `3.12` or newer for native backend work
- Node `20` or newer for frontend builds

Net-SNMP CLI tools are not required. The `2.1.0` runtime uses an in-process
SNMP stack.

## Recommended Daily Workflow

1. Use the repo-root virtual environment for backend work.
2. Rebuild `frontend/dist` after frontend changes.
3. Run the test suite before merging runtime, API, or packaging changes.

## Local Full Stack With The Installer

Closest path to the shipped runtime:

```bash
./install-trishul-snmp-suite.sh up-local
```

Useful companion commands:

```bash
./install-trishul-snmp-suite.sh build-local
./install-trishul-snmp-suite.sh restart-local
./install-trishul-snmp-suite.sh logs
./install-trishul-snmp-suite.sh status
./install-trishul-snmp-suite.sh down
```

Use this path for:

- Dockerfile or packaging changes
- end-to-end page-flow verification
- release-candidate validation

## Native Backend Loop

From the repo root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements-dev.txt
cd frontend && npm ci && npm run build && cd ..
uvicorn app.main:app --app-dir backend --reload --host 0.0.0.0 --port 8000
```

Then open:

- app UI: `http://localhost:8000`
- OpenAPI docs: `http://localhost:8000/docs`

Notes:

- runtime data stays under `backend/data/` unless you set `TRISHUL_DATA_DIR`
- the backend serves `frontend/dist`, not raw frontend source files
- if `frontend/dist` is missing, the backend shows a placeholder page

## Frontend Iteration

After frontend edits, rebuild:

```bash
cd frontend
npm ci
npm run build
```

`frontend/` is a static shell build with no dev server.

## Running Tests

From the repo root:

```bash
.venv/bin/python -m pytest backend/ -q
```

Current test layout:

- `backend/tests/unit/` — unit tests for app modules, scripts, and services
- `backend/tests/contract/` — API and WebSocket contract coverage
- `backend/tests/integration/` — lifespan, schema, and migration workflows
- `backend/tests/live/` — live UDP runtime tests gated by `TRISHUL_ENABLE_LIVE_SNMP_RUNTIME=1`

Expected result: backend tests pass; the live UDP tests are skipped unless
`TRISHUL_ENABLE_LIVE_SNMP_RUNTIME=1` is set.

To run live tests:

```bash
TRISHUL_ENABLE_LIVE_SNMP_RUNTIME=1 .venv/bin/python -m pytest backend/tests/live -v
```

For release-facing backend changes, also run:

```bash
.venv/bin/python scripts/check_backend_coverage.py
```

## Compose Path

`docker compose up -d` exists as a convenience path, but the canonical operator
and release workflow is `install-trishul-snmp-suite.sh`.

## Related Docs

- [Installation Guide](installation_guide.md)
- [Release Process](release_process.md)
- [Architecture Overview](architecture_overview.md)
