// perf/calendar-and-menu-cache-policy: single, explicit source of truth for
// how every top-level content state (state.activeTab) handles its own data,
// so a future addition can never quietly slip through without anyone
// deciding how it should behave.
//
// tests/menu-cache-policy-coverage.test.mjs reads loadActiveTab()'s own
// dispatch chain in app.js - the actual, authoritative list of every
// activeTab this app currently knows how to render - and fails if any of
// those ids is missing an entry below. Adding a new `state.activeTab ===`
// branch in loadActiveTab() without also adding a policy entry here breaks
// the frontend test suite, on purpose - the goal is a loud failure in
// development, not a runtime crash in production.
//
// Adding a new data-driven main menu item? You must:
//   1. Pick a policy:
//        "cached"         - goes through view-cache.js's loadCachedView
//                            (see coach-profile-actions.js,
//                            program-library-data.js, exercise-actions.js,
//                            or app.js's own loadWeekly/renderOrganizationPanel
//                            for real examples to copy).
//        "always-refresh" - always a real fetch, no caching. Only for cases
//                            where staleness is genuinely unacceptable
//                            (e.g. "today's" data) or the view hasn't been
//                            wired into the cache system yet - never the
//                            default just because it's easier.
//        "local-draft"    - Builder's model: autosaved local state, no
//                            cache/refetch concept applies to the draft
//                            itself.
//        "static"         - renders purely from state/props already loaded
//                            elsewhere; makes no API call of its own at all.
//   2. If "cached": define its context/cache key. It must include
//      currentUserWorkspaceContextParts() (access.js) plus whatever
//      view-specific filter/selection actually reaches the server - never
//      a permission-sensitive view without a correct context key. Anything
//      that's purely client-side (never sent to the server) should NOT be
//      folded into the key - document that decision inline, the way
//      loadWeekly's own comment in app.js does for week/day/month selection.
//   3. Decide its TTL - reuse VIEW_CACHE_FRESHNESS_MS (view-cache.js) unless
//      you have a specific reason not to; note it here if you deviate.
//   4. Find every mutation that can change what this view shows, and force
//      a refresh (`{ forceRefresh: true }`) or invalidate its cache entry
//      after each one succeeds - never before, and never guess at "just
//      invalidate everything" when the specific context is cheap to target
//      precisely (only fall back to a whole-namespace invalidation when
//      precise targeting is genuinely unsafe, and say why in a comment).
//   5. Add tests: first entry fetches, repeat entry with fresh data doesn't,
//      repeat entry renders the cache instantly, a race (selection or
//      workspace changing mid-request) never lets a stale response win, and
//      logout/login clears it.
//
// No separate document beyond this file and its test is required or
// expected - keep both short.

export const MENU_CACHE_POLICIES = {
  weekly: {
    label: "Calendar",
    policy: "cached",
    namespace: "weekly",
    rationale:
      "Wired into view-cache.js in perf/calendar-and-menu-cache-policy. Context key is [...workspace parts, athleteId] - GET /api/athletes/:id/program-data?program=__weekly__ never takes a date/week/month/day parameter (the backend always returns every week for that athlete), so period/view selection is deliberately NOT part of the key - see loadWeekly's own comment in app.js.",
  },
  coaches: {
    label: "Coaches",
    policy: "cached",
    namespace: "coaches",
    rationale:
      "Wired in perf/main-navigation-cache. Context key is account+workspace only - the coach directory has no other server-side filter.",
  },
  templates: {
    label: "Program Library",
    policy: "cached",
    namespace: "templates",
    rationale:
      "Wired in perf/main-navigation-cache. Context key is account+workspace+scope; every other filter (search/category/tag/creator/...) is applied client-side against the already-cached list.",
  },
  "athlete-library": {
    label: "Programs (athlete shell)",
    policy: "cached",
    namespace: "templates",
    rationale:
      "The athlete shell's Program-Library equivalent - renderAthleteLibrary() calls the exact same loadTemplates(), so it shares the templates cache namespace/context key rather than having its own.",
  },
  exercises: {
    label: "Exercise Library",
    policy: "cached",
    namespace: "exercises",
    rationale:
      "Wired in perf/main-navigation-cache. Context key includes account+workspace plus every server-relevant search/filter/limit param; `marked` (a client-only filter never sent to the server) is deliberately excluded.",
  },
  organization: {
    label: "Settings",
    policy: "cached",
    namespace: "organization",
    rationale:
      "Wired in perf/main-navigation-cache. Context key is account+workspace only - every Settings sub-tab (Overview/Users/Clubs/Teams/Athletes/Tags & Presets/Join links) reads the same /api/organization payload.",
  },
  builder: {
    label: "Builder",
    policy: "local-draft",
    namespace: "builderDrafts",
    rationale:
      "An open draft is never cached/refetched - every structural edit already autosaves per-action (see queuedBuilderApi in builder-actions.js), so loadBuilder() just re-renders whatever's already in memory on re-entry instead of re-GETing and risking a race against an in-flight autosave. Only the read-only empty-state drafts LIST (shown when no draft is open) uses view-cache.js, under the builderDrafts namespace, keyed by user id only (drafts are not workspace-scoped server-side).",
  },
  "coach-home": {
    label: "Home",
    policy: "always-refresh",
    namespace: null,
    rationale:
      "Shows \"today's\" athlete overview (GET /api/athletes/today) - not wired into view-cache in this PR. A stale cached view of \"today\" is a worse failure mode than one extra request, and Home is typically the very first screen after login, with nothing to reuse yet. Candidate for a future perf PR if warranted.",
  },
  programs: {
    label: "Specific programs",
    policy: "always-refresh",
    namespace: null,
    rationale:
      "Same loader shape and same athleteId-scoped endpoint family as Calendar (GET /api/athletes/:id/program-data?program=<name>), but deliberately not wired into view-cache in this PR to keep this change reviewable and scoped to Calendar. Documented follow-up, not a silent gap.",
  },
  "athlete-settings": {
    label: "Settings (athlete shell)",
    policy: "static",
    namespace: null,
    rationale:
      "renderAthleteSettings() makes no API call of its own - it renders purely from state.athletes/state.currentUser, already loaded elsewhere.",
  },
};
