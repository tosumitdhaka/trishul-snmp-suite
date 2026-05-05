# UI Verification Checklist

Use this checklist before cutting a UI-affecting release such as `1.3.1`.

## Test Matrix

- Desktop: `1440px` wide viewport
- Mobile: `390px` wide viewport
- Themes: light and dark
- Entry points: fresh logged-out load and normal authenticated app load

## Setup

1. Start the local stack with the intended release build.
2. Open the frontend in a clean browser profile.
3. Verify default login still works, or use the current configured credentials.
4. Repeat the core checks once in light mode and once in dark mode.

## Global Checks

- Fresh page load applies the saved theme before first paint on the login screen and app shell.
- Theme toggle is keyboard reachable, exposes a meaningful label, and updates icon plus state correctly.
- Navbar, sidebar, cards, inputs, tables, modals, and code panes use one coherent surface palette in both themes.
- Sticky headers remain readable while scrolling and do not flash white in dark mode.
- Icon-only buttons have consistent sizing, spacing, and focus styling.
- Desktop layout does not clip header actions or sidebar content.
- Mobile layout keeps login usable, navbar controls wrapped cleanly, and page actions reachable without horizontal scrolling.

## Page Checks

- Login: auth card is centered, responsive, readable, and shows no light-mode flash when dark mode is saved.
- Dashboard: stat cards, quick actions, badges, and icon treatments look consistent.
- Simulator: metrics strip, custom-data note, toolbar, and live log pane render correctly in both themes.
- Walker: empty state, progress bar, result pane, history list, and export controls render correctly in both themes.
- Traps: sender form, receiver controls, sticky table header, JSON preview modal, and action buttons render correctly in both themes.
- Browser: search/filter card, tree controls, sticky details panel, breadcrumb, description blocks, and varbind lists render correctly in both themes.
- MIB Manager: stats strip, MIB list, failed-MIB card, upload modal, and trap details modal render correctly in both themes.
- Settings: auth panel, switches, badges, and about metadata remain readable and aligned in both themes.

## Sign-Off

- Record any visual regressions with page name, viewport, theme, and screenshot.
- Do not mark UI tracker items done until this checklist passes for the release build.
