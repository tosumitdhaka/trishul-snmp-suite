# UI Pages

This file keeps its old name for link compatibility. The current `2.2.3`
release UI is the restored page-based shell.

The current shell uses the unified REST API under `/api/...` plus `/api/ws`
for live status and event updates on the pages that need them.

## Page Map

| Page | Purpose | Main Backend Surfaces |
| --- | --- | --- |
| `Dashboard` | status overview, counters, shortcuts | `/api/meta`, `/api/stats/`, `/api/simulator/status`, `/api/traps/status`, `/api/mibs/status`, `/api/ws` |
| `Simulator` | responder control, custom data, activity log | `/api/simulator/*`, `/api/ws` |
| `Walk & Parse` | SNMP walk execution and result parsing | `/api/walk/execute`, `/api/mibs/resolve` |
| `Traps` | listener control, trap send, received-event history | `/api/traps/*`, `/api/mibs/traps`, `/api/mibs/objects`, `/api/mibs/resolve`, `/api/ws` |
| `MIB Browser` | tree browse, search, resolve, detail inspection | `/api/mibs/browse/*` |
| `MIB Manager` | loaded MIB status, upload, reload, dependency fetch, export, trap catalog | `/api/mibs/status`, `/api/mibs/upload`, `/api/mibs/reload`, `/api/mibs/fetch-dependencies`, `/api/mibs/export`, `/api/mibs/traps` |
| `Settings` | credentials, app settings, stats actions, product metadata | `/api/settings/*`, `/api/stats/`, `/api/meta` |

## Dashboard

Use `Dashboard` as the operator landing page for:

- simulator and trap-listener runtime status
- activity counters and live changes
- loaded MIB totals
- quick jumps into the main task pages

## Simulator

Use `Simulator` to:

- set the responder port and community
- edit custom OID data as JSON
- start, stop, or restart the responder
- watch the local activity log update live

## Walk & Parse

Use `Walk & Parse` to:

- run SNMP walks against a target
- switch between raw and parsed output
- filter results
- copy or export the current result set

## Traps

Use `Traps` to:

- start or stop the trap listener
- browse available trap templates from loaded MIBs
- build or edit varbind lists
- send a trap to a local or remote target
- inspect received events as they arrive

## MIB Browser

Use `MIB Browser` to:

- browse by module or numeric OID tree
- search symbols and notifications
- inspect object details
- jump a selected symbol into `Walk & Parse` or `Traps`

## MIB Manager

Use `MIB Manager` to:

- review loaded and failed MIB files
- validate uploads before loading
- upload and reload MIB files
- fetch missing dependencies from configured sources
- export catalog views by scope and type
- inspect the trap catalog exposed by current MIBs

## Settings

Use `Settings` to:

- rotate credentials
- change operator app settings
- export or reset stats
- review app name, version, author, and description
