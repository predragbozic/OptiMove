import { emptyExerciseEditor } from "./exercise-editor.js";

export const EXERCISE_FILTERS = [
  { key: "purpose", label: "Purpose", optionsKey: "purposes" },
  { key: "quality", label: "Quality / modality", optionsKey: "qualities" },
  { key: "group", label: "Exercise group", optionsKey: "groups" },
  { key: "bodyPart", label: "Body part", optionsKey: "bodyParts" },
  { key: "movementPattern", label: "Movement pattern", optionsKey: "movementPatterns" },
  { key: "startingPosition", label: "Starting position", optionsKey: "startingPositions" },
  { key: "place", label: "Place", optionsKey: "places" },
  { key: "complexity", label: "Complexity", optionsKey: "complexities" },
  { key: "attractor", label: "Attractor", optionsKey: "attractors" },
  { key: "tag", label: "Tag", optionsKey: "tags" },
];

export const emptyExerciseFilters = () => ({
  purpose: "",
  quality: "",
  group: "",
  bodyPart: "",
  movementPattern: "",
  startingPosition: "",
  place: "",
  complexity: "",
  attractor: "",
  tag: "",
  favorite: false,
  marked: false,
});

export const emptyExerciseOptions = () => ({
  purposes: [],
  qualities: [],
  groups: [],
  bodyParts: [],
  movementPatterns: [],
  startingPositions: [],
  places: [],
  complexities: [],
  attractors: [],
  tags: [],
});

export const emptyTemplateFilters = () => ({
  search: "",
  category: "",
  tag: "",
  creator: "",
  club: "",
  ownerType: "",
  visibility: "",
  lifecycle: "",
  pricing: "all",
});

export const emptyTemplatePreview = (overrides = {}) => ({
  open: false,
  loading: false,
  detail: null,
  error: "",
  settingsOpen: false,
  reviewOpen: false,
  reviewMessage: "",
  reviewError: "",
  reviewsOpen: false,
  reviews: [],
  accessRequests: [],
  accessRequestError: "",
  submittingAccessId: "",
  submittingAccessBulk: false,
  assignOpen: false,
  assigning: false,
  assignError: "",
  assignMessage: "",
  assignedAthleteIds: [],
  usedMarked: false,
  requestSent: false,
  submittingUse: false,
  submittingReview: false,
  ...overrides,
});

export const emptyBlockPicker = (overrides = {}) => ({
  open: false,
  sourceType: "",
  templates: [],
  templatesLoading: false,
  athleteId: "",
  athletePlans: [],
  athletePlansLoading: false,
  planId: "",
  planName: "",
  blocks: [],
  blocksLoading: false,
  // Drill-down steps (Phase F2): picking a block no longer immediately sets
  // the clipboard - it loads that block's sessions instead, so a coach can
  // choose "copy this whole day" OR drill into a session, and from there
  // either "copy this whole session" OR drill into that session's node
  // tree to copy just one domain/category/section.
  blockId: "",
  blockName: "",
  sessions: [],
  sessionsLoading: false,
  sessionId: "",
  sessionName: "",
  nodes: [],
  nodesLoading: false,
  error: "",
  ...overrides,
});

