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

## Sign-Off

- record any regressions with page, viewport, and screenshot
- do not mark UI-affecting release work complete until this checklist passes on the intended release build
