# Architecture Overview

Trishul SNMP Suite `2.2.3` is a bundle-first SNMP lab and operations platform. The
runtime is centered on:

- one FastAPI application
- one built operator frontend artifact served by that application
- one SQLite database for durable product state
- one in-process SNMP runtime built on `trishul-snmp`
- one compiled-bundle pipeline built on `trishul-smi`

## High-Level Shape

The shipped runtime provides:

- the shell UI at `/`
- OpenAPI docs at `/docs`
- metadata and health at `/api/meta` and `/api/health`
- all operator API routes under `/api/...`
- the live operator socket at `/api/ws`

There is no Nginx layer and no external WebSocket bridge or broker in the
current release path. FastAPI serves both the built UI and the live `/api/ws` socket
directly.

## Request Flow

Typical browser flow:

1. the browser requests `/`
2. FastAPI serves files from `frontend/dist`
3. the shell authenticates with `/api/settings/login`
4. the shell sends `X-Auth-Token` on authenticated requests
5. the shell opens `/api/ws` for live status, stats, trap, and simulator-log updates
6. operator endpoints under `/api/...` call flat backend services directly

If `frontend/dist` does not exist, the backend serves a placeholder page that
asks the operator to build the frontend artifact.

## Runtime Components

### FastAPI Application

Defined in `backend/app/main.py`.

Responsibilities at startup:

- run Alembic migrations
- compile and activate the bundled starter MIB set if no active bundle exists
- load the active bundle into memory as a `MibBundle` instance
- auto-start the simulator and trap receiver if configured
- serve the built frontend artifact
- shut down the runtime service cleanly on exit

### Release UI Shell

Source lives under `frontend/` and builds to `frontend/dist/`.

The shipped UI is organized around seven pages:

- `Dashboard`
- `Simulator`
- `Walk & Parse`
- `Traps`
- `MIB Browser`
- `MIB Manager`
- `Settings`

The shell uses hash navigation, page partial loading, and the API surface
exposed by the backend, plus `/api/ws` for live updates on the main
operational pages.

### API Routes

All routes live under `backend/app/api/routes/` and call flat service modules
directly. There is no bridge or adapter layer between the routes and the
services.

Route modules:

- `settings.py` — login, logout, session check, auth, app settings
- `stats.py` — stats read and reset
- `simulator.py` — simulator start, stop, restart, status, custom data, logs
- `walker.py` — walk execute
- `traps.py` — listener start, stop, status, send, event list, clear
- `mibs.py` — MIB status, upload, reload, validate, export, delete, objects, resolve
- `browser.py` — OID browser: modules, tree, search, node detail
- `system.py` — metadata, health
- `ws.py` — WebSocket endpoint

### Service Layer

`backend/app/services/` contains flat service modules. Routes call them
directly — no intermediate shell or bridge classes.

Key services:

| Module | Responsibility |
|---|---|
| `runtime.py` | In-process SNMP responder, manager (GET/GETNEXT/GETBULK/walk), notification listener, trap/inform send, event decode |
| `bundles.py` | MIB bundle compile, activate, rollback via `trishul-smi` |
| `mib_sources.py` | Upload directory scanning, source group precedence, shadowing detection, remote source caching |
| `mib_mutations.py` | MIB upload, partial compile, dependency fetch, delete with rollback |
| `mibs_service.py` | Orchestrates mib_sources + mib_mutations + bundles for route handlers and source-group-aware status or export views |
| `browser_service.py` | OID resolve, module tree, OID tree, search via `MibBundle` |
| `traps_service.py` | Trap listener lifecycle, send, event formatting, history reads |
| `simulator_service.py` | Simulator lifecycle, custom data, logs |
| `walker_service.py` | Walk execution and result formatting |
| `stats_service.py` | Stats aggregation from runtime, history, and state store |
| `history.py` | Durable notification event storage and retrieval |
| `session.py` | Auth credential storage and session management |
| `state_store.py` | Persistent key-value settings backed by SQLite |
| `app_settings.py` | Operator app settings read and write |
| `realtime.py` | WebSocket connection manager and broadcast functions |
| `bundle_state.py` | In-memory `MibBundle` singleton |

### Bundle Pipeline

`backend/app/services/bundles.py` drives MIB compilation through `trishul-smi`.

Compile output is stored as versioned bundle directories containing:

- `manifest.json`
- `oid_index.json`
- one compiled JSON file per module

SQLite records bundle metadata, compile runs, and the active-bundle pointer.

The active bundle is loaded into memory at startup as a `MibBundle` instance.
All catalog, browser, and trap resolution queries use this in-memory bundle —
there are no SQLite catalog index tables.

### Runtime Service

`backend/app/services/runtime.py` owns all live SNMP surfaces in-process as
async tasks. There are no worker subprocesses.

- `V2cResponder` — SNMP agent responding to GET, GETNEXT, GETBULK
- `V2cManager` — manager-side GET, GETNEXT, GETBULK, walk, bulkwalk
- `V2cNotifier` — send trap or inform
- `V2cNotificationListener` — receive traps and informs
- offline notification decode

The runtime supports simulation rules (counter, random, timestamp, uptime) and
uses the active compiled bundle for symbolic translation and notification
enrichment.

## Persistence Layout

The default data root is `backend/data/` locally or `/app/backend/data/` in the
container.

Important runtime paths:

- `trishul_v2.sqlite3`
- `bundles/sets/`
- `bundles/cache/tsmi/`
- `mibs/`
- `configs/custom_data.json`
- `configs/`

Container deployments emit logs to `stdout`/`stderr` and rely on Docker log
rotation. `backend/data/logs/backend.log` is only used when file logging is
explicitly enabled.

## Database Schema

The current SQLite schema covers:

- `app_settings` — operator app settings key-value store
- `auth_sessions` — durable session tokens
- `bundle_sets` — compiled bundle records
- `bundle_modules` — per-module compile output metadata
- `compile_runs` — compile history with error capture
- `notification_events` — durable received and sent notification history with FTS

There are no catalog index tables. The active bundle is queried in memory via
the loaded `MibBundle` instance.

## Deployment Shape

The container path uses a multi-stage Docker build:

1. build the operator frontend with Node
2. install backend requirements including `trishul-smi` and `trishul-snmp`
3. run `uvicorn app.main:app` from `/app/backend`

The canonical operator entrypoint is `./install-trishul-snmp-suite.sh`.
