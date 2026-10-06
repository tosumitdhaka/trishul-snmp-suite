# End-to-End Review Findings (2.1.0) — Registry and 2.2.0 Plan

Independent end-to-end review of all seven operator functionalities (MIB Browser,
MIB Manager, Walk & Parse, Simulator, Trap Sender, Trap Receiver, Settings),
backend-to-frontend and code-to-UI/UX. Five read-only review lanes (three
logic/contract, two UI/UX) plus live empirical verification against a running
2.1.0 deployment.

- **Date**: 2026-10-05 (against 2.1.0 release-prep tree, commit `b84d0db` + staged release prep)
- **Raw findings**: 158 across five lanes → **148 distinct** after cross-lane dedup; +3 from the 2.1.0 fix-round re-review → **151 distinct**
- **Severity**: 7 high · ~30 medium · ~111 low/notes
- **Live verification**: all 7 pages load with zero console/JS errors; top claims verified at API level (TRP-01, TRP-02) or by reviewer repro (WLK-01, SIM-01 chain)
- **Disposition**: `2.1.0-FIX` = regression/incompletion of a 2.1.0 feature, candidate for the pending release; `2.2.0-A/B/C` = correctness / missing features / polish; `IDEA` = feature ideas
- **Status 2026-10-05**: all 20 `2.1.0-FIX` items (incl. TRP-02 pulled in by decision) were fixed and independently re-reviewed — verdicts 17 FIXED, 3 FIXED-WITH-NOTES, 0 INCOMPLETE, 0 REGRESSION; release gate green. Shipped in 2.1.0.
- **Status 2026-10-05 (2.2.0 execution)**: **Phase A (correctness, 52 findings) complete** — independently reviewed: 46 FIXED, 5 FIXED-WITH-NOTES, 1 regression (SIM-28 responder leak) fixed in the residual pass along with SET-15, RCV-13, BRW-26, SIM-27, BRW-25, TRP-22. **Phase B (features, 19 findings) complete** — reviewed: 15 FIXED, 4 FIXED-WITH-NOTES; residual pass fixed MGR-26, MGR-27, MGR-28, RCV-14. **Phase C (polish, 54 findings) complete** — reviewed: 52 FIXED, 2 FIXED-WITH-NOTES; residual pass fixed RCV-16, WLK-28, TRP-23. **All 151 registry findings closed for 2.2.0** (fixed or explicitly accepted: WLK-27 heuristic limitation, MGR-29 documented shim, RCV-17 pager-lag note, TRP-14 raw-JSON retention).
- **Status 2026-10-06 (2.2.1 patch round)**: post-release QA against live 2.2.0 deployments (Playwright functional verification of all pages + backend root-cause analysis of user-reported failures) confirmed and fixed 12 issues, shipped as 2.2.1 — see the `[2.2.1]` changelog entry. Verified working in the same round: receiver live rendering, enum dropdowns, symbolic OID sends, bundle lifecycle UX, settings round-trips, all pages console-clean.

## Summary by area

| Area | Findings | High | 2.1.0-FIX candidates |
|---|---|---|---|
| MIB Browser (BRW) | 24 | 1 | 8 |
| MIB Manager (MGR) | 25 | 1 | 5 |
| Walk & Parse (WLK) | 26 | 1 | 2 |
| Simulator (SIM) | 26 | 1 | 1 |
| Trap Sender (TRP) | 21 | 2 | 2 |
| Trap Receiver (RCV) | 12 | 0 | 0 |
| Settings (SET) | 14 | 0 | 0 |
| **Total** | **148** | **7** | **17 (+2 verify)** |

---

## MIB Browser (BRW)