export const emptyBuilderState = (overrides = {}) => ({
  draft: null,
  // "" until a coach picks one of the three entry tiles (weekly/program/template) -
  // gates whether renderBuilderInner shows the tile grid or the create form.
  entryType: "",
  planType: "weekly",
  weekStart: "",
  // Mirror of the create form's uncontrolled name/color inputs - without this,
  // opening the athlete picker (which re-renders the whole create-form branch)
  // wipes whatever the coach already typed/picked, since those inputs would
  // otherwise have no value= binding at all.
  createName: "",
  createColor: "#C2F0E6",
  selectedSessionId: "",
  selectedNodeId: "",
  exerciseQuery: "",
  exerciseFilters: emptyExerciseFilters(),
  exercises: [],
  athletePickerOpen: false,
  sectionPickerOpen: false,
  createAthleteId: "",
  createAthleteIds: [],
  batchSync: true,
  drafts: [],
  draftsLoading: false,
  draftsOpen: false,
  selectedDraftKeys: [],
  copyPlanId: "",
  copyPlanName: "",
  copyAthleteId: "",
  copyAthleteIds: [],
  copyPlanType: "program",
  copyWeekStart: "",
  // "copy" (existing "Copy" action from a plan's more-menu) vs "assign"
  // (the open-Builder "Assign to athlete" button) - both share this same
  // modal/state and the same /duplicate endpoint; intent only changes the
  // modal's wording, whether "reusable template" is offered, and what
  // happens after a successful confirm (see builder-actions.js).
  copyIntent: "copy",
  // Minted once per Assign attempt (crypto.randomUUID()) and reused across
  // retries of that SAME attempt, so the backend can tell "the coach
  // clicked Assign again after a failed request" apart from "a new assign"
  // (backend/src/routes/builder.js's assignmentRequestId idempotency
  // check). Cleared by resetBuilderCopyState() - i.e. on a successful
  // confirm or on closing the picker - never on a failed attempt, so a
  // retry naturally reuses it.
  copyAssignmentRequestId: "",
  // Set when the plan being copied/assigned is an edit-draft (draft.plan.isEditDraft) -
  // confirming an "assign" for one of these must apply the edit-draft to its
  // original first (same /submit endpoint "Apply changes" already uses), so
  // the assigned copy can never silently contain a stale pre-edit version.
  copyIsEditDraft: false,
  // Set after a successful "assign" confirm - { planId, athleteNames } - shown
  // as a dismissible confirmation banner in the still-open template Builder,
  // with an "Open program" affordance, instead of navigating away into the
  // new copy (which the "copy" intent still does).
  assignResult: null,
  clipboard: null,
  // Set when a day/block paste is refused with 409 (target day already has
  // content) - {targetDayId, sourceDayId} for the confirm dialog to re-issue
  // the same POST with confirmOverwrite: true. Same "just enough to redo the
  // action" shape as messages.js's hideConfirmOpen pattern, not a generic
  // pending-action payload, since day-paste can target any of several days
  // (unlike a single "currently selected conversation").
  overwriteDayConfirm: null,
  // Phase 2: "Copy a block from another plan" picker, opened from a weekly
  // day's header. A small wizard - sourceType ("template"|"program") ->
  // (if "program") pick an athlete -> pick that athlete's/the template
  // library's specific plan -> pick one of that plan's blocks (fetched
  // lightweight via GET /api/builder/plans/:planId/blocks, not the full
  // node/item tree). Picking a block sets state.builder.clipboard to
  // {type: "cross-plan-block", ...} and closes this.
  blockPicker: emptyBlockPicker(),
  showNote: false,
  addNodeOpen: false,
  sessionQuickAdd: { blockId: "", amPm: "", bta: "", time: "" },
  structureModalOpen: false,
  blockAddOpen: false,
  inlineAddOpen: false,
  inlineAddType: "",
  inlineAddSessionId: "",
  inlineAddParentId: "",
  previewSectionId: "",
  editNodeOpen: "",
  infoOpen: "",
  customExerciseOpen: false,
  customExerciseDose: { sets: "", reps: "", load: "" },
  nodePresets: [],
  // feature/mobile-builder-section-workflow: explicit mobile-only UI state
  // for the Exercise section editor - see builder-section.js/builder-
  // exercises.js. Deliberately state-driven, never CSS :focus-within/:has()
  // driven (see the audit note in scrollToLastAddedItem, builder-
  // actions.js) - a real DOM focus/blur race during a tap was the root
  // cause of "first tap only reflows" on mobile. Desktop's parallel
  // library/added layout ignores all of these; they only affect the
  // ≤560px single-column mode (see styles.css).
  mobileMode: "add", // "add" | "added" - which of the two mobile modes is showing.
  lastAddedItemId: "", // drives the sticky bar's "last added" thumbnail emphasis and Edit now.
  addConfirmation: null, // { itemId, title } - transient inline "<title> added" banner + Edit now, cleared on next navigation/add.
  editItemId: "", // set while a single item's Sets/Reps/Load/Instruction is open in Added-exercises mode.
  editItemInstructionOpen: false, // Instruction starts collapsed per item; resets whenever editItemId changes.
  ...overrides,
});

