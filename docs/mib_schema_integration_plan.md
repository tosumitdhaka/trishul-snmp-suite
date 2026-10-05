# MIB Schema Integration Plan

Status: planning complete, phased for `2.1.0`
Date: 2026-10-01
Owner: backend/frontend maintainers

This plan integrates the trishul-smi `0.5.3` JSON IR capabilities into the
suite. It consolidates two prior analyses (the schema delta review and the
earlier feasibility study). Where they disagreed — the earlier study claimed
`constraints` was new in `0.5.3` — the corrected finding stands: `constraints`
predates `0.5.2` (it was contract-pinned there, along with a BITS fix), while
`enums` and `units` are genuinely new.

## 1. Scope and background

trishul-smi `0.5.3` (with trishul-snmp `0.6.2`) emits an additive, richer MIB
JSON IR at `schema_version` `1.1` (unchanged — bumping is reserved for breaking
changes per the trishul-smi bundle compatibility policy).

Object-level IR delta fields in the `0.4.5` → `0.5.3` window:

| Field | Since | Meaning |
|---|---|---|
| `enums` | 0.5.2 | Ordered `label → number` map for INTEGER/BITS inline constraints (e.g. `ifOperStatus` → `{"up": 1, ...}`) |
| `units` | 0.5.2 | SMIv2 `UNITS` clause string (e.g. `"bits/second"`) |
| `enterprise` | 0.4.7 | TRAP-TYPE `ENTERPRISE` ref, emitted as `{module, object}` |
| `trap_number` | 0.4.7 | TRAP-TYPE assignment subidentifier |

Supporting facts, with evidence:

- Emitter: `trishul_smi/output/json_fmt.py:87-116` (`_enum_map`) and `:157-171`
  (field emission); `models/mib_object.py:23,26-27`.
- `constraints` existed in 0.4.5 (`models/mib_object.py:22` in the 0.4.5 tree);
  0.5.2 documented it and fixed dropped BITS constraints.
- Module-level JSON shape, `types` (TC records incl. `display_hint`), `imports`,
  `notifications`, `module_metadata`, `manifest.json`, and `oid_index.json`
  are byte-identical between 0.4.5 and 0.5.3 generators.
- Runtime library: trishul-snmp `0.6.2` already parses `enums`/`units`
  (`mib/registry.py:369-404`), exposes them on `MibNode`
  (`mib/models.py:41-43`) and on enriched `VarBind.enum_label`/`VarBind.units`
  (`mib/render.py:56-63`), and gates `schema_version` at `mib/registry.py:25,31-68`
  (accepts `<= 1.1`, rejects newer).

What already works with no suite changes (verified against the real bundle
`backend/data/bundles/sets/run-000001-if-mib-ianaiftype-mib/`, producer 0.5.3):

- Auto-enrichment of live responses: enum labels are embedded in
  `display_value` strings (`up(1)`) and `VarBind.units` is populated by
  trishul-snmp's `enrich_varbinds`.
- Old-bundle (pre-0.5.2) enum labels on live responses, via the constraints
  fallback inside trishul-snmp `mib/render.py:195-212` (`_constraint_enum_map`)
  and `:222-244` (`_enum_label_from_constraints` — the docstrings
  designate these the "older bundles" paths). Units are never available for
  old bundles — 0.4.5 dropped UNITS at parse time.
- Compile hardening inherited from the library: `cached` status,
  `WriterError` on output failures, per-run formatter instances,
  name-validation, offline cache fallback. The suite already tolerates the
  `cached` status (`bundles.py:771`).
- Schema gate: both old and new bundles load; only a hypothetical future
  `schema_version > 1.1` would be rejected.

## 2. Current state

Serializer drop-sites (all confirmed by review; `enums`/`units` never reach
the frontend through these paths):

