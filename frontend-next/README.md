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

## Troubleshooting development WebSocket proxy errors

Vite proxies `/api/ws` to the same FastAPI backend as other `/api` requests. A terminal message such as `ws proxy error: write ECONNABORTED` means the proxy's underlying socket write was interrupted; by itself it does **not** identify whether a browser reload/logout, backend restart, network interruption, or another connection issue caused it. Do not suppress all proxy errors or log token-bearing WebSocket URLs.

1. Confirm `curl http://127.0.0.1:8980/api/health` returns `"status":"ok"`. For a native backend on 8000 instead, use `TRISHUL_API_ORIGIN=http://127.0.0.1:8000 npm run dev`.
2. After the message, look at the header indicator. `Live updates` means the WebSocket reconnected. `WS: reconnecting` means the app is retrying, with REST polling temporarily covering operational readouts.
3. If the error repeats while the app is open, inspect backend terminal or `./install-trishul-snmp-suite.sh logs`, container health/restarts, and the browser Network > WS connection's close code. Never share a full `/api/ws?token=...` URL or session token in diagnostics.
4. If only a one-off disconnect appears and live updates recover, it does not require changing credentials or turning off WebSocket support.

The client retains the existing ping/pong lifecycle and reconnect-with-backoff behavior. Actual local-stack integration testing is required to establish the root cause of a recurring disconnect.

### Isolate repeated Vite WebSocket proxy aborts (development only)

A green `/api/health` result proves **HTTP** connectivity, not WebSocket uptime. FastAPI does not necessarily log every routine WebSocket connect/disconnect. If Vite repeatedly reports `ws proxy socket error: write ECONNABORTED`, use this **A/B diagnostic**, not a blanket error-suppression patch:

**A — Normal proxy (baseline).** Run `npm run dev`, log in and leave the browser tab open. Note whether `Live updates` repeatedly changes to `WS: reconnecting`. If it does, inspect the browser Network > WS status and frames. Avoid sharing or copying the token-bearing request URL.

**B — Direct loopback WebSocket (without the Vite WS proxy).** Stop Vite, then from `frontend-next/` run:

```bash
VITE_TRISHUL_WS_ORIGIN=ws://127.0.0.1:8980 VITE_TRISHUL_WS_DEBUG=1 npm run dev
```

This option changes **only the WebSocket target** to FastAPI at localhost:8980 and **disables Vite's `/api` WebSocket proxy for this development session**; REST calls still use Vite's `/api` proxy, and Vite's own hot-reload WebSocket remains enabled. For a native backend on port 8000, also set `TRISHUL_API_ORIGIN=http://127.0.0.1:8000` and set the WebSocket origin to `ws://127.0.0.1:8000`. Both the browser and backend must be reachable on the same loopback interface. The value `ws://127.0.0.1:5173` is rejected because that is Vite itself, not FastAPI. **Close other preview tabs and restart Vite** so stale proxied sockets cannot interfere with the A/B test. Open `http://127.0.0.1:5173/next/` again.

The direct target override is accepted **only in development**, with an HTTP-served local UI, and a loopback `ws://` or `wss://` target with an explicit port. Non-loopback URLs, embedded credentials, unexpected paths/query strings, and production usage fall back to the same-origin Vite proxy. Do not configure a public WebSocket origin; the backend has no origin-checking mechanism for direct cross-site exposure.

With `VITE_TRISHUL_WS_DEBUG=1`, browser DevTools **Console** shows `[Trishul WS] connecting {route: 'direct-loopback'}` (or `'vite-proxy'`), `[Trishul WS] connected`, and sanitized close diagnostics: `code`, `wasClean`, and `durationSeconds`. These omit URLs, payloads, and session tokens. Common codes: `1000` orderly close, `1006` abnormal transport close, `4000` heartbeat timeout, `4001` expired/unauthorized session.

If direct mode remains connected while the regular proxy mode aborts, investigate Vite's dev WebSocket proxy rather than changing FastAPI auth. If **both** modes drop, inspect backend runtime logs, container restarts, browser lifecycle and the close code. Debug logging and direct mode are disabled by default; neither changes deployed Docker/runtime behavior. Stop Vite and run plain `npm run dev` to return to normal.

## Implemented scope

Stage 1 foundation plus Stage 2 preview: React Router with seven routes, theme control, authentication, one typed API client, WS reconnect/cache lifecycle, searchable Ctrl+K navigation, and a read-only dashboard preserving all eight activity counters, four health/MIB tiles, six workspace shortcuts, and explicit API versus WebSocket state. Unmigrated workspaces still show placeholders with direct legacy links.

The dashboard normalizes the legacy MIB REST response and the WebSocket summary without presenting missing counts as zero.

The Stage 2 shell uses the unchanged legacy Trishul SVG brand mark in both the sidebar and sign-in screen. One header navigation button controls either the sidebar or mobile drawer (no duplicate hamburger button): on desktop (lg and wider) it toggles between the labeled 256px sidebar and compact icon rail (76px), while on smaller viewports it opens the full-label drawer. The desktop choice is persisted in `localStorage` as `trishul_next_sidebar_collapsed`. Compact icons have accessible names and hover titles. The single button always displays the three-line hamburger icon at every viewport size; its accessible label describes its current action. This setting is independent from `trishul_theme` and login state. Retry, stale/error and light/dark behavior still need real-browser sign-off.

Not yet implemented: full shadcn/ui component library, generated OpenAPI schemas, migrated operational workspaces, Playwright/browser E2E evidence, production container integration or /next/ preview serving.

See docs/ui-modernization/architecture.md, docs/ui-modernization/migration-plan.md, docs/ui-modernization/design-system.md, docs/ui-modernization/legacy-feature-inventory.md and docs/ui-modernization/dashboard-review-spec.md.