export const TEMPLATE_SCOPES = ["my_programs", "optimove", "marketplace"];
export const ATHLETE_TEMPLATE_SCOPES = ["my_programs", "optimove", "marketplace"];

// WELLNESS check-in form state - shared shape used both by the normal
// in-app Tests tab (state.tests.form) and the public check-in page
// (state.checkIn.form), since the form itself behaves identically once an
// assignment has been resolved. `answered` is tracked separately from
// `values` so a slider that has genuinely been moved to 0 (or an Injury
// answer of No) is indistinguishable from "still untouched" nowhere in the
// UI - `values[key] === 0` alone can never mean "unanswered".
export const emptyWellnessForm = (overrides = {}) => ({
  assignmentId: "",
  testName: "",
  athleteName: "",
  athleteImageUrl: "",
  opensAt: "",
  closesAt: "",
  canSubmit: false,
  parameters: [],
  values: {},
  answered: {},
  submitting: false,
  error: "",
  result: null, // { wellnessScore } once a submit has succeeded this page load
  latestAssessment: null, // a previously-saved answer, if any (pre-fills values/answered)
  idempotencyKey: "",
  // Item 4 ("Schedule again" from a result-detail view): only ever set by
  // the coach's own openResult (tests-actions.js), never by the athlete's
  // own submit/correction flow - gates the "Schedule again" button on
  // renderWellnessResultHtml.
  scheduleId: "",
  ...overrides,
});

