# Modern Settings — Stage 3 Review Specification

**Status:** Implemented as an isolated React preview slice; browser and real-backend sign-off pending.  
**Branch:** `feat/modern-ui-settings-stage3` (based on Stage 2).  
**Scope boundary:** `frontend-next/` and related docs only. Legacy UI, FastAPI routes, Docker, default route and production packaging unchanged.

## Parity contract (source-audited)

| Function | Existing endpoint | Implementation / safety rule |
| --- | --- | --- |
| Load persisted preferences | `GET /api/settings/app` | Authenticated; save disabled until successful load; no fake defaults |
| Save startup flags, session expiry and remote MIB sources | `POST /api/settings/app` | Full-value writes; validate entire request before send, preserve source order, flag restart from returned data |
| Rotate password | `POST /api/settings/auth` | Fixed username, verify current password server-side, min 6 chars, confirm action, all sessions invalidated, redirect to login |
| Export statistics | `GET /api/stats/` | Fetch fresh data, omit `runtime` field, JSON download, no credential/session tokens in payload |
| Reset statistics | `DELETE /api/stats/` | Explicit destructive confirmation, error feedback, invalidate dashboard stats |
| App metadata | `GET /api/meta` | Name, version, author, description |
| Active MIB bundle | `GET /api/mibs/status` | Bundle label, producer version, loaded modules, recompile advisory linking to MIB Manager |

### Controls and behaviors

- Accessible, responsive grouping: **Application settings**, **Authentication**, **Statistics**, **About**.
- Auto-start simulator and trap receiver switches are boot preferences, not live start/stop commands; keep the server-generated **Restart required** badge.
- Session timeout accepts whole numbers from **60** through **86400** seconds inclusive. Blank, NaN, decimals and out-of-range values block save.
- Remote source list accepts one HTTP(S) URL per line, requiring the literal `@mib@` placeholder. Trim whitespace, ignore blank lines and preserve order. Show specific line numbers when invalid. Server always has final validation authority.
- Store draft values separately from the server snapshot: a failed initial load cannot accidentally overwrite real values, and background updates cannot erase unsaved edits.
- Password input is masked, username readonly, strength label is a hint, mismatch is reported. No password/token console logging. A successful change expires the current React session immediately; other active sessions are invalidated on the server.
- Statistics reset is irreversible; the confirmation dialog supports Cancel/Escape. Export removes the `runtime` object, matching legacy behavior. Do not display secrets in export logs.
- Any backend error is shown without inventing zero data or success.
- Legacy Settings remains available at `/#settings`.

## Manual acceptance before parity sign-off

- [ ] Desktop at 1440px and 1024px; mobile at 390px, light/dark, keyboard navigation and Escape/focus restoration.
- [ ] Settings GET success, offline/error, retry, unsaved edits, reload and save of every field against a running 2.2.4 FastAPI instance.
- [ ] Restart badge matches the backend across navigation after changing autostart versus actual runtime state; no surprise live start/stop.
- [ ] Invalid timeout and malformed source lines block writes; server rejects bad input atomically; valid source list persists in order.
- [ ] Wrong current password leaves login intact; mismatch/short new password block request; successful password rotation logs out all sessions and new password works.
- [ ] Stats export contains expected activity groups without `runtime`, reset has explicit confirm and dashboard counters refresh. Cancel does not call DELETE.
- [ ] Metadata and MIB bundle values match legacy and no failures present as zero.
- [ ] WebSocket connection stability, session expiry (HTTP 401 and WS 4001), mobile drawer, and theme switches remain functional.
- [ ] Browser E2E, visual screenshots and measured benchmark comparison pending. CI checks alone are not browser sign-off.

**Known open gate:** The Stage 2 Vite WebSocket `ECONNABORTED` investigation remains under user testing. Stage 3 does not change its backend or proxy logic. This slice stays a draft preview.
