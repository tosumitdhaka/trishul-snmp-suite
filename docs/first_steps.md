# First Steps

This is the fastest way to confirm that a fresh Trishul SNMP Suite install is working end to end.

## 1. Log In And Secure The Instance

1. Open the app URL.
2. Log in with `admin` / `admin123`.
3. Go to Settings.
4. Change the username or password.
5. Review the "About" card and confirm the expected version.

## 2. Start The Local Simulator

Open the **Simulator** page.

Suggested starting values for the custom data editor:

```json
{
  "SNMPv2-MIB::sysName.0": "lab-switch-01",
  "SNMPv2-MIB::sysContact.0": "noc@example.invalid",
  "IF-MIB::ifDescr.1": "eth0",
  "IF-MIB::ifSpeed.1": 1000000000
}
```

Then:

1. Click `Save`.
2. Confirm the JSON validates cleanly.
3. Click `Start`.
4. Check that the status badge, uptime, request count, and activity log update.

## 3. Run A Walk Against The Local Simulator

Open **Walk & Parse**.

Use:

- Host: `127.0.0.1`
- Port: `1061`
- Community: `public`
- OID: `IF-MIB::ifTable`

Keep `Parse to JSON` enabled and run the walk.

Confirm:

- results appear in the right-side panel
- history is added on the left
- you can search, copy, or export the results

## 4. Receive And Send A Trap

Open **Trap Manager**.

Receiver:

1. Set port `1162`
2. Keep community `public`
3. Leave `Resolve OIDs` enabled
4. Click `Start`

Sender:

1. Set target `127.0.0.1`
2. Set port `1162`
3. Choose a trap from the library or enter a trap OID
4. Click `Send Trap`

Confirm:

- the trap appears in the receiver table
- the receiver metrics update
- the live status stays connected

## 5. Upload A MIB

Open **MIB Manager**.

1. Click `Upload`
2. Select one or more `.mib`, `.txt`, or `.my` files
3. Wait for automatic validation
4. If dependencies are missing, either fetch them manually or resolve them yourself
5. Click `Upload & Reload`

Confirm:

- the MIB appears in the library
- counts for loaded, failed, and traps update
- the trap library reflects newly available notifications

## 6. Browse The MIB Tree

Open **MIB Browser**.

Try:

- view by module
- view by OID
- search for `ifDescr`
- filter by module or object type
- export the current view as JSON or CSV

## 7. Review Settings

Open **Settings** and review:

- auto-start for simulator and trap receiver
- session timeout
- remote MIB fetch behavior
- approved remote source list

Validation is always read-only. Auto-fetch only applies during MIB upload and reload.

## Suggested Next Reads

- [SNMP Simulator Guide](snmp_simulator_guide.md)
- [Walker Guide](walker_guide.md)
- [Trap Manager Guide](trap_manager_guide.md)
- [MIB Manager Guide](mib_manager_guide.md)
- [MIB Browser Guide](mib_browser_guide.md)
