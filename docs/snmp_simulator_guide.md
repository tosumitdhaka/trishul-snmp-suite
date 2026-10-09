# Simulator Guide

`Simulator` is the current release page for controlling the SNMP responder.

It keeps the familiar operator flow:

- configure the responder port and community
- edit custom OID data as JSON
- start, stop, or restart the responder
- inspect the local activity log

## Before You Start

For the smoothest workflow:

1. choose the host UDP port you want to expose
2. use the same value in the page and in your deployment
3. keep community `public` unless your test requires something else

For the default installer path, local responder validation usually uses
`1061/udp`.

## Custom Data Format

The editor accepts a JSON object that maps symbolic or numeric OIDs to simple
values.

Example:

```json
{
  "SNMPv2-MIB::sysName.0": "demo-agent",
  "IF-MIB::ifSpeed.1": 1000,
  "1.3.6.1.2.1.1.6.0": "Lab Rack 7"
}
```

Practical notes:

- string values become OCTET STRING values
- integers become INTEGER values
- booleans are normalized to integer values
- symbolic names need the relevant MIBs loaded if you want resolution support

## Starting And Stopping

The normal flow is:

1. save the current JSON
2. start the simulator
3. verify the status card shows the expected port and community
4. stop or restart as needed

While the simulator is running, the page locks configuration inputs so the live
binding is explicit.

## Activity Log

The log pane records local lifecycle and request activity.

Use it to:

- confirm the responder actually started
- inspect request bursts during a walk
- filter by severity
- export or clear the current log view

## Recommended Local Validation

1. set custom data for one or two well-known OIDs
2. start the simulator on port `1061`
3. open `Walk & Parse`
4. run a walk against `127.0.0.1:1061`
5. confirm the returned values match the simulator data

## Common Failure Patterns

Check these first if the simulator does not behave as expected:

- UDP port conflict
- invalid JSON in the editor
- symbolic targets with missing MIB support
- querying the container-internal port instead of the host-exposed port

If both startup and custom-data saves fail with `value must be a non-empty
string`, older runtime code may be rejecting a valid empty hex/base64 OCTET
STRING. Both operations validate the full set of bundle defaults, including
physical addresses with `SIZE (0 | 6)`, even when the edited OID is unrelated.
Update to code containing the empty-byte-value fix and rebuild the container
with `./install-trishul-snmp-suite.sh restart-local` from that checkout. Keep
the existing data volume; clearing custom overrides does not fix a failing
bundle default. Empty values still have to satisfy their MIB size constraints.

## Related Docs

- [Walk & Parse Guide](walker_guide.md)
- [First Steps](first_steps.md)
- [Troubleshooting](troubleshooting.md)
