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
  error: "",
  ...overrides,
});

export const emptyBuilderState = (overrides = {}) => ({
  draft: null,
  planType: "weekly",
  weekStart: "",
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
