# Trishul Modern UI — Stage 2 dashboard preview

This is a separate React + TypeScript application, **not** the released UI. It does not replace anything in the legacy frontend directory.

## Local development

Node 22.12+ required. Start FastAPI on http://127.0.0.1:8980 (or override with TRISHUL_API_ORIGIN), then:

    cd frontend-next
    npm ci
    npm run dev

Open http://127.0.0.1:5173/next/.

Vite proxies /api (including WebSocket upgrades) to the existing backend. Authentication uses the same server-side session and X-Auth-Token contract. A same-tab legacy login can be validated using the existing snmp_token session storage key. Each tab may otherwise require its own login.

Check locally:

    npm ci
    npm run typecheck
    npm run lint
    npm test
    npm run build

The built app is isolated under frontend-next/dist. It is **not** packaged by the existing Dockerfile and /next/ is not mounted by the backend yet. The old UI remains at /.

## Implemented scope

Stage 1 foundation plus Stage 2 preview: React Router with seven routes, theme control, authentication, one typed API client, WS reconnect/cache lifecycle, searchable Ctrl+K navigation, and a read-only dashboard preserving all eight activity counters, four health/MIB tiles, six workspace shortcuts, and explicit API versus WebSocket state. Unmigrated workspaces still show placeholders with direct legacy links.

The dashboard normalizes the legacy MIB REST response and the WebSocket summary without presenting missing counts as zero.

The Stage 2 shell uses the unchanged legacy Trishul SVG brand mark in both the sidebar and sign-in screen. One header navigation button controls either the sidebar or mobile drawer (no duplicate hamburger button): on desktop (lg and wider) it toggles between the labeled 256px sidebar and compact icon rail (76px), while on smaller viewports it opens the full-label drawer. The desktop choice is persisted in `localStorage` as `trishul_next_sidebar_collapsed`. Compact icons have accessible names and hover titles. This setting is independent from `trishul_theme` and login state. Retry, stale/error and light/dark behavior still need real-browser sign-off.

Not yet implemented: full shadcn/ui component library, generated OpenAPI schemas, migrated operational workspaces, Playwright/browser E2E evidence, production container integration or /next/ preview serving.

See docs/ui-modernization/architecture.md, docs/ui-modernization/migration-plan.md, docs/ui-modernization/design-system.md, docs/ui-modernization/legacy-feature-inventory.md and docs/ui-modernization/dashboard-review-spec.md.
