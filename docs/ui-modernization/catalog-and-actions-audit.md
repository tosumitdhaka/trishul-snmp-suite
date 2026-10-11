# Catalog consolidation, fetch diagnostics, and action consistency

**Branch:** `feat/modern-ui-catalog-and-action-consistency` stacked on PR #41. Draft preview only.

## Online MIB fetch: what CERAGON-MIB failure means
The existing API `POST /api/mibs/fetch-dependencies` reports `cached`, `resolved`, `failed`, `auto_enabled`, `using_default_sources`, and `sources`. This is not a universal MIB registry: it only checks locally cached sources or tries the configured/default tsmi remote sources when policy permits. A returned `failed: ["CERAGON-MIB"]` may mean the repository does not provide that vendor MIB; do **not** treat a 200 response with `failed` as a successful fetch. The UI displays report details and actionable reasons: disabled online fetching vs default source miss vs configured source miss. It offers local vendor-MIB upload and Settings. An untrusted third-party MIB host is not silently added as a default.

**Live diagnosis pending:** actual Settings values, remote template availability, backend logs, network access and vendor file validity in operator environment. Public searchable indexes are not the same as configured raw source servers.

## Manager catalog simplification
- Two tabs: **Modules & sources** (default) and **Notifications**. A deduplicated view displays active modules with their managed source file when available, plus unmatched pending/failed/shadowed uploads. Source-group and status filter operate on the combined data.
- Single row selection identifier; selected active modules become catalog export filters. Selected managed paths can be downloaded or deleted; built-in modules never become deletion targets. Notification selection uses symbolic full name required by backend export contract.
- Sort from visible column headers (name, source group, status, objects, traps), with accessible `aria-sort` and toggle direction. No separate Sort dropdown. Notification header sorts symbolic names.
- Selection persists across pages/filters; visible Select/Deselect affects only the visible page.
- Catalog stays two-thirds on desktop; Export and Bundle History remain on the right.

## Button and spacing audit
- Shared `btn-primary` for explicit submit/start/execute, `btn-secondary` for non-destructive actions, `btn-danger` for clear/delete and unsent-varbind removal, and `btn-icon-action` for obvious repeated Refresh, Copy and Close actions with accessible names/tooltips.
- Refresh icon is a circular arrow; Restart is a distinct rotate-back icon. Format-specific exports keep visible JSON/CSV/TSV identifiers to distinguish multiple formats. Clear filters is secondary, not danger; server history clear is danger.
- Aligned button dimensions/padding and consistent panel header/body spacing, mobile padding, narrower default workspace gutters. Maintains responsive sidebar and modal scroll behavior.

## Acceptance gates
- [ ] With actual backend Settings, retry CERAGON-MIB, capture only sanitized `cached/resolved/failed/auto_enabled/using_default_sources` fields; inspect backend logs if necessary; do not share credentials or private remote URLs.
- [ ] Source-group filter exposes pending and failed uploads without separate Sources tab; selected managed paths download/delete correctly, while builtins are export-only.
- [ ] Header sorting and table selection work with 75+ rows, repeated click, pagination, filtered statuses.
- [ ] Review all workspace action buttons and spacing on 390px/768px/1440px, at 200% zoom, light/dark themes, keyboard navigation.
- [ ] Validate action endpoints with live server; unit/component test fixtures do not prove network fetch or SNMP behavior.

Do not merge or deploy; legacy frontend unchanged.
