# Installation Guide

This guide covers the supported `1.4.1` installation paths for Trishul SNMP Suite.

## What Gets Installed

The default runtime is now a single container that serves:

- the web UI
- the REST API under `/api`
- the WebSocket endpoint under `/api/ws`
- the OpenAPI docs under `/docs`

Persistent data is stored in a Docker volume named `trishul-snmp-suite-data`.

## Prerequisites

- Docker
- Docker Compose v2 if you want to use `docker compose`
- Free ports for:
  - `8080/tcp` for the app UI by default
  - `1061/udp` for the simulator by default
  - `1162/udp` for the trap receiver by default

## Recommended: One-Shot Installer

From a local checkout:

```bash
./install-trishul-snmp-suite.sh up
```

What this does:

- pulls `ghcr.io/<owner>/trishul-snmp-suite:latest`
- creates the data volume if needed
- migrates legacy data if the old volume is present
- starts the merged application container

After startup:

- App UI: `http://localhost:8080`
- API docs: `http://localhost:8080/docs`
- Default login: `admin` / `admin123`

## Build And Run From This Checkout

Use this when you want the image built from local source:

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

## Docker Compose Path

The checked-in `docker-compose.yml` runs the published single image:

```bash
docker compose up -d
docker compose logs -f app
docker compose down
```

Default endpoints:

- App UI: `http://localhost:8080`
- API docs: `http://localhost:8080/docs`

To build locally with Compose, add a `docker-compose.override.yml`:

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

## Custom Ports

Primary app port:

```bash
APP_PORT=8980 ./install-trishul-snmp-suite.sh up
```

Custom SNMP and trap ports:

```bash
APP_PORT=8980 SNMP_PORT=2161 TRAP_PORT=2162 ./install-trishul-snmp-suite.sh up
```

Legacy compatibility mode:

```bash
FRONTEND_PORT=8980 BACKEND_PORT=8900 ./install-trishul-snmp-suite.sh up-local
```

In that compatibility mode:

- `FRONTEND_PORT` is treated as the primary app URL
- `BACKEND_PORT` exposes the same merged app on a second host port

## Upgrade From The Legacy Split Runtime

If you previously used:

- `trishul-snmp-backend`
- `trishul-snmp-frontend`
- `trishul-snmp-data`

then the new installer can migrate you automatically. Read [Migration To Trishul SNMP Suite](migration_to_trishul_snmp_suite.md) for the exact behavior.

## Backup And Restore

Create a backup:

```bash
./install-trishul-snmp-suite.sh backup
```

Restore a backup:

```bash
./install-trishul-snmp-suite.sh restore trishul-snmp-suite-backup-YYYYMMDD-HHMMSS.tar.gz
```

Restore stops the running container first.

## First Login

After installation:

1. Open the app.
2. Log in as `admin` / `admin123`.
3. Change the password in Settings.
4. Confirm the version and app metadata in the Settings "About" card.

Next: [First Steps](first_steps.md)