| Site | Evidence | Drops |
|---|---|---|
| `_serialize_varbind` | `backend/app/services/runtime.py:1521-1542` | `VarBind.enum_label`, `VarBind.units` (enum survives only inside the `display_value` string, line 1528) |
| `_extract_value` | `backend/app/services/walker_service.py:23-30` | prefers raw inner `value` over the enriched display |
| trap history varbind loop | `backend/app/services/traps_service.py:234-247` | uses the raw `to_display_string()` (`raw_val["display"]`), not `display_value`; drops `enum_label`/`units` |
| `_node_to_record` | `backend/app/services/browser_service.py:40-60` | passes `constraints` (line 59) but not `enums`/`units` |

Five constraints-fallback implementations (the redundancy this
plan eliminates):

1. `backend/app/services/mibs_service.py:111-126` (`_enum_values_from_constraints`)
2. `backend/app/services/simulator_service.py:154-166` (`_first_enum_value`)
3. `backend/app/services/browser_service.py:321-338` (`_member_entry` inline constraints→enum_values derivation — the actual backend producer for the trap picker via `get_trap_catalog` → `/api/mibs/traps`)
4. `frontend/js/modules/traps.js:757` (`oid.enum_values || oid.constraints` fallback in the varbind picker — dead code from the picker path, since `_member_entry` output carries `enum_values` but no `constraints` key)
5. trishul-snmp `mib/render.py` (library-side, pinned 0.6.2, VarBind display boundary)

Other gaps:

- `reproducible` is not enabled: `bundles.py:191-197` builds `CompilerConfig`
  without it, so `generated_at` varies and recompiles are never byte-identical.
- `oid_index.json` is written by every compile (`bundles.py:195`) and its path
  is tracked in the DB (`models/bundles.py:24`), but it is never read.
- `units` is latent: no bundled MIB in `backend/mibs_bundled/` contains a
  `UNITS` clause (verified by grep; the only hit is a macro-body mention in
  `SNMPv2-SMI.txt:187`). The field is supported by the toolchain but no
  starter bundle exercises it.
- `enterprise`/`trap_number` are unused (no SMIv1 TRAP-TYPE MIBs in the
  starter set).
- TC `display_hint` is loaded by trishul-snmp and used by nothing.

Phase 0 (completed 2026-10-01):

- re-pinned to `trishul-smi==0.5.3` (`backend/requirements.txt:5`) and
  `trishul-snmp==0.6.2`
- pysnmp stack purged from the venv; requirements cleaned
- release gate re-run green (`scripts/run_release_gate.py`)

## 3. Work packages

### P1 — Serializer plumbing, reproducible bundles, recompile prompts

Goal: carry `enum_label`/`units` through every serialization path; make
compiles deterministic and bundle identity content-addressed; tell operators
when their bundle predates a capability.

Changes:

1. `backend/app/services/runtime.py:1521-1542` (`_serialize_varbind`): add
   two keys after `display_value`:
   `"enum_label": varbind.enum_label, "units": varbind.units`.
   Both exist on `VarBind` (trishul-snmp `mib/render.py:56-63`); they are
   `None` on non-enriched varbinds. Additive keys — old frontend ignores them.
2. `backend/app/services/walker_service.py`:
   - add `"enum_label": entry.get("enum_label")` and `"units": entry.get("units")`
     to `_walk_item` (`:33-42`, both `use_mibs` branches).
   - split value extraction: introduce `_raw_value(entry)` containing today's
     `_extract_value` body (`:23-30`); change `_extract_value` to prefer
     `entry.get("display_value")` and fall back to `_raw_value`.
     `_walk_compat_items` spans `:79-135`; change the `_extract_value` call
     at **line 110** to `_raw_value` — this single edit keeps both compat
     label values and metrics plain numerics, not `"up(1)"` display strings.
     `_metric_value` (`:61-76`) never calls `_extract_value` (its input is
     the line-110 value); no change needed there.
   - `_walk_line` (`:45-47`) keeps using `_extract_value` (display preferred).