export const emptyScheduleForm = (overrides = {}) => ({
  open: false,
  editingScheduleId: "", // "" = create mode; set = editing this schedule (PATCH, not a parallel route)
  // Both mirror the schedule's own same-named fields (GET /schedules/:id).
  // hasOccurrences alone no longer decides whether full-edit is blocked
  // (Phase 2.5) - a one_time schedule with an occurrence but no real
  // activity is still editable; hasActivity is the one that actually gates
  // it, and is what the UI explains to the coach.
  hasOccurrences: false,
  hasActivity: false,
  // "one_time" | "daily" | "specific_dates". The coach only ever picks
  // between the two top-level pills - "Specific dates" and "Repeat daily" -
  // and BOTH open the exact same calendar component (mobile scheduling
  // redesign - see tests-view.js's renderTestsCalendarSectionHtml). Create
  // mode: "Specific dates" = "specific_dates" (multi-select mode - never
  // sent as scheduleKind to the server: submitting it calls POST /schedules/
  // bulk instead of POST /schedules, creating one independent one_time
  // schedule per date in selectedDates), "Repeat daily" = "daily" (range
  // mode - one recurring schedule with start/end dates from
  // startDate/endDate). Edit mode: "Specific dates" = "one_time" (the
  // existing schedule's own single date - the calendar is used in range
  // mode there too, but the interaction always collapses start===end since
  // a one_time schedule structurally has only one date column), "Repeat
  // daily" = "daily" (range mode, startDate/endDate).
  scheduleKind: "one_time",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  startDate: "",
  // Only meaningful in "daily" (range) mode - the recurring schedule's own
  // end_date. Empty string means "not chosen yet" (required before submit,
  // unlike the schedule model's own end_date column, which CAN be null/
  // open-ended - this form always asks for a concrete end so a coach can't
  // accidentally create a schedule with no end in sight).
  endDate: "",
  opensTime: "06:00",
  dueTime: "",
  closesTime: "22:00",
  // Calendar picker state, shared by BOTH interaction modes (see the
  // scheduleKind comment above). calendarMonth is a "YYYY-MM" string (the
  // month currently displayed). selectedDates (multi-select mode only)
  // holds "YYYY-MM-DD" strings, order-independent (rendered sorted). Range
  // mode (daily/one_time) reads/writes startDate/endDate directly instead -
  // selectedDates stays empty and unused in that mode. calendarOpen now
  // auto-opens the instant a recurrence pill is clicked (mobile redesign:
  // no more separate "open the calendar" step) but can still be manually
  // re-collapsed afterward via the same toggle, to save space once dates
  // are already picked.
  calendarMonth: "",
  calendarOpen: false,
  selectedDates: [],
  // Phase 3A notification rules - each entry is { kind, enabled,
  // reminderOffsetMinutes? }, at most one per kind ("athlete_invitation" |
  // "athlete_reminder" | "coach_digest" | "final_digest"). A kind missing
  // from this array means "unconfigured", not "disabled" - GET /schedules/
  // :id returns [] for a schedule that's never had rules saved, and the
  // form shows that as a visible unconfigured state rather than silently
  // defaulting it to anything. tests-open-schedule-form (create) seeds this
  // with the visible MVP defaults instead; the coach sees and can change
  // them before the first save, they are never a hidden backend default.
  notificationRules: [],
  // Recipients (item 1, Builder-style picker): athletes/teams/clubs are all
  // arrays now - the backend's own targets model (backend/src/routes/
  // tests.js's insertTargets/resolveValidTargets) always supported an
  // arbitrary MIX of any number of athlete/team/club target rows; teamId/
  // clubId being bare single strings here was purely a frontend limitation
  // of the old raw-<select> UI, never a backend one - so widening these to
  // arrays needed no backend change at all. Combinable, never mutually
  // exclusive - an athlete can be targeted directly AND via a team/club
  // they belong to at the same time; the backend's own union-based
  // materialization already de-duplicates that down to one real assignment
  // per athlete regardless.
  athleteIds: [],
  athleteSearch: "",
  teamIds: [],
  clubIds: [],
  // The single, unified "Recipients" bottom-sheet picker (replaces the old
  // raw Club/Team <select> pair + the separate Athletes collapsible - see
  // tests-view.js's renderRecipientPickerHtml, styled with Builder's own
  // .builder-athlete-overlay/-picker/-option/-checkmark classes). recipient
  // PickerTab is which of the 3 tabs is currently showing ("clubs" |
  // "teams" | "athletes"). recipientPickerSnapshot is taken the instant the
  // picker opens ({ athleteIds, teamIds, clubIds }, all arrays) so its own
  // X (cancel) can revert every change made during this one open/close
  // session, mirroring the calendar's own cancel snapshot below - Confirm
  // (check) just closes without restoring anything.
  recipientPickerOpen: false,
  recipientPickerTab: "athletes",
  recipientPickerSnapshot: null,
  // Item 2 (direct calendar open/close): taken the instant the calendar
  // opens (a Dates/Daily pill click - tests-actions.js's tests-schedule-
  // set-recurrence is the ONLY way to open it now, the old separate "Pick
  // dates"/"N dates selected" toggle row is gone) - { selectedDates,
  // startDate, endDate }, whichever of these the CURRENT mode actually
  // uses. The calendar's own header X restores this and closes; its own
  // check just closes, keeping whatever was picked during this session.
  calendarCancelSnapshot: null,
  // Mobile scheduling redesign: Notifications is a collapsible section with
  // a summary line ("Notifications · 2 athlete · 2 coach") on narrow
  // viewports, fully expanded (unchanged from before) on desktop. Default
  // here is the DESKTOP default (always open) - tests-open-schedule-form/
  // openEditSchedule override it to false on a narrow viewport when the
  // form is first opened. Explicit state (not a bare CSS media query)
  // specifically so a later full re-render (e.g. toggling a notification
  // switch) never snaps an already-open section shut out from under
  // whatever the coach was doing inside it.
  notificationsSectionOpen: true,
  // "Advanced settings": the fallback timezone field, tucked away by
  // default on every viewport (not just mobile) - it only matters for an
  // athlete whose own device timezone is still unknown, so it doesn't need
  // the prominence of a top-level field. Starts collapsed both on create
  // and on edit.
  advancedSettingsOpen: false,
  // Item 4 ("Schedule again"): the id of the ORIGINAL schedule this form's
  // settings were copied FROM, purely for the form's own header/labeling -
  // NEVER used as editingScheduleId, so submitting this form always goes
  // through the normal CREATE path (POST /schedules or /schedules/bulk),
  // never a PATCH of the original. "" in every other mode (plain create,
  // real edit).
  scheduleAgainFromId: "",
  submitting: false,
  error: "",
  ...overrides,
});

