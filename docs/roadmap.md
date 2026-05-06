# Roadmap

This roadmap groups the stable IDs from [issue_tracker.md](issue_tracker.md) into delivery tracks so planning stays tied to concrete work.

## Current Baseline

- `IMPR-002` is complete: non-root project docs now live under `docs/`, while `README.md` remains the entry point.
- `1.3.0` shipped the hardening, workflow, and targeted feature baseline.
- `1.3.1` shipped the UI polish and simulator activity improvements.

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

## Release 1.3.1

### Track 4: UI Polish & Theme Consistency

**Scope:** `BUG-007`, `BUG-008`, `BUG-009`, `GAP-004`, `IMPR-004`, `IMPR-005`

Delivered in `1.3.1`:

- Theme initialization before first paint so saved dark mode applies cleanly
- Removal of hardcoded light and dark classes that previously left mixed surfaces after a theme switch
- Dark-mode cleanup for sticky table headers, modal dialogs, code blocks, and log or result panels
- Consistent button, badge, and icon styling across dashboard and feature pages
- Responsive shell improvements for login and top-level navigation, including better theme-toggle accessibility
- A repeatable UI review checklist covering desktop, mobile, light mode, and dark mode

## Release 1.4.0

### Track 5: Runtime and Packaging Cutover

Delivered in `1.4.0`:

- Frontend and backend merged into a single runtime image
- FastAPI now serves the static UI directly
- Deployment defaults simplified to one primary app port and one container
- GHCR publishing moved to a single package image
- Legacy installer flow preserved through a compatibility wrapper

### Track 6: Product Rename and Upgrade Migration

Delivered in `1.4.0`:

- Product renamed to `Trishul SNMP Suite`
- Canonical package and runtime slug renamed to `trishul-snmp-suite`
- Installer migration added for legacy containers and volumes
- Docker, docs, and release metadata aligned to the new name

## Deferred Beyond 1.4.0

**Scope:** `FEAT-002`, `FEAT-004`, `FEAT-005`, `FEAT-006`

Notes:

- `FEAT-002` SNMPv3 support remains the most prominent deferred feature after the `1.4.0` platform cutover.
- Longer-term feature work stays behind the merged runtime and rename baseline established in `1.4.0`.

## Planning Rules

- Update [issue_tracker.md](issue_tracker.md) first, then adjust roadmap references.
- Keep roadmap entries phase-level; keep item detail in the tracker.
- When a scope moves into active delivery, mirror it in GitHub issues and milestones using the same IDs.