3. `backend/app/services/traps_service.py:234-247`: value preference becomes
   `vb.get("display_value")` → `raw_val.get("display")` → `raw_val.get("value")`;
   append `"enum_label": vb.get("enum_label")` and `"units": vb.get("units")`
   to each varbind row. Decision: the `display_value` preference is gated on
   `effective_resolve_mibs` — users with MIB resolution off keep seeing raw
   values, matching the toggle's meaning. History rows come from stored event JSON, which serializes via
   `_serialize_varbind`, so the fields are present in stored data once change 1
   lands.
4. `backend/app/services/browser_service.py:40-60` (`_node_to_record`): add
   `"enums": dict(node.enums) if node.enums else None` and
   `"units": node.units`.
5. Reproducible compiles and content-hash identity:
   - `backend/app/services/bundles.py:191-197`: add `reproducible=True` to
     the `CompilerConfig(...)` call. Module JSON, `manifest.json`, and
     `oid_index.json` become byte-identical across recompiles of the same
     sources (trishul-smi pins `generated_at` to epoch —
     `trishul_smi/output/json_ir.py:17-22`).
   - `backend/app/models/bundles.py` (`BundleSet`): add a nullable
     `content_hash` text column (Alembic migration required).
   - `bundles.py` (`compile_bundle`, after `:296` commit): compute
     `sha256` over the sorted manifest-declared module files, and record it
     on the `BundleSet`. Expose it in `_bundle_summary` (`:876-901`) and in
     the compile-run payload. Do not enforce uniqueness — identical content
     across runs is expected; the diff view (`:386-470`) uses it as an
     "identical to left bundle" fast path and exactness proof.
6. Producer-aware recompile prompts:
   - `bundles.py:513-521` (`_manifest_summary`): add a
     `capability_floor = "0.5.2"` constant; emit
     `recompile_recommended: bool` (true when `producer_version < 0.5.2`)
     and `missing_capabilities: ["enums", "units"]` derived from a static
     `PRODUCER_CAPABILITIES = {"enums": "0.5.2", "units": "0.5.2"}`
     mapping.
   - Data flow: `list_state`/`get_bundle` have **no HTTP routes today**.
     Extend `mibs_service.get_status` (which already reads the active bundle
     summary via `get_effective_bundle_summary`) to surface the active
     bundle's `producer_version`, `recompile_recommended`, and
     `missing_capabilities` through the existing `/api/mibs/status` response.
   - `frontend/js/modules/mibs.js`: read the flag from the existing
     `/api/mibs/status` fetch and render a dismissible banner on the MIB
     Manager page: "This bundle was compiled by an older MIB compiler and
     lacks enum/units metadata. Recompile?" — the banner action invokes
     `POST /api/mibs/reload` (the existing recompile path via
     `mib_mutations`); if reload's semantics do not fit, add a dedicated
     route.

Old-bundle compatibility: all API additions are additive keys. For 0.4.5-era
bundles, `enum_label`/`units` are `None` (the library fallback never produced
units and the suite never re-derives it); enum display still arrives through
`display_value` via the library path. No behavior regressions.

Verification:

- `backend/tests/unit/services/runtime/test_runtime_serialization.py`: cases
  asserting `enum_label`/`units` on enriched and non-enriched varbinds.
- `test_walker_service.py`: `_extract_value` prefers display; `_raw_value`
  unchanged; `_walk_item` carries the new keys; metric rows stay numeric.
  Update `test_walk_item_and_metric_helpers_handle_display_and_metric_edges`:
  the `_walk_item` exact-dict assertion gains the `enum_label`/`units` keys,
  and the `entry_with_display` case expects the display-preferred value
  (`"ignored"`, not the raw `value.display` `"friendly"`).
- `test_traps_service.py`: history varbind rows prefer `display_value` and
  carry `enum_label`/`units`.