- **BRW-01** (med, BUG, 2.2.0-A) — Type-filtered search can silently drop results: `limit*2` pre-filter buffer exhausted by one-to-many type mappings before all true matches found. `browser_service.py:277-283`
- **BRW-02** (low, GAP, 2.2.0-A) — `get_node` accepts `?module=` but never uses it; multi-module OIDs resolve to whichever the accelerator finds first. `browser_service.py:352-366`
- **BRW-03** (low, IMPR, 2.2.0-C) — Tree expand re-materializes all bundle nodes + O(n×children) has-children scan per click. `browser_service.py:220-238`
- **BRW-04** (low, IMPR, 2.2.0-C) — `except (UnknownOidError, Exception)` catch-alls swallow real backend errors in 4 flows. `browser_service.py:94,212,365,385`
- **BRW-05** (low, IMPR, 2.2.0-C) — MODULE-IDENTITY nodes display a misleading "ModuleCompliance" badge. `browser_service.py:28-29`
- **BRW-06** (low, IMPR, 2.2.0-C) — oid-index route: full service+session per hit, no ETag/Cache-Control. `routes/browser.py:32-50`
- **BRW-07** (med, IMPR, 2.1.0-FIX) — Browser page load triggers full `/api/mibs/status` (reads every stored MIB file) only to learn `active_bundle_id`. `browser.js:598-603`; cost `mibs_service.py:339-346,491-517`
- **BRW-08** (high, BUG, **2.1.0-FIX**) — oid-index cache never invalidates on bundle switch; the bundle-id check is dead code; SPA singleton serves the previous bundle's index for numeric searches until hard reload. Found by 3 lanes. `browser.js:595-625,672-675`; `app.js:639-654`
- **BRW-09** (med, BUG, **2.1.0-FIX**) — oid-index fast path ignores module/type filters; results also render emptier (no description). `browser.js:627-657` vs `:686-694`
- **BRW-10** (low, BUG, 2.2.0-A) — No request sequencing in `search()`; overlapping searches can resolve out of order (stale overwrites fresh). `browser.js:659-726`; contrast guard `mibs.js:236-255`
- **BRW-11** (low, BUG, 2.2.0-A) — Failed child load writes into tree children; lazy-load only fires on empty innerHTML → node can never retry. `browser.js:479-481,1149-1158`
- **BRW-12** (low, BUG, **2.1.0-FIX**) — Fast-path results carry raw SMI type tokens the icon maps don't know → generic cube icon, inconsistent with server results. `browser.js:644-651` vs `:1109-1133`
- **BRW-13** (low, IMPR, 2.2.0-C) — Tree row click both selects and toggles expansion. `browser.js:1184-1188`
- **BRW-14** (low, IMPR, 2.2.0-C) — Module-view count badge reports top-level nodes, not objects. `browser_service.py:183-186`
- **BRW-15** (med, GAP, 2.2.0-B) — Constraints arrive in node-detail payload but are never rendered (range/size info invisible). `browser_service.py:61`; `browser.js:1330-1353`
- **BRW-16** (med, IMPR, **2.1.0-FIX**) — Enumerations table UX: ~3-4 rows visible (150px cap), non-sticky header, no filter/copy for large enums (ifType ≈ 250 entries). `browser.js:1366-1385`
- **BRW-17** (med, IMPR, **2.1.0-FIX**) — Units row has no prominence (identical to Syntax row). `browser.js:1336-1341`
- **BRW-18** (med, IMPR, 2.2.0-C) — Primary action ("Walk this OID"/"Send this Trap") below the fold on long detail panels. `browser.js:1410-1423`
- **BRW-19** (low, BUG, 2.2.0-A) — `restoreState()` sets module filter before options load → UI/state mismatch. `browser.js:90,199-209,415-430`
- **BRW-20** (low, IMPR, 2.2.0-C) — Enum table: no numeric sort, no count badge on heading. `browser.js:1366-1385`
- **BRW-21** (low, IMPR, 2.2.0-C) — Search interaction inconsistent with MIBs page (debounce, no refocus on clear, count-badge meaning varies). `browser.js:562-592`
- **BRW-22** (low, IMPR, 2.2.0-C) — Dead token `app-browser-enum-table` (no CSS rule). `browser.js:1370`
- **BRW-23** (med, IDEA, 2.2.0-B) — Inline notice in browser when bundle lacks enum/units metadata (links to MIB Manager recompile). `browser.js:1330-1341`
- **BRW-24** (med, GAP, **2.1.0-FIX**) — First numeric search silently awaits oid-index download before any loading feedback. `browser.js:672-683`
- **BRW-25** (low, GAP, fixed 2.2.0-A residual) — Filtered numeric search downloaded the oid-index then discarded it for the server path. FIXED: filter-first gate skips the index path entirely.
- **BRW-26** (info, IMPR, fixed 2.2.0-A residual) — browser.js had no mibs-broadcast coalescing (repeated loadTree per burst). FIXED: 250ms timer.
- **BRW-27** (low, IMPR, 2.2.0-C) — BRW-23's status snapshot re-adds a full `/api/mibs/status` call to browser entry and every mibs broadcast (partial BRW-07 regression while MGR-05 unfixed). Lighter manifest-summary source needed.
- **BRW-28** (low, GAP, 2.2.0-C) — `bits` constraint kind renders nothing in the browser detail Constraints row (BRW-15 covered range/size/enum/union only).

## MIB Manager (MGR)

