# Walker Guide

The walker is the quickest way to test SNMP reachability, inspect OID data, and export structured results.

## Inputs

The left panel controls:

- target host
- UDP port
- community string
- root OID
- `Parse to JSON`

The UI also lets you jump in from the MIB Browser so the OID field is pre-filled.

## Common Targets

Local simulator:

- Host: `127.0.0.1`
- Port: `1061`
- Community: `public`

Useful starting OIDs:

- `IF-MIB::ifTable`
- `SNMPv2-MIB::sysDescr.0`
- `1.3.6.1.2.1.1`

## Output Modes

The backend can return different result modes depending on the request and the output format:

- parsed JSON data
- raw lines
- label-only lines when the output is informative but not parseable into `OID = value` pairs

In the UI, the goal is the same: show the result set clearly, keep it searchable, and allow export.

## Result Panel

The right panel supports:

- searching within the current result
- clearing the current result
- copying output
- exporting output

The panel is scrollable and intended to stay within the page layout rather than expanding the whole page.

## Walk History

The left-side history stores recent walks locally in the browser.

You can:

- reload a previous target or OID quickly
- delete an individual history item
- clear the full walk history

## Recommended Flow

1. Start the simulator or identify a reachable SNMP device.
2. Enter the host, port, community, and OID.
3. Leave `Parse to JSON` enabled for normal use.
4. Run the walk.
5. Search or export the result.

## Tips

- Use symbolic OIDs when you want readable starting points.
- Use numeric OIDs when you want strict reproducibility.
- If a walk returns less than expected, verify both the root OID and the loaded MIB set.

## Related Docs

- [SNMP Simulator Guide](snmp_simulator_guide.md)
- [MIB Browser Guide](mib_browser_guide.md)
- [API Reference](api_reference.md)
- [Troubleshooting](troubleshooting.md)
