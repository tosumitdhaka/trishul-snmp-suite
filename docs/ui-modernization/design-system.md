# Modern Operator UI — Visual and Interaction Design System

**Status:** Initial design specification for review (not yet implemented)
**Date:** 2026-10-09
**Direction:** Professional, **light-first** operations console with fully supported dark mode
**Related:** [Architecture](architecture.md) · [Migration plan](migration-plan.md)

## Design principles

1. **Operational clarity before decoration.** Show whether a device, simulator, receiver or WebSocket is running, failing, idle or disconnected with explicit text and contextual detail.
2. **Light by default; dark by design.** Both themes use the same semantic hierarchy, keyboard focus, validation and density standards.
3. **Fast to scan, powerful when needed.** Summaries stay simple; structured tables, advanced OID/tree navigation and raw protocol details are one deliberate interaction away.
4. **Dense without being cramped.** Favor logical grouping, meaningful whitespace, short labels, consistent column alignment and discoverable bulk actions.
5. **Preserve operator mental models.** Existing SNMP terms, protocol values and workflows remain recognizable. Redesign presentation, not the meaning of commands.
6. **Design for failure.** Empty data, auth expiry, WS reconnect, partial failure, invalid MIBs and long-running operations are first-class screens/states.

**Avoid:** generic marketing hero blocks; gradients behind data tables; decorative charts that do not answer an operator question; animated counters; ambiguous icon-only controls; red/green without text; hidden destructive actions; layout shifts during live updates.

## Layout blueprint

Desktop (>1024px):
- Persistent left sidebar (~248px), collapsible for data-heavy work; top app bar (~64px) with workspace title, global command search, health indicators, theme and account.
- Main content fluid with logical maximum reading widths where appropriate; table/tree workspaces may use full width.
- A compact page intro and a right-aligned primary action area; sticky contextual filters/toolbars only when justified.
- Dashboard sequence: service health → key counts → activity/recent events → task entry points. All values must come from real endpoints.

Tablet (641–1024px):
- Sidebar collapses to icon rail or drawer as usable space demands.
- Search and status actions remain accessible; table toolbars may wrap.
- Dense tables scroll horizontally with clearly labeled columns rather than shrinking OIDs into illegible text.

Mobile (≤640px):
- Drawer navigation with focus trap and Escape/overlay close.
- Single-column cards, stacked compact filters, accessible touch targets and sticky critical action where appropriate.
- Hide optional table columns only if users can still access all data in row details; never omit essential OID values or error text.

The exact breakpoint values are **starting targets**, not a substitute for testing with real content.

## Typography and rhythm

- Use a locally available/system sans stack for UI: `Inter` when bundled/licensed, otherwise `ui-sans-serif, system-ui, Segoe UI, sans-serif`.
- Use a local/system monospace stack for OIDs, hex payloads, IP addresses, timestamps where alignment helps, raw SNMP values and JSON.
- Suggested type scale: page heading 24–28px; section heading 18–20px; body 14–16px; table 13–14px; helper text 12–13px with verified contrast.
- Prefer tabular numbers for counters, ports, measurements and timing. Make long OIDs selectable/copyable; allow truncation with an accessible full-value reveal.
- Spacing scale: 4, 8, 12, 16, 24, 32px. Use 16–24px for card padding; avoid unrelated arbitrary margins.
- Reusable radii: 8px controls, 12px cards, 16px panels. Flat, restrained shadow; borders should organize content better than drop shadows.

## Starter semantic color tokens

These are provisional **design tokens**, not a committed palette. Do not hardcode literal color values in feature components; use semantic utilities/CSS variables and verify contrast in context.

| Token | Light | Dark | Intent |
|---|---|---|---|
| `--canvas` | `#F6F8FC` | `#09111F` | App background |
| `--surface` | `#FFFFFF` | `#111C30` | Cards and navigation |
| `--surface-subtle` | `#F0F4F9` | `#192840` | Table hover / grouped controls |
| `--text` | `#17243B` | `#E6EDF8` | Primary text |
| `--text-muted` | `#52627A` | `#A4B4CE` | Secondary text |
| `--accent` | `#2563EB` | `#60A5FA` | Actions, selected, focus |
| `--success` | `#15803D` | `#4ADE80` | Healthy / completed |
| `--warning` | `#9A6700` | `#FBBF24` | Partial / pending / caution |
| `--danger` | `#B42318` | `#FCA5A5` | Failed / destructive |

For reference, sample text contrast against the paired **white/light surface** or **dark surface** is above 4.5:1 for the listed accent, muted, success, warning and danger text tokens. **This is not sufficient to certify every UI combination**: badges, borders, overlays, hover, disabled states and text against `--surface-subtle` still need automated and manual validation.

Design tokens should extend to border, focus-ring, chart-series, semantic backgrounds and selection/highlight variants; derive those only after contrast testing.

## Information architecture