- **MGR-01** (high, BUG, **2.1.0-FIX**) — Recompile banner is a no-op for exactly the upgraded installs it targets: with no uploaded sources, "Recompile" re-activates the same old bundle (producer unchanged) → banner loop. `mibs.js:231-234` → `routes/mibs.py:223-235` → `mib_mutations.py:279-295,364-374`
- **MGR-02** (med, GAP, 2.2.0-A) — `POST /api/mibs/fetch-dependencies` is a stub: hardcodes `enabled: False`, drops `reload_after_fetch`. `routes/mibs.py:238-247`; `mib_mutations.py:538-557`
- **MGR-03** (low, BUG, 2.2.0-A) — `reset_source_caches()` clears the path cache but not the warmed flag → lookups return None after reset. `mib_sources.py:498-499` vs `:828-830`
- **MGR-04** (med, MISSING-FEATURE, 2.2.0-B) — Bundle lifecycle (list/get/diff/rollback) has no routes or UI; `content_hash` is computed+stored but never read (the plan's diff fast-path not implemented). `bundles.py:163-186,437-530,553-563`; `api/router.py:16-24`
- **MGR-05** (med, IMPR, 2.2.0-C) — `/api/mibs/status` reads every stored MIB file 2-3× per call. `mib_sources.py:403-421`; `mibs_service.py:339-346,372,444,503`
- **MGR-06** (low, IMPR, 2.2.0-C) — No cross-request compile lock; long transaction holds DB during compiles. `bundles.py:193-414`
- **MGR-07** (low, GAP, 2.2.0-A) — Bundle activation load failure only logged: DB says B active, memory serves A; no rollback or user error. `bundles.py:402-408`
- **MGR-08** (low, GAP, 2.2.0-A) — No upload size cap (`await u.read()` unbounded). `routes/mibs.py:130,150`
- **MGR-09** (low, IMPR, 2.2.0-C) — Only 5 most-recent failed compile runs surface; older failures vanish while files sit "pending". `mibs_service.py:406-412`
- **MGR-10** (low, IMPR, 2.2.0-C) — Module-level source-service singleton without thread-safety. `mibs_service.py:29-36,266-287`
- **MGR-11** (low, GAP, 2.2.0-A) — Manifest with missing/unparseable `producer_version` yields no banner. `bundles.py:48-67,576-588`
- **MGR-12** (med, GAP, 2.2.0-A) — MIBs/Browser pages ignore `trishul:ws:mibs` broadcasts → cross-tab staleness. `mibs.py:168-294` (emits); consumers: only `dashboard.js:47`
- **MGR-13** (med, BUG, 2.2.0-A) — `loadStatus`/`loadTraps`/`validateFiles` never check `res.ok`: errors render as empty states or TypeErrors. `mibs.js:253-254,874-875,1184-1189`
- **MGR-14** (low, GAP, **2.1.0-FIX**) — Banner dismissal is global+permanent (not bundle-scoped), no un-dismiss path. `mibs.js:21,217-234`
- **MGR-15** (low, BUG, 2.2.0-A) — `deleteAllFailed` hides modal even when delete failed (catch never rethrows). `mibs.js:830-841,1604-1610`
- **MGR-16** (low, IMPR, 2.2.0-C) — Dead UI code: fetch-dependencies handlers reference non-existent button. `mibs.js:1779-1788`; `mibs.html:296-305`
- **MGR-17** (low, IMPR, 2.2.0-C) — Blocking `alert()` for upload/validation/delete failures vs toasts elsewhere on same page. `mibs.js:1301,1409,1416,1609`
- **MGR-18** (low, IMPR, **2.1.0-FIX**) — Banner hardcodes "lacks enum/units metadata"; backend's `producer_version`/`missing_capabilities` unused. `mibs.js:217-223`
- **MGR-19** (med, BUG, **2.1.0-FIX**) — Banner Recompile button has no busy state; spinner logic targets the wrong button; double-triggerable. `mibs.js:1423-1429`
- **MGR-20** (med, IMPR, **2.1.0-FIX**) — Revision cards: no `aria-expanded`; any list re-render silently collapses them. `mibs.js:387,709-719`
- **MGR-21** (low, IMPR, 2.2.0-C) — Revision dates raw (`200005090000Z`), no newest-first/"latest" highlight. `mibs.js:735-746`
- **MGR-22** (med, GAP, 2.2.0-A) — Filter change (keystroke) silently wipes multi-select selection. `mibs.js:561-564`
- **MGR-23** (low, IMPR, 2.2.0-C) — Dead tokens `app-recompile-banner`/`mib-module-meta-card` (no CSS rules). `mibs.html:1`; `mibs.js:725`
- **MGR-24** (low, IMPR, 2.2.0-C) — Trap table Module/Objects columns not sortable (pattern exists). `mibs.html:220-235`
- **MGR-25** (low, IDEA, 2.2.0-B) — Per-module compiled-version/producer hint in list. `mibs.js:305-390`
- **MGR-26** (med-low, BUG, fixed 2.2.0-B residual) — Diff button on the active bundle always errored (self-diff 400, no pair selection). FIXED: diff-vs-previous default + disabled state when no predecessor.
- **MGR-27** (med, BUG, fixed 2.2.0-B residual) — `POST /api/bundles/{id}/activate` emitted no `trishul:ws:mibs` broadcast (cross-tab caches stale after rollback). FIXED: broadcast added + contract-tested.
- **MGR-28** (low, IMPR, fixed 2.2.0-B residual) — Bundle list payload embedded full module arrays + per-bundle manifest reads. FIXED: summaries-only list.
- **MGR-29** (note, 2.2.0-C) — `_QueryParam` sentinel shim in the diff route exists solely for direct-call contract tests; move to a shared test helper or accept as documented.

## Walk & Parse (WLK)

- **WLK-01** (high, BUG, 2.2.0-A) — Grouped mode emits garbage metric rows when symbolic resolution fails (numeric label split as symbolic: `metric_name:"1"`, OID-tail as index). Reviewer-verified by repro. `walker_service.py:254-261`
- **WLK-02** (med, BUG, 2.2.0-A) — Zero-match filter → export silently exports the full dataset (copy correctly warns). `walker.js:717-719` vs `:697-698`
- **WLK-03** (med, BUG, 2.2.0-A) — Pydantic 422s render as "[object Object]"; no client-side target/port validation. `walker.js:499,446-447`
- **WLK-04** (med, GAP, 2.2.0-A) — Index-aware decoding only for single-column roots; table/MIB-root walks merge cross-table rows into mega-rows. `walker_service.py:149-157,237-241,275`
- **WLK-05** (low, BUG, 2.2.0-A) — `download('txt')` would join objects as "[object Object]" (latent; no txt button today). `walker.js:759-761`
- **WLK-06** (low, GAP, 2.2.0-A) — `JSON.parse(sessionStorage.walkerLastResult)` unguarded; corrupt storage aborts init. `walker.js:26-48`
- **WLK-07** (low, GAP, 2.2.0-C) — OID regex rejects leading-dot numerics the backend accepts. `walker.js:465-466` vs `runtime.py:2008-2011`
- **WLK-08** (low, GAP, 2.2.0-A) — Failed walk nulls in-session result but not `walkerLastResult` → reload resurrects the failed result. `walker.js:548-553`
- **WLK-09** (low, GAP, **2.1.0-FIX**) — Grouped mode carries no `enum_label`/`units` (2.1.0 contract only in flat mode). `walker_service.py:284-297`
- **WLK-10** (low, MISSING-FEATURE, 2.2.0-B) — No timeout/retry controls (hardcoded `timeout=2.0, retries=1`); no route field, no UI. `runtime.py:519-530`
- **WLK-11** (low, IMPR, 2.2.0-C) — Synthetic 50%→100% progress; aria-live announces fake milestones. `walker.js:482-486,510-511`
- **WLK-12** (low, IMPR, 2.2.0-C) — `_value_is_metric` name-substring heuristic misclassifies some numeric objects. `walker_service.py:97-105`
- **WLK-13** (low, IMPR, 2.2.0-A) — Debug `console.log("Walker API Response:"...)` left in production path. `walker.js:496`
- **WLK-14** (med, BUG, 2.2.0-A) — Loading a history item with an active filter shows the previous walk's filtered rows as the loaded result. `walker.js:132,346-369`
- **WLK-15** (med, BUG, 2.2.0-A) — sessionStorage quota throw inside try-block reports a successful walk as failed. `walker.js:513-519,543-553`
- **WLK-16** (low, BUG, 2.2.0-A) — Stale 500ms setTimeout hides the next walk's progress bar on quick re-runs. `walker.js:557-561`
- **WLK-17** (med, GAP, 2.2.0-B) — Results pane goes blank during walks (no pane-level loading state). `walker.js:479,101-119`
- **WLK-18** (med, GAP, 2.2.0-B) — No walk cancellation; Run disabled with no cancel affordance. `walker.js:475-486`
- **WLK-19** (med, IMPR, **2.1.0-verify**) — Enum badge visual weight in dense tables (pills wrap rows; no toggle). Speculative — verify visually. `utils.js:87`; `walker.js:186-191`
- **WLK-20** (low, IMPR, 2.2.0-C) — OID column lacks title tooltip with numeric OID. `walker.js:184`
- **WLK-21** (low, GAP, 2.2.0-C) — No form wrapper; Enter in Host/OID does nothing (traps page supports Enter). `walker.html:43-54`
- **WLK-22** (low, IMPR, 2.2.0-C) — Count badge ignores active filter (traps page updates it). `walker.js:508,599`
- **WLK-23** (low, IMPR, 2.2.0-C) — Filter-miss state is bare text, not `app-panel-placeholder`. `walker.js:136-138,648`
- **WLK-24** (low, MISSING-FEATURE, 2.2.0-B) — No column sorting on results table (pattern exists on traps page). `walker.js:161-225`
- **WLK-25** (low, IDEA, fixed 2.2.0-B) — Ctrl/Cmd+Enter to run; "copy as table" TSV export. Done.
- **WLK-26** (low, IMPR, 2.2.0-C) — `is-info` reused for every badge on the page; tone stops meaning anything. `utils.js:87`; `walker.js:303-327`
- **WLK-27** (note, accepted 2.2.0) — Numeric-label fallback rows key on the bare instance index, so cross-table mega-rows remain possible in the no-symbolic-resolution heuristic path (pre-existing; documented limitation of the fallback).
- **WLK-28** (low, BUG, fixed 2.2.0-C residual) — Ctrl/Cmd+Enter could start a second concurrent walk (bypassing the disabled submit) and clobber the active abort controller. FIXED: in-flight guard in `execute()`.

## Simulator (SIM)

- **SIM-01** (high, BUG, 2.2.0-A) — A custom-data value that fails encode (e.g. malformed IpAddress) kills the responder on first query: `ResponderWithActivity` override drops the library's `ProtocolError` guard; `responder.last_error` never surfaced. `runtime.py:254-274` vs library `responder/server.py:146-150`; unvalidated chain `simulator_service.py:59-61,147-148`, `runtime.py:1397-1398,1244-1249`
- **SIM-02** (med, BUG, 2.2.0-A) — Same override drops the SNMPv1 boundary check → simulator answers v1 traffic incl. undefined v1 GETBULK. `runtime.py:258-265` vs `responder/server.py:138-142`
- **SIM-03** (med, BUG, 2.2.0-A) — Requests counter / last_activity not reset on restart (only global stats reset does). `runtime.py:186,286-368,934-938`
- **SIM-04** (med, GAP, **2.1.0-FIX**) — `custom_data_warnings` (documented 2.1.0 contract) never rendered by any frontend. `simulator_service.py:341-374`; `simulator.js:524-533`
- **SIM-05** (med, GAP, 2.2.0-A) — Numeric-OID custom-data targets skip type resolution → values become gauge32, wrong type + no range validation. `simulator_service.py:68-79,130-134`
- **SIM-06** (med, GAP, 2.2.0-A) — Requests/Uptime cards frozen when WS healthy (live path only exists in WS-down fallback). `simulator.js:60-125,669-676`
- **SIM-07** (med, BUG, 2.2.0-A) — Lifecycle failures show only "HTTP 400/422" (backend detail discarded); no client-side port validation. `simulator.js:520-567` vs `:818-833`
- **SIM-08** (med, GAP, 2.2.0-A) — Corrupt `custom_data.json` silently ignored at startup (no warning despite the 2.1.0 warn contract). `simulator_service.py:171-179,429-431`
- **SIM-09** (low, BUG, 2.2.0-A) — Symbolic + numeric custom-data keys duplicate the same OID in obj_map/state counts. `simulator_service.py:292-304,340-346,415-423`
- **SIM-10** (low, BUG, 2.2.0-C) — BITS-typed nodes default to an integer (docstring acknowledges). `mib_metadata.py:53-63`
- **SIM-11** (low, BUG, 2.2.0-A) — PhysAddress/MacAddress display-format defaults clamped by character count vs byte-size constraints → garbled MACs (speculative on bundle metadata). `simulator_service.py:242-266`
- **SIM-12** (low, GAP, 2.2.0-A) — Unsaved-changes guard only on full page unload; SPA hash-nav discards edits; listener leak on re-init. `simulator.js:427-434,47-53`
- **SIM-13** (low, IMPR, 2.2.0-C) — `get_status` serializes every object+rule then discards all but 8 scalars. `runtime.py:201-213`
- **SIM-14** (low, GAP, 2.2.0-C) — Local log entries wiped when backend list replaces them. `simulator.js:604-613`
- **SIM-15** (low, GAP, 2.2.0-A) — Failed REST start with new port shuts down the running responder first (no rollback). `runtime.py:307,319-337`
- **SIM-16** (low, IMPR, 2.2.0-C) — `int(float(str))` silently truncates "3.7"→3 for integer nodes. `simulator_service.py:137-139`
- **SIM-17** (med, GAP, 2.2.0-B) — Activity log force-scrolls to bottom; no stick-to-bottom detection or pause. `simulator.js:351-354,390,622`
- **SIM-18** (med, GAP, 2.2.0-A) — `clearLog` destructive without confirmation (inconsistent with traps page). `simulator.js:726-736`
- **SIM-19** (low, BUG, 2.2.0-A) — "Restart required" badge can never appear (all paths only add `d-none`). `simulator.html:65`; `simulator.js:666,695-698`
- **SIM-20** (low, GAP, 2.2.0-C) — Backend-down status errors spam the activity log every 4s. `simulator.js:587-590,110-116`
- **SIM-21** (low, IMPR, 2.2.0-C) — "Live" indicator shown even when on 1.5s polling. `simulator.html:171-173`
- **SIM-22** (low, IMPR, 2.2.0-C) — Log pane O(n) innerHTML rebuild per event (up to 500 entries). `simulator.js:351,373-392`
- **SIM-23** (low, IMPR, 2.2.0-C) — Filter-miss flow double-renders with two different empty-state styles. `simulator.js:781-784,341-349`
- **SIM-24** (low, IMPR, 2.2.0-C) — Save has no in-flight state; double-click double-submits. `simulator.js:458-491`
- **SIM-25** (low, IMPR, 2.2.0-C) — "JSON Error" badge carries no detail. `simulator.html:115-117`
- **SIM-26** (low, IDEA, fixed 2.2.0-B) — Tail/pause toggle; level-count chips; client-side port validation. Done.
- **SIM-28** (med-high, BUG, fixed 2.2.0-A residual) — Responder leak on different-address restart (`start_responder` lacked the post-open shutdown the listener path has). FIXED: swap shuts down the previous responder + test.

## Trap Sender (TRP)

- **TRP-01** (high, BUG, **2.1.0-FIX**) — VarBind picker enum dropdowns dead: `/api/mibs/objects` returns `constraint` but no `enum_values`; 2.1.0 removed the working 2.0.3 constraints fallback without wiring to the new field. API-verified live. `routes/mibs.py:96-110`; `traps.js:768`; `utils.js:36-46`
- **TRP-02** (high, BUG, 2.2.0-A) — Picker-added INTEGER/Counter/Gauge/TimeTicks objects default to varbind type "String" (weak `_input_type` + short-circuited inference) → wrong trap semantics; range validation unreachable. API-verified live. `routes/mibs.py:86-94,104`; `traps.js:408-419,760-764,870-874`
- **TRP-03** (med, GAP, 2.2.0-A) — Resolve-response status never checked; trap OID becomes undefined → 422 rendered as "[object Object]". `traps.js:947-992`
- **TRP-04** (low, GAP, 2.2.0-A) — Bad numeric values silently coerced to 0 on direct API sends. `traps_service.py:133-150`
- **TRP-05** (low, GAP, 2.2.0-A) — Enum membership not enforced (frontend allows custom option; backend only validates range/size). `traps.js:663-669`; `mib_metadata.py:76-102`
- **TRP-06** (med, MISSING-FEATURE, 2.2.0-B) — Inform sending: service complete+tested, no route, no UI. `runtime.py:713-784`
- **TRP-07** (med, MISSING-FEATURE, 2.2.0-B) — Replay from history: service complete (host/port/community overrides), no route/UI. Backlog `POST-210-003`. `runtime.py:786-899`
- **TRP-08** (low, MISSING-FEATURE, 2.2.0-B) — Offline payload decode: complete, no route/UI. `runtime.py:940-979`
- **TRP-09** (low, GAP, 2.2.0-B) — Counter64 not sendable from UI (type select lacks it). `traps.js:786-794` vs `traps_service.py:121-131`
- **TRP-10** (low, IMPR, 2.2.0-C) — N+1 sequential resolve round-trips per varbind (backend already resolves symbolic targets). `traps.js:955-967`
- **TRP-11** (low, IMPR, 2.2.0-A) — Community string logged in plaintext on successful send (UI treats it as a secret). `traps_service.py:112`
- **TRP-12** (low, GAP, 2.2.0-A) — Picker/library caches never invalidate on MIB reload/bundle activation. `traps.js:309-334,424-434`
- **TRP-13** (med, BUG, **2.1.0-FIX**) — Enum badges hard-clipped (no ellipsis/tooltip) in receiver varbind cells — the dense context the feature targets. Speculative (CSS-reasoned); verify visually then fix. `traps.js:1376-1385`; `style.css:1561-1567,1892-1893`
- **TRP-14** (med, GAP, 2.2.0-B) — Detail modal: formatted table + raw JSON both shown, no toggle; three projections disagree on `snmpTrapOID`; JSON block unheaded. `traps.js:1343-1416,1452-1463`
- **TRP-15** (med, GAP, 2.2.0-A) — Typing in Trap Library rebuilds the varbind list, discarding manual rows without confirmation. `traps.html:34-38`; `traps.js:353-384`
- **TRP-16** (low, BUG, 2.2.0-A) — `onTrapSelected` double-fires (input+change) → double rebuild + duplicate toast. `traps.html:37-38`; `traps.js:353-362,383`
- **TRP-17** (low, BUG, 2.2.0-C) — Trap badge tone is a substring heuristic ("group" paints green via 'up', "warmup" etc.). `traps.js:1301-1307`
- **TRP-18** (low, GAP, 2.2.0-C) — Validation error banner below the scrollable varbind panel; no scroll-into-view of first invalid row. `traps.js:924-935`
- **TRP-19** (low, IMPR, 2.2.0-C) — Constraint hints only for Integer/range and String/size (Counter/Gauge/OID constraints unhinted). `traps.js:674-692,870-874`
- **TRP-20** (low, IMPR, 2.2.0-C) — Varbind remove uses literal "X" text instead of the icon pattern. `traps.js:783`
- **TRP-21** (low, IDEA, fixed 2.2.0-B) — CSV export for received traps; pause live updates while inspecting. Done.
- **TRP-23** (low, BUG, fixed 2.2.0-C residual) — Badge-tone vocabulary checked success first, so `linkUpFailure` painted green off its "up" token. FIXED: danger/warning outrank success.

## Trap Receiver (RCV)

- **RCV-01** (med, BUG, 2.2.0-A) — Failed listener (re)start tears down a running receiver (shutdown-before-bind, no rollback). `runtime.py:589-609`
- **RCV-02** (med, IMPR, 2.2.0-C) — Unconditional 1s REST poll + full tbody re-render even with healthy WS; inconsistent with simulator's WS-aware strategy. `traps.js:32,101-108,142-162`
- **RCV-03** (med, GAP, 2.2.0-A) — Reset Stats clears the DB but traps page re-adds cached events → counts disagree, deleted traps resurrect. `stats_service.py:84-85`; `traps.js:1174-1191`
- **RCV-04** (low, BUG, 2.2.0-A) — `clear_events` orphans FTS rows (unbounded growth; spurious search matches on id reuse). `traps_service.py:188-194`
- **RCV-05** (low, GAP, 2.2.0-B) — No pagination surface, no pruning; DB grows unbounded; client caps at 100. `traps_service.py:164-178`; `routes/traps.py:131-141`
- **RCV-06** (low, IMPR, 2.2.0-C) — `time_str` strips the date → cross-day traps indistinguishable. `traps_service.py:255-262`
- **RCV-07** (low, IMPR, 2.2.0-C) — Uptime doesn't tick between status payloads. `traps.js:1050,1159-1162`
- **RCV-08** (low, GAP, 2.2.0-A) — `stopReceiver` ignores HTTP status; UI shows STOPPED + success toast regardless. `traps.js:1118-1126`
- **RCV-09** (note) — UDP fire-and-forget: "sent" ≠ delivered (inherent; inform is the confirmable path — see TRP-06). `runtime.py:640-711`
- **RCV-10** (low, IMPR, 2.2.0-C) — Row actions keyed by render-time array index instead of `trap.id`. `traps.js:1321-1333,1428-1507`
- **RCV-11** (low, GAP, 2.2.0-C) — "Total Traps" mixes session/persisted semantics. `traps.js:1138,271-278`
- **RCV-12** (low, GAP, 2.2.0-B) — No per-trap delete (only Clear all). `traps.html:197-201`
- **RCV-13** (low, BUG, fixed 2.2.0-A residual) — Inline-onclick quote escaping in traps row actions. FIXED: delegated `data-trap-key`/`data-trap-action` handlers.
- **RCV-14** (low, BUG, fixed 2.2.0-B residual) — Pager edges: clear didn't reset offset/total; `older` could step past a shrunken total. FIXED: reset on clear + offset clamping.
- **RCV-15** (note, 2.2.0-C) — `GET /api/traps` now returns the community string per event (needed by replay/CSV). Redact in list payloads; replay applies the stored value server-side when the override is blank (replay modal shows a masked placeholder).
- **RCV-16** (med, BUG, fixed 2.2.0-C residual) — RCV-02's signature-skip suppressed re-renders when only resolve-derived display fields changed (toggle/bundle switch), even on manual refresh. FIXED: signature salted with resolve state + toggle re-fetches immediately.
- **RCV-17** (note, accepted 2.2.0) — While paused or paged past page 1, arrived traps don't increment the pager total until the next fetch; refresh on Resume already covers it.

## Settings (SET)

- **SET-01** (med, GAP, 2.2.0-A) — `restart_required` always false though autostart flags need a backend restart; badge can never appear. `routes/settings.py:126-144`; `main.py:101-115`
- **SET-02** (low, GAP, 2.2.0-A) — `mib_remote_sources` has no server-side validation. `routes/settings.py:142-143`
- **SET-03** (low, GAP, 2.2.0-A) — API allows username rename though UI declares it fixed/readonly. `session.py:102-137`
- **SET-04** (low, IMPR, 2.2.0-C) — Credential update deletes all sessions; other clients only discover on next REST 401. `session.py:131`; `realtime.py:43-66`
- **SET-05** (low, IMPR, 2.2.0-C) — Per-request auth overhead: fresh services + 4 DB setting rows per request; per-message WS token validation. `session.py:139-142,274-275`
- **SET-06** (low, GAP, 2.2.0-C) — WS close 4001 doesn't trigger logout (app stays interactive with dead session until next 401). `ws-client.js:98-105`
- **SET-07** (low, IMPR, 2.2.0-B) — Dead service surface umbrella: `send_inform`/`replay`/`decode`/`list_notification_events` unreachable (see TRP-06/07/08). `runtime.py:713,786,901,940`
- **SET-08** (note) — `/api/meta` + `/health` unauthenticated (app metadata pre-login). `routes/system.py:12-24`
- **SET-09** (med, GAP, 2.2.0-A) — Settings load failure is silent; Save then persists HTML defaults over real values. `settings.js:109-127`
- **SET-10** (med, IMPR, 2.2.0-A) — Save has no busy state (double-submit); inconsistent with `updateAuth()`. `settings.js:129-180`
- **SET-11** (low, IMPR, 2.2.0-C) — Remote-source lines validated only at save time; no per-line inline feedback. `settings.html:137-145`
- **SET-12** (low, IMPR, 2.2.0-C) — Restart-required badge not persisted across navigation. `settings.html:87-90`
- **SET-13** (low, IMPR, 2.2.0-C) — Session-timeout out-of-range only flagged at save; no `is-invalid` while typing. `settings.html:112-123`
- **SET-14** (low, IDEA, 2.2.0-B) — About card: show active bundle/producer version. `settings.html:184-205`
- **SET-15** (low, BUG, fixed 2.2.0-A residual) — Settings save persisted some fields before validating remote sources (partial persistence on 400). FIXED: validate-all-then-persist.

---

## Disposition summary

### 2.1.0-FIX (20 items) — FIXED and re-reviewed 2026-10-05

All resolved in the pending 2.1.0 release (re-review verdicts: 17 FIXED, 3 FIXED-WITH-NOTES — BRW-08, BRW-09, SIM-04, each for a documented deferred edge such as cross-tab staleness (MGR-12); 0 regressions):

| ID | Sev | Resolution |
|---|---|---|
| TRP-01 | high | FIXED — `/api/mibs/objects` attaches `enum_values`; picker dropdown renders |
| BRW-08 | high | FIXED — oid-index cache revalidates bundle id; init resets |
| MGR-01 | high | FIXED — old-producer starter bundles recompile (not re-activate) |
| TRP-02 | high | FIXED — canonical `input_type_for_syntax` in `mib_metadata`, wired into the picker route; picker-added objects default to their MIB-declared varbind type |
| BRW-09 | med | FIXED — fast path defers to server search when filters active |
| BRW-12 | low | FIXED — SMI-token normalization for fast-path icons/exports |
| BRW-16 | med | FIXED — enumerations table: 300px, sticky header, count badge, sorted |
| BRW-17 | med | FIXED — Units row renders as a monospace info badge |
| BRW-24 | med | FIXED — loading state during first index download |
| BRW-07 | med | FIXED — `active_bundle_id` in the browse payload; status call dropped |
| MGR-14 | low | FIXED — bundle-scoped banner dismissal |
| MGR-18 | low | FIXED — banner copy driven by producer_version/missing_capabilities |
| MGR-19 | med | FIXED — banner Recompile busy state |
| MGR-20 | med | FIXED — revision-card persistence + aria-expanded |
| MGR-23 | low | FIXED — real CSS rules for the dead tokens |
| SIM-04 | med | FIXED — custom_data_warnings inline warning panel |
| WLK-09 | low | FIXED — grouped mode carries enum_label/units |
| TRP-13 | med | FIXED — flex-row varbind lines + full-text tooltips, no clipping |
| WLK-19 | med | FIXED — inline `label(value)` enrichment, single-line walker rows |

New findings from the re-review (deferred to 2.2.0-A unless noted): **SIM-27** (restart response carries `custom_data_warnings` but the restart handler doesn't render them), **BRW-25** (filtered numeric search downloads the oid-index then discards it for the server path), **TRP-22** (`input_type: "OID"` doesn't round-trip through `syntaxToType` — pre-existing, half the canonical map unreachable from the picker). Informational: legacy banner dismissal (`'1'`) re-prompts once after upgrade; the banner recompile also spins the toolbar Reload button.

### 2.2.0 phased plan

- **2.2.0-A — Correctness** (~40): all remaining BUG/GAP high+medium: WLK-01, SIM-01/02/05/06/07/08, TRP-02/03, RCV-01/03, MGR-02/03/07/08/11/12/13, BRW-01/10/11/19, WLK-02..08, 14-16, SIM-03/09/12/15/18/19, TRP-04/05/11/12/15/16, RCV-04/08, SET-01/02/03/09/10
- **2.2.0-B — Missing features** (~15): MGR-04 (bundle lifecycle UI + `content_hash` fast-path diff), TRP-06/07/08 (inform/replay/decode routes+UI), WLK-10 (timeout/retry), WLK-17/18 (loading state + cancel), WLK-24 (sorting), RCV-05/12, TRP-09/14, BRW-15/23, MGR-25, SET-14
- **2.2.0-C — Polish, consistency, perf** (~50): all remaining IMPR items + BRW-03..06, SIM log/UX, badge/token consistency, liveness standardization (RCV-02/SIM-06 family), SET/ST polish
- **Backlog ideas** (~5): WLK-25, SIM-26, TRP-21, BRW-12-adjacent, SET-14 variants

Sequencing guidance: 2.2.0-A first (bugs before features), B next, C opportunistically; the three liveness/`res.ok` families (MGR-13, RCV-02, SIM-06) are best fixed as one cross-page pass.
