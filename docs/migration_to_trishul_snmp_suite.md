# Migration To Trishul SNMP Suite

This guide covers the `1.4.0` cutover from the legacy split runtime to the merged `Trishul SNMP Suite` deployment.

## What Changed

- Product name: `Trishul SNMP Suite`
- Canonical image: `ghcr.io/<owner>/trishul-snmp-suite`
- Canonical installer: `./install-trishul-snmp-suite.sh`
- Canonical container name: `trishul-snmp-suite`
- Canonical data volume: `trishul-snmp-suite-data`
- Runtime shape: one container serving UI, API, WebSocket, and docs

## Legacy Names Still Recognized During Migration

- Containers:
  - `trishul-snmp-backend`
  - `trishul-snmp-frontend`
- Volume:
  - `trishul-snmp-data`
- Script:
  - `install-trishul-snmp.sh`

## Automatic Migration Behavior

When you run `./install-trishul-snmp-suite.sh up` or `up-local`:

1. The installer pulls or builds the merged suite image.
2. Legacy containers are stopped and removed if present.
3. The new `trishul-snmp-suite-data` volume is created if needed.
4. If `trishul-snmp-data` exists and the new volume is still empty, data is copied forward automatically.
5. The old volume is left in place for rollback safety.
6. The merged `trishul-snmp-suite` container is started.

## Recommended Upgrade Commands

Published image:

```bash
./install-trishul-snmp-suite.sh up
```

Local build from this checkout:

```bash
./install-trishul-snmp-suite.sh up-local
```

Legacy wrapper:

```bash
./install-trishul-snmp.sh up
```

## Port Behavior

- `APP_PORT` is the primary host port for the merged application.
- `FRONTEND_PORT` is accepted as a legacy alias for `APP_PORT`.
- `BACKEND_PORT` is optional and exposes the same merged application on a second host port during transition.

Example:

```bash
FRONTEND_PORT=8980 BACKEND_PORT=8900 ./install-trishul-snmp-suite.sh up-local
```

In that mode:

- `http://localhost:8980` is the canonical app URL.
- `http://localhost:8900` is a compatibility URL to the same app.

## Rollback Guidance

If you need to roll back during validation:

1. Stop the merged container.
2. Keep `trishul-snmp-suite-data` intact.
3. Recreate the legacy containers if required.
4. Use `trishul-snmp-data` as the preserved pre-cutover data source.

The installer does not delete the old volume automatically.