Primary navigation:
- **Overview:** Dashboard
- **Operations:** Simulator, Walk & Parse, Traps
- **MIB Workbench:** MIB Browser, MIB Manager
- **Account & Preferences:** Settings

Every workspace title should answer “where am I?” and its subtitle “what can I do here?”. Persistent nav selection, route-based breadcrumbs where helpful and Cmd/Ctrl+K search reduce hunting. Command search must honor current route, keyboard shortcuts and screen-reader labels.

Cross-workspace actions such as “Inspect OID in MIB Browser”, “Use in Walk” and “Send as Trap” should preserve task context in routes or deliberate state transfer; never silently carry over sensitive communities between workflows.

## Components to standardize

| Component | Required behavior |
|---|---|
| Shell/nav | Visible active item, full label/tooltips in collapsed mode, focus order, mobile drawer behavior |
| Command search | Keyboard shortcut; text synonyms; safe static routing; no auth bypass; no hidden focus |
| Status indicator | Text + icon + semantic tone; distinguish online/offline from simulator running/stopped |
| KPI/metric card | Real value, label, source/last-updated hint when useful; stable digits, loading/error state |
| Toolbar | Search/filter, primary action, exports, result count; compact but not crowded |
| Data table | Sort, column labels, filters, pagination/virtualization only where needed; keyboard access |
| Tree/OID inspector | Expand/collapse, selection, search, detail panel, copy, numeric/symbolic toggles |
| Input/validation | Visible label, hints, exact SNMP range/type error, input association and focus to invalid field |
| Dialog/confirmation | Clear action/impact, safe defaults, Escape and focus restoration, destructive emphasis |
| Toast/notification | Specific outcome; non-blocking where possible; link to details if helpful |
| Empty/error/loading | Distinguish no data, no results, disconnected, unauthorized, request failed, still working |
| Log/event viewer | Time, severity, bounded list, pause/follow, copy, filtering and accessible updates |

Prefer consistent primitives instead of feature-specific markup. shadcn/ui components are locally owned source that must be maintained, not magic immutable dependencies.

## Screen-specific direction

### Dashboard
Use a concise status overview above the fold. Runtime status, MIB catalog health and activity must be understandable without reading small print. Prefer compact recent-event summaries and context links over many equal-weight cards. If a metric is unavailable, say so rather than displaying zero.

### Simulator
Separate **configuration**, **lifecycle controls** and **activity log** into readable zones. Highlight running port/endpoint, unsaved custom-data edits and restart-required state. No accidental restart from a tab change.

### Walk & Parse
Prioritize a visible target/OID command row, progress and cancellation, and a high-utility results table with copy/export. Parsed and raw results must be switchable without losing relevant user context.

### Traps
Distinguish **receiver** and **sender** clearly. Use a structured varbind editor with safe type/range handling, event history filters, and strong visual confirmation of send/replay results. Live history must not jump unexpectedly when paused.

### MIB Browser
Optimize a two/three-pane explorer for symbol search, tree context and detail. Keep detail actions visible; show schema constraints and enums as understandable metadata, not decorative badges only.

### MIB Manager
Show active bundle and source-group status first; make risky upload/reload/rollback/delete actions explicit. Surface dependency and compile errors with affected modules, resolution hints and retry paths.

### Settings
Group credentials/security separately from app/runtime preferences; surface which changes apply immediately and which require restart. Make stats reset and logout consequences unambiguous.

## Accessibility and inclusive interactions

Target WCAG 2.2 AA for interactive screens, tested with keyboard and assistive technology. Key points: labels and programmatic errors; minimum effective target sizes; visible focus; semantic headings/landmarks; adequate color contrast; reduced-motion preference; table headers and descriptions; no forced auto-scroll from streaming events; and no content known only by color. Test critical flows at 200% zoom and on narrow viewports.

- No fake `button` implemented with a `div`.
- Avoid nested interactive elements and dialogs without predictable focus handling.
- For live events, announce connection-state changes politely; do not announce every log line in a noisy stream.
- Secret fields remain appropriately masked; copying a value is an explicit user action.

## Theme behavior

1. Default to **light** when the user has no saved preference; explicit dark choice is equally supported.
2. Provide clear light/dark control; a future `system` option is possible, but requires defined precedence.
3. Persist preference with the legacy key `trishul_theme` only after compatibility is verified. Auth state must not be stored there.
4. Apply theme before React paints to prevent an initial flash; do not delay functionality if storage is blocked.
5. Test all semantic combinations (selection, hover, focus, disabled, warning/error, code panels, tables, modals, chart legends) in both themes.
6. Do not automatically switch themes based on time of day.

## Prototype approval before implementation

Review at least three representative layouts in light and dark: **dashboard**, **dense MIB Browser**, and **form-heavy Traps or Simulator**. Include compact desktop and mobile states.

Approve the type scale, color tokens, sidebar/navigation, density, status language and components against real SNMP data. Only after prototype review should the Stage 2 shell styling be treated as stable; refinements remain possible without affecting API contracts.