- `test_browser_service.py`: `_node_to_record` emits `enums`/`units`.
- `test_bundles_service.py`: compile twice from identical sources → identical
  `content_hash` and byte-identical module files; `recompile_recommended`
  logic for producer `0.4.5` (true) vs `0.5.3` (false).
- Release gate: `scripts/run_release_gate.py` green.
- Browser probe: walk `IF-MIB::ifTable` on the simulator → `ifOperStatus`
  rows render `up(1)`-style display values (already true today for live
  responses — the probe now also confirms the structured keys are present in
  the JSON response).

Effort: M (3-4 days). Files touched: 5 service files + 1 model + 1 migration +
`mibs.js` (8 total). Tests added: ~14 cases across 5 files.

Risks: changing `_extract_value` display preference could alter metric
extraction for enum-valued gauges — mitigated by the `_raw_value` split and a
regression case over the IF-MIB walk fixture. `reproducible=True` changes
`generated_at` in new bundles — harmless (informational field; the diff
engine never compares it).

### P2 — Enums/units end-to-end UI + fallback consolidation

Goal: render the new metadata everywhere; reduce four constraints-fallback
implementations to exactly one suite-side fallback.

Canonical source: the schema `enums` field via `node.enums` /
`VarBind.enum_label` / `VarBind.units`.

Fallback architecture (decision recorded 2026-10-01):

- The single suite-side fallback lives in one new shared backend helper,
  `backend/app/services/mib_metadata.py`:
  - `enum_map(node) -> dict[str, int] | None` — returns `node.enums` if
    present, else derives a label→number map from `node.constraints`
    (kinds `enum`/`bits`). This is the only code in the suite that interprets
    `constraints` as an enumeration.
  - `enum_values(node) -> list[dict]` — the `[{label, value}]` dropdown shape,
    built on `enum_map`.
  - `first_enum_value(node) -> int | None` — simulator default, built on
    `enum_map`.
- One shared frontend util: move `normalizeEnumValues` from
  `frontend/js/modules/traps.js` (currently around `:596-636`) to
  `frontend/js/modules/utils.js` as `TrishulUtils.normalizeEnumValues`, and
  add `TrishulUtils.formatValue(value, {enumLabel, units})` returning the
  badge/suffix markup used by walker, traps, and browser. The frontend
  performs no constraints interpretation — the backend always sends
  normalized `enum_values`.
- trishul-snmp `mib/render.py` fallback is retained as-is: it is pinned
  upstream library code at the VarBind display boundary, documented by
  upstream as the "older bundles" path, and versioned with the schema loader.
  It is out of this repo's tree and out of scope to fork. When the suite's
  minimum supported bundle producer reaches `>= 0.5.2`, file an upstream issue
  to retire it.   (This is the reconciliation with the reviews' count of five
  implementations: the four suite-side ones below are deleted; the fifth
  is upstream boundary code, not suite plumbing.)

Explicit deletion list (four implementations):

1. `backend/app/services/mibs_service.py:111-126`
   (`_enum_values_from_constraints`) — delete. `_notification_member_payload`
   (`:129-166`) uses `enum_values(node)` from `mib_metadata`; the
   `enum_values` attach at `:163-165` stays.
2. `backend/app/services/simulator_service.py:154-166`
   (`_first_enum_value`) — delete. `_default_value_for_syntax` (`:168+`)
   takes the enum default via `first_enum_value(node)`.
3. `backend/app/services/browser_service.py:321-338` (`_member_entry`) —
   delete the inline constraints→enum_values derivation; `_member_entry`
   uses `enum_values(node)` from `mib_metadata`.
4. `frontend/js/modules/traps.js:757` — delete the `|| oid.constraints`
   half; the picker consumes only the backend-provided `enum_values`.

UI changes:

- `frontend/js/modules/walker.js:181-191`: value column renders
  `TrishulUtils.formatValue(r.value, {enumLabel: r.enum_label, units: r.units})`
  — an enum badge next to the raw value, a muted units suffix.
