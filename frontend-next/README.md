# Trishul Modern UI — Stage 1 foundation preview

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

Stage 1 scaffolding: React Router with seven routes, theme control, authentication, one typed API client, WS reconnect/cache lifecycle, read-only connectivity metrics, accessible navigation and explicit placeholders for unmigrated workspaces.

Not yet implemented: full shadcn/ui component library, generated OpenAPI schemas, migrated operational workspaces, Playwright/browser E2E evidence, production container integration or /next/ preview serving.

See docs/ui-modernization/architecture.md, docs/ui-modernization/migration-plan.md and docs/ui-modernization/design-system.md.
