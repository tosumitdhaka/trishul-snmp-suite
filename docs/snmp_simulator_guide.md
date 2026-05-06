# SNMP Simulator Guide

The simulator lets you expose a lightweight SNMP agent for testing clients, walks, dashboards, and integrations without real hardware.

## What It Does

- starts a local SNMP agent process
- serves data on a configurable UDP port
- uses a configurable community string
- generates values from loaded MIBs plus your custom overrides
- streams lifecycle and request activity into the UI in real time

## Supported Workflow

The simulator is designed around SNMPv1 and SNMPv2c testing.

Typical use cases:

- local walk testing
- client integration development
- QA test fixtures
- demonstration environments
- validating MIB-driven OID resolution

## Configuration

The configuration card controls:

- UDP port
- community string

If the simulator is already running, stop it before editing the configuration.

## Custom Data

The custom data editor stores JSON that overrides generated OID values.

Example:

```json
{
  "SNMPv2-MIB::sysName.0": "core-sw-01",
  "IF-MIB::ifDescr.1": "uplink0",
  "IF-MIB::ifSpeed.1": 1000000000
}
```

Notes:

- keys can be symbolic OIDs such as `IF-MIB::ifDescr.1`
- values are converted according to the underlying MIB object syntax
- saving while the simulator is running writes the file and restarts the simulator automatically

## Lifecycle Controls

The status card exposes:

- `Start`
- `Stop`
- `Restart`

The status panel also shows:

- current state
- uptime
- SNMP request count
- last activity time

## Activity Log

The activity log is intended to be useful rather than noisy.

It records:

- lifecycle events
- configuration saves
- startup and restart results
- grouped walk activity

The log supports:

- search
- level filtering
- export
- clear

## Recommended Local Test Loop

1. Enter a few custom OID values.
2. Save the JSON.
3. Start the simulator.
4. Open [Walker Guide](walker_guide.md) and walk `127.0.0.1:1061`.
5. Confirm the simulator request count and activity log update.

## Operational Notes

- Auto-start behavior is managed in Settings.
- Runtime state is visible in the dashboard and the simulator page.
- The merged `1.4.0` runtime serves the simulator UI and API from the same app.

## Related Docs

- [First Steps](first_steps.md)
- [Walker Guide](walker_guide.md)
- [API Reference](api_reference.md)
- [Troubleshooting](troubleshooting.md)