- `frontend/js/modules/traps.js`: trap history varbind rows (and the trap
  detail view) show the same enum badge/units suffix using the row fields
  added in P1. The varbind picker (`:740-770`) switches to
  `TrishulUtils.normalizeEnumValues`; its `enum_values` arrive from
  `browser_service.get_trap_catalog` (`/api/mibs/traps`), consolidated
  through `mib_metadata`.
- `frontend/js/modules/browser.js:1254-1302` (detail panel): add an
  "Enumerations" table (label ↔ number pairs from `node.enums`) and a
  "Units" row next to Syntax.

Old-bundle compatibility: old bundles get identical UI behavior —
`enum_map` falls back to `constraints`, so the trap picker, simulator
defaults, and browser table work for pre-0.5.2 bundles. `units` is simply
absent (nothing renders).

Verification:

- `test_mibs_service.py`: member payload `enum_values` for a node with
  `enums` (new bundle) and with only `constraints` (old bundle) — identical
  results through `mib_metadata`.
- `test_simulator_service.py`: default value for an enum node, old and new
  shapes.
- New `test_mib_metadata.py`: `enum_map` for enums/enums-with-constraints/
  range-constraints/None; bits constraints.
- Grep gate in review: `rg -n "kind.*enum|constraints.get" backend/app/services`
  must show `mib_metadata.py` only.
- Browser probe: browser detail for `IF-MIB::ifOperStatus` shows the 7-value
  enumeration table; trap picker for a notification carrying `ifOperStatus`
  shows a dropdown; trap history row for an enum varbind shows the label
  badge.

Effort: M (2-3 days). Files touched: 1 new module + 6 modified (7 total).
Implementations deleted: 3. Tests added: ~10 cases (4 files).

Risks: moving `normalizeEnumValues` to utils.js must keep the
`data-enum-values` attribute encoding contract (`traps.js:632-633`) intact —
ship as a pure move, no shape change.

### P3 — Constraint validation, index-aware walking, oid_index serving, module metadata

Goal: use the schema for correctness (input validation, instance decoding)
and speed (client-side OID search); surface provenance.

Changes:

1. Constraint validation (trap sender + simulator):
   - `backend/app/services/mibs_service.py` (`_notification_member_payload`):
     add `"constraint": node.constraints` (range/size/union kinds).
   - `frontend/js/modules/traps.js` (`buildVarbindValueControl`, `:640-666`):
     for Integer inputs with a `range` constraint, show min/max hints and
     validate before submit; for String inputs with a `size` constraint,
     enforce length. Server-side: the pre-encode coercion sites —
     `traps_service._varbind_to_runtime` (`traps_service.py:116`) and
     `runtime._parse_runtime_objects` (`runtime.py:653`, invoked from
     `send_trap` at `:639`) — reject out-of-range integers and oversize
     strings with an actionable error before PDU encode. (Note:
     `runtime.py:1729-1776` is the post-send stored-event builder, not the
     validation site.)
   - `backend/app/services/simulator_service.py`: `_default_value_for_syntax`
     (`:168+`) draws random values inside the declared range (respecting the
     `MIN`/`MAX` bound spellings); `_coerce_custom_value` (`:80-116`)
     validates bounds/sizes and returns an explicit error instead of
     silently skipping.
2. Index-aware walker grouping:
   - `backend/app/services/walker_service.py:79-135`
     (`_walk_compat_items`): when the walk root resolves to a column node,
     locate its row (parent OID), read the row's `index` list, and decode
     the OID suffix against each index column's syntax (integer vs
     octet-string escaping) instead of splitting symbolic names on `"."`.
     Heuristic fallback retained for unresolved roots. This fixes grouping
     for string-indexed tables (e.g. `snmpCommunityTable`).
   - Plumbing: `_walk_compat_items` and `execute` currently receive only
     varbinds and have no MIB metadata access. Obtain the active bundle via
     `app.services.bundle_state.get_bundle()` (the pattern `traps_service`
     uses) or pass it through `execute`, then resolve the root OID and read
     the row node's `index` list.
