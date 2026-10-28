# D4 — layout and GridStack assessment

The current 12-column grid persists x/y/width/height and mobileOrder using the
existing layout draft, save/cancel actions and revision checks. Desktop has pointer
drag/resize plus directional and size buttons; mobile uses separate reorder
buttons and intentionally disables pointer drag/resize. H-slice regression tests
cover these existing flows.

ECharts requires container resizing, not a new layout engine. ResizeObserver on
each plot responds to the existing pointer-driven CSS layout patches. A bounded,
keyboard-focusable widget body scrolls multiple identity plots and value tables
inside the saved desktop height. Header, menus and editing tools stay outside
that scroller. Mobile retains natural content height and the saved mobile order.

Recommendation for this delivery: retain the current grid. Adding GridStack would
create a second owner of placement, collision handling and DOM lifetime and would
need explicit decisions about converting saved coordinates, mobile order,
overlap behavior, save/cancel and keyboard equivalence. The current chart work
does not justify that architecture change. No GridStack dependency, experiment
against saved dashboards, automatic layout rewrite or persistence change is made.

Reconsider only with a separate approved interaction requirement and a reversible
prototype using synthetic layouts. That evaluation must verify old saved layouts,
editing permissions, collision policy, mobile/touch/keyboard behavior, instance
cleanup and revision conflicts before any backend or saved-layout change.
