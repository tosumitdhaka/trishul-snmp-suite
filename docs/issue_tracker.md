# Issue Tracker

This document is the repo-level backlog for bugs, gaps, improvements, and feature scope. Use the IDs below in pull requests, release notes, and roadmap updates.

## Priority Guide

- `P0`: security issue or release blocker
- `P1`: high-priority reliability or platform work
- `P2`: important but non-blocking follow-up
- `P3`: longer-term backlog

## Bugs & Risks

- `BUG-001` `P0` `Done` Harden `/api/mibs/validate-batch` temp-file handling so uploaded filenames cannot escape the validation directory.
- `BUG-002` `P0` `Done` Remove stored XSS paths caused by rendering trap payloads and MIB metadata with `innerHTML` in frontend modules.
- `BUG-003` `P0` `Done` Enforce logout and session timeout on active WebSocket connections, not only during initial handshake.
- `BUG-004` `P1` `Done` Make `stats.json` updates reliable under concurrent API and worker writes; remove lost counter increments.
- `BUG-005` `P1` `Done` Verify simulator and trap receiver startup before returning `started`, so port-bind failures do not look healthy.
- `BUG-006` `P1` `Done` Remove or gate hardcoded `linux/arm64` platform pins in `docker-compose.yml` so amd64 hosts work cleanly.
- `BUG-007` `P1` `Done` Apply the saved UI theme before first paint so auth and app shells do not flash light mode on startup.
- `BUG-008` `P1` `Done` Remove hardcoded light or dark utility classes and inline colors that leave pages visually mixed after theme changes.
- `BUG-009` `P2` `Done` Fix dark-mode rendering for sticky table headers, modal surfaces, code blocks, and log or result panes.

## Gaps

- `GAP-001` `P1` `Done` Add automated smoke tests for login, simulator lifecycle, trap send/receive, walk execution, and MIB upload flows.
- `GAP-002` `P2` `Done` Add a repo-local developer setup path for backend and frontend work without relying only on published container images or wiki pages.
- `GAP-003` `P2` `Done` Document the release workflow: version bump points, changelog updates, image publishing, and verification steps.
- `GAP-004` `P2` `Done` Add a repeatable UI verification checklist covering light and dark mode plus desktop and mobile review for the core pages.

## Improvements

- `IMPR-001` `P1` `Done` Centralize frontend escaping and DOM-render helpers to reduce repeated manual HTML construction.
- `IMPR-002` `P2` `Done` Keep non-root project docs under `docs/` and reduce duplicated planning content in `README.md`.
- `IMPR-003` `P2` `Done` Map tracker IDs to GitHub labels, milestones, and PR templates so backlog state is easier to manage.
- `IMPR-004` `P2` `Done` Normalize buttons, iconography, badges, and status treatments so the UI reads as one consistent product surface.
- `IMPR-005` `P2` `Done` Improve the auth shell and global chrome for responsive layout, theme-toggle accessibility, and clearer visual hierarchy.

## Feature Scope

- `FEAT-001` `P1` `Done` Auto-fetch missing MIB dependencies from trusted sources with opt-in controls and caching.
- `FEAT-002` `P1` `Deferred to 1.4.0` Add SNMPv3 authentication and privacy support.
- `FEAT-003` `P2` `Done` Export MIB tree and search results to JSON and CSV.
- `FEAT-004` `P2` `Backlog` Add scheduled SNMP walks and saved jobs.
- `FEAT-005` `P3` `Backlog` Add device or agent inventory plus reusable connection profiles.
- `FEAT-006` `P3` `Backlog` Add multi-language UI support.

## Working Rules

- Update this tracker before changing roadmap references.
- Keep the stable ID in any matching GitHub issue title or body.
- Mark an item done only after code, docs, and verification land together.
