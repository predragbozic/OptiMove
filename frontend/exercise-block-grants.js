import { api } from "./api.js";
import { openModalShell } from "./modal-shell.js";
import { escapeAttr, escapeHtml } from "./utils.js";

// The administrator's grant of application blocks to several accounts at
// once (Settings -> Users, the selection): grant access to, or take it away
// from, every selected account for the chosen blocks - all or none.
export const USER_SELECTION_LIMIT = 100;
// A change whose answer never comes is "not confirmed" after this long.
export const GRANT_CLIENT_BOUND_MS = 45000;

const noun = (count, one, many) => (count === 1 ? one : many);

// Every coded refusal is a whole refusal: the server changes all or nothing.
const changeMessages = {
  blockNotAvailable: "Nothing was changed: a chosen block no longer exists. Check again to choose again.",
  invalidSelection: "Nothing was changed: some of these accounts can no longer receive blocks. Check again.",
  tryAgain: "Nothing was changed: the blocks are being changed right now. Try again in a moment.",
  notFound: "Nothing was changed: you no longer have permission to manage application blocks.",
  invalidBody: "Nothing was changed: this selection could not be sent. Close and select again.",
};
const readMessages = {
  notFound: "You no longer have permission to manage application blocks.",
  invalidBody: "This selection could not be read. Close and select again.",
};
// Never "nothing was changed": a late COMMIT may still land.
const NOT_CONFIRMED = "The change was not confirmed. Check again to see what is saved before you try again.";
const CHECKED = "Checked just now. Review what each account has and press the button again.";

// The accounts a change applies to: granting needs coach access, taking
// away only an existing account.
function participants(model) {
  const users = model.data?.users || [];
  return model.mode === "add" ? users.filter((user) => user.eligible) : users;
}

function grantedCount(model, blockId) {
  return participants(model).filter((user) => (user.grants || []).some((grant) => grant.id === blockId)).length;
}

function accessSentence(mode) {
  return mode === "add"
    ? "Granted accounts can use the exercises of these blocks from now on. A block open to all users is available to every coach anyway."
    : "The accounts can no longer use the exercises of these blocks, unless a block is open to all users. Their personal copies are hidden, not deleted.";
}

