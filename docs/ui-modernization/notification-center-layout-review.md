# Notification Center & Layout System — Foundation Review

**Status:** Draft preview for incremental review, not production approval.  
**Branch:** `feat/modern-ui-notification-center-layout` based on `feat/modern-ui-all-workspaces`.  
**Scope:** Cross-workspace feedback and visual consistency only. No backend or legacy UI changes.

## Diagnosis

The initial integrated React UI mixed per-workspace banners with varying 2-column ratios, widths, header heights and panel paddings. Success and failure messages inserted into page flow, shifting controls and content and creating visual jumps. Multiple independently sized blocks made the workspaces look assembled rather than designed.

## Interaction design

**Notification center (header bell):**
- One predictable, always-visible control between workspace search and transport/theme controls, with an unread count capped visually at `9+`.
- Opens an accessible right-side dialog/drawer on desktop and mobile; close with Escape, close button or outside click; focus returns to the trigger.
- Most recent first: tone icon, action title, human-readable message, source workspace, timestamp, unread marker.
- Per-item mark-as-read and dismiss; mark-all-read and clear-all controls.
- No auto-dismiss timers, popup toasts, or page reflow. A screen-reader-only polite live region announces the latest outcome.
- Memory-only history, maximum **40 notifications**, reset when signed-out session unmounts or browser reloads. No localStorage, cross-user persistence, secret/token or trap payloads in the notification store.
- Actions initiated from Simulator, Walker, Traps, MIB Manager and Settings publish outcomes here. Existing backend request/query errors that are part of the page's loading/empty states remain inline; input validation remains beside fields, where users can act on it.
- **Not** a server alarm or trap inbox. Incoming SNMP notifications remain in Traps.

**Visual layout:**
- Single workspace vertical rhythm: **24px section gap**, with narrower mobile gap.
- Unified panel radius, border, shadow, minimum heading area, heading weight, body padding and control height.
- Paired cards: equal 1:1 columns at wide viewports; exploration/inventory versus detail: stable 7:5 split.
- Equal height for peer cards in the same row, without stretching unrelated panels to arbitrary heights.
- Content max width 1480px. Tables, logs and editors manage their own overflow, and layouts stack vertically below 1100px.
- All shared controls preserve keyboard focus styling, readable dark/light tokens and reduced-motion behavior.

## Manual acceptance

- [ ] At 1440px, 1024px, 768px and 390px, check bell alignment with search, connection status, theme, logout and hamburger (expanded and collapsed sidebar).
- [ ] Confirm no toast or banner pushes content down on successful start, stop, send, walk, upload, export, or failed request.
- [ ] Open drawer via keyboard and mouse; test Escape, outside click, focus return, mark one read, mark all read, dismiss, clear all, scroll with 40 messages and no horizontal overflow.
- [ ] Navigate between workspaces with drawer history intact; refresh/sign out to clear.
- [ ] Check that failed GET, inline timeout/MIB URL validation, error descriptions and confirmation dialogs remain contextual.
- [ ] Confirm actual SNMP received events still go to Traps, not the UI activity drawer.
- [ ] Review consistent card margins, equal heights for peer runtime panels, 7:5 exploration/detail layout, long text, dialogs, forms and tall tables in both themes.
- [ ] Real backend and cross-browser checks; automated TypeScript/lint/Vitest/build are not enough to establish visual sign-off.

Next iterations will revalidate each workspace's feature parity against the legacy module and backend API, one at a time. This foundation change does not claim missing features have been completed.
