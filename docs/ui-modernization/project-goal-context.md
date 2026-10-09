# Trishul SNMP Suite — Project and Goal Context

**Last reviewed:** 2026-10-09
**Repository:** https://github.com/tosumitdhaka/trishul-snmp-suite
**Authority:** [Architecture](architecture.md), [Migration plan](migration-plan.md), [Design system](design-system.md)

This companion note is optimized for inclusion in ChatGPT Project sources. The
architecture, migration and design documents above are the **canonical decision
record** and must be updated if requirements change.

## Vision

Modernize Trishul SNMP Suite into a polished, dependable network operations
console, with emphasis on discoverability, accessibility, data density,
responsiveness and maintainability. Preserve SNMP semantics, runtime behavior,
MIB compilation/bundles, FastAPI, SQLite and the existing /api and /api/ws APIs.

## Decided direction

- Build a **second UI** in `frontend-next/` using React, TypeScript, Vite,
  Tailwind, shadcn/ui/Radix, React Router, TanStack Query/Table and Lucide.
- Treat the **legacy Bootstrap/vanilla-JS `frontend/` as protected**. It remains
  the default at `/` until complete parity and operational validation.
- Target a professional **light-first** operations console; **dark mode** must
  meet the same accessibility, contrast and usability standard.
- Proposed future preview at `/next/`. Do not enable production serving or
  modify the old Docker build/default route without a separately approved
  integration PR and rollback checks.
- One backend; shared REST + WebSocket contracts; session-auth compatibility;
  no duplicated SNMP business logic or DB schema migration.
- Roll out feature by feature, with measured baselines, unit/contract/E2E
  evidence and manual verification; cutover is an explicit release decision.

## Git boundaries

- Shipped/default: `main`
- Planning baseline: `docs/modern-ui-architecture-plan` (keep as reference)
- Active parallel implementation: `feat/modern-ui-foundation` (branched from docs baseline)
- Planning PR: #30, documentation only and initially draft
- Legacy navigation PR: #29, separate work, not a modern UI dependency

## Roadmap

0. Feature/API inventory, screenshots and performance/accessibility baseline.
1. Foundation: independent build, theme, auth/API/WS, routes, test/CI setup.
2. New shared design shell and fully functional real-data Dashboard.
3. In order: Settings, Simulator, Walk & Parse, Traps, MIB Browser, MIB Manager.
4. Regression hardening: contracts, streaming and large data, both modes, mobile,
   keyboard, Playwright and production-like deployment.
5. Separately approved reversible `/` cutover, retaining legacy `/legacy/`.
6. Delayed legacy retirement after stable operation and sign-off.

## Critical fidelity requirements

WebSocket `full_state`, `status`, `stats`, `mibs`, `trap` and `simulator_log`;
ping/pong reconnect and WS 4001; REST 401; per-tab tokens; masked/redacted
credentials; ranked server-side large-MIB search; simulator lifecycle; walk
cancel/parse/sort/export; traps send/inform/replay/receive/delete; MIB schema
constraints, source inventory and bundle lifecycle. Preserve explicit
confirmation before destructive actions, and honest loading/error/offline state.

## Rules for future work

Inspect the current branch and repository code first. Follow canonical docs,
keep implementation PRs small and feature-gated, and avoid changing the legacy
UI or backend by default. Test actual functionality and both themes before
claiming parity. Report any limitations honestly. Update this context when a
decision changes, but prefer version-controlled repo docs as source of truth.

**Present stage:** Stage 1 foundation is under construction; placeholder
workspaces and read-only preview tiles are not completed migration. No
production cutover is approved.
