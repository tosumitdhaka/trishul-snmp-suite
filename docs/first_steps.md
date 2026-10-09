# First Steps

This is the fastest end-to-end validation flow for a fresh Trishul SNMP Suite
`2.2.4` install using the current page-based release UI.

The examples below assume the default installer ports:

- app UI: `8980/tcp`
- responder test port: `1061/udp`
- notification-listener test port: `1162/udp`

The shell forms are editable. If your deployment uses different ports, enter the
values that match your environment.

## 1. Log In And Secure The Shell

1. Open the app URL.
2. Log in with `admin` / `admin123`.
3. Open `Settings`.
4. Rotate the operator credentials from the auth panel.
5. Log back in with the new credentials.

## 2. Start The Simulator

Open `Simulator`.

Set the custom data editor to:

```json
{
  "1.3.6.1.2.1.1.5.0": "lab-switch-01",
  "1.3.6.1.2.1.1.1.0": "Trishul SNMP Suite demo agent"
}
```

Then:

1. save the JSON
2. leave port `1061` and community `public`
3. start the simulator

Confirm the status card shows the responder as running.

## 3. Run A Walk

Open `Walk & Parse`.

Use:

- Target: `127.0.0.1`
- Port: `1061`
- Community: `public`
- Root OID: `1.3.6.1.2.1.1`
- `JSON Output`: enabled

Run the walk and confirm the output includes the values you set in the
simulator.

## 4. Receive And Send A Trap

Open `Traps`.

Listener:

1. Start the listener on `1162`.
2. Keep community `public`.

Sender:

1. Set target host to `127.0.0.1`.
2. Set target port to `1162`.
3. Leave the default `sysUpTime` varbind in place.
4. Send a trap.

Confirm the received-events table updates.

## 5. Load MIBs If You Have Them

If you have local MIB files available:

1. open `MIB Manager`
2. upload one or more MIB files
3. reload them if prompted
4. confirm the loaded count increases

Then open `MIB Browser` and confirm you can search or browse the loaded symbols.

## 6. Review Dashboard And Settings

Open `Dashboard` and `Settings` and verify:

- the version is reported correctly
- simulator and traps status are visible
- activity counters are populated
- app settings load and save
- stats export or reset works as expected

## Suggested Next Reads

- [Workspaces](workspaces.md)
- [MIB Manager Guide](mib_manager_guide.md)
- [Simulator Guide](snmp_simulator_guide.md)
- [Traps Guide](trap_manager_guide.md)
- [API Reference](api_reference.md)
- [Troubleshooting](troubleshooting.md)
- [Development Setup](development_setup.md)
