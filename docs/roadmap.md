# Roadmap

This file tracks the shipped `2.0.x`, `2.1.0`, and `2.2.0` release lines and
the follow-up queue.

The temporary `2.0.0` and `2.1.0` planning workspaces were removed from the
active repo tree during the release cleanup. Use this file for release-level
status and [issue_tracker.md](issue_tracker.md) for slice and backlog tracking.

## Current Delivery State

`2.2.0` is the current shipped release. The initial `2.0.0` implementation
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

## Delivered In 2.1.0

- MIB schema integration per the [MIB Schema Integration Plan](mib_schema_integration_plan.md): enum labels, units, and constraints surfaced end-to-end (walks, trap history, MIB browser), reproducible content-addressed bundles with producer-aware recompile prompts, constraint validation before PDU encode, index-aware walk grouping, client-side OID search, and module revision-history cards
- `trishul-smi==0.5.3` / `trishul-snmp==0.6.2` pinned, with the constraints-as-enum fallback consolidated into one shared helper

## Delivered In 2.2.0

- The full 151-finding end-to-end review closed — registry, dispositions, and phase verdicts in the [E2E Review Findings](e2e_review_findings.md) doc
- Bundle lifecycle management: list/inspect/diff (content-hash fast path)/rollback with live-session broadcasts
- Trap inform sending, trap replay, offline payload decoding, Counter64 varbinds, CSV export, per-trap delete, and paginated receiver history
- Walker timeout/retry controls, cancellation, sortable columns, Enter-to-run, and copy-as-table export
- MIB browser constraint badges (range/size/enum/bits), inline recompile notices, ETag-cached OID index, and sticky detail actions
- Community-string redaction across list payloads, the live WS push, and exports
- Performance: single-scan MIB status inventory, compile lock without held DB sessions, change-only table re-rendering, WS-aware polling

## Planned Beyond 2.2.0

`2.2.0` follow-ups should keep the current operator shell and add schema depth
and protocol reach.

The follow-up queue is summarized in this file and mirrored in
[issue_tracker.md](issue_tracker.md).

No secondary API surface is planned. Follow-up work should extend the current
`/api/...` routes where needed.

Initial targets:

- saved connection and simulator profiles in the current pages
- direct manager operations (GET/GETNEXT/GETBULK) on the existing unified API
- richer dashboard and settings diagnostics through the current stats, runtime, and settings services
- schema depth and protocol reach: display hints, SMIv1 generic-trap decoding, a compile-time lint gate, v1 walker support, and SNMPv3 exposure
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
