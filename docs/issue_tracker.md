# Issue Tracker

This file is the current release tracker.

The temporary `2.0.0` implementation planning document was removed from the
active repo tree during the release cleanup. This page is the short status
board used in PRs, release notes, and roadmap updates.

## Active Release IDs

Use implementation slice IDs for release-bound work: `S0` to `S13`.

Use `POST-200-*` IDs for explicitly deferred work beyond `2.0.0`.

Use `POST-210-*` IDs for planned `2.2.1` backend/frontend parity work.

## 2.0.0 Slice Status

- `S0` `Done` Create the `2.0.0` repo skeleton with the new backend package, Alembic, and release-gate entrypoint.
- `S1` `Done` Create the SQLite base schema for settings, bundles, compile runs, and foundational persistence.
- `S2` `Done` Implement bundle storage, activation, and rollback-safe switching.
- `S3` `Done` Implement catalog resolve and search services on the bundle-first model.
- `S4` `Done` Implement the in-process SNMP runtime for responder, manager, and notifications.
- `S5` `Done` Implement durable notification history and related persistence services.
- `S6` `Done` Build the authenticated shell foundation and restore the current operator UI on the new backend platform.
- `S7` `Done` Implement MIB upload, compile, source group management, and the operator-facing MIB pages.
- `S8` `Done` Implement simulator, walk, and runtime services with the corresponding operator pages.
- `S9` `Done` Implement trap listener, send, and notification services with the traps page.
- `S10` `Done` Implement dashboard, settings, and stats services.
- `S11` `Done` Remove legacy runtime dependencies. Eliminate subprocess-based simulator and trap workers; all SNMP runs in-process.
- `S12` `Done` Rewrite operator and platform documentation for the `2.0.0` runtime.
- `S13` `Done` Backend shell consolidation: eliminated the operator-shell bridge and catalog DB tables; all routes call flat services directly; all tests call services directly with no bridge intermediary.

## Deferred Beyond 2.0.0

- `POST-200-001` `Backlog` Add SNMPv3 runtime and UI parity.
- `POST-200-002` `Backlog` Add writable `SET` responder behavior.
- `POST-200-003` `Backlog` Add bundle import and export workflows.
- `POST-200-004` `Backlog` Add one-click ecosystem demo flows.
- `POST-200-005` `Backlog` Add distributed polling or orchestration features.

## Planned 2.2.1 Follow-Up

- `POST-210-001` `Backlog` Surface bundle list, detail, activate, rollback, and diff in the MIB Manager flow.
- `POST-210-002` `Backlog` Add saved connection and simulator profiles to the operator pages.
- `POST-210-003` `Backlog` Add notification history drill-down and replay to the Traps page.
- `POST-210-004` `Backlog` Add direct runtime manager tools: GET, GETNEXT, GETBULK, inform send, and payload decode.
- `POST-210-005` `Backlog` Expose richer system overview and diagnostics in the UI.

## Working Rules

- use the tracker ID in any matching issue title, PR title, or changelog note
- update this tracker before changing [roadmap.md](roadmap.md)
- do not mark a slice `Done` until code, docs, and verification all landed together
