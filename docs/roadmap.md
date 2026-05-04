# Roadmap

This roadmap groups the stable IDs from [issue_tracker.md](issue_tracker.md) into delivery tracks so planning stays tied to concrete work.

## Current Baseline

- `IMPR-002` is complete: non-root project docs now live under `docs/`, while `README.md` remains the entry point.
- `1.3.0` ships Tracks 1 to 3 from the current plan, with hardening work as the release gate.

## Release 1.3.0

### Track 1: Hardening & Stability

**Scope:** `BUG-001`, `BUG-002`, `BUG-003`, `BUG-004`, `BUG-005`, `BUG-006`, `GAP-001`

Delivered in `1.3.0`:

- Path-safe MIB validation handling
- Stored-XSS cleanup across high-risk frontend views
- Active WebSocket auth enforcement
- Concurrent-safe stats persistence
- Real startup readiness checks for simulator and trap receiver
- Multi-arch Compose defaults
- Smoke and regression coverage for core flows

### Track 2: Contributor Workflow & Release Hygiene

**Scope:** `GAP-002`, `GAP-003`, `IMPR-003`

Delivered in `1.3.0`:

- Repo-local development setup guidance
- Release checklist and version-bump documentation
- Tracker-aware GitHub workflow and PR template conventions

### Track 3: Targeted Feature Expansion

**Scope:** `FEAT-001`, `FEAT-003`, `IMPR-001`

Delivered in `1.3.0`:

- Trusted-source MIB dependency fetch with manual default and optional auto-fetch during upload or reload
- Current-view JSON and CSV export from the MIB browser
- Shared frontend escaping helpers used by the release-facing UI paths

## Deferred To 1.4.0

**Scope:** `FEAT-002`, `FEAT-004`, `FEAT-005`, `FEAT-006`

Notes:

- `FEAT-002` SNMPv3 support is explicitly deferred out of `1.3.0`.
- Longer-term feature work stays behind the hardening and workflow baseline established in `1.3.0`.

## Planning Rules

- Update [issue_tracker.md](issue_tracker.md) first, then adjust roadmap references.
- Keep roadmap entries phase-level; keep item detail in the tracker.
- When a scope moves into active delivery, mirror it in GitHub issues and milestones using the same IDs.
