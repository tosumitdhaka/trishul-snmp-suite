# Architecture Overview

Trishul SNMP Suite `1.4.0` runs as a merged application instead of the old split frontend/backend deployment.

## High-Level Shape

One container provides:

- FastAPI
- static frontend assets
- REST API
- WebSocket push
- simulator lifecycle control
- trap receiver lifecycle control
- MIB loading and browsing

## Request Flow

Browser request flow:

1. browser requests `/`
2. FastAPI serves `frontend/src/index.html`
3. frontend loads module partials such as `dashboard.html` and `simulator.html`
4. frontend calls `/api/*` for authenticated operations
5. frontend connects to `/api/ws?token=<session-token>` for live state

## Runtime Components

### FastAPI App

Defined in `backend/main.py`.

Responsibilities:

- serve static assets
- expose `/api/meta` and `/api/health`
- register authenticated API routers
- host the WebSocket endpoint
- manage startup and shutdown hooks

### Frontend Assets

Stored in `frontend/src/`.

The UI is a static Bootstrap-based shell with:

- `index.html`
- feature partials
- JavaScript modules
- CSS
- icons

### Simulator Worker

The simulator is managed by the backend but runs as a dedicated process when started.

It serves SNMP data over UDP and reports activity back to the main app.

### Trap Receiver Worker

The trap receiver is also process-managed by the backend and listens on its configured UDP port.

### MIB Service

The MIB service loads bundled and uploaded MIBs, compiles them, exposes search/tree APIs, and supports dependency analysis plus optional trusted-source fetch.

### Stats Store

Module-level counters are persisted under the data directory and enriched at runtime with live process state.

### WebSocket Manager

The WebSocket layer pushes:

- full state on connect
- lifecycle status
- trap events
- simulator activity logs
- stats updates
- MIB summary changes

## Persistence Layout

In the container, persistent data lives under:

- `/app/backend/data/configs`
- `/app/backend/data/logs`
- `/app/backend/data/mibs`
- `/app/backend/data/traps.jsonl`

The canonical Docker volume is `trishul-snmp-suite-data`.

## Default Ports

- `8080/tcp` app UI and API docs
- `1061/udp` simulator
- `1162/udp` trap receiver
- `19876/udp` internal loopback-only WebSocket side-channel

## Deployment Paths

Supported approaches:

- `install-trishul-snmp-suite.sh up`
- `install-trishul-snmp-suite.sh up-local`
- `docker compose up -d`
- native backend development for code iteration

## Upgrade Model

The `1.4.0` installer handles migration from the old split runtime by stopping legacy containers and copying data into the new suite volume when needed.

See [Migration To Trishul SNMP Suite](migration_to_trishul_snmp_suite.md).
