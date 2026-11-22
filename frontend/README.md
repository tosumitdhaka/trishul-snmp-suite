# Trishul SNMP Suite — Workbench (`frontend`)

React 19 + TypeScript + Tailwind CSS v4 operator workbench for Trishul SNMP Suite `2.3.0`, built with `trishul-ui` design tokens and Radix UI accessible dialog primitives.

## Prerequisites & Local Development

- Node.js `>= 22.12.0`
- Running FastAPI backend (default native port `8000`, or container port via `TRISHUL_API_ORIGIN`)

```bash
cd frontend
npm ci
npm run dev
```

Open `http://127.0.0.1:3000/`.

Vite proxies `/api` (HTTP and WebSocket `/api/ws`) to `TRISHUL_API_ORIGIN` (defaults to `http://127.0.0.1:8000`). Authentication uses the shared `/api/settings/*` session contract (`X-Auth-Token` / `Authorization: Bearer`) and reads legacy `sessionStorage` `snmp_token` / `snmp_username` fallbacks when present.

## Verification Commands

```bash
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend test
npm --prefix frontend run build
```

- `typecheck`: `tsc --noEmit`
- `lint`: `eslint .`
- `test`: `vitest run` (`jsdom` environment, unit & contract suite in `src/lib/workbench.test.ts` and `src/components/UiPrimitives.test.tsx`)
- `build`: `tsc --noEmit && vite build` -> outputs static bundle to `frontend/dist/`

## Implemented Workspaces & Design System

1. **Overview** — Service telemetry cards (`—` placeholder until initial telemetry loads, disabled toggles until status settles), 8-cell activity matrix, live recent event feed, and workspace launchpad.
2. **Simulator** — Responder lifecycle controls (`Start`, `Stop`, `Restart`, `restart_required` indicator, startup `custom_data_warnings` banner), masked community input with visibility toggle, MIB-assisted custom OID JSON overrides, and filtered terminal log stream with TXT/JSON exports.
3. **Walk & Parse** — SNMPv2c subtree walker (`timeout_ms` `[500..10000]`, `retries` `[0..5]`), persistent draft/history, flat/grouped/raw result tables, filterable JSON & raw panes, and CSV/TSV/JSON exports.
4. **Traps Console** — Trap/Inform sender with VarBind auto-enrichment (numeric OID and symbolic lookups), Inform `error_status_code` acknowledgement checking, server-paginated live receiver table (`Older` / `Newer`), 4-metric receiver bar, masked community inputs, replay overrides (`host`, `port` default `162`, `community`, `timeout`, `retries`), and BER payload decoder with optional source host/port summary.
5. **MIB Browser** — Module & numeric `oid_tuple`-sorted OID hierarchy, `Depth 1..5` expansion, `sessionStorage` expansion persistence, numeric OID + text search, human-readable SMI constraint badges, and cross-workspace handoffs.
6. **MIB Manager** — Multi-file drag/drop validation (`duplicate_modules` warnings, partial compile readiness, remote auto-fetch reporting), upload/reload outcome reporting, module metadata inspection, `recompile_recommended` 1-click recompile banner, sortable Trap Library, scoped JSON/CSV exports, and immutable bundle timeline with `previous_active_bundle_id` structural diffs.
7. **Settings** — Runtime & MIB preferences (`auto_start_simulator`, `auto_start_trap_receiver`, `session_timeout` `[60..86400]s`, `@mib@` URL validation, `restart_required` indicator, failed-load guard), read-only username with password rotation strength meter, JSON statistics export, and release metadata.
