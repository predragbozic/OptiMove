import { api } from "./api.js";
import { invalidateBuilderDraftsCache, loadBuilderNodePresets } from "./builder-data.js";
import { findBuilderNode, findBuilderSession } from "./builder-helpers.js";
import { invalidateCoachHomeCache } from "./coach-home-data.js";
import { invalidateAthleteHomeCache } from "./athlete-home-data.js";
import { emptyBlockPicker, emptyBuilderState, state } from "./state.js";
import { localDateIso, weekMondayIso } from "./utils.js";

// feature/mobile-builder-section-workflow: replaces the old post-add
// helper, which used to blur the search input and scroll to the (CSS-
// hidden-until-blur) Added panel after every add - that's exactly what
// interrupted adding several exercises in a row, and the same focus-driven
// CSS it depended on is what caused the "first tap only reflows" bug (see
// the audit note on styles.css's now-removed focus-within-based rules).
// The coach now stays in Add-exercises mode, keyboard open, search/
// filters/scroll untouched - this just records what to show in the
// transient confirmation banner and the sticky bar, both of which live in
// their own DOM subtree.
function markExerciseJustAdded(nodeId, itemId) {
  const node = findBuilderNode(state.builder.draft, nodeId);
  const item = node?.items?.find((candidate) => candidate.id === itemId) || node?.items?.at(-1);
  if (!item) return;
  state.builder.lastAddedItemId = item.id;
  state.builder.addConfirmation = { itemId: item.id, title: item.title || "Exercise" };
  clearTimeout(addConfirmationTimer);
  addConfirmationTimer = setTimeout(() => {
    if (state.builder.addConfirmation?.itemId !== item.id) return;
    state.builder.addConfirmation = null;
    handlersForConfirmationTimeout?.renderBuilderAddFeedback?.();
  }, 4000);
}
let addConfirmationTimer = null;
let handlersForConfirmationTimeout = null;

function renderBuilderPreservingAthleteListScroll(handlers) {
  const list = document.querySelector("[data-builder-athlete-list]");
  const scrollTop = list?.scrollTop || 0;
  handlers.renderBuilder();
  const nextList = document.querySelector("[data-builder-athlete-list]");
  if (nextList) nextList.scrollTop = scrollTop;
}

function resetBuilderCopyState() {
  state.builder.copyPlanId = "";
  state.builder.copyPlanName = "";
  state.builder.copyAthleteId = "";
  state.builder.copyAthleteIds = [];
  state.builder.copyPlanType = "program";
  state.builder.copyWeekStart = "";
  state.builder.copyIntent = "copy";
  state.builder.copyIsEditDraft = false;
}

function getBuilderBatchId(draft = state.builder.draft) {
  return (
    draft?.batch?.id ||
    draft?.plan?.batchId ||
    draft?.plan?.builderBatchId ||
    draft?.plan?.builder_batch_id ||
    ""
  );
}

function shouldSyncBuilderBatch() {
  const batchPlans = state.builder.draft?.batch?.plans || [];
  return Boolean(state.builder.batchSync && (batchPlans.length > 1 || getBuilderBatchId()));
}

function setBuilderDraft(nextDraft, options = {}) {
  if (!nextDraft) {
    state.builder.draft = nextDraft;
    return nextDraft;
  }
  const previousDraft = state.builder.draft;
  const previousBatch = previousDraft?.batch;
  const previousBatchId = getBuilderBatchId(previousDraft);
  state.builder.draft = nextDraft;
  if (
    options.preserveBatch !== false &&
    previousBatch?.plans?.length > 1 &&
    !(state.builder.draft.batch?.plans?.length > 1)
  ) {
    state.builder.draft.batch = previousBatch;
  }
  if (previousBatchId && state.builder.draft?.plan && !getBuilderBatchId(state.builder.draft)) {
    state.builder.draft.plan.batchId = previousBatchId;
  }
  return state.builder.draft;
}

function withBatchSyncPayload(payload = {}) {
  return shouldSyncBuilderBatch() ? { ...payload, syncBatch: true } : payload;
}

