# Roadmap

This file tracks the shipped `2.0.x` release line and the first planned
`2.1.0` follow-up queue.

The temporary `2.0.0` and `2.1.0` planning workspaces were removed from the
active repo tree during the release cleanup. Use this file for release-level
status and [issue_tracker.md](issue_tracker.md) for slice and backlog tracking.

## Current Delivery State

`2.0.3` is the current shipped release. The initial `2.0.0` implementation
slices `S0` through `S13` remain `Done`.

## Delivered In The 2.0.x Line

### Platform And Runtime

- one FastAPI application serving the built release UI
- SQLite-backed product state with Alembic migrations
- bundle-first MIB compilation and activation via `trishul-smi`
- in-process SNMP responder, manager, and notification runtime via `trishul-snmp`
- flat service architecture: routes call services directly, no bridge or adapter layer
- simulation rules: counter, random, timestamp, uptime
- source group management for uploaded MIBs with shadowing detection and partial compile

### Release UI

- page-based shell: `Dashboard`, `Simulator`, `Walk & Parse`, `Traps`, `MIB Browser`, `MIB Manager`, `Settings`
- single unified API surface under `/api/...`
- durable notification history stored in the backend runtime/state layer

### Packaging And Migration

- one suite image and installer
- local build path from the repo checkout
- legacy-volume copy-forward for operators coming from older runtimes
- legacy `1.4.1` installer retained as a pinned compatibility path

## Planned For 2.1.0

`2.1.0` should keep the current operator shell and surface backend capabilities
that already exist in the platform but are not yet exposed in the shipped UI.

The initial `2.1.0` follow-up queue is summarized in this file and mirrored in
[issue_tracker.md](issue_tracker.md).

No secondary API surface is planned. Follow-up work should extend the current
`/api/...` routes where needed.

Initial targets:

- bundle lifecycle UI on top of the existing bundle service
- saved connection and simulator profiles in the current pages
- notification history detail and replay in `Traps`
- direct runtime tools such as `GET`, `GETNEXT`, `GETBULK`, inform send, and payload decode
- richer dashboard and settings diagnostics through the current stats, runtime, and settings services
- API and page refinements on the existing unified `/api/...` surface where they simplify the current UI

## Deferred Beyond 2.0.x

These items are intentionally out of the current release cut:

- SNMPv3 runtime and UI parity
- writable `SET` responder behavior
- bundle import and export as first-class operator actions
- one-click ecosystem demo flows
- distributed polling or orchestration features

## Planning Rules

- update [issue_tracker.md](issue_tracker.md) when release state changes materially
- keep detailed sequencing inline in this roadmap and the issue tracker
- keep this file focused on release-level status, not implementation minutiae
