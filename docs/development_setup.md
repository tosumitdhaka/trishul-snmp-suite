# Development Setup

This repo supports two development paths for `1.3.0` and later:

- Docker-first full-stack development for end-to-end UI and API checks.
- Native backend development for faster router, service, and test iteration.

## Prerequisites

- Docker with Compose v2 for container-based workflows.
- Python 3.10 or newer for native backend work.
- Net-SNMP CLI tools on the host for native backend work.
  The backend shells out to `snmpwalk`, so install the usual Net-SNMP package set before using the native path.

## Docker Full Stack

Use this path when you need the browser UI, `/api` proxying, and WebSocket behavior exactly as users see it.

```bash
docker compose up -d
docker compose logs -f backend
docker compose logs -f frontend
```

Endpoints:

- Frontend: `http://localhost:8080`
- Backend API docs: `http://localhost:8000/docs`
- Default login: `admin` / `admin123`

Stop the stack with:

```bash
docker compose down
```

## Docker Full Stack From Local Source

The checked-in `docker-compose.yml` uses published images by default. For repo-local frontend or backend changes, add a local override file so Compose builds from this checkout instead.

Create `docker-compose.override.yml` in the repo root:

```yaml
services:
  backend:
    build: ./backend
    image: trishul-snmp-backend-local
  frontend:
    build: ./frontend
    image: trishul-snmp-frontend-local
```

Then run:

```bash
docker compose up --build
```

Use this mode for:

- Frontend HTML, CSS, or JavaScript changes.
- End-to-end verification of upload, trap, browser, and WebSocket flows.
- Any change that depends on the frontend Nginx proxy behavior.

## One-Shot Local Deploy Script

If you want the existing installer-style workflow but backed by local images from this checkout, use:

```bash
./install-trishul-snmp.sh up-local
```

Useful variants:

```bash
./install-trishul-snmp.sh build-local
./install-trishul-snmp.sh restart-local
TRISHUL_IMAGE_SOURCE=local ./install-trishul-snmp.sh up
BACKEND_PORT=9000 FRONTEND_PORT=3000 ./install-trishul-snmp.sh up-local
```

This path:

- Builds local backend and frontend images from the repo Dockerfiles.
- Replaces any existing `trishul-snmp-backend` and `trishul-snmp-frontend` containers.
- Reuses the existing named data volume for runtime state.

## Native Backend Loop

Use this path when you are iterating on backend code and do not need the full UI on every change.

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
  Export environment overrides manually if you need non-default ports, timeouts, or metadata while running natively.
- The browser UI expects `/api` and `/api/ws` to be proxied.
  For full UI verification, switch back to the Docker full-stack path.

Useful commands:

```bash
cd backend
python3 -m pytest
python3 -m compileall .
```

## Recommended Workflow

For day-to-day work:

1. Use the native backend loop for API, worker, and test changes.
2. Use Docker full stack before merging any frontend-facing or release-facing change.
3. Keep tracker IDs and release notes aligned using [github_workflow.md](github_workflow.md) and [release_process.md](release_process.md).
