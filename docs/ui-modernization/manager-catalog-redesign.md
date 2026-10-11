# MIB Manager catalog redesign — preview only

## Layout

The MIB Manager uses a catalog-first layout. At desktop widths (at least 1100px), the **Catalog & source inventory** occupies approximately two-thirds of the available content width. The right third contains **Catalog export** and **Compiled bundle history** as vertically stacked panels. Narrow layouts stack all sections. Summary metrics remain compact across the top.

The catalog heading has **Add / upload** and **Reload & dependencies** controls, with dialogs instead of page-height forms:

- **Add / upload → Fetch by name:** enter names such as `IF-MIB` (comma/newline separated, 1–30 names). The form posts to the existing authenticated `POST /api/mibs/fetch-dependencies` endpoint, passing `dependencies` and `reload_after_fetch`. The backend honors its configured remote-source policy; fetching only works when remote MIB fetching is enabled in Settings, and unresolved names can fail. The form reports downloaded/cached/unresolved names. It never promises success or substitutes fake source content.
- **Add / upload → Upload files:** uses the existing file validation and upload endpoints, compile mode, optional source group, and explicit upload action. Validation remains non-persistent and never performs an online fetch.
- **Reload & dependencies:** keeps the existing compile/reload confirmation and fetch-dependencies confirmation in a dedicated dialog.

## Selection and operations

The initial catalog view is **Modules**, so active MIBs can be selected even when no managed source files have been uploaded.

- **Modules:** checkboxes select loaded module names, scoped into catalog exports; selecting is not destructive.
- **Notifications:** checkboxes select notification OIDs, scoped into catalog exports; Send/Browse links remain per row.
- **Sources:** checkboxes select real managed source paths, allowing downloads. Delete is enabled only for selected paths explicitly marked deletable by the backend and still requires confirmation. Non-managed builtin modules cannot be deleted or downloaded through source endpoints.
- Bulk **Select visible / Deselect visible** operates on the currently displayed page. Selections persist while switching tabs. A per-view Clear selection action is available.
- Export includes the selected module names / notification OIDs in the backend export contract. With no selection, it exports the full eligible catalog subject to source group/export type.
- Active bundle changes, compile actions, activation/rollback, and diff are unchanged.

## Acceptance tests still needed

- Confirm online policy on/off and cached/new/missing modules using a real backend. Validate actual `IF-MIB` fetch and bundle reload if remote source is configured.
- Check 390/768/1024/1440px layouts in light/dark, keyboard access and modal scroll.
- Validate source selection/download/deletion restrictions, module/notification scoped export, 75-item pagination, bundle comparison and rollback.
- Confirm the legacy interface and production remain unchanged. This is a stacked draft preview branch, not merged/deployed.