export const emptyTestsState = (overrides = {}) => ({
  section: "today",
  loading: false,
  error: "",
  pendingCount: 0,
  athleteToday: [],
  athleteUpcoming: [],
  athleteHistory: [],
  coachToday: [],
  schedules: [],
  scheduleDetail: null,
  results: [],
  resultsScheduleId: "",
  library: { tests: [], batteries: [] },
  orgPickerData: null,
  scheduleForm: emptyScheduleForm(),
  showCancelledSchedules: false,
  // Id of the schedule currently mid-delete (double-click guard + "Deleting..."
  // label on that one row's button) - "" when no delete is in flight.
  deletingScheduleId: "",
  // Set right after a successful POST /schedules/bulk (Specific dates),
  // cleared on the next navigation/section change - a one-time confirmation
  // banner: "N dates scheduled: <list>", per the requirement that the coach
  // sees exactly what was created, not just a silently-closed form.
  bulkResult: null,
  form: null,
  // Manual reminder (Coach Today). reminderSelection[scheduleId] is
  // { fingerprint, ids } (item 4 correction) - fingerprint is a stable
  // snapshot of the schedule's own CURRENT full assignment-id set at the
  // moment this choice was made (assignmentSetFingerprint, tests-view.js),
  // ids is the explicit list of checked assignment ids. reminderSelectedSet
  // (tests-view.js) is the only reader: it falls back to "every not-yet-
  // completed athlete" whenever this value is absent OR its fingerprint no
  // longer matches the group's CURRENT assignment set - which is exactly
  // what makes a stale selection (yesterday's daily occurrence, an athlete
  // who completed after the coach already chose) self-correct on the very
  // next render, without needing to eagerly populate/reset this map on
  // every Today load. remindingScheduleId mirrors deletingScheduleId's own
  // double-click-guard shape (one send in flight at a time, "" when none).
  // reminderResult is a one-time confirmation banner ({ scheduleId,
  // message }), reset on every fresh coach Today load (tests-data.js) -
  // same lifecycle intent as bulkResult, just tied to Today instead of the
  // schedule-form flow.
  reminderSelection: {},
  remindingScheduleId: "",
  reminderResult: null,
  ...overrides,
});

export const emptyCheckInState = (overrides = {}) => ({
  token: "",
  loading: true,
  error: "",
  testName: "",
  needsLogin: false,
  loginError: "",
  loginPending: false,
  message: "",
  form: null,
  ...overrides,
});

