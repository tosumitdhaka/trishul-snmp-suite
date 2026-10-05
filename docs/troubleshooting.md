# Troubleshooting

This guide covers the most common `2.1.0` runtime and operator issues.

## The App Does Not Start

Check:

- `./install-trishul-snmp-suite.sh status`
- `./install-trishul-snmp-suite.sh logs`
- `docker logs --tail 200 trishul-snmp-suite`

Common causes:

- `APP_PORT` already in use
- `BACKEND_PORT` already in use when a compatibility alias is enabled
- `SNMP_PORT` already in use
- `TRAP_PORT` already in use
- Docker not running

If needed, choose different ports:

```bash
APP_PORT=9080 BACKEND_PORT=9000 SNMP_PORT=2161 TRAP_PORT=2162 ./install-trishul-snmp-suite.sh up
```

## The UI Loads But Login Fails

Check:

- you are using the expected app URL
- the credentials are current
- the session token is not expired

Important current-line note:

- credentials are stored in SQLite-backed app settings, not only in `secrets.json`
- there is no in-product password-reset flow yet

If you lost access, recover from a backup or edit the SQLite-backed auth records
offline before restarting the app.

## MIB Manager Upload Or Reload Fails

Check:

- the file extension is supported
- validation reported missing dependencies
- the reload returned file-specific errors
- the symbol you want is in a MIB that actually loaded successfully

If dependency fetch is disabled in your environment, upload missing MIBs
manually first.

## Symbolic Names Do Not Resolve

Check:

- the required MIBs are loaded
- the current MIB set contains the symbol you expect
- you are using the right module and symbol name

If no matching MIBs are loaded, use numeric OIDs until the catalog is ready.

## Simulator Will Not Start

Common causes:

- UDP port conflict
- invalid JSON in the custom data editor
- querying the container-internal port instead of the host-exposed port
- symbolic targets that require MIBs which are not loaded

For same-host container validation, explicitly use the UDP ports exposed by your
deployment, such as `1061`.

## Traps Listener Starts But No Events Appear

Check:

- the listener port matches the sender target
- the community string matches
- the sender trap OID and varbind OIDs are valid
- the trap library is not empty because of missing MIBs

If events still do not appear, restart the listener and repeat the test with a
simple loopback target such as `127.0.0.1:1162`.

## Walk & Parse Fails

Check:

- host
- UDP port
- community
- whether the target device or local responder is actually reachable
- whether the root OID is valid

When validating locally in Docker, prefer the exposed host UDP port instead of
the form defaults if those differ.

## Upgrade From 1.x Looks Empty

This can happen even when the old Docker volume was copied forward.

The new runtime uses SQLite and compiled bundle artifacts, so validate:

1. MIBs in `MIB Manager`
2. simulator custom data in `Simulator`
3. traps flow in `Traps`
4. metadata and settings in `Dashboard` and `Settings`

## Where Runtime State Lives

Default container path:

- `/app/backend/data/`

Important runtime paths:

- `trishul_v2.sqlite3`
- `bundles/sets/`
- `bundles/cache/tsmi/`
- `mibs/`
- `configs/custom_data.json`

Container logs are not persisted in the data volume by default. Read them with
`./install-trishul-snmp-suite.sh logs` or `docker logs trishul-snmp-suite`.
`/app/backend/data/logs/backend.log` is only used when file logging is
explicitly enabled.

## Useful Commands

```bash
./install-trishul-snmp-suite.sh status
./install-trishul-snmp-suite.sh logs
npm --prefix frontend run build
.venv/bin/python -m pytest backend/ -q
.venv/bin/python scripts/check_backend_coverage.py
```

If the problem is still unclear, reduce the workflow to:

1. log in
2. start a responder in `Simulator`
3. run one walk in `Walk & Parse`
4. start a listener in `Traps`
5. send one local trap
