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
  clipboard: null,
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
  messages: { open: false, rows: [], unreadCount: 0, selectedId: "", detail: null, loading: false, error: "", search: "" },
  navStack: [],
  exerciseDetail: { ids: [], currentId: null },
  exerciseLayout: "horizontal",
  touch: { startX: 0, startY: 0, startTime: 0 },
  appHistoryDepth: 0,
  backGuardReady: false,
  allowBrowserExit: false,
  weekCalendarMonth: "",
  openWeekCalendarOnLoad: false,
});

export const state = createInitialState();
