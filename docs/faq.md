# FAQ

## Does `2.2.3` support SNMPv3?

No. The current runtime surface is built around SNMP `v2c`.

## Do I need internet access to use it?

No for normal operation.

The current `2.2.3` bundle pipeline works fully from local files. Optional
remote dependency fetch can be enabled in `Settings` if you want uploads or
reloads to resolve missing MIB imports from approved remote sources.

## Where is state stored?

In the `2.2.3` runtime, the main sources of truth are:

- `backend/data/trishul_v2.sqlite3`
- `backend/data/bundles/sets/`
- `backend/data/bundles/cache/tsmi/`

In Docker, the data root is persisted in the `trishul-snmp-suite-data` volume.
Container logs are read with `docker logs trishul-snmp-suite` and are not
stored in that volume by default. File logs only exist when
`LOG_DESTINATION` includes `file`.

## What are the default ports?

The installer defaults are:

- app UI and docs: `8980/tcp`
- local responder testing: `1061/udp`
- local notification-listener testing: `1162/udp`

The page forms are editable. Use the values that match your deployment.

## What is the default login?

`admin` / `admin123`

Rotate those credentials immediately in `Settings`.

## Can I use symbolic OIDs?

Yes, as long as the required MIBs are loaded and the current runtime can resolve
them.

If the symbol does not resolve, use numeric OIDs until the relevant MIBs are
available.

## Is the UI still served by Nginx or a WebSocket bridge?

No. FastAPI serves the built frontend artifact directly. The current shell uses
normal `/api/...` requests for actions and `/api/ws` for live updates. The old
split-runtime WebSocket bridge is gone.

## Can I run this without Docker?

Yes for development and testing. See [Development Setup](development_setup.md).

## Will my 1.x data appear automatically in the new shell?

Not in full.

The installer can preserve and copy old Docker volumes forward, and the current
release shell intentionally keeps familiar file-backed workflows where possible,
but you should still validate MIBs, simulator data, and settings after upgrade.

## Which docs are current for 2.2.3?

Start with:

- [Installation Guide](installation_guide.md)
- [First Steps](first_steps.md)
- [Workspaces](workspaces.md)
- [API Reference](api_reference.md)
- [MIB Manager Guide](mib_manager_guide.md)
- [MIB Browser Guide](mib_browser_guide.md)
- [Simulator Guide](snmp_simulator_guide.md)
- [Walk & Parse Guide](walker_guide.md)
- [Traps Guide](trap_manager_guide.md)
