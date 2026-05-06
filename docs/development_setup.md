# Development Setup

This repo supports two development paths for `1.4.0` and later:

- Docker-first full-stack development using the merged single-image runtime.
- Native backend development for faster router, service, and test iteration.

## Prerequisites

- Docker with Compose v2 for container-based workflows.
- Python 3.10 or newer for native backend work.
- Net-SNMP CLI tools on the host for native backend work.
  The backend shells out to `snmpwalk`, so install the usual Net-SNMP package set before using the native path.

## Docker Full Stack

Use this path when you need the browser UI, `/api`, `/api/ws`, and `/docs` exactly as users see them in the merged runtime.

```bash
docker compose up -d
docker compose logs -f app
```

Endpoints:

- App UI: `http://localhost:8080`
- API docs: `http://localhost:8080/docs`
- Default login: `admin` / `admin123`

Stop the stack with:

```bash
docker compose down
```

## Docker Full Stack From Local Source

The checked-in `docker-compose.yml` uses the published image by default. For repo-local changes, add a local override file so Compose builds from this checkout instead.

Create `docker-compose.override.yml` in the repo root:

```yaml
services:
  app:
    build: .
    image: trishul-snmp-suite-local
```

Then run:

```bash
docker compose up --build
```

Use this mode for:

- Frontend HTML, CSS, or JavaScript changes.
- End-to-end verification of upload, trap, browser, and WebSocket flows.
- Release-facing deployment or packaging changes.

## One-Shot Local Deploy Script

The canonical deployment script for `1.4.0` is:

```bash
./install-trishul-snmp-suite.sh up-local
```

Useful variants:

```bash
./install-trishul-snmp-suite.sh build-local
./install-trishul-snmp-suite.sh restart-local
TRISHUL_IMAGE_SOURCE=local ./install-trishul-snmp-suite.sh up
APP_PORT=8980 ./install-trishul-snmp-suite.sh up-local
FRONTEND_PORT=8980 BACKEND_PORT=8900 ./install-trishul-snmp-suite.sh up-local
```

Compatibility notes:

- `install-trishul-snmp.sh` remains as a wrapper to the new script.
- `FRONTEND_PORT` is treated as a legacy alias for `APP_PORT`.
- `BACKEND_PORT` is optional and maps a second host port to the same merged app for transition compatibility.
- Old containers and the old `trishul-snmp-data` volume are migrated automatically when possible.

## Native Backend Loop

Use this path when you are iterating on backend code and do not need the full containerized runtime on every change.

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Notes:

- Tests are scoped by `pytest.ini` to `backend/tests`.
- Runtime data stays under `backend/data/`.
- Most config defaults are already in `backend/core/config.py`.
- The backend now serves the static UI directly from `frontend/src`, so a native backend run can serve the application shell without Nginx.

Useful commands:

```bash
cd backend
python3 -m pytest
python3 -m compileall .
```

## Recommended Workflow

1. Use the native backend loop for API, worker, and test changes.
2. Use the Docker full stack or the one-shot local deploy script before merging any UI, deployment, or release-facing change.
3. Keep tracker IDs and release notes aligned using [github_workflow.md](github_workflow.md) and [release_process.md](release_process.md).
