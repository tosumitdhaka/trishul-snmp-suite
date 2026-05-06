# Troubleshooting

This guide covers the most common runtime and workflow issues in Trishul SNMP Suite.

## The App Does Not Start

Check:

- `./install-trishul-snmp-suite.sh status`
- `./install-trishul-snmp-suite.sh logs`

Common causes:

- `APP_PORT` already in use
- `SNMP_PORT` already in use
- `TRAP_PORT` already in use
- Docker not running

If you need different ports:

```bash
APP_PORT=8980 SNMP_PORT=2161 TRAP_PORT=2162 ./install-trishul-snmp-suite.sh up
```

## The UI Loads But I Cannot Log In

Check:

- you are using the expected app URL
- you are using the current credentials
- the token is not expired

Default credentials only apply until you change them:

- username: `admin`
- password: `admin123`

If you changed credentials and forgot them, inspect the persisted secrets file in the runtime data directory before deciding on a reset.

## The Simulator Will Not Start

Common causes:

- UDP port conflict
- invalid community or saved config issues

Actions:

1. Stop anything else that might already be bound to the chosen UDP port.
2. Retry with a different port.
3. Review the simulator page and container logs.

The API now verifies real startup success, so a failed bind should not be reported as healthy.

## The Trap Receiver Will Not Start

The most common issue is a UDP port conflict on `1162`.

Try:

```bash
TRAP_PORT=2162 ./install-trishul-snmp-suite.sh restart
```

If the receiver starts but no traps appear:

- confirm the sender target and port
- verify community and firewall rules
- leave `Resolve OIDs` enabled only if the current MIB set supports what you expect

## A Walk Returns Unexpected Or Empty Results

Check:

- host
- UDP port
- community string
- root OID
- whether the simulator or target device is actually responding

If parsing returns nothing but raw output exists, the backend may return label-oriented output rather than structured `OID = value` pairs.

## MIB Upload Fails

Check:

- file extension: only `.mib`, `.txt`, and `.my` are accepted
- filename: directory traversal patterns are rejected
- validation results in the upload modal

If dependencies are missing:

- fetch them manually if trusted remote fetch is configured
- or supply the missing files yourself

Validation never fetches remotely.

## Remote Dependency Fetch Does Not Work

Check Settings:

- remote sources are valid URLs
- each source contains `@mib@`
- auto-fetch is enabled only if you expect upload or reload to fetch automatically

Remember:

- manual fetch is available in the MIB Manager
- validation remains read-only

## WebSocket Status Shows Offline

Possible causes:

- the app container is not healthy
- session token expired
- you logged out in another tab

The app intentionally closes active WebSocket sessions when logout or timeout occurs.

Check:

- app reload behavior
- current login state
- container logs

## Upgrade From Legacy Split Runtime Did Not Preserve Data

Read [Migration To Trishul SNMP Suite](migration_to_trishul_snmp_suite.md).

Expected behavior:

- old containers are stopped
- old `trishul-snmp-data` is copied into `trishul-snmp-suite-data` if the new volume is empty
- the old volume is preserved

If migration did not happen as expected:

1. stop the new container
2. inspect both volumes
3. restore from the preserved old volume or a backup if needed

## Where To Look For Runtime Data

Container path:

- `/app/backend/data`

Common files:

- `configs/custom_data.json`
- `configs/secrets.json`
- `configs/stats.json`
- `configs/app_settings.json`
- `traps.jsonl`
- `mibs/`

## Useful Commands

```bash
./install-trishul-snmp-suite.sh status
./install-trishul-snmp-suite.sh logs
docker compose logs -f app
python3 -m pytest
```

If the problem is still unclear, start with the smallest reproducible workflow:

1. log in
2. start the simulator
3. walk the local simulator
4. start the trap receiver
5. send a local test trap