export function renderBlockGrantsHtml(model) {
  const closing = model.result || model.denied;
  // The heading follows the action, so Remove is never done under "Grant".
  const head = `<div class="builder-modal-head"><h3>${model.mode === "remove" ? "Remove blocks" : "Grant blocks"}</h3><button class="plain-button" type="button" data-grants-close ${model.busy ? "disabled" : ""}>${closing ? "Close" : "Cancel"}</button></div>`;
  if (model.loading) return `${head}<p role="status">Reading the selected accounts...</p>`;
  if (model.loadError) return `${head}<p role="alert">${escapeHtml(model.loadError)}</p>
    ${model.denied ? "" : '<div class="builder-modal-actions"><button class="plain-button" type="button" data-grants-check>Check again</button></div>'}`;
  if (model.result) return `${head}<p role="status">${escapeHtml(model.result)}</p>`;
  if (model.denied) return `${head}<p role="alert">${escapeHtml(model.error)}</p>`;
  const users = model.data.users || [];
  const who = participants(model);
  const leftOut = users.filter((user) => !user.eligible);
  const missing = model.requested - users.length;
  const locked = model.busy || model.uncertain;
  const chosen = (model.data.blocks || []).filter((block) => model.chosen.has(block.id));
  const verb = model.mode === "add" ? "Grant" : "Remove";
  const label = model.busy ? "Saving..."
    : !chosen.length || !who.length ? `${verb} blocks`
      : `${verb} ${chosen.length} ${noun(chosen.length, "block", "blocks")} ${model.mode === "add" ? "to" : "from"} ${who.length} ${noun(who.length, "account", "accounts")}`;
  // At most five names in the sentence; the rest as a count.
  const names = `${who.slice(0, 5).map((user) => escapeHtml(user.name)).join(", ")}${who.length > 5 ? ` and ${who.length - 5} more` : ""}`;
  const participantsSentence = model.mode === "add"
    ? who.length ? `${who.length} selected ${noun(who.length, "account", "accounts")} can receive blocks: ${names}.` : "None of the selected accounts can receive blocks now."
    : who.length ? `${who.length} selected ${noun(who.length, "account", "accounts")}: ${names}.` : "None of the selected accounts exists any more.";
  const leftOutSentence = !leftOut.length ? ""
    : model.mode === "add" ? `Left out (no coach access or login disabled): ${leftOut.map((user) => escapeHtml(user.name)).join(", ")}.`
      : `${leftOut.map((user) => escapeHtml(user.name)).join(", ")} ${noun(leftOut.length, "has", "have")} no coach access; a block can still be removed.`;
  return `${head}
    <p>${participantsSentence}</p>
    ${leftOutSentence ? `<p class="muted">${leftOutSentence}</p>` : ""}
    ${missing > 0 ? `<p class="muted">${missing} selected ${noun(missing, "account no longer exists and is", "accounts no longer exist and are")} left out.</p>` : ""}
    <fieldset class="exercise-block-grants-fieldset" ${locked ? "disabled" : ""}><legend>Action</legend><div class="exercise-block-grants-mode">
      <label><input type="radio" name="grants-mode" value="add" data-grants-mode ${model.mode === "add" ? "checked" : ""}> Grant access</label>
      <label><input type="radio" name="grants-mode" value="remove" data-grants-mode ${model.mode === "remove" ? "checked" : ""}> Remove access</label>
    </div></fieldset>
    <fieldset class="exercise-block-grants-fieldset" ${locked ? "disabled" : ""}><legend>Blocks</legend><div class="exercise-block-grants-list">
      ${(model.data.blocks || []).length ? (model.data.blocks || []).map((block) => {
        const have = grantedCount(model, block.id);
        return `<label><input type="checkbox" data-grants-block="${escapeAttr(block.id)}" ${model.chosen.has(block.id) ? "checked" : ""}>
          <span>${escapeHtml(block.name)} <small>— ${block.accessAll ? "open to all" : "selected users"} · ${block.exerciseCount} ${noun(block.exerciseCount, "exercise", "exercises")}${block.accessAll ? " · every coach can use it already" : who.length ? ` · ${have} of ${who.length} ${have === 1 ? "has" : "have"} it` : ""}</small></span></label>`;
      }).join("") : '<p class="muted">There are no application blocks yet.</p>'}
    </div></fieldset>
    <p id="exercise-block-grants-access">${escapeHtml(accessSentence(model.mode))}</p>
    ${model.checked ? `<p role="status">${escapeHtml(CHECKED)}</p>` : ""}
    ${model.error ? `<p role="alert">${escapeHtml(model.error)}</p>` : ""}
    <div class="builder-modal-actions">
      ${model.uncertain ? `<button class="plain-button" type="button" data-grants-check ${model.busy ? "disabled" : ""}>Check again</button>` : ""}
      <button class="plain-button" type="button" data-grants-submit aria-describedby="exercise-block-grants-access" ${locked || !chosen.length || !who.length ? "disabled" : ""}>${escapeHtml(label)}</button>
    </div>`;
}

