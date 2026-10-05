# UI Verification Checklist

Use this checklist for the current `2.2.0` release UI.

## Test Matrix

- desktop: `1440px` wide viewport
- laptop: `1024px` wide viewport
- mobile: `390px` wide viewport
- entry points: fresh logged-out load and authenticated session restore

## Setup

1. start the intended release build or local installer flow
2. open the app in a clean browser profile
3. verify login with the current configured credentials
4. repeat the page checks at desktop and mobile widths

## Global Checks

- login page loads metadata, version, and health without broken layout
- authenticated shell lands on `Dashboard` and hash routing works across every page
- live connection status reaches the online state after login and recovers after refresh
- sidebar, header badges, and sign-out action stay visible and usable
- forms, buttons, tables, and cards keep consistent spacing and focus treatment
- desktop layout does not clip long labels, JSON blocks, or header actions
- mobile layout avoids horizontal scrolling and keeps primary actions reachable

## Page Checks

- `Dashboard`: status cards, counters, and shortcuts all load cleanly
- `Simulator`: config form, JSON editor, status panel, and activity log all remain usable and update live
- `Walk & Parse`: walk form, results panel, filters, copy, and export actions all behave correctly
- `Traps`: listener controls, sender form, trap library, varbind editor, and received-events table all render and update correctly in live use
- `MIB Browser`: module view, OID view, search, filters, and detail pane all remain usable
- `MIB Manager`: status counters, trap catalog, export actions, upload dialog, validation, and reload actions all behave correctly
- `Settings`: auth form, app settings, stats actions, and metadata panels all remain usable

## 2.1.0 UI Elements

- `Walk & Parse`: parsed rows render the raw value with a muted `label(value)` inline enrichment and units suffix, single-line rows (no badge pills in the dense table); line mode still shows display strings
- `Traps`: received-trap varbind rows show the enum badge / units suffix with a full-text tooltip on hover (no clipping) and the detail modal shows the badge variants; the varbind picker defaults each object to its MIB-declared type (Integer/Counter/Gauge/TimeTicks/OID/IpAddress) and offers enum dropdowns immediately; Integer rows with a range constraint show a min/max hint below the input, String rows with a size constraint show a length hint and validate before send
- `MIB Browser`: the detail pane shows the Enumerations table (sorted by value, count-badged, sticky header, ~300px scroll) and a Units badge; typing a numeric OID prefix resolves instantly from the local oid-index (e.g. `1.3.6.1.2.1.2` → `ifTable`) — with a loading state while the index first downloads, and the fast path defers to server search when a module/type filter is active
- `MIB Manager`: the recompile banner appears when the active bundle was produced by an older MIB compiler — the Recompile action actually recompiles, shows a busy state, dismissal is scoped to the bundle, and the copy reflects the actual producer version; module rows expand a revision-history card (organization, contact info, revisions) that stays expanded across list re-renders
- `Simulator`: starting with invalid custom-data entries shows an inline warning panel listing the skipped entries (dismissible; not erased by status refreshes)

## 2.2.0 UI Elements

- `MIB Manager`: a Bundle Sets panel lists compiled bundles — each row offers Diff (against the previous active bundle by default; disabled with a hint when there is nothing to diff against) and Activate/rollback; activation broadcasts to other open tabs; the trap catalog's Module and Objects columns are sortable; revision dates are humanized with a Latest badge; blocking alerts replaced with toasts
- `Traps`: sender supports inform mode; each received-trap row offers replay (recorded community masked with a "recorded value used" hint) and delete; the history table is paginated with a pager; CSV export and a pause control for live updates exist; timestamps show the full date; community strings render masked everywhere
- `Walk & Parse`: timeout and retry inputs in the advanced row; Cancel aborts an in-flight walk; result columns are sortable via keyboard-operable headers; plain Enter in the config form runs the walk; copy-as-table TSV export; progress runs indeterminate during the walk
- `MIB Browser`: detail panel shows constraint badges (range/size/enum/bits); an inline notice appears when the active bundle predates enum/units support; detail actions stay visible in a sticky bar; numeric OID search is instant after the first load (ETag-cached)
- `Simulator`: log pane has follow/pause toggle and level-count chips; the status indicator reflects the actual data source (Live vs Polling); Save shows an in-flight state and guards double-submits
- `Settings`: About card shows the active bundle and producer version; remote-source lines and session-timeout validate inline while editing; the restart-required badge persists across navigation

## Sign-Off

- record any regressions with page, viewport, and screenshot
- do not mark UI-affecting release work complete until this checklist passes on the intended release build