export const createInitialState = () => ({
  currentUser: null,
  athletes: [],
  selectedAthleteId: null,
  athletesExpanded: false,
  railExpanded: false,
  mobileNavOpen: false,
  sidebarSubmenuOpen: {},
  activeTab: "weekly",
  programLibrarySection: "programs",
  templateScope: "my_programs",
  selectedProgramId: null,
  // Whether the Specific Program detail is showing as the full overlay
  // (see program-view.js's renderProgramRootHtml / handleAppBack in app.js)
  // - decoupled from selectedProgramId itself so a click keeps highlighting/
  // targeting the more-menu exactly as before, while the overlay only ever
  // opens from an explicit click, never automatically on tab entry.
  specificProgramOverlayOpen: false,
  // feature/athlete-programs-profile: client-side-only search text for the
  // athlete's own Specific programs card rail - never sent to the server,
  // reset to "" on every fresh entry into the tab (see programs-data.js's
  // loadPrograms), not on background cache refreshes.
  athleteProgramsSearchQuery: "",
  selectedTemplateId: null,
  selectedWeekIndex: 0,
  selectedWeekDay: "",
  viewedWeekStart: "",
  weekSelectorOpen: false,
  pendingScrollDate: "",
  lastWeeklyData: null,
  lastProgramBundle: null,
  lastTemplates: [],
  templateAllowedScopes: TEMPLATE_SCOPES,
  templatePreview: emptyTemplatePreview(),
  templateFilters: emptyTemplateFilters(),
  templateOptions: { categories: [], tags: [], creators: [], clubs: [] },
  lastExerciseResults: [],
  builder: emptyBuilderState(),
  exerciseSearch: { term: "", limit: 30, hasMore: false, filters: emptyExerciseFilters(), options: emptyExerciseOptions() },
  markedExerciseIds: new Set(),
  markedExercises: new Map(),
  tagEditor: { open: false, exerciseId: "", exerciseName: "", tags: [], options: [], error: "" },
  exerciseEditor: emptyExerciseEditor(),
  programTagEditor: { open: false, planId: "", programName: "", tags: [], options: [], error: "" },
  programInfo: { open: false, program: null },
  organization: { data: null, error: "", selectedClubId: "", selectedTeamId: "", section: "overview", addFormOpen: false, assignOpen: false, accessOpen: false, showArchivedAthletes: false, showArchivedTeamMembers: false, showArchivedClubMembers: false, showDisabledUsers: false, requestStatus: "all", requestAthleteId: "all", requestError: "", requestMessage: "" },
  organizationEditor: { open: false, type: "", row: null },
  organizationUserManage: { open: false, userId: "", pending: false, error: "" },
  organizationInvite: { open: false, athleteId: "", pending: false, error: "", inviteUrl: "", mailtoUrl: "", copied: false },
  // security/verified-email-change: platform-admin-only Account view for an
  // athlete-only account (one with no staff role, so it never appears in
  // the Users list above). Deliberately its own state slice fetching its
  // own narrow GET /api/organization/users/:userId/account payload rather
  // than reusing organizationUserManage/the bulk organization data - that
  // payload is read by every viewer who can see the Athletes list (coaches,
  // club/team admins), and it must never carry another account's login
  // email to a non-platform-admin viewer. See renderAthleteAccountModal in
  // organization-view.js and its backend counterpart in
  // backend/src/routes/organization.js.
  athleteAccountManage: { open: false, athleteId: "", userId: "", loading: false, data: null, error: "", message: "", pending: false },
  organizationJoinLinks: { pending: false, error: "", justCreatedId: "", justCreatedUrl: "", copiedId: "", reviewPendingId: "" },
  joinPage: { token: "", loading: true, error: "", link: null, submitted: false, statusToken: "", requiresLogin: false, prefillEmail: "", application: null },
  workspaceSwitcher: { open: false, pending: false, error: "" },
  taxonomy: {
    loaded: false,
    error: "",
    nodePresets: [],
    templateTags: [],
    libraryRows: { domain: [], category: [], section: [], tag: [], attractor: [] },
    addOpenKind: "",
  },
  coaches: { rows: [], selected: null, detail: null, editOpen: false, contactOpen: false, error: "" },
  notifications: { rows: [], unreadCount: 0, open: false, loading: false, error: "" },
  tests: emptyTestsState(),
  checkIn: emptyCheckInState(),
  // feature/mobile-messages-fullscreen: menuOpen is the mobile thread
  // header's 3-dot overflow menu (Hide/Block live there on mobile instead
  // of always-visible buttons); hideConfirmOpen drives the styled confirm
  // modal that replaced window.confirm for Hide (used on both desktop and
  // mobile); sending guards against a rapid double-submit; draft holds the
  // composer text ONLY across an error re-render (never written on every
  // keystroke - see wireComposer in messages.js) so a failed send never
  // loses what was typed.
  messages: { open: false, rows: [], unreadCount: 0, selectedId: "", detail: null, loading: false, error: "", search: "", menuOpen: false, hideConfirmOpen: false, sending: false, draft: "" },
  navStack: [],
  exerciseDetail: { ids: [], currentId: null },
  exerciseLayout: "horizontal",
  touch: { startX: 0, startY: 0, startTime: 0 },
  appHistoryDepth: 0,
  backGuardReady: false,
  allowBrowserExit: false,
  weekCalendarMonth: "",
  openWeekCalendarOnLoad: false,
  // hotfix/athlete-home-mobile-layout
  athleteExitConfirmOpen: false,
  realtimeOffline: false,
});

export const state = createInitialState();
