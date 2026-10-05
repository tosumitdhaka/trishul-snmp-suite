# UI Verification Checklist

Use this checklist for the current `2.0.3` release UI.

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

- `Walk & Parse`: parsed rows render the raw value with an enum badge and muted units suffix next to it (no duplicated `up(1)` label in the value column); line mode still shows display strings
- `Traps`: received-trap varbind rows and the detail modal show the enum badge / units suffix next to the raw value; the varbind picker offers enum dropdowns; Integer rows with a range constraint show a min/max hint below the input, String rows with a size constraint show a length hint and validate before send
- `MIB Browser`: the detail pane shows the Enumerations table (label ↔ value) and a Units row; typing a numeric OID prefix resolves instantly from the local oid-index (e.g. `1.3.6.1.2.1.2` → `ifTable`)
- `MIB Manager`: the recompile banner appears when the active bundle was produced by an older MIB compiler and dismisses via the close button; module rows expand a revision-history card (organization, contact info, revisions)

## Sign-Off

- record any regressions with page, viewport, and screenshot
- do not mark UI-affecting release work complete until this checklist passes on the intended release build