// Builder mutations (rename, move, dose/instruction edits, ...) all replace the
// whole draft with whatever the server returns. If two of these are in flight at
// once, their responses can land out of order and the older one silently reverts
// the newer edit. Running them through a single queue keeps requests -- and their
// responses -- in submission order, so nothing gets clobbered.
let builderMutationQueue = Promise.resolve();
function queuedBuilderApi(url, options) {
  const result = builderMutationQueue.then(() => api(url, options));
  builderMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

// Shared by the initial "Paste day" click and the overwrite-confirm dialog's
// own confirm button - the only difference between them is whether
// confirmOverwrite is set, so this is the one place that builds the request
// for either caller. source is {type, id}: type "day" (Phase 1 - another
// day of the SAME weekly plan) hits /days/:id/copy-into, type
// "cross-plan-block" (Phase 2 - a block from a Template/Specific Program)
// hits /blocks/:id/copy-into - both resolve to the exact same backend
// behavior past ownership resolution (see respondCopyIntoDay in
// backend/src/routes/builder.js), only the URL differs.
function requestDayPaste(source, targetDayId, confirmOverwrite) {
  const segment = source.type === "cross-plan-block" ? "blocks" : "days";
  return queuedBuilderApi(`/api/builder/${segment}/${encodeURIComponent(source.id)}/copy-into/${encodeURIComponent(targetDayId)}`, {
    method: "POST",
    body: JSON.stringify(withBatchSyncPayload(confirmOverwrite ? { confirmOverwrite: true } : {})),
  });
}

function withBatchSyncUrl(url) {
  return shouldSyncBuilderBatch() ? `${url}${url.includes("?") ? "&" : "?"}syncBatch=1` : url;
}

function isNotFoundError(error) {
  return error?.status === 404 || /not found/i.test(error?.message || "");
}

function forgetBatchPlan(planId) {
  const batch = state.builder.draft?.batch;
  if (!batch?.plans) return;
  batch.plans = batch.plans.filter((plan) => String(plan.id) !== String(planId));
}

async function exitBuilderToPlanContext(plan, handlers) {
  state.builder = emptyBuilderState();
  state.navStack = [];
  if (plan?.athleteId) state.selectedAthleteId = String(plan.athleteId);
  if (plan?.planType === "weekly") {
    state.activeTab = "weekly";
    state.weekSelectorOpen = false;
    handlers.renderTabs();
    handlers.renderLibraryNav();
    // Same reasoning as the templates branch below - this exit always
    // follows a delete/submit/save that can change what Calendar shows for
    // this exact athlete; never trust a cached pre-exit payload here.
    await handlers.loadWeekly({ forceRefresh: true });
    // Home's "today" overview (GET /api/athletes/today) is a same-day
    // rollup of exactly this data across every athlete, not just this one -
    // invalidate rather than force-load, since Home is very likely not even
    // the active tab right now; the next time it IS entered, it must not
    // still show pre-mutation counts.
    invalidateCoachHomeCache();
    // The athlete shell's own Home aggregates this exact same today/week
    // data for the plan's athlete - same reasoning as invalidateCoachHomeCache
    // above, just for the athlete-facing rollup instead of the coach-facing
    // one.
    invalidateAthleteHomeCache();
    return;
  }
  if (plan?.isTemplate || !plan?.athleteId) {
    state.activeTab = "templates";
    handlers.renderTabs();
    handlers.renderLibraryNav();
    // Every path into exitBuilderToPlanContext follows a delete/submit/save
    // that can change this plan's row in the template list - never trust a
    // cached pre-exit list here.
    await handlers.loadTemplates({ forceRefresh: true });
    return;
  }
  state.activeTab = "programs";
  handlers.renderTabs();
  handlers.renderLibraryNav();
  // Same reasoning as the weekly branch above - this exit always follows a
  // delete/submit/save that can change this exact athlete's specific-program
  // list; never trust a cached pre-exit payload here.
  await handlers.loadPrograms({ forceRefresh: true });
  // Athlete Home's "active specific programs" section rolls up exactly this
  // same per-athlete program list - invalidate it too, same reasoning as the
  // weekly branch above.
  invalidateAthleteHomeCache();
}

export async function handleBuilderPlanAction(action, handlers) {
  const type = action.dataset.action;
  if (type === "builder-edit-plan") {
    // Same double-click guard/pending-label pattern as
    // builder-confirm-duplicate-plan below. This button has no CSS
    // :disabled styling of its own (.plan-more-menu-popover button never
    // defined one - unlike .plain-button:disabled elsewhere), so the old
    // bare action.disabled = true was invisible: the button looked
    // completely unchanged for however long POST /edit + loadBuilderExercises()
    // took, so a coach with no on-screen sign their click had registered
    // would click Edit again (and again) - reported live ("nemamo vizuelni
    // osecaj da smo kliknuli pa pokusavamo vise puta"). Swapping the label
    // text is the same fix already used for "Assigning..." on the copy/
    // assign confirm button, and is impossible to miss the way a subtle
    // opacity change would be.
    if (action.disabled) return true;
    const planId = action.dataset.planId || "";
    const batchPlans = state.builder.draft?.batch?.plans || [];
    const isBatchPlanSwitch = batchPlans.some((plan) => String(plan.id) === String(planId));
    action.disabled = true;
    const label = action.querySelector("span");
    const originalLabel = label?.textContent;
    if (label) label.textContent = "Opening…";
    try {
      setBuilderDraft(await queuedBuilderApi(`/api/builder/plans/${encodeURIComponent(planId)}/edit`, { method: "POST" }), {
        preserveBatch: isBatchPlanSwitch,
      });
      state.builder.selectedSessionId = "";
      state.builder.selectedNodeId = "";
      state.builder.exerciseQuery = "";
      // A stale "Assigned to ..." banner from whatever was open before must
      // not follow the coach into a different plan (including - the common
      // case right after an assign - the newly assigned Specific Program
      // itself, opened via the banner's own "Open new Specific Program").
      state.builder.assignResult = null;
      state.activeTab = "builder";
      state.navStack = [];
      handlers.renderTabs();
      handlers.renderLibraryNav();
      void loadBuilderNodePresets().catch(() => {});
      await handlers.loadBuilderExercises();
    } catch (error) {
      action.disabled = false;
      if (label) label.textContent = originalLabel;
      if (isNotFoundError(error)) {
        forgetBatchPlan(planId);
        state.builder.error = "That athlete copy is no longer available in this group.";
        handlers.renderBuilder();
        return true;
      }
      throw error;
    }
    return true;
  }
  if (type === "builder-duplicate-plan") {
    const intent = action.dataset.intent === "assign" ? "assign" : "copy";
    state.builder.copyPlanId = action.dataset.planId || "";
    // "Assign to athlete" is only ever triggered from the open Builder, for
    // the plan currently being edited - use its own name directly rather
    // than the more-menu's DOM-scraping fallback below, which has no
    // ".section-heading h3" ancestor to find from inside the Builder.
    state.builder.copyPlanName = intent === "assign"
      ? (state.builder.draft?.plan.name || "Template")
      : (action.closest(".section-heading")?.querySelector("h3")?.textContent || "Program");
    state.builder.copyAthleteId = "";
    state.builder.copyAthleteIds = [];
    state.builder.copyPlanType = action.dataset.planType === "weekly" ? "weekly" : "program";
    state.builder.copyWeekStart = state.builder.copyPlanType === "weekly" ? weekMondayIso(localDateIso()) : "";
    state.builder.copyIntent = intent;
    state.builder.copyIsEditDraft = action.dataset.isEditDraft === "true";
    await handlers.renderCopyPlanSource();
    return true;
  }
  if (type === "builder-close-copy-plan") {
    resetBuilderCopyState();
    await handlers.renderCopyPlanSource();
    return true;
  }
  if (type === "builder-dismiss-assign-result") {
    state.builder.assignResult = null;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-select-copy-athlete") {
    const athleteId = action.dataset.athleteId || "";
    if (!athleteId) {
      state.builder.copyAthleteIds = [];
      state.builder.copyAthleteId = "";
    } else {
      const current = new Set((state.builder.copyAthleteIds || []).map(String));
      if (current.has(String(athleteId))) current.delete(String(athleteId));
      else current.add(String(athleteId));
      state.builder.copyAthleteIds = [...current];
      state.builder.copyAthleteId = state.builder.copyAthleteIds[0] || "";
    }
    await handlers.renderCopyPlanSource();
    return true;
  }
  if (type === "builder-confirm-duplicate-plan") {
    // Same double-click guard as builder-submit-plan: action.disabled is set
    // synchronously below, before any await, so a real <button> refuses a
    // second click on its own - this early return only covers a
    // programmatic re-dispatch (e.g. a held Enter key) that could reach the
    // handler again before the DOM has reflowed the disabled attribute.
    if (action.disabled) return true;
    action.disabled = true;
    const isAssign = state.builder.copyIntent === "assign";
    const originalLabel = action.textContent;
    if (isAssign) action.textContent = "Assigning…";
    try {
      const athleteIds = state.builder.copyAthleteIds?.length
        ? state.builder.copyAthleteIds
        : (state.builder.copyAthleteId ? [state.builder.copyAthleteId] : []);
      let duplicateSourceId = state.builder.copyPlanId;
      if (isAssign && state.builder.copyIsEditDraft) {
        // This template is currently open as an edit-draft (draft.plan.isEditDraft) -
        // its edits only reach the real template when applied (the same
        // /submit endpoint "Apply changes" already uses). Applying first
        // guarantees the assigned copy can never silently contain a stale
        // pre-edit version. setBuilderDraft() here matters: applying deletes
        // the edit-draft row server-side and returns the now-updated
        // original, so the coach's open Builder must switch to reflect that
        // exact same swap "Apply changes" itself performs, or every
        // subsequent action here would 404 against the deleted edit-draft id.
        const applied = await queuedBuilderApi(`/api/builder/plans/${encodeURIComponent(state.builder.copyPlanId)}/submit`, {
          method: "POST",
          body: JSON.stringify(withBatchSyncPayload({})),
        });
        setBuilderDraft(applied, { preserveBatch: false });
        duplicateSourceId = applied.plan.id;
      }
      const created = await queuedBuilderApi(`/api/builder/plans/${encodeURIComponent(duplicateSourceId)}/duplicate`, {
        method: "POST",
        body: JSON.stringify({ athleteId: athleteIds[0] || "", athleteIds, weekStart: state.builder.copyWeekStart }),
      });
      // /duplicate always creates a brand new status='draft' row (see
      // backend/src/routes/builder.js) - the cached drafts list must never
      // be missing it just because it happened to be cached before this copy.
      invalidateBuilderDraftsCache();
      if (isAssign) {
        // Unlike a plain "Copy", assigning a template doesn't navigate the
        // coach away into the new copy - the template they were just
        // editing stays open exactly as it was (see the setBuilderDraft(applied)
        // swap above for the one case where its identity legitimately
        // changed), with a dismissible confirmation offering to open the
        // new Specific Program instead. /duplicate creates one plan PER
        // selected athlete (created.assignments, one entry per athlete/planId
        // pair) - the confirmation must offer a separate "Open" link for
        // EACH one, not just the first-created plan (created.plan.id), or a
        // 2+-athlete assign would silently strand every copy but the first
        // with no way to reach it from here.
        state.builder.assignResult = {
          entries: (created.assignments || []).map((entry) => {
            const athlete = state.athletes.find((candidate) => String(candidate.athlete_id) === String(entry.athleteId));
            return { planId: entry.planId, athleteName: athlete?.athlete || "Athlete" };
          }),
        };
        resetBuilderCopyState();
        handlers.renderBuilder();
        return true;
      }
      setBuilderDraft(created, { preserveBatch: false });
      state.builder.selectedSessionId = "";
      state.builder.selectedNodeId = "";
      state.builder.exerciseQuery = "";
      resetBuilderCopyState();
      state.activeTab = "builder";
      state.navStack = [];
      handlers.renderTabs();
      handlers.renderLibraryNav();
      void loadBuilderNodePresets().catch(() => {});
      await handlers.loadBuilderExercises();
    } catch (error) {
      action.disabled = false;
      action.textContent = originalLabel;
      if (isNotFoundError(error)) {
        forgetBatchPlan(state.builder.copyPlanId);
        state.builder.error = "That athlete copy is no longer available in this group.";
        handlers.renderBuilder();
        return true;
      }
      throw error;
    }
    return true;
  }
  if (type === "builder-open-draft") {
    const planId = action.dataset.planId || "";
    if (!planId) return true;
    action.disabled = true;
    try {
      setBuilderDraft(await queuedBuilderApi(`/api/builder/plans/${encodeURIComponent(planId)}`));
      state.builder.selectedSessionId = "";
      state.builder.selectedNodeId = "";
      state.builder.exerciseQuery = "";
      void loadBuilderNodePresets().catch(() => {});
      await handlers.loadBuilderExercises();
    } catch (error) {
      action.disabled = false;
      throw error;
    }
    return true;
  }
  if (type === "builder-discard-draft") {
    const planIds = (action.dataset.planIds || "").split(",").filter(Boolean);
    if (!planIds.length) return true;
    const confirmLabel = planIds.length > 1 ? "this draft for all selected athletes" : "this draft";
    if (!window.confirm(`Discard ${confirmLabel}? This cannot be undone.`)) return true;
    action.disabled = true;
    for (const id of planIds) {
      await api(`/api/builder/plans/${encodeURIComponent(id)}`, { method: "DELETE" });
    }
    state.builder.selectedDraftKeys = [];
    // Just deleted one or more drafts - the cached drafts list must never
    // keep showing them.
    await handlers.loadBuilderDrafts({ forceRefresh: true });
    return true;
  }
  if (type === "builder-toggle-drafts-panel") {
    state.builder.draftsOpen = !state.builder.draftsOpen;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-toggle-select-draft") {
    const groupKey = action.dataset.groupKey || "";
    if (!groupKey) return true;
    const current = new Set(state.builder.selectedDraftKeys || []);
    if (current.has(groupKey)) current.delete(groupKey);
    else current.add(groupKey);
    state.builder.selectedDraftKeys = [...current];
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-toggle-select-all-drafts") {
    const groupKeys = (state.builder.drafts || []).map((item) => item.groupKey).filter(Boolean);
    const selected = new Set(state.builder.selectedDraftKeys || []);
    const allSelected = groupKeys.length > 0 && groupKeys.every((key) => selected.has(key));
    state.builder.selectedDraftKeys = allSelected ? [] : groupKeys;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-discard-selected-drafts") {
    const selected = new Set(state.builder.selectedDraftKeys || []);
    const selectedDrafts = (state.builder.drafts || []).filter((item) => selected.has(item.groupKey));
    if (!selectedDrafts.length) return true;
    if (!window.confirm(`Discard ${selectedDrafts.length} selected draft${selectedDrafts.length === 1 ? "" : "s"}? This cannot be undone.`)) return true;
    action.disabled = true;
    for (const item of selectedDrafts) {
      for (const id of item.planIds || []) {
        await api(`/api/builder/plans/${encodeURIComponent(id)}`, { method: "DELETE" });
      }
    }
    state.builder.selectedDraftKeys = [];
    // Just deleted one or more drafts - the cached drafts list must never
    // keep showing them.
    await handlers.loadBuilderDrafts({ forceRefresh: true });
    return true;
  }
  if (type === "builder-open-batch-plan") {
    const planId = action.dataset.planId || "";
    if (!planId || String(state.builder.draft?.plan?.id) === String(planId)) return true;
    action.disabled = true;
    try {
      const batchPlans = state.builder.draft?.batch?.plans || [];
      if (batchPlans.length && !batchPlans.some((plan) => String(plan.id) === String(planId))) {
        action.disabled = false;
        state.builder.error = "";
        handlers.renderBuilder();
        return true;
      }
      setBuilderDraft(await queuedBuilderApi(`/api/builder/plans/${encodeURIComponent(planId)}`));
      state.builder.error = "";
      state.builder.selectedSessionId = "";
      state.builder.selectedNodeId = "";
      state.builder.exerciseQuery = "";
      await handlers.loadBuilderExercises();
    } catch (error) {
      action.disabled = false;
      if (isNotFoundError(error)) {
        forgetBatchPlan(planId);
        state.builder.error = "That athlete copy is no longer available in this group.";
        handlers.renderBuilder();
        return true;
      }
      throw error;
    }
    return true;
  }
  return false;
}

export async function handleBuilderWorkspaceAction(action, handlers) {
  const type = action.dataset.action;
  if (type === "builder-toggle-batch-sync") {
    state.builder.batchSync = Boolean(action.checked);
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-choose-entry-type") {
    const entryType = action.dataset.entryType;
    state.builder.entryType = entryType;
    state.builder.planType = entryType === "weekly" ? "weekly" : "program";
    state.builder.weekStart ||= weekMondayIso(localDateIso());
    // Program tile nudges straight into picking an athlete (a Specific Program
    // is meant to be assigned); Template tile leaves the picker closed so it
    // defaults to a reusable, unassigned template - same default as today.
    state.builder.athletePickerOpen = entryType === "program";
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-entry-back") {
    state.builder.entryType = "";
    state.builder.athletePickerOpen = false;
    state.builder.createName = "";
    state.builder.createColor = "#C2F0E6";
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-open-info") {
    state.builder.infoOpen = action.dataset.info || "session";
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-close-info") {
    state.builder.infoOpen = "";
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-toggle-session-quick-add") {
    const blockId = action.dataset.blockId || "";
    state.builder.sessionQuickAdd = state.builder.sessionQuickAdd.blockId === blockId
      ? { blockId: "", amPm: "", bta: "", time: "" }
      : { blockId, amPm: "", bta: "", time: "" };
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-pick-session-am-pm") {
    const value = action.dataset.value || "";
    state.builder.sessionQuickAdd.amPm = state.builder.sessionQuickAdd.amPm === value ? "" : value;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-pick-session-bta") {
    const value = action.dataset.value || "";
    state.builder.sessionQuickAdd.bta = state.builder.sessionQuickAdd.bta === value ? "" : value;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-quick-add-session") {
    const blockId = action.dataset.blockId || "";
    const { amPm, bta, time } = state.builder.sessionQuickAdd;
    const payload = withBatchSyncPayload({ amPm, bta, time });
    const draft = setBuilderDraft(await queuedBuilderApi(`/api/builder/blocks/${encodeURIComponent(blockId)}/sessions`, { method: "POST", body: JSON.stringify(payload) }));
    const updatedBlock = draft?.blocks.find((block) => block.id === blockId);
    state.builder.selectedSessionId = updatedBlock?.sessions.at(-1)?.id || state.builder.selectedSessionId;
    state.builder.selectedNodeId = "";
    state.builder.sessionQuickAdd = { blockId: "", amPm: "", bta: "", time: "" };
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-close-structure-modal") {
    state.builder.structureModalOpen = false;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-open-custom-exercise") {
    const doseInputs = document.querySelectorAll("[data-builder-new-dose]");
    const dose = { sets: "", reps: "", load: "" };
    doseInputs.forEach((input) => {
      if (input.name in dose) dose[input.name] = input.value;
    });
    state.builder.customExerciseDose = dose;
    state.builder.customExerciseOpen = true;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-close-custom-exercise") {
    state.builder.customExerciseOpen = false;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-copy-node") {
    const node = findBuilderNode(state.builder.draft, action.dataset.nodeId || state.builder.selectedNodeId);
    if (!node) return true;
    state.builder.clipboard = { type: node.type, nodeId: node.id, name: node.name, itemCount: node.items.length };
    state.builder.selectedNodeId = "";
    state.builder.customExerciseOpen = false;
    state.builder.sectionPickerOpen = false;
    state.builder.structureModalOpen = false;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-clear-clipboard") {
    state.builder.clipboard = null;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-paste-node") {
    const clipboard = state.builder.clipboard;
    if (!clipboard) return true;
    action.disabled = true;
    try {
      setBuilderDraft(await queuedBuilderApi(`/api/builder/nodes/${encodeURIComponent(clipboard.nodeId)}/copy`, {
        method: "POST",
        body: JSON.stringify(withBatchSyncPayload({ targetSessionId: action.dataset.sessionId, targetParentId: action.dataset.parentId || "" })),
      }));
      state.builder.selectedSessionId = action.dataset.sessionId || "";
      state.builder.selectedNodeId = "";
      handlers.renderBuilder();
    } catch (error) {
      action.disabled = false;
      throw error;
    }
    return true;
  }
  if (type === "builder-move-node") {
    action.disabled = true;
    try {
      setBuilderDraft(await queuedBuilderApi(`/api/builder/nodes/${encodeURIComponent(action.dataset.nodeId || "")}/move`, {
        method: "POST",
        body: JSON.stringify(withBatchSyncPayload({ direction: action.dataset.direction || "" })),
      }));
      handlers.renderBuilder();
    } catch (error) {
      action.disabled = false;
      throw error;
    }
    return true;
  }
  if (type === "builder-finish-section") {
    // Everything in the section editor already autosaves through its own
    // PATCH/POST calls the moment it changes - there is nothing to roll
    // back here, so this is the single real "I'm done" action regardless
    // of which mobile control (header close icon, sticky-bar Done,
    // backdrop, Escape) triggered it. See the header comment in
    // builder-section.js for why the mobile header no longer shows a
    // separate "Cancel" that implied otherwise.
    state.builder.selectedNodeId = "";
    state.builder.customExerciseOpen = false;
    state.builder.mobileMode = "add";
    state.builder.editItemId = "";
    state.builder.editItemInstructionOpen = false;
    state.builder.addConfirmation = null;
    state.builder.lastAddedItemId = "";
    clearTimeout(addConfirmationTimer);
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-toggle-note") {
    state.builder.showNote = !state.builder.showNote;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-open-athlete-picker") {
    state.builder.athletePickerOpen = true;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-close-athlete-picker") {
    state.builder.athletePickerOpen = false;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-select-athlete") {
    const athleteId = action.dataset.athleteId || "";
    if (!athleteId) {
      state.builder.createAthleteIds = [];
      state.builder.createAthleteId = "";
    } else {
      const current = new Set((state.builder.createAthleteIds || []).map(String));
      if (current.has(String(athleteId))) current.delete(String(athleteId));
      else current.add(String(athleteId));
      state.builder.createAthleteIds = [...current];
      state.builder.createAthleteId = state.builder.createAthleteIds[0] || "";
    }
    renderBuilderPreservingAthleteListScroll(handlers);
    return true;
  }
  if (type === "builder-toggle-select-all-athletes") {
    const athleteIds = (state.athletes || []).map((athlete) => String(athlete.athlete_id)).filter(Boolean);
    const selectedIds = new Set((state.builder.createAthleteIds || []).map(String));
    const allSelected = athleteIds.length > 0 && athleteIds.every((id) => selectedIds.has(id));
    state.builder.createAthleteIds = allSelected ? [] : athleteIds;
    state.builder.createAthleteId = state.builder.createAthleteIds[0] || "";
    renderBuilderPreservingAthleteListScroll(handlers);
    return true;
  }
  if (type === "builder-confirm-athlete-picker") {
    state.builder.athletePickerOpen = false;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-open-section-panel") {
    state.builder.sectionPickerOpen = true;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-close-section-panel") {
    state.builder.sectionPickerOpen = false;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-start-inline-add") {
    state.builder.inlineAddSessionId = action.dataset.sessionId || "";
    state.builder.inlineAddParentId = action.dataset.parentId || "";
    state.builder.inlineAddType = action.dataset.nodeType || "domain";
    state.builder.inlineAddOpen = true;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-cancel-inline-add") {
    state.builder.inlineAddOpen = false;
    state.builder.inlineAddType = "";
    state.builder.inlineAddSessionId = "";
    state.builder.inlineAddParentId = "";
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-toggle-add-block") {
    state.builder.blockAddOpen = !state.builder.blockAddOpen;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-copy-block") {
    const blockId = action.dataset.blockId || "";
    const block = (state.builder.draft?.blocks || []).find((candidate) => candidate.id === blockId);
    if (!block) return true;
    state.builder.clipboard = { type: "block", blockId: block.id, name: block.name || `Block ${block.index}` };
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-paste-block") {
    const clipboard = state.builder.clipboard;
    if (!clipboard || clipboard.type !== "block") return true;
    action.disabled = true;
    try {
      setBuilderDraft(await queuedBuilderApi(`/api/builder/blocks/${encodeURIComponent(clipboard.blockId)}/copy`, { method: "POST" }));
      state.builder.blockAddOpen = false;
      handlers.renderBuilder();
    } catch (error) {
      action.disabled = false;
      handlers.renderBuilderError(error);
    }
    return true;
  }
  if (type === "builder-copy-day") {
    const dayId = action.dataset.dayId || "";
    const block = (state.builder.draft?.blocks || []).find((candidate) => candidate.id === dayId);
    if (!block) return true;
    state.builder.clipboard = { type: "day", dayId: block.id, name: block.name || block.date || "Day" };
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-paste-day") {
    const clipboard = state.builder.clipboard;
    if (!clipboard || (clipboard.type !== "day" && clipboard.type !== "cross-plan-block")) return true;
    const source = clipboard.type === "day" ? { type: "day", id: clipboard.dayId } : { type: "cross-plan-block", id: clipboard.blockId };
    const targetDayId = action.dataset.dayId || "";
    if (!targetDayId || (source.type === "day" && targetDayId === source.id)) return true;
    action.disabled = true;
    try {
      setBuilderDraft(await requestDayPaste(source, targetDayId, false));
      handlers.renderBuilder();
    } catch (error) {
      action.disabled = false;
      // 409 means the target day already has content - hand off to the
      // styled overwrite-confirm dialog (same pattern as messages.js's
      // hideConfirmOpen) instead of surfacing this as a plain error.
      if (error?.status === 409) {
        state.builder.overwriteDayConfirm = { sourceType: source.type, sourceId: source.id, targetDayId };
        handlers.renderBuilder();
        return true;
      }
      handlers.renderBuilderError(error);
    }
    return true;
  }
  if (type === "builder-overwrite-day-cancel") {
    state.builder.overwriteDayConfirm = null;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-overwrite-day-confirm") {
    const pending = state.builder.overwriteDayConfirm;
    state.builder.overwriteDayConfirm = null;
    if (!pending) {
      handlers.renderBuilder();
      return true;
    }
    action.disabled = true;
    try {
      setBuilderDraft(await requestDayPaste({ type: pending.sourceType, id: pending.sourceId }, pending.targetDayId, true));
      handlers.renderBuilder();
    } catch (error) {
      action.disabled = false;
      handlers.renderBuilderError(error);
    }
    return true;
  }
  if (type === "builder-open-block-picker") {
    state.builder.blockPicker = emptyBlockPicker({ open: true });
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-close-block-picker") {
    state.builder.blockPicker = emptyBlockPicker();
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-block-picker-back-to-source") {
    state.builder.blockPicker = emptyBlockPicker({ open: true });
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-block-picker-back-to-athletes") {
    state.builder.blockPicker = { ...state.builder.blockPicker, athleteId: "", athletePlans: [], planId: "", planName: "", blocks: [], error: "" };
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-block-picker-back-to-plans") {
    state.builder.blockPicker = { ...state.builder.blockPicker, planId: "", planName: "", blocks: [], error: "" };
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-block-picker-choose-source-type") {
    const sourceType = action.dataset.sourceType || "";
    state.builder.blockPicker = { ...state.builder.blockPicker, sourceType, error: "" };
    if (sourceType === "template") {
      state.builder.blockPicker.templatesLoading = true;
      handlers.renderBuilder();
      try {
        const result = await api("/api/templates?scope=my_programs");
        state.builder.blockPicker.templates = result.templates || [];
      } catch (error) {
        state.builder.blockPicker.error = error.message || "Could not load templates.";
      }
      state.builder.blockPicker.templatesLoading = false;
    }
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-block-picker-choose-athlete") {
    const athleteId = action.dataset.athleteId || "";
    if (!athleteId) return true;
    state.builder.blockPicker = { ...state.builder.blockPicker, athleteId, athletePlansLoading: true, error: "" };
    handlers.renderBuilder();
    try {
      const result = await api(`/api/athletes/${encodeURIComponent(athleteId)}/plans`);
      state.builder.blockPicker.athletePlans = (result.plans || []).filter((plan) => plan.plan_type === "program" && !plan.is_template);
    } catch (error) {
      state.builder.blockPicker.error = error.message || "Could not load this athlete's programs.";
    }
    state.builder.blockPicker.athletePlansLoading = false;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-block-picker-choose-plan") {
    const planId = action.dataset.planId || "";
    const planName = action.dataset.planName || "";
    if (!planId) return true;
    state.builder.blockPicker = { ...state.builder.blockPicker, planId, planName, blocksLoading: true, error: "" };
    handlers.renderBuilder();
    try {
      const result = await api(`/api/builder/plans/${encodeURIComponent(planId)}/blocks`);
      state.builder.blockPicker.blocks = result.blocks || [];
    } catch (error) {
      state.builder.blockPicker.error = error.message || "Could not load this plan's blocks.";
    }
    state.builder.blockPicker.blocksLoading = false;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-block-picker-choose-block") {
    const blockId = action.dataset.blockId || "";
    const blockName = action.dataset.blockName || "Block";
    if (!blockId) return true;
    state.builder.clipboard = { type: "cross-plan-block", sourcePlanId: state.builder.blockPicker.planId, blockId, name: blockName };
    state.builder.blockPicker = emptyBlockPicker();
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-toggle-section-preview") {
    const nodeId = action.dataset.nodeId || "";
    state.builder.previewSectionId = state.builder.previewSectionId === nodeId ? "" : nodeId;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-toggle-node-edit") {
    const nodeId = action.dataset.nodeId || "";
    state.builder.editNodeOpen = state.builder.editNodeOpen === nodeId ? "" : nodeId;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-select-session") {
    state.builder.selectedSessionId = action.dataset.sessionId || "";
    state.builder.selectedNodeId = "";
    state.builder.sectionPickerOpen = false;
    state.builder.addNodeOpen = false;
    state.builder.structureModalOpen = false;
    state.builder.inlineAddOpen = false;
    state.builder.inlineAddType = "";
    state.builder.inlineAddSessionId = "";
    state.builder.inlineAddParentId = "";
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-select-node") {
    state.builder.selectedSessionId = action.dataset.sessionId || "";
    state.builder.selectedNodeId = action.dataset.nodeId || "";
    state.builder.sectionPickerOpen = findBuilderNode(state.builder.draft, state.builder.selectedNodeId)?.type === "section";
    state.builder.addNodeOpen = true;
    state.builder.structureModalOpen = !state.builder.sectionPickerOpen;
    state.builder.inlineAddOpen = false;
    state.builder.inlineAddType = "";
    state.builder.inlineAddSessionId = "";
    state.builder.inlineAddParentId = "";
    // Every fresh entry into a (possibly different) section starts in
    // Add-exercises mode with no stale edit-item/confirmation carried over
    // from whatever was open before.
    state.builder.mobileMode = "add";
    state.builder.editItemId = "";
    state.builder.editItemInstructionOpen = false;
    state.builder.addConfirmation = null;
    state.builder.lastAddedItemId = "";
    clearTimeout(addConfirmationTimer);
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-set-mobile-mode") {
    const mode = action.dataset.mode === "added" ? "added" : "add";
    state.builder.mobileMode = mode;
    if (mode === "add") {
      state.builder.editItemId = "";
      state.builder.editItemInstructionOpen = false;
    }
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-edit-now") {
    state.builder.mobileMode = "added";
    state.builder.editItemId = state.builder.lastAddedItemId;
    state.builder.editItemInstructionOpen = false;
    state.builder.addConfirmation = null;
    clearTimeout(addConfirmationTimer);
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-open-edit-item") {
    state.builder.mobileMode = "added";
    state.builder.editItemId = action.dataset.itemId || "";
    state.builder.editItemInstructionOpen = false;
    if (!handlers.renderBuilderSectionItems?.()) handlers.renderBuilder();
    return true;
  }
  if (type === "builder-close-edit-item") {
    state.builder.editItemId = "";
    state.builder.editItemInstructionOpen = false;
    if (!handlers.renderBuilderSectionItems?.()) handlers.renderBuilder();
    return true;
  }
  if (type === "builder-edit-item-nav") {
    const node = findBuilderNode(state.builder.draft, state.builder.selectedNodeId);
    const currentIndex = node?.items.findIndex((item) => item.id === state.builder.editItemId) ?? -1;
    const targetIndex = currentIndex + (action.dataset.direction === "next" ? 1 : -1);
    if (!node || currentIndex < 0 || targetIndex < 0 || targetIndex >= node.items.length) return true;
    state.builder.editItemId = node.items[targetIndex].id;
    state.builder.editItemInstructionOpen = false;
    if (!handlers.renderBuilderSectionItems?.()) handlers.renderBuilder();
    return true;
  }
  if (type === "builder-toggle-item-instruction") {
    state.builder.editItemInstructionOpen = !state.builder.editItemInstructionOpen;
    if (!handlers.renderBuilderSectionItems?.()) handlers.renderBuilder();
    return true;
  }
  return false;
}

export async function handleBuilderDraftAction(action, handlers) {
  const type = action.dataset.action;
  if (type === "builder-submit-plan") {
    const draft = state.builder.draft;
    if (!draft) return true;
    // action.disabled = true happens synchronously, before any await - a
    // real <button> refuses further clicks once disabled, so a rapid
    // double-click can never fire a second, parallel submit for the same
    // draft (matches the same guard already used for Add above). The
    // "Saving…" label change is the visible confirmation of that state -
    // Builder itself never closes/navigates away until the request settles,
    // whether the button label changed or not, but a coach staring at an
    // unchanged "Save and finish" button after clicking it has no way to
    // tell a slow save from a swallowed click.
    if (action.disabled) return true;
    action.disabled = true;
    const originalLabel = action.textContent;
    action.textContent = "Saving…";
    try {
      const currentDraft = state.builder.draft || draft;
      const result = await api(`/api/builder/plans/${encodeURIComponent(currentDraft.plan.id)}/submit`, {
        method: "POST",
        body: JSON.stringify(withBatchSyncPayload({})),
      });
      // This plan has left 'draft' status either way - the cached drafts
      // list (see loadBuilderDrafts) must never keep showing it once the
      // user next lands on that empty-state picker.
      invalidateBuilderDraftsCache();
      if (result?.deleted && result?.empty) {
        await exitBuilderToPlanContext(draft.plan, handlers);
        return true;
      }
      setBuilderDraft(result);
      handlers.renderBuilder();
    } catch (error) {
      // A failed save must not look like a success (no navigation, no
      // "Saved" state) and must not lose the coach's local edits -
      // state.builder.draft is never touched on this path (setBuilderDraft
      // is only reached after a successful response above), so whatever the
      // coach had open is exactly as they left it; restoring the button
      // (same pattern as the Add-exercise error path above) makes a retry
      // available immediately instead of leaving it stuck on "Saving…".
      action.disabled = false;
      action.textContent = originalLabel;
      handlers.renderBuilderError(error);
    }
    return true;
  }
  if (type === "builder-cancel") {
    const plan = state.builder.draft?.plan;
    if (plan?.isEditDraft) {
      if (!window.confirm("Discard these changes and keep the original unchanged?")) return true;
      await api(`/api/builder/plans/${encodeURIComponent(plan.id)}`, { method: "DELETE" });
    }
    await exitBuilderToPlanContext(plan, handlers);
    return true;
  }
  if (type === "builder-delete-source-plan") {
    const planId = action.dataset.planId || "";
    const objectLabel = action.dataset.objectLabel || "program";
    if (!planId || !window.confirm(`Delete this ${objectLabel} and all of its contents? This cannot be undone.`)) return true;
    action.disabled = true;
    await api(`/api/builder/plans/${encodeURIComponent(planId)}`, { method: "DELETE" });
    if (state.activeTab === "weekly") {
      state.weekSelectorOpen = false;
      // Just deleted this plan - the cached Calendar payload for this
      // athlete must never keep showing it.
      await handlers.loadWeekly({ forceRefresh: true });
      // Home's "today" overview rolls up exactly this data across every
      // athlete - invalidate so the next visit reflects the deletion,
      // whether or not Home happens to be the active tab right now.
      invalidateCoachHomeCache();
      // Same reasoning, for the athlete-facing Home rollup.
      invalidateAthleteHomeCache();
    } else if (state.activeTab === "programs") {
      state.selectedProgramId = null;
      // Just deleted this plan - the cached specific-programs payload for
      // this athlete must never keep showing it.
      await handlers.loadPrograms({ forceRefresh: true });
      // Athlete Home's "active specific programs" section rolls up exactly
      // this same per-athlete program list.
      invalidateAthleteHomeCache();
    } else {
      state.selectedTemplateId = null;
      // Just deleted this plan - the cached list must never keep showing it.
      await handlers.loadTemplates({ forceRefresh: true });
    }
    return true;
  }
  const deleteTargets = {
    "builder-delete-plan": ["draft program", `/api/builder/plans/${encodeURIComponent(state.builder.draft?.plan.id || "")}`],
    "builder-delete-block": ["block and its contents", `/api/builder/blocks/${encodeURIComponent(action.dataset.blockId || "")}`],
    "builder-delete-session": ["session and its contents", `/api/builder/sessions/${encodeURIComponent(action.dataset.sessionId || "")}`],
    "builder-delete-node": ["selected node and its contents", `/api/builder/nodes/${encodeURIComponent(action.dataset.nodeId || "")}`],
  };
  if (deleteTargets[type]) {
    const [label, url] = deleteTargets[type];
    if (!window.confirm(`Delete this ${label}? This cannot be undone.`)) return true;
    const result = await api(type === "builder-delete-plan" ? url : withBatchSyncUrl(url), { method: "DELETE" });
    if (type === "builder-delete-plan") {
      // The just-deleted plan may well have been the one showing in the
      // cached drafts list (unless it was an is_edit_draft row, already
      // excluded from that list server-side) - invalidate unconditionally
      // rather than re-deriving which case this was, so the next re-entry
      // into the empty-state picker can never show a plan that's gone.
      invalidateBuilderDraftsCache();
      state.builder = emptyBuilderState();
      handlers.renderBuilder();
      return true;
    }
    state.builder.selectedNodeId = "";
    state.builder.selectedSessionId = "";
    // DELETE /blocks|sessions|nodes/:id already responds with the fresh
    // draft (respondWithDraft on the backend) - using it directly instead
    // of discarding it and firing a separate refreshBuilderDraft() GET for
    // the exact same plan removes a redundant round-trip on every delete.
    setBuilderDraft(result);
    handlers.renderBuilder();
    return true;
  }
  return false;
}

export async function handleBuilderItemAction(action, handlers) {
  const type = action.dataset.action;
  if (type === "builder-pick-exercise") {
    // A single tap must always send exactly one POST, right now - no CSS
    // reflow, focus change, or re-render happens before this fires (see the
    // removed :has(.builder-section-library:focus-within) rules in
    // styles.css). `action.disabled = true` below happens synchronously,
    // before any await - a real <button> refuses further clicks once
    // disabled, so a rapid duplicate tap on the SAME button during this
    // request can never send a second POST; a separate, deliberate tap
    // after this one finishes (button re-enabled again via the results-
    // list re-render) is a normal, allowed second add.
    if (action.disabled) return true;
    const section = findBuilderNode(state.builder.draft, state.builder.selectedNodeId);
    const panel = action.closest(".builder-section-panel");
    const doseInput = (name) => panel?.querySelector(`[data-builder-new-dose][name="${name}"]`);
    if (!section || section.type !== "section") return true;
    action.disabled = true;
    const originalLabel = action.textContent;
    action.textContent = "Adding…";
    try {
      setBuilderDraft(await queuedBuilderApi(`/api/builder/nodes/${encodeURIComponent(section.id)}/exercises`, {
        method: "POST",
        body: JSON.stringify(withBatchSyncPayload({
          exerciseId: action.dataset.exerciseId || "",
          sets: doseInput("sets")?.value || "",
          reps: doseInput("reps")?.value || "",
          load: doseInput("load")?.value || "",
        })),
      }));
      handlersForConfirmationTimeout = handlers;
      markExerciseJustAdded(section.id);
      // Deliberately NOT renderBuilder() (full re-render) here - that would
      // recreate the search input's DOM node and silently drop keyboard
      // focus. renderBuilderAddFeedback only ever touches the results list,
      // sticky bar, and confirmation banner - all outside the library's
      // search/filters/quick-dose subtree - so the coach can add several
      // exercises in a row without the keyboard closing or losing their
      // place. Falls back to a full render only if the section editor
      // somehow isn't open (shouldn't normally happen).
      if (!handlers.renderBuilderAddFeedback?.()) handlers.renderBuilder();
    } catch (error) {
      action.disabled = false;
      action.textContent = originalLabel;
      handlers.renderBuilderError(error);
    }
    return true;
  }
  if (type === "builder-move-item") {
    const node = findBuilderNode(state.builder.draft, state.builder.selectedNodeId);
    const currentIndex = node?.items.findIndex((item) => item.id === action.dataset.itemId) ?? -1;
    const targetIndex = currentIndex + (action.dataset.direction === "up" ? -1 : 1);
    if (!node || currentIndex < 0 || targetIndex < 0 || targetIndex >= node.items.length) return true;
    [node.items[currentIndex], node.items[targetIndex]] = [node.items[targetIndex], node.items[currentIndex]];
    if (!handlers.renderBuilderSectionItems?.()) handlers.renderBuilder();
    try {
      setBuilderDraft(await queuedBuilderApi(`/api/builder/items/${encodeURIComponent(action.dataset.itemId)}/move`, {
        method: "POST",
        body: JSON.stringify(withBatchSyncPayload({ direction: action.dataset.direction })),
      }));
      if (!handlers.renderBuilderSectionItems?.()) handlers.renderBuilder();
    } catch (error) {
      await handlers.refreshBuilderDraft();
      throw error;
    }
    return true;
  }
  if (type === "builder-delete-item") {
    if (!window.confirm("Remove this exercise from the program?")) return true;
    const result = await api(withBatchSyncUrl(`/api/builder/items/${encodeURIComponent(action.dataset.itemId)}`), { method: "DELETE" });
    // Removing exactly one duplicate/item must never disturb any other item
    // (independent sets/reps/load/instruction, independent order) - if the
    // just-removed item was open in the single-item edit view, fall back to
    // the list rather than rendering a stale edit form for an id that no
    // longer exists.
    if (state.builder.editItemId === action.dataset.itemId) {
      state.builder.editItemId = "";
      state.builder.editItemInstructionOpen = false;
    }
    if (state.builder.lastAddedItemId === action.dataset.itemId) state.builder.lastAddedItemId = "";
    if (state.builder.addConfirmation?.itemId === action.dataset.itemId) state.builder.addConfirmation = null;
    // DELETE /items/:id already responds with the fresh draft - see the
    // matching comment on the block/session/node delete branch above.
    setBuilderDraft(result);
    if (!handlers.renderBuilderSectionItems?.()) handlers.renderBuilder();
    return true;
  }
  return false;
}

export async function submitBuilderForm(form, handlers) {
  const mode = form.dataset.builderForm;
  const data = Object.fromEntries(new FormData(form));
  const draft = state.builder.draft;
  if (mode === "create") {
    const athleteIds = state.builder.createAthleteIds?.length
      ? state.builder.createAthleteIds
      : (data.athleteId ? [data.athleteId] : []);
    data.athleteIds = athleteIds;
    data.athleteId = athleteIds[0] || "";
    const created = await api("/api/builder/plans", { method: "POST", body: JSON.stringify(data) });
    // A brand new draft now exists - the cached drafts list (shown again
    // whenever this account next has no draft open) must never be missing
    // it just because it happened to be cached before this create.
    invalidateBuilderDraftsCache();
    setBuilderDraft(created, { preserveBatch: false });
    state.builder.selectedSessionId = "";
    state.builder.selectedNodeId = "";
    state.builder.athletePickerOpen = false;
    state.builder.sectionPickerOpen = false;
    state.builder.createAthleteId = "";
    state.builder.createAthleteIds = [];
    state.builder.planType = "weekly";
    state.builder.weekStart = "";
    state.builder.createName = "";
    state.builder.createColor = "#C2F0E6";
    state.builder.addNodeOpen = false;
    await handlers.loadBuilderExercises();
    return;
  }
  if (!draft) return;
  if (mode === "add-block") {
    setBuilderDraft(await queuedBuilderApi(`/api/builder/plans/${encodeURIComponent(draft.plan.id)}/blocks`, { method: "POST", body: JSON.stringify(withBatchSyncPayload(data)) }));
    state.builder.blockAddOpen = false;
  }
  if (mode === "update-block") {
    setBuilderDraft(await queuedBuilderApi(`/api/builder/blocks/${encodeURIComponent(form.dataset.blockId)}`, { method: "PATCH", body: JSON.stringify(withBatchSyncPayload(data)) }));
  }
  if (mode === "update-plan") {
    setBuilderDraft(await queuedBuilderApi(`/api/builder/plans/${encodeURIComponent(draft.plan.id)}`, { method: "PATCH", body: JSON.stringify(withBatchSyncPayload(data)) }));
  }
  if (mode === "update-node") {
    setBuilderDraft(await queuedBuilderApi(`/api/builder/nodes/${encodeURIComponent(form.dataset.nodeId)}`, { method: "PATCH", body: JSON.stringify(withBatchSyncPayload(data)) }));
  }
  if (mode === "update-session") {
    setBuilderDraft(await queuedBuilderApi(`/api/builder/sessions/${encodeURIComponent(form.dataset.sessionId)}`, { method: "PATCH", body: JSON.stringify(withBatchSyncPayload(data)) }));
  }
  if (mode === "add-node") {
    setBuilderDraft(await queuedBuilderApi(`/api/builder/sessions/${encodeURIComponent(form.dataset.sessionId)}/nodes`, { method: "POST", body: JSON.stringify(withBatchSyncPayload(data)) }));
    const session = findBuilderSession(state.builder.draft, form.dataset.sessionId);
    const added = session?.nodes.at(-1);
    state.builder.selectedSessionId = form.dataset.sessionId;
    state.builder.selectedNodeId = added?.id || "";
    state.builder.inlineAddOpen = false;
    state.builder.inlineAddType = "";
    state.builder.inlineAddSessionId = "";
    state.builder.inlineAddParentId = "";
  }
  if (mode === "add-exercise") {
    if (!data.exerciseId) return;
    setBuilderDraft(await queuedBuilderApi(`/api/builder/nodes/${encodeURIComponent(form.dataset.nodeId)}/exercises`, { method: "POST", body: JSON.stringify(withBatchSyncPayload(data)) }));
    handlersForConfirmationTimeout = handlers;
    markExerciseJustAdded(form.dataset.nodeId);
  }
  if (mode === "add-custom-exercise") {
    setBuilderDraft(await queuedBuilderApi(`/api/builder/nodes/${encodeURIComponent(form.dataset.nodeId)}/custom-exercise`, { method: "POST", body: JSON.stringify(withBatchSyncPayload(data)) }));
    state.builder.customExerciseOpen = false;
    handlersForConfirmationTimeout = handlers;
    markExerciseJustAdded(form.dataset.nodeId);
  }
  if (mode === "update-item") {
    setBuilderDraft(await queuedBuilderApi(`/api/builder/items/${encodeURIComponent(form.dataset.itemId)}`, { method: "PATCH", body: JSON.stringify(withBatchSyncPayload(data)) }));
    if (handlers.renderBuilderSectionItems?.()) return;
  }
  handlers.renderBuilder();
}
