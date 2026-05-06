# FAQ

## Does Trishul SNMP Suite support SNMPv3?

Not in `1.4.0`. The current release targets SNMPv1 and SNMPv2c workflows. SNMPv3 remains deferred feature work.

## Do I need internet access to use it?

No for normal operation. Internet access is only relevant if you enable remote MIB dependency fetch or use the manual dependency fetch action.

## Does MIB validation fetch remote dependencies?

No. Validation is intentionally read-only. Remote dependency fetch is manual by default and can optionally run during upload or reload.

## Where is my data stored?

In the merged container runtime, data lives under `/app/backend/data` and is persisted in the Docker volume `trishul-snmp-suite-data`.

For native backend runs, data lives under `backend/data/`.

## Why do I see `APP_PORT`, `FRONTEND_PORT`, and `BACKEND_PORT`?

`APP_PORT` is the real primary port in `1.4.0`.

`FRONTEND_PORT` is kept as a legacy alias for migration convenience.

`BACKEND_PORT` is optional and only exposes the same merged app on a second host port for compatibility with older habits or scripts.

## Is the UI still served by Nginx?

No. Since `1.4.0`, FastAPI serves the static UI directly.

## What are the default ports?

- App UI and API docs: `8080/tcp`
- Simulator: `1061/udp`
- Trap receiver: `1162/udp`

## What is the default login?

`admin` / `admin123`

Change it immediately after first login.

## Can I use symbolic OIDs?

Yes in most UI workflows:

- simulator custom data
- walker input
- browser navigation
- trap library integration

For trap sending, the backend API expects numeric OIDs. The frontend resolves symbolic values before submission.

## What file types can I upload as MIBs?

`.mib`, `.txt`, and `.my`

## Can I run this without Docker?

Yes for backend-focused development. See [Development Setup](development_setup.md). Docker remains the recommended full-stack path.

## Is this intended for production monitoring?

No. It is best positioned as a simulation, testing, validation, and exploration tool. It is not a replacement for a full production monitoring platform.

## How do I upgrade from the old split frontend/backend deployment?

Use the new installer and read [Migration To Trishul SNMP Suite](migration_to_trishul_snmp_suite.md).

## How do I inspect runtime problems?

Start with:

```bash
./install-trishul-snmp-suite.sh status
./install-trishul-snmp-suite.sh logs
```

Then read [Troubleshooting](troubleshooting.md).