3. oid_index serving + client-side search:
   - New route in `backend/app/api/routes/browser.py`:
     `GET /api/bundles/{bundle_set_id}/oid-index` streaming the sidecar from
     `BundleSet.oid_index_path` (path already tracked in the DB). Note:
     streaming the sidecar from disk does **not** invoke the loader's
     schema gate (that runs on the manifest at bundle load); the route
     404s on a missing sidecar file. The route needs a bundle-service
     dependency — copy the `_ctx()` pattern from `routes/mibs.py`.
   - `frontend/js/modules/browser.js`: load once per bundle, use for
     instant OID-prefix search (type `1.3.6.1.2.1.2` → `ifTable`) without
     per-keystroke server round-trips.
4. Module metadata panel:
   - There is no module-detail payload or endpoint today. Add
     `module_metadata` (already on `MibModuleRecord` — `lastupdated`,
     `revisions[]`, `organization`, `contactinfo`, `description`) to the
     module rows built by `mibs_service.get_status` (`:342-607`), exposed
     through the existing `/api/mibs/status` response.
   - `frontend/js/modules/mibs.js`: build a module revision-history card
     from those rows (revision history with per-revision descriptions,
     organization, contact info).

Old-bundle compatibility: constraints and index data exist in 0.4.5-era
bundles, so validation works for old and new bundles alike; `module_metadata`
is unchanged since before 0.4.5.

Verification:

- `test_mibs_service.py`: member payload carries `constraint`.
- Trap-send rejection tests: out-of-range integer, oversize string.
- `test_simulator_service.py`: random values within range; custom value
  validation errors.
- `test_walker_service.py`: compat items for an integer-indexed table
  (unchanged output) and a string-indexed table (correct instance keys).
- Route test for the oid-index endpoint (404 for missing sidecar, payload
  shape for the run-000001 set).
- Browser probe: search `1.3.6.1.2.1.2` resolves instantly client-side;
  module detail for `IF-MIB` shows the 2026-era revision list from
  `module_metadata`.

Effort: M-L (4-6 days). Files touched: ~7 backend/frontend files + route.
Tests added: ~12 cases.

Risks: index decoding for exotic index syntaxes (OID-valued, implied) —
scope to integer and octet-string indexes, keep the heuristic fallback, and
log when decoding is skipped.

### P4 — Deferred / optional

Not scheduled for `2.1.0`; recorded so the decisions survive.

1. `display_hint` value formatting (DateAndTime, MacAddress, etc.): requires
   an upstream trishul-snmp change (apply RFC 2579 hints in `mib/render.py`
   where `MibTypeRecord.display_hint` is already loaded). Suite-side cost
   drops to zero once the library renders it into `display_value`.
2. SMIv1 generic-trap decoding via `enterprise`/`trap_number`: match
   incoming v1 trap PDUs to `traptype` nodes and use their `members`
   (VARIABLES) to label varbinds, mirroring the v2 `declared_members`
   pattern at `runtime.py:1766-1776`. Only matters once SMIv1 vendor MIBs
   are compiled.
3. `tsmi lint` gate in `compile_bundle`: run the 0.5.x lint engine over the
   compiled set and attach findings to `CompileRun.command_json`; render in
   the compile-result panel. `lint --fix` as an explicit operator action on
   uploaded MIBs.
4. SNMPv1 walker protocol support: same protocol-layer workstream as SNMPv3;
   see item 5.
5. SNMPv3: out of scope. The prior feasibility study concluded SNMPv3 is a
   separate workstream (USM/authPriv engine work in trishul-snmp,
   securityName/context plumbing through the session/runtime layers),
   orthogonal to the IR changes in this plan — it is not re-derived here.
   The current FAQ position stands: the runtime surface is v2c.

