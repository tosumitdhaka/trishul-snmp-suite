# Stage 2 Dashboard — Light/Dark Review Specification

**Status:** Proposed visual and behavioral design, awaiting actual browser review and sign-off.
**Baseline:** [Legacy feature inventory](legacy-feature-inventory.md)
**Parent:** [Design system](design-system.md) and [migration plan](migration-plan.md)

## Information priority

1. Title **Operations overview**, plain subtitle with real backend version/refresh state and an unobtrusive “Preview” indicator.
2. **Runtime health band:** Backend API health and WebSocket transport are separate; simulator and trap receiver show Running/Stopped/Unavailable; loaded MIB modules/trap types show numeric totals, not decorative scores.
3. **Activity ledger:** the eight actual v2.2.4 counters displayed in two readable groups. No invented trend percentage, fake graphs, or synthetic metrics.
4. **Workspace launchers:** six native links into the React routes with explicit “Not migrated” messaging and quick legacy fallback. No fake buttons for disabled workflows.
5. **Feedback:** last updated timestamps; a visible retry button; accurate loading, stale/disconnected and partial failure states without turning missing data into 0.

## Layout wireframe (content structure, not a final screenshot)

```text
┌────────────────── left navigation ────────────────┬───────────────────────────────────────────────────────┐
│ Trishul / SNMP Suite · Preview                     │ Dashboard                           Live updates / Theme │
│ Overview · Operations · MIB Workbench · Account    ├───────────────────────────────────────────────────────┤
│                                                    │ Operations overview                  [Refresh] [Legacy] │
│                                                    │ System health & shared SNMP backend                  │
│                                                    │                                                       │
│                                                    │ [Backend status][Simulator][Receiver][MIB modules]   │
│                                                    │            [Trap types] + transport status             │
│                                                    │                                                       │
│                                                    │ Activity                  (8 real counters, 2 rows)   │
│                                                    │ [Requests][OIDs][Received][Sent]                     │
│                                                    │ [Walks][OID results][Sources][Reloads]               │
│                                                    │                                                       │
│                                                    │ Workspaces              native React links           │
│                                                    │ [Simulator][Walk & Parse][Traps]                     │
│                                                    │ [MIB Browser][MIB Manager][Settings]                 │
└────────────────────────────────────────────────────┴───────────────────────────────────────────────────────┘
```

Desktop (~1440): 4 health cells in a row plus trap types as compact dedicated summary, activity 4-column. Tablet (~1024): 2-column health/activity. Mobile (~390): one-column health and short activity cells, accessible nav drawer; long text wraps.

## Interaction/state rules

| Condition | UI behavior |
| --- | --- |
| No token / invalid session | Login screen, no cached private dashboard display |
| Request still pending | “Checking…” or skeleton; never 0 |
| REST request failed without previous data | “Unavailable” with retriable message |
| REST request failed with older cached data | Label **Last known** and time; avoid presenting as live |
| WebSocket disconnected, API working | Explicit **Updates delayed; checking by polling**; continue safe REST refresh |
| WS full_state received | Apply simulator/receiver/status/stats/MIB summary cache updates |
| Backend API down | Show backend unavailable even if socket state still reads reconnecting |
| Operator refresh | Revalidate individual API queries, announce updating, do not mutate backend |
| MIB REST summary and WS payload differ | Normalize to a common count model, preserve numeric zero |
| Unmigrated page selected | Explicit placeholder with a single-click legacy destination |

## Light and dark execution

Use the existing semantic `--canvas`, `--surface`, `--text`, `--muted`, `--accent`, `--success`, `--warning`, `--danger` variables; avoid raw per-feature colors. Health should have **text + icons**, not just hue. Keep card borders quiet and typography clean. No gradients behind data, aggressive shadows, animated graphs, or inaccessible status chips.

## Contract-backed calculations

- `GET /api/mibs/status` supplies `loaded`, `mibs[].traps` and `source_groups[].file_count`.
- Live `full_state.mibs` / `mibs` event supplies `loaded`, `traps_available` and `source_files`.
- `GET /api/stats/` supplies activity counters. `mibs.upload_count` may be used for “MIB sources” (or normalized source groups fallback).
- Simulator/receiver state from respective `/status` endpoints and WS status/full_state events.
- Backend metadata from `GET /api/meta` (unauthenticated health reference; does not prove that private routes work).

The app must not infer loaded object counts from unrelated figures, invent a trend, treat “Stopped” as unreachable, or claim WS health means the SNMP listener is active.

## Stage 2 acceptance checks

- [ ] Four runtime/API health and MIB/trap-type statuses are represented distinctly
- [ ] All **eight** legacy activity counts and six shortcut links are present
- [ ] MIB REST response and WebSocket summary normalize correctly (including empty arrays and missing fields)
- [ ] Session expiry/reconnect state and unavailable/stale data are displayed accurately
- [ ] Both light/dark modes pass manual contrast and keyboard review
- [ ] 1440/1024/390 reference screenshots captured with actual app in each theme
- [ ] Unit/component tests plus clean TypeScript/lint/build CI
- [ ] Real-backend regression and browser checks before declaring dashboard complete

## Implementation status

The initial Stage 2 PR may implement this layout as a **reviewable preview**, but approval of the final design, complete API contract fixtures, performance evidence, and manual browser checks are independent gates. The default legacy UI remains untouched.
