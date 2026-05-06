# Trap Manager Guide

The Trap Manager combines two workflows:

- trap sending for validation and test generation
- trap receiving for real-time monitoring during development or QA

## Trap Sender

The sender lets you define:

- target host
- target UDP port
- community string
- trap OID
- optional varbind list

You can choose a trap by:

- selecting it from the trap library
- entering the OID directly
- jumping in from the MIB Browser

The UI resolves symbolic trap names before submission. The backend API expects numeric OIDs.

## VarBinds

VarBinds can be added manually or selected through the UI flow.

Supported types include:

- string
- integer
- counter
- gauge
- OID
- IP address
- TimeTicks

## Trap Receiver

The receiver can be started and stopped directly from the page.

Configurable options:

- UDP port
- community string
- `Resolve OIDs`

When enabled, MIB resolution enriches the trap view with names instead of only numeric OIDs where possible.

## Real-Time View

The receiver panel shows:

- current running state
- received trap list
- basic receiver metrics
- resolved trap type and varbind details when available

Because the app uses WebSocket push, the receiver updates without polling.

## Recommended Local Loopback Test

1. Open Trap Manager.
2. Start the receiver on `1162`.
3. In the sender form, target `127.0.0.1:1162`.
4. Pick a known trap such as `IF-MIB::linkDown`.
5. Send the trap.
6. Confirm it appears in the receiver table.

## Operational Notes

- Trap receiver lifecycle is validated on startup so a bind failure is reported instead of looking healthy.
- Clearing the trap list removes stored received-trap entries from the runtime data file.

## Related Docs

- [MIB Manager Guide](mib_manager_guide.md)
- [MIB Browser Guide](mib_browser_guide.md)
- [API Reference](api_reference.md)
- [Troubleshooting](troubleshooting.md)