## 4. Compatibility matrix

| Feature | Old bundle (0.4.5-compiled) | New bundle (0.5.3-compiled) |
|---|---|---|
| Enum label in live responses (`display_value`) | yes — via trishul-snmp constraints fallback (`mib/render.py:195-244`) | yes — via `enums` field |
| Structured `enum_label` in API responses | `null` | present (P1) |
| Enum dropdowns (trap picker) | yes — via `mib_metadata.enum_map` fallback (P2) | yes — via `enums` |
| Browser enumerations table | yes (derived from constraints) | yes |
| Units | never (field absent in IR) | present when source has UNITS (P1/P2) |
| Constraint validation | yes (constraints predate 0.5.2) | yes |
| Recompile prompt | shown (`producer_version < 0.5.2`) | not shown |
| Content-hash identity | computable (hash covers whatever is on disk) | computable, byte-stable with `reproducible=True` |
| Bundle diffing (`diff_bundles`) | unchanged | unchanged; hash fast path when identical |
| Schema gate | loads (`1.1 <= 1.1`) | loads |

## 5. Verification strategy

Per-phase test additions are listed in each work package. Overall:

- Unit/contract layers live in `backend/tests/unit/services/` (plus
  `backend/tests/unit/services/runtime/`); every package above names its
  target files. No test deletions are planned — existing suites pin current
  behavior and the changes are additive except where a test asserts raw-value
  preference (walker/traps value extraction), which gets updated alongside
  the change.
- Release gate: run `scripts/run_release_gate.py` after each phase merges.
- UI probes: use `scripts/capture_ui_pages.py` plus manual checks per the
  probe expectations in each package; `docs/ui_checklist.md` gets a row per
  new UI element (enum badge, units suffix, enumerations table, recompile
  banner, constraint hints, OID search).
- Empirical bundle recompile: recompile the starter set after P1 and confirm
  `enums` present on `ifAdminStatus`/`ifOperStatus` in the emitted JSON and
  a stable `content_hash` across two runs. Note on units: no bundled MIB
  contains a `UNITS` clause (verified), so a recompile alone cannot
  demonstrate units end-to-end — a demo MIB is optional. If desired, add a
  small UNITS-bearing MIB (e.g. `ETHERLIKE-MIB`, or a fixture MIB with
  `UNITS "seconds"` on a gauge) to the test fixtures rather than to
  `mibs_bundled/`, keeping the shipped starter set unchanged.
- The real reference bundle
  (`backend/data/bundles/sets/run-000001-if-mib-ianaiftype-mib/`) is the
  golden corpus for "new bundle" behavior; a 0.4.5-produced fixture (checked
  in under `backend/tests/fixtures/`) is the "old bundle" corpus for the
  fallback tests.

## 6. Rollout

Target release: `2.1.0` (next planned minor per `docs/roadmap.md`). Everything
in P1-P3 is additive — new API keys, new UI elements, one nullable DB column —
and fits the 2.1.0 mandate of surfacing existing backend capability. No
secondary API surface; all routes extend the current `/api/...` namespace.

Operator guidance (release notes):

- Existing bundles keep working; old bundles continue to show enum labels
  through the fallback path and never show units.
- Recompile active bundles to gain `enums`/`units` and byte-stable identity;
  the MIB Manager banner identifies bundles that need it.
- `generated_at` in newly compiled bundles is pinned to epoch when
  `reproducible` is on — expected, not a bug; use the new `content_hash`
  for identity.

Counts summary:

| Phase | Files touched | Tests added | Implementations deleted |
|---|---|---|---|
| P0 (done) | requirements/venv | 0 | 0 |
| P1 | 8 | ~14 | 0 |
| P2 | 8 (1 new) | ~10 | 4 |
| P3 | ~7 | ~12 | 0 |
| P4 | deferred | — | — |
