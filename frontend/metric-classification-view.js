// Training Load -> Data configuration -> Variables -> Domains & categories: the
// markup (phase 12c, J6 3.4). Every text that came from the server or the coach
// is escaped; ids live only in data- attributes and under Technical details.
import {
  CLASS_LIMITS, categoryPlaceable, findNode, nounOf, ownActive, placeableDomains, removablePlacement, removableVariableLink, treeOf,
} from "./metric-classification-data.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const cut = (node) => `${escapeHtml(node?.name || "")}${node?.truncated ? "…" : ""}`;
const KIND_TITLE = { domain: "Domain", category: "Category" };

// The badges after a name: whose it is when it is not this workspace's own, and
// an archived state.
function badges(node, ctx) {
  return [
    node.ownerScope === "system" && ctx.owner === "club" ? `<span class="item-badge">System</span>` : "",
    node.state === "archived" ? `<span class="item-badge">Archived</span>` : "",
  ].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// The switch between the variables and their domains and categories
// ---------------------------------------------------------------------------
export function renderViewSwitchHtml(s) {
  const tab = (view, label) => `<button type="button" class="plain-button compact-button ${s.view === view ? "is-active" : ""}" aria-pressed="${s.view === view}" data-action="metric-classification-view" data-view="${view}">${label}</button>`;
  return `<div class="metric-variables-segmented metric-classification-switch" role="group" aria-label="What to show">${tab("variables", "Variables")}${tab("classification", "Domains &amp; categories")}</div>`;
}

// The list's filter by a domain or a category (C6): every node of the read.
export function renderFilterHtml(s) {
  const t = s.classification.tree;
  if (!t || (!(t.domains || []).length && !(t.categories || []).length)) return "";
  const value = s.filter ? `${s.filter.kind === "domain" ? "d" : "c"}:${s.filter.id}` : "";
  const option = (prefix, node) => `<option value="${prefix}:${escapeAttr(node.id)}" ${value === `${prefix}:${node.id}` ? "selected" : ""}>${escapeHtml(node.name || "")}${node.state === "archived" ? " (archived)" : ""}</option>`;
  return `
    <label class="search-field metric-variables-state"><span>Domain or category</span>
      <select data-metric-variables-filter="classification">
        <option value="" ${value ? "" : "selected"}>All</option>
        ${(t.domains || []).length ? `<optgroup label="Domains">${t.domains.map((n) => option("d", n)).join("")}</optgroup>` : ""}
        ${(t.categories || []).length ? `<optgroup label="Categories">${t.categories.map((n) => option("c", n)).join("")}</optgroup>` : ""}
      </select>
    </label>`;
}
// What the list says it is filtered by, with a way back to all. In a club
// workspace the filter reads one scope at a time (the server ANDs the two), so
// the note says which, and where the other's variables are.
export function renderFilterNoteHtml(s, ctx) {
  if (!s.filter) return "";
  const node = findNode(s.classification.tree, s.filter.kind, s.filter.id);
  const name = node ? escapeHtml(node.name || "") : `this ${nounOf(s.filter.kind)}`;
  const how = s.filter.kind === "domain" ? `in the domain ${name}, directly or through one of its categories` : `in the category ${name}`;
  const what = ctx.owner !== "club" ? `Showing the variables ${how}.`
    : s.scope === "system" ? `Showing the system variables ${how}.`
    : `Showing this club's variables ${how}. System variables placed there are under System (reference).`;
  return `<p class="muted metric-classification-filter-note">${what} <button class="plain-button ghost compact-button" type="button" data-action="metric-classification-filter-clear">Show all</button></p>`;
}

// ---------------------------------------------------------------------------
// The tree (C1)
// ---------------------------------------------------------------------------
function treeIntro(ctx) {
  if (ctx.view === "coach") return "The domains and categories of this team's club and the system's, for reference. An administrator of the club creates them and places variables in them.";
  if (ctx.owner === "system") return "System domains and categories group the system variables, for example Endurance or Speed. Each category sits in at most one domain.";
  return `Domains and categories of ${escapeHtml(ctx.clubName || "this club")} group its variables and the system's. A category of this club can sit in one domain: this club's or a system one. System domains and categories are shown for reference.`;
}

export function renderClassificationHtml(s, ctx) {
  const c = s.classification;
  if (s.node) return renderNodeHtml(s, ctx);
  const canCreate = ctx.view !== "coach";
  const t = c.tree ? treeOf(c.tree) : null;
  return `
    <div class="metric-variables-head">
      <div>
        <h2 id="metric-variables-title">Domains &amp; categories</h2>
        <p class="muted">${treeIntro(ctx)}</p>
      </div>
      ${canCreate ? `<div class="metric-variables-actions">
        <button class="plain-button data-sources-primary" type="button" data-action="metric-classification-create-open" data-kind="domain">New domain</button>
        <button class="plain-button data-sources-primary" type="button" data-action="metric-classification-create-open" data-kind="category">New category</button>
      </div>` : ""}
    </div>
    ${renderViewSwitchHtml(s)}
    ${s.notice ? `<p class="metric-variables-notice" role="status">${escapeHtml(s.notice)}</p>` : ""}
    ${c.loading && !c.loaded ? `<p class="muted" role="status">Loading domains and categories...</p>` : ""}
    ${c.error ? `<div class="error" role="alert"><p>${escapeHtml(c.error)}</p><button class="plain-button" type="button" data-action="metric-classification-reload">Try again</button></div>` : ""}
    ${t ? renderTreeHtml(t, ctx, canCreate) : ""}
  `;
}

function nodeButton(kind, node, ctx, extra = "") {
  return `
    <button type="button" class="metric-variables-item metric-classification-item" data-action="metric-classification-open" data-kind="${kind}" data-node-id="${escapeAttr(node.id)}">
      <span class="metric-variables-item-name">${cut(node)} ${badges(node, ctx)}</span>
      ${node.description ? `<span class="metric-variables-item-facts muted">${escapeHtml(node.description)}</span>` : ""}
      ${extra ? `<span class="metric-variables-item-facts muted">${extra}</span>` : ""}
    </button>`;
}

function renderTreeHtml(t, ctx, canCreate) {
  if (!t.domains.length && !t.unplaced.length && !t.placedElsewhere.length) {
    return `<p class="empty">${canCreate ? "No domains or categories yet. Create a domain (for example Endurance), then categories, and place the categories in it." : "There are no domains or categories yet."}</p>`;
  }
  const domains = t.domains.map(({ domain, categories }) => `
    <li class="metric-classification-domain">
      ${nodeButton("domain", domain, ctx, categories.length ? "" : "No categories in it yet.")}
      ${categories.length ? `<ul class="metric-classification-categories" aria-label="Categories in ${escapeAttr(domain.name || "")}">${categories.map(({ category }) => `<li>${nodeButton("category", category, ctx)}</li>`).join("")}</ul>` : ""}
    </li>`).join("");
  const loose = [...t.unplaced, ...t.placedElsewhere];
  return `
    ${t.truncated ? `<p class="muted">Only the first 500 of each are shown.</p>` : ""}
    <section class="metric-classification-section" aria-labelledby="mc-domains-title">
      <h3 id="mc-domains-title">Domains</h3>
      ${t.domains.length ? `<ul class="metric-variables-list metric-classification-tree">${domains}</ul>` : `<p class="muted">No domains yet.</p>`}
    </section>
    <section class="metric-classification-section" aria-labelledby="mc-loose-title">
      <h3 id="mc-loose-title">Categories in no domain</h3>
      ${loose.length ? `<ul class="metric-variables-list">${loose.map((category) => `<li>${nodeButton("category", category, ctx, t.linkOf(category.id) ? "In a domain not shown here." : "")}</li>`).join("")}</ul>`
        : `<p class="muted">${t.domains.some((d) => d.categories.length) ? "Every category is in a domain." : "No categories yet."}</p>`}
    </section>
  `;
}

// ---------------------------------------------------------------------------
// One domain or category
// ---------------------------------------------------------------------------
const NODE_ACTIONS = [
  ["rename", "metric-classification-rename-open", "Rename"],
  ["archive", "metric-classification-archive-open", "Archive"],
  ["restore", "metric-classification-restore-open", "Restore"],
];
function renderNodeHtml(s, ctx) {
  const { kind, id } = s.node;
  const back = `<button class="plain-button ghost metric-variables-back" type="button" data-action="metric-classification-back">← Domains &amp; categories</button>`;
  const tree = s.classification.tree;
  const node = findNode(tree, kind, id);
  const notice = s.notice ? `<p class="metric-variables-notice" role="status">${escapeHtml(s.notice)}</p>` : "";
  if (!node) {
    if (s.classification.loading) return `${back}${notice}<p class="muted" role="status">Loading...</p>`;
    return `${back}${notice}<p class="empty">This ${nounOf(kind)} is not in the list any more.</p>`;
  }
  const t = treeOf(tree);
  const actions = node.actions || [];
  const buttons = NODE_ACTIONS.filter(([name]) => actions.includes(name)).map(([name, action, label], index) => `<button class="plain-button ${index === 0 && name !== "archive" ? "data-sources-primary" : "ghost"}" type="button" data-action="${action}" data-kind="${kind}" data-node-id="${escapeAttr(node.id)}">${label}</button>`);
  let place = "";
  if (kind === "category") {
    const link = t.linkOf(node.id);
    const domain = link ? findNode(tree, "domain", link.domainId) : null;
    // The same helpers decide the buttons and the handlers (a forged click opens nothing).
    const removable = link ? removablePlacement(tree, link.id, ctx) : null;
    const placeable = categoryPlaceable(node, tree, ctx);
    const canPlace = placeable && placeableDomains(tree).length > 0;
    place = `
      <div class="metric-classification-place">
        <h3>Domain</h3>
        <p>${link ? (domain ? `${cut(domain)} ${badges(domain, ctx)}` : "A domain not shown here.") : "In no domain."}</p>
        ${removable ? `<button class="plain-button ghost" type="button" data-action="metric-classification-link-remove-open" data-link-id="${escapeAttr(link.id)}">Remove from the domain</button>` : ""}
        ${canPlace ? `<button class="plain-button" type="button" data-action="metric-classification-place-open" data-node-id="${escapeAttr(node.id)}">Place in a domain</button>` : ""}
        ${placeable && !canPlace ? `<p class="muted">There is no active domain to place it in yet. Create a domain first (New domain).</p>` : ""}
      </div>`;
  } else {
    const inside = (t.domains.find((x) => x.domain.id === node.id)?.categories || []).map(({ category }) => category);
    place = `
      <div class="metric-classification-place">
        <h3>Categories in it</h3>
        ${inside.length ? `<ul class="metric-classification-names">${inside.map((category) => `<li>${cut(category)} ${badges(category, ctx)}</li>`).join("")}</ul>`
          : `<p class="muted">${ctx.view === "coach" ? "No categories in it yet." : "No categories in it yet. Place a category in it from the category."}</p>`}
      </div>`;
  }
  const readOnly = node.editable === false && ctx.view !== "coach"
    ? `<p class="muted">Read only here: system domains and categories are changed in the platform workspace.</p>` : "";
  return `
    ${back}
    <div class="metric-variables-head">
      <div>
        <h2 id="metric-variables-title">${cut(node)}</h2>
        <p class="muted">${KIND_TITLE[kind]} ${badges(node, ctx)}</p>
      </div>
      ${buttons.length ? `<div class="metric-variables-actions">${buttons.join("")}</div>` : ""}
    </div>
    ${notice}
    ${node.state === "archived" ? `<p class="muted">Archived: its links stay as they are, and no new variable${kind === "domain" ? " or category" : ""} can be placed in it until it is restored.</p>` : ""}
    ${readOnly}
    ${node.description ? `<p>${escapeHtml(node.description)}</p>` : ""}
    ${place}
    <button class="plain-button ghost metric-classification-show" type="button" data-action="metric-classification-show-variables" data-kind="${kind}" data-node-id="${escapeAttr(node.id)}">Show its variables</button>
    <details class="data-sources-tech"><summary>Technical details</summary><dl>
      <div><dt>Key</dt><dd>${escapeHtml(node.key || "")}</dd></div>
      <div><dt>Owner</dt><dd>${escapeHtml(node.ownerScope || "")}</dd></div>
      <div><dt>${KIND_TITLE[kind]} id</dt><dd>${escapeHtml(node.id)}</dd></div>
    </dl></details>
  `;
}

// ---------------------------------------------------------------------------
// A variable's domains and categories (C6), in its detail
// ---------------------------------------------------------------------------
export function renderVariableClassificationHtml(item, ctx, classification) {
  const c = item?.classification;
  if (!c) return "";
  const tree = classification?.tree || null;
  const admin = ctx.view !== "coach";
  const removable = (entry) => Boolean(entry.linkId && removableVariableLink(item, entry.linkId, ctx));
  const rows = [
    ...(c.categories || []).map((entry) => ({ entry, kind: "category", label: "Category", removable: removable(entry) })),
    ...(c.domains || []).filter((entry) => !entry.viaCategoryId).map((entry) => ({ entry, kind: "domain", label: "Domain", removable: removable(entry) })),
  ];
  const via = (c.domains || []).filter((entry) => entry.viaCategoryId);
  const categoryName = (id) => (c.categories || []).find((x) => x.id === id)?.name || "";
  const nodeBadges = (entry) => [entry.ownerScope === "system" && ctx.owner === "club" ? `<span class="item-badge">System</span>` : "", entry.state === "archived" ? `<span class="item-badge">Archived</span>` : ""].filter(Boolean).join(" ");
  const linkedIds = new Set([...(c.categories || []).map((x) => x.id), ...(c.domains || []).filter((x) => !x.viaCategoryId).map((x) => x.id)]);
  const canAdd = (kind) => admin && item.state === "active" && ownActive(tree, kind, ctx).some((n) => !linkedIds.has(n.id));
  // An admin who cannot add is told why: the read failed, or there is nothing to add to yet.
  let addNote = "";
  if (admin && item.state === "active" && !canAdd("category") && !canAdd("domain")) {
    if (!tree && classification?.error) addNote = `<div class="metric-classification-add-note"><p class="muted">Domains and categories could not be loaded.</p><button class="plain-button" type="button" data-action="metric-classification-reload">Try again</button></div>`;
    else if (tree && !ownActive(tree, "category", ctx).length && !ownActive(tree, "domain", ctx).length) addNote = `<p class="muted">To add it to a domain or category, first create one under Domains &amp; categories.</p>`;
  }
  return `
    <section class="metric-classification-variable" aria-labelledby="mc-variable-title">
      <h3 id="mc-variable-title">Domains and categories</h3>
      ${rows.length || via.length ? `<ul class="metric-classification-links">
        ${rows.map(({ entry, kind, label, removable }) => `
          <li>
            <span><span class="muted">${label}:</span> ${escapeHtml(entry.name || "")} ${nodeBadges(entry)}</span>
            ${removable ? `<button class="plain-button ghost compact-button" type="button" data-action="metric-classification-link-remove-open" data-link-id="${escapeAttr(entry.linkId)}" data-variable-id="${escapeAttr(item.id)}" aria-label="${escapeAttr(`Remove from ${entry.name || `the ${kind}`}`)}">Remove</button>` : ""}
          </li>`).join("")}
        ${via.map((entry) => `<li><span><span class="muted">Domain:</span> ${escapeHtml(entry.name || "")} ${nodeBadges(entry)} <span class="muted">(through ${escapeHtml(categoryName(entry.viaCategoryId))})</span></span></li>`).join("")}
      </ul>` : `<p class="muted">In no domain or category yet.</p>`}
      ${c.truncated ? `<p class="muted">Only the first 500 links are shown.</p>` : ""}
      ${canAdd("category") || canAdd("domain") ? `<div class="metric-classification-add">
        ${canAdd("category") ? `<button class="plain-button" type="button" data-action="metric-classification-variable-link-open" data-link-kind="category" data-variable-id="${escapeAttr(item.id)}">Add to a category</button>` : ""}
        ${canAdd("domain") ? `<button class="plain-button" type="button" data-action="metric-classification-variable-link-open" data-link-kind="domain" data-variable-id="${escapeAttr(item.id)}">Add to a domain</button>` : ""}
      </div>` : ""}
      ${addNote}
    </section>`;
}

// ---------------------------------------------------------------------------
// The forms
// ---------------------------------------------------------------------------
const fieldError = (form, field) => (form.errors[field] ? `<span class="metric-variables-field-error" id="mc-err-${field}">${escapeHtml(form.errors[field])}</span>` : "");
const described = (form, field, hint = "") => {
  const ids = [hint ? `mc-hint-${field}` : "", form.errors[field] ? `mc-err-${field}` : ""].filter(Boolean).join(" ");
  return ids ? ` aria-describedby="${ids}"` : "";
};
const invalid = (form, field) => (form.errors[field] ? ` aria-invalid="true"` : "");
const TOKEN_ATTRS = ` autocapitalize="none" autocorrect="off" spellcheck="false"`;
function textInput(form, field, label, { max, required = false, hint = "", token = false } = {}) {
  const locked = form.busy || form.unconfirmed;
  return `
    <label class="search-field"><span>${escapeHtml(label)}${required ? "" : ` <span class="muted">(optional)</span>`}</span>
      <input type="text" data-mc-field="${field}" value="${escapeAttr(form.draft[field] ?? "")}" ${max ? `maxlength="${max}"` : ""} autocomplete="off"${token ? TOKEN_ATTRS : ""} ${locked ? "disabled" : ""}${described(form, field, hint)}${invalid(form, field)}>
      ${hint ? `<span class="muted" id="mc-hint-${field}">${escapeHtml(hint)}</span>` : ""}
      ${fieldError(form, field)}
    </label>`;
}
function selectInput(form, field, label, options, { hint = "" } = {}) {
  const locked = form.busy || form.unconfirmed;
  return `
    <label class="search-field"><span>${escapeHtml(label)}</span>
      <select data-mc-field="${field}" ${locked ? "disabled" : ""}${described(form, field, hint)}${invalid(form, field)}>
        <option value="" ${form.draft[field] ? "" : "selected"}>Choose...</option>
        ${options.map((o) => `<option value="${escapeAttr(o.value)}" ${form.draft[field] === o.value ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}
      </select>
      ${hint ? `<span class="muted" id="mc-hint-${field}">${escapeHtml(hint)}</span>` : ""}
      ${fieldError(form, field)}
    </label>`;
}
function unconfirmedHtml(form) {
  return `
    <div class="metric-variables-unconfirmed" role="alert">
      <p><strong>Result not confirmed.</strong> No confirmation arrived, so it is not known whether it was saved. Check result sends the same request again: it is never saved twice.</p>
      ${form.checkNote ? `<p>${escapeHtml(form.checkNote)}</p>` : ""}
      <div class="data-sources-form-actions">
        <button class="plain-button data-sources-primary" type="button" data-action="metric-variables-check-result" ${form.busy ? "disabled" : ""}>${form.busy ? "Checking..." : "Check result"}</button>
        <button class="plain-button ghost" type="button" data-action="metric-variables-cancel" ${form.busy ? "disabled" : ""}>Close without checking</button>
      </div>
    </div>`;
}
function actionsHtml(form, submitLabel, busyLabel) {
  if (form.unconfirmed) return unconfirmedHtml(form);
  return `
    <div class="data-sources-form-actions">
      <button class="plain-button data-sources-primary" type="submit" ${form.busy ? "disabled" : ""}>${form.busy ? busyLabel : submitLabel}</button>
      <button class="plain-button ghost" type="button" data-action="metric-variables-cancel" ${form.busy ? "disabled" : ""}>Cancel</button>
    </div>`;
}
const optionOf = (node, ctx) => ({ value: node.id, label: `${node.name || ""}${node.ownerScope === "system" && ctx.owner === "club" ? " (system)" : ""}` });

export function renderClassificationFormHtml(s, ctx) {
  const form = s.form;
  const tree = s.classification.tree;
  const noun = nounOf(form.kind);
  let title = "";
  let body = "";
  let submit = ["Save", "Saving..."];
  if (form.mode === "node-create") {
    title = ctx.owner === "system" ? `New system ${noun}` : `New ${noun} for this club`;
    body = `
      ${textInput(form, "name", "Name", { max: CLASS_LIMITS.name, required: true, hint: form.kind === "domain" ? "For example Endurance or Speed." : "For example Aerobic capacity." })}
      ${textInput(form, "description", "Description", { max: CLASS_LIMITS.description })}
      <details class="data-sources-tech" ${form.errors.key || String(form.draft.key ?? "").trim() ? "open" : ""}><summary>Technical details</summary>
        ${textInput(form, "key", "Custom key", { max: CLASS_LIMITS.key, token: true, hint: "Leave empty to use a key made from the name. It cannot be changed later." })}
      </details>
      ${form.unconfirmed ? "" : `<p class="metric-variables-field-note">After you create it, its key cannot be changed and it cannot be deleted; it can be renamed, and archived when it is no longer used.</p>`}`;
    submit = [`Create ${noun}`, "Creating..."];
  } else if (form.mode === "node-rename") {
    title = `Rename ${escapeHtml(form.nodeName)}`;
    body = `
      <p class="muted">Only the name and the description change. The key, its links and its variables stay as they are.</p>
      ${form.truncated ? `<p class="metric-variables-field-note">The saved name or description may be longer than shown here. A field you leave as it is stays as saved; a field you change replaces the whole saved text.</p>` : ""}
      ${textInput(form, "name", "Name", { max: CLASS_LIMITS.name, required: true })}
      ${textInput(form, "description", "Description", { max: CLASS_LIMITS.description, hint: "Leave it empty to remove it." })}`;
    submit = ["Save changes", "Saving..."];
  } else if (form.mode === "node-archive") {
    title = `Archive ${escapeHtml(form.nodeName)}`;
    body = `
      <p class="metric-variables-field-note">Its links stay as they are and its variables keep their values. Until it is restored, no new variable${form.kind === "domain" ? " or category" : ""} can be placed in it.</p>
      ${textInput(form, "reason", "Reason", { max: CLASS_LIMITS.reason, required: true, hint: "Saved with the change, for example: merged into Speed." })}`;
    submit = [`Archive ${noun}`, "Archiving..."];
  } else if (form.mode === "node-restore") {
    title = `Restore ${escapeHtml(form.nodeName)}`;
    body = `
      <p class="metric-variables-field-note">It becomes active again: variables${form.kind === "domain" ? " and categories" : ""} can be placed in it.</p>
      ${textInput(form, "reason", "Reason", { max: CLASS_LIMITS.reason })}`;
    submit = [`Restore ${noun}`, "Restoring..."];
  } else if (form.mode === "category-place") {
    title = `Place ${escapeHtml(form.nodeName)} in a domain`;
    body = `
      <p class="muted">A category sits in one domain. Its variables then also count as variables of that domain.</p>
      ${selectInput(form, "targetId", "Domain", placeableDomains(tree).map((n) => optionOf(n, ctx)))}`;
    submit = ["Place in the domain", "Saving..."];
  } else if (form.mode === "variable-link") {
    const kind = form.linkKind;
    const variable = s.detail.variable;
    const linked = new Set([...(variable?.classification?.categories || []).map((x) => x.id), ...(variable?.classification?.domains || []).filter((x) => !x.viaCategoryId).map((x) => x.id)]);
    title = `Add ${escapeHtml(form.variableLabel)} to a ${kind}`;
    body = `
      <p class="muted">${kind === "category" ? "A variable can be in several categories; each category's domain then counts it too." : "A variable can be in several domains. Placing it in a category of the domain is usually enough."}</p>
      ${selectInput(form, "targetId", kind === "category" ? "Category" : "Domain", ownActive(tree, kind, ctx).filter((n) => !linked.has(n.id)).map((n) => optionOf(n, ctx)))}`;
    submit = [kind === "category" ? "Add to the category" : "Add to the domain", "Saving..."];
  } else if (form.mode === "link-remove") {
    // What leaves what, and what that changes, by the link's shape.
    const subject = escapeHtml(form.subject);
    const target = escapeHtml(form.target);
    const note = {
      "category-domain": `${subject} leaves ${target}. Its variables no longer count in ${target} through it (unless they are in ${target} directly). The category, the domain and the variables stay as they are, and the removal is recorded.`,
      "variable-category": `${subject} leaves ${target}, and no longer counts in that category's domain through it. The variable and the category stay as they are, and the removal is recorded.`,
      "variable-domain": `${subject} leaves ${target} (it still counts there through any of its categories in it). The variable and the domain stay as they are, and the removal is recorded.`,
    }[form.shape] || "";
    title = `Remove ${subject} from ${target}`;
    body = `
      <p class="metric-variables-field-note">${note}</p>
      ${textInput(form, "reason", "Reason", { max: CLASS_LIMITS.reason, hint: "Saved with the change." })}`;
    submit = [form.shape === "variable-category" ? "Remove from the category" : "Remove from the domain", "Removing..."];
  }
  // Only a form with a text field asks to keep personal data out of it.
  const hasText = !["category-place", "variable-link"].includes(form.mode);
  return `
    <form class="data-sources-form metric-variables-form metric-classification-form" data-metric-variables-form="${form.mode}" novalidate autocomplete="off">
      <h2 id="metric-variables-title">${title}</h2>
      ${hasText ? `<p class="muted">Do not enter athlete names, ids, dates of birth or measured values.</p>` : ""}
      ${body}
      ${form.error ? `<p class="error" role="alert">${escapeHtml(form.error)}</p>` : ""}
      ${actionsHtml(form, ...submit)}
    </form>`;
}