// `userIds`: the selected account ids (at most USER_SELECTION_LIMIT).
// `onSaved()`: called once a change is known to be saved. Returns the overlay.
export function openExerciseBlockGrants(userIds, { onSaved = async () => {} } = {}) {
  const model = { requested: userIds.length, data: null, loading: true, loadError: "", mode: "add", chosen: new Set(),
    busy: false, error: "", result: "", uncertain: false, checked: false, denied: false };
  const { overlay, dialog, close: requestClose } = openModalShell({
    overlayClass: "exercise-bulk-move-overlay exercise-block-grants-overlay", dialogClass: "exercise-bulk-move-modal exercise-block-grants-modal",
    label: "Block access", closeLabel: "Close block access",
    canClose: () => !model.busy,
    onClosed: () => (document.querySelector('[data-action="organization-user-grant-blocks-open"]:not(:disabled)') || document.querySelector("[data-user-selection-count]"))?.focus(),
  });
  // Drawn again whole; the block list's and the dialog's scroll come back.
  const render = () => {
    if (!overlay.isConnected) return;
    const scrolled = [dialog.scrollTop, dialog.querySelector(".exercise-block-grants-list")?.scrollTop || 0];
    dialog.innerHTML = renderBlockGrantsHtml(model);
    dialog.scrollTop = scrolled[0];
    const list = dialog.querySelector(".exercise-block-grants-list");
    if (list) list.scrollTop = scrolled[1];
  };

  let saved = false;
  async function markSaved(message) {
    model.result = message;
    if (saved) return;
    saved = true;
    try { await onSaved(); } catch {}
  }

  // What the chosen change asks of every participant and block, as the
  // server would answer it: granted for "add", not granted for "remove".
  function asAsked(data) {
    const mode = model.mode;
    const users = mode === "add" ? (data.users || []).filter((user) => user.eligible) : data.users || [];
    return users.length > 0 && users.every((user) => [...model.chosen].every((blockId) => (user.grants || []).some((grant) => grant.id === blockId) === (mode === "add")));
  }

  // Reads what every selected account has now; after an unconfirmed change
  // it also tells whether that change landed.
  let readGeneration = 0;
  async function read() {
    const generation = ++readGeneration;
    const afterUncertain = model.uncertain;
    model.loading = !model.data;
    model.loadError = "";
    model.error = "";
    model.checked = false;
    render();
    try {
      const data = await api(`/api/exercise-collections/user-grants?userIds=${userIds.map(encodeURIComponent).join(",")}`);
      if (generation !== readGeneration) return;
      model.data = data;
      model.uncertain = false;
      const blockIds = new Set((data.blocks || []).map((block) => block.id));
      model.chosen = new Set([...model.chosen].filter((id) => blockIds.has(id)));
      if (afterUncertain && model.chosen.size && asAsked(data)) {
        await markSaved(`The change was saved: every account now ${model.mode === "add" ? "has" : "is without"} the chosen ${noun(model.chosen.size, "block", "blocks")}.`);
      } else if (afterUncertain) model.checked = true;
    } catch (error) {
      if (generation !== readGeneration) return;
      model.denied = error.message === "notFound";
      model.loadError = readMessages[error.message] || "The selected accounts could not be read. Check again.";
    } finally {
      if (generation === readGeneration) {
        model.loading = false;
        render();
        (dialog.querySelector("[data-grants-block]:not(:disabled)") || dialog.querySelector("[data-grants-close]"))?.focus();
      }
    }
  }

  async function submit() {
    const who = participants(model);
    const chosen = [...model.chosen];
    if (!who.length || !chosen.length || model.busy) return;
    model.busy = true;
    model.error = "";
    model.checked = false;
    render();
    const controller = new AbortController();
    const bound = setTimeout(() => controller.abort(), GRANT_CLIENT_BOUND_MS);
    try {
      const body = { userIds: who.map((user) => user.id), [model.mode]: chosen };
      const answer = await api("/api/exercise-collections/user-grants", { method: "PUT", signal: controller.signal, body: JSON.stringify(body) });
      const pairs = model.mode === "add" ? answer.added?.length || 0 : answer.removed?.length || 0;
      const already = answer.unchanged || 0;
      if (answer.changed) {
        await markSaved(model.mode === "add"
          ? `Granted ${chosen.length} ${noun(chosen.length, "block", "blocks")} to ${who.length} ${noun(who.length, "account", "accounts")} (${pairs} new ${noun(pairs, "grant", "grants")}${already ? `, ${already} ${noun(already, "was", "were")} already granted` : ""}). They can use the exercises now.`
          : `Removed ${chosen.length} ${noun(chosen.length, "block", "blocks")} from ${who.length} ${noun(who.length, "account", "accounts")} (${pairs} ${noun(pairs, "grant", "grants")} ended${already ? `, ${already} ${noun(already, "was", "were")} not granted` : ""}).`);
      } else model.result = model.mode === "add" ? "Nothing to change: every account already has the chosen blocks." : "Nothing to change: no account had the chosen blocks.";
    } catch (error) {
      const known = !controller.signal.aborted && changeMessages[error.message];
      model.error = known || NOT_CONFIRMED;
      if (!known) model.uncertain = true;
      else if (error.message === "notFound") model.denied = true;
    } finally {
      clearTimeout(bound);
      model.busy = false;
      render();
      (dialog.querySelector("[data-grants-check]") || dialog.querySelector("[data-grants-close]"))?.focus();
    }
  }

  dialog.addEventListener("change", (event) => {
    event.stopPropagation();
    const target = event.target;
    if (target.hasAttribute("data-grants-mode")) { model.mode = target.value === "remove" ? "remove" : "add"; model.error = ""; model.checked = false; render(); dialog.querySelector(`[data-grants-mode][value="${model.mode}"]`)?.focus({ preventScroll: true }); return; }
    if (!target.hasAttribute("data-grants-block")) return;
    const id = target.dataset.grantsBlock;
    if (target.checked) model.chosen.add(id); else model.chosen.delete(id);
    model.error = "";
    render();
    dialog.querySelector(`[data-grants-block="${id}"]`)?.focus({ preventScroll: true });
  });
  dialog.addEventListener("click", (event) => {
    event.stopPropagation();
    const button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-grants-close")) requestClose();
    else if (button.hasAttribute("data-grants-check")) void read();
    else if (button.hasAttribute("data-grants-submit")) void submit();
  });

  render();
  dialog.querySelector("[data-grants-close]")?.focus();
  void read();
  return overlay;
}
