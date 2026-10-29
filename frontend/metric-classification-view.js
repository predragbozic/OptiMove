// Training Load -> Data configuration -> Domains and Categories: the markup
// (phase 12c, J6 3.4; two screens of their own since layout C, PR-1). Every text that came from the server or the coach
// is escaped; ids live only in data- attributes and under Technical details.
import {
  CLASS_LIMITS, categoryPlaceable, findNode, nounOf, ownActive, placeableDomains, removablePlacement, removableVariableLink, treeOf,
} from "./metric-classification-data.js";
import { escapeAttr, escapeHtml } from "./utils.js";
import { HOME_BACK, nodeTileHtml, variableTileHtml } from "./data-config-tiles.js";
import { dragOffered, dropBlocked, dropNeedsAsk, dropTargets } from "./metric-classification-drag.js";

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
// The list's filter by a domain or a category (C6): every node of the read,
// active ones apart from archived ones.
// ---------------------------------------------------------------------------
export function renderFilterHtml(s) {
  const t = s.classification.tree;
  if (!t || (!(t.domains || []).length && !(t.categories || []).length)) return "";
  const value = s.filter ? `${s.filter.kind === "domain" ? "d" : "c"}:${s.filter.id}` : "";
  const option = (prefix, node) => `<option value="${prefix}:${escapeAttr(node.id)}" ${value === `${prefix}:${node.id}` ? "selected" : ""}>${escapeHtml(node.name || "")}</option>`;
  const group = (label, prefix, nodes) => (nodes.length ? `<optgroup label="${label}">${nodes.map((n) => option(prefix, n)).join("")}</optgroup>` : "");
  const domains = t.domains || [];
  const categories = t.categories || [];
  const active = (n) => n.state === "active";
  return `
    <label class="search-field metric-variables-state"><span>Domain or category</span>
      <select data-metric-variables-filter="classification">
        <option value="" ${value ? "" : "selected"}>All</option>
        ${group("Domains", "d", domains.filter(active))}
        ${group("Categories", "c", categories.filter(active))}
        ${group("Archived domains", "d", domains.filter((n) => !active(n)))}
        ${group("Archived categories", "c", categories.filter((n) => !active(n)))}
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
// Domains and Categories: two screens of their own (layout C, PR-1), each
// with its own tiles - a domain filled, a category outlined - and its archived
// items folded away in a group of their own.
// ---------------------------------------------------------------------------
function domainsIntro(ctx) {
  if (ctx.view === "coach") return "The domains of this team's club and the system's, for reference. An administrator of the club creates them.";
  if (ctx.owner === "system") return "Domains are the broad groups of the system variables, for example Endurance or Speed. Each holds categories.";
  return `Domains of ${escapeHtml(ctx.clubName || "this club")} group its categories and variables. System domains are shown for reference.`;
}
function categoriesIntro(ctx) {
  if (ctx.view === "coach") return "The categories of this team's club and the system's, for reference. An administrator of the club creates them and places variables in them.";
  if (ctx.owner === "system") return "Categories group the system variables, for example Aerobic capacity. Each category sits in at most one domain.";
  return `Categories of ${escapeHtml(ctx.clubName || "this club")} group its variables and the system's. A category of this club can sit in one domain: this club's or a system one. System categories are shown for reference.`;
}

export function renderClassificationHtml(s, ctx) {
  if (s.node) return renderNodeHtml(s, ctx);
  const c = s.classification;
  const domains = s.view === "domains";
  const canCreate = ctx.view !== "coach";
  const kind = domains ? "domain" : "category";
  const t = c.tree ? treeOf(c.tree) : null;
  return `
    ${HOME_BACK}
    <div class="metric-variables-head">
      <div>
        <h2 id="metric-variables-title" tabindex="-1">${domains ? "Domains" : "Categories"}</h2>
        <p class="muted">${domains ? domainsIntro(ctx) : categoriesIntro(ctx)}</p>
      </div>
      ${canCreate ? `<div class="metric-variables-actions">
        <button class="plain-button data-sources-primary" type="button" data-action="metric-classification-create-open" data-kind="${kind}" ${dropNeedsAsk() ? "disabled" : ""}>New ${kind}</button>
      </div>` : ""}
    </div>
    ${s.notice ? `<p class="metric-variables-notice" role="status">${escapeHtml(s.notice)}</p>` : ""}
    ${c.loading && !c.loaded ? `<p class="muted" role="status">Loading ${domains ? "domains" : "categories"}...</p>` : ""}
    ${c.error ? `<div class="error" role="alert"><p>${escapeHtml(c.error)}</p><button class="plain-button" type="button" data-action="metric-classification-reload">Try again</button></div>` : ""}
    ${t ? (t.truncated ? `<p class="muted">Only the first 500 of each are shown.</p>` : "") : ""}
    ${t ? (domains ? renderDomainsListHtml(c.tree, t, ctx, canCreate) : renderCategoriesScreenHtml(s, c.tree, t, ctx, canCreate)) : ""}
  `;
}

// ---------------------------------------------------------------------------
// Dragging a variable onto a category (PR-2): on a computer the Categories
// screen holds a tray of this workspace's own active variables beside the
// categories; this workspace's active categories take the drop.
// ---------------------------------------------------------------------------
function renderCategoriesScreenHtml(s, tree, t, ctx, canCreate) {
  if (!dragOffered(s, ctx)) return renderCategoriesListHtml(tree, t, ctx, canCreate);
  const targets = new Set(dropTargets(tree, ctx).map((node) => node.id));
  const locked = dropBlocked();
  return `
    <div class="dc-drag-board${locked ? " is-locked" : ""}">
      ${trayHtml(s.tray, targets, locked, ctx, dropStatusHtml(s.drop, locked))}
      <div class="dc-drag-categories">${renderCategoriesListHtml(tree, t, ctx, canCreate, targets)}</div>
    </div>`;
}

// A club's tray holds only the club's own variables; a system variable is added
// to a club's category from its detail (the way without a mouse too). The last
// drop's line sits at the top of the tray, which stays on the screen, so Undo
// and Check result are in reach however long the list of categories is.
function trayHtml(tray, targets, locked, ctx, status) {
  const club = ctx.owner === "club";
  let body = "";
  if (!tray || (tray.loading && !tray.loaded)) body = `<p class="muted" role="status">Loading variables...</p>`;
  else if (tray.error) body = `<div class="error" role="alert"><p>${escapeHtml(tray.error)}</p><button class="plain-button" type="button" data-action="metric-classification-tray-reload">Try again</button></div>`;
  else if (!tray.items.length) {
    body = `<p class="muted">${club
      ? "This club has no variables of its own yet. To add a system variable to a category, open it under Variables, in System (reference), and choose Add to a category."
      : "There are no active variables here yet. Create one under Variables."}</p>`;
  }
  else {
    body = `<ul class="dc-tray-list">${tray.items.map((item) => `
      <li class="dc-chip" draggable="${locked ? "false" : "true"}" data-dc-drag-variable data-variable-id="${escapeAttr(item.id)}">
        ${variableTileHtml(item, { size: "sm" })}<span class="dc-chip-label">${escapeHtml(item.label || "")}${item.truncated ? "…" : ""}</span>
      </li>`).join("")}</ul>
      ${tray.more ? `<p class="muted">The first 100 are shown. To add another one, open it under Variables and choose Add to a category.</p>` : ""}`;
  }
  const hint = targets.size
    ? "Drag a variable onto a category to add it there. Adding never moves it: it stays in any category it is already in."
    : "Create a category first, then drag variables onto it.";
  const other = club
    ? "System variables are not listed here: to add one, open it under Variables, in System (reference), and choose Add to a category. Without a mouse, open any variable under Variables and choose Add to a category."
    : "Without a mouse: under Variables, open a variable and choose Add to a category.";
  return `
    <aside class="dc-tray" aria-labelledby="dc-tray-title">
      ${status}
      <h3 id="dc-tray-title">${club ? "This club's variables" : "Variables"}</h3>
      <p class="muted">${hint}</p>
      <p class="muted">${other}</p>
      ${body}
    </aside>`;
}

// What the last drop did: one line, with Undo for 10 seconds after a saved
// one; a lost answer is not confirmed and is checked with the same request.
function dropStatusHtml(drop, locked) {
  if (!drop) return "";
  const x = escapeHtml(drop.variableLabel);
  const y = escapeHtml(drop.categoryName);
  if (drop.unconfirmed) {
    const what = drop.phase === "undo" ? `whether ${x} was removed from ${y}` : `whether ${x} was added to ${y}`;
    return `
      <div class="metric-variables-unconfirmed dc-drop-status" role="alert">
        <p><strong>Result not confirmed.</strong> No confirmation arrived, so it is not known ${what}. Check result sends the same request again: it is never saved twice.</p>
        ${drop.checkNote ? `<p>${escapeHtml(drop.checkNote)}</p>` : ""}
        <div class="data-sources-form-actions">
          <button class="plain-button data-sources-primary" type="button" data-action="metric-classification-drop-check" ${drop.busy ? "disabled" : ""}>${drop.busy ? "Checking..." : "Check result"}</button>
          <button class="plain-button ghost" type="button" data-action="metric-classification-drop-dismiss" ${drop.busy ? "disabled" : ""}>Close without checking</button>
        </div>
      </div>`;
  }
  const line = (text, { role = "status", warning = false, undo = false } = {}) => `
    <p class="metric-variables-notice dc-drop-status${warning ? " is-warning" : ""}" role="${role}">${text}${undo ? ` <button class="plain-button ghost compact-button" type="button" data-action="metric-classification-drop-undo">Undo</button> <span class="muted">You can undo it for 10 seconds.</span>` : ""}</p>`;
  if (drop.busy) return line(drop.phase === "undo" ? `Removing ${x} from ${y}...` : `Adding ${x} to ${y}...`);
  if (drop.phase === "done") {
    const undo = Boolean(drop.linkId) && Date.now() < drop.undoUntil && !locked;
    // Once Undo is gone, the line says how to take the variable out.
    return line(undo ? `${x} was added to ${y}.` : `${x} was added to ${y}. To take it out, open ${x} under Variables and choose Remove next to ${y}.`, { undo });
  }
  if (drop.phase === "already") return line(`${x} is already in ${y}. Nothing was changed.`);
  if (drop.phase === "undone") return line(`${x} is no longer in ${y}.`);
  if (drop.phase === "unchecked") return line(`The result was not checked. To see whether ${x} is in ${y}, open ${x} under Variables.`);
  if (drop.phase === "refused") return line(`${x} was not added to ${y}. ${escapeHtml(drop.text || "")}`, { role: "alert", warning: true });
  if (drop.phase === "undo-refused") return line(`Undo did not go through. ${escapeHtml(drop.text || "")} Open ${x} under Variables to see its categories.`, { role: "alert", warning: true });
  return "";
}

function nodeButton(kind, node, ctx, extra = "") {
  return `
    <button type="button" class="metric-variables-item dc-item metric-classification-item" data-action="metric-classification-open" data-kind="${kind}" data-node-id="${escapeAttr(node.id)}">
      ${nodeTileHtml(kind, node)}
      <span class="metric-variables-item-name">${cut(node)} ${badges(node, ctx)}</span>
      ${node.description ? `<span class="metric-variables-item-facts muted">${escapeHtml(node.description)}</span>` : ""}
      ${extra ? `<span class="metric-variables-item-facts muted">${extra}</span>` : ""}
    </button>`;
}
const listOf = (items) => `<ul class="metric-variables-list">${items.map((html) => `<li>${html}</li>`).join("")}</ul>`;
function archivedGroup(items, noun) {
  if (!items.length) return "";
  return `
    <details class="dc-archived">
      <summary>Archived ${noun} <span class="muted">(${items.length})</span></summary>
      ${listOf(items)}
    </details>`;
}

function renderDomainsListHtml(tree, t, ctx, canCreate) {
  const rows = t.domains.map(({ domain, categories }) => {
    const names = categories.map(({ category }) => category.name || "").filter(Boolean);
    const facts = names.length ? `${names.length === 1 ? "1 category" : `${names.length} categories`}: ${names.slice(0, 4).map(escapeHtml).join(", ")}${names.length > 4 ? ", …" : ""}` : "No categories in it yet.";
    return { domain, html: nodeButton("domain", domain, ctx, facts) };
  });
  const active = rows.filter((r) => r.domain.state === "active").map((r) => r.html);
  const archived = rows.filter((r) => r.domain.state !== "active").map((r) => r.html);
  if (!rows.length) return `<p class="empty">${canCreate ? "No domains yet. Create the first one with New domain, for example Endurance." : "There are no domains yet."}</p>`;
  return `
    <section class="metric-classification-section" aria-labelledby="mc-domains-title">
      <h3 id="mc-domains-title" class="visually-hidden">Active domains</h3>
      ${active.length ? listOf(active) : `<p class="muted">No active domains.</p>`}
    </section>
    ${archivedGroup(archived, "domains")}`;
}

function renderCategoriesListHtml(tree, t, ctx, canCreate, targets = null) {
  const domainName = (category) => {
    const link = t.linkOf(category.id);
    if (!link) return "";
    const domain = findNode(tree, "domain", link.domainId);
    return domain ? `In ${escapeHtml(domain.name || "")}` : "In a domain not shown here.";
  };
  const placed = t.domains.flatMap(({ categories }) => categories.map(({ category }) => category));
  const all = [...placed, ...t.placedElsewhere, ...t.unplaced];
  if (!all.length) return `<p class="empty">${canCreate ? "No categories yet. Create the first one with New category, for example Aerobic capacity." : "There are no categories yet."}</p>`;
  const active = (category) => category.state === "active";
  const inDomain = [...placed, ...t.placedElsewhere].filter(active);
  const loose = t.unplaced.filter(active);
  const archived = all.filter((category) => !active(category));
  // On a computer (PR-2) each category that takes a variable is a drop target.
  const listOfCategories = (categories, facts) => `<ul class="metric-variables-list">${categories.map((category) => {
    const target = targets?.has(category.id);
    return `<li${target ? ` class="dc-drop-category" data-dc-drop-category data-category-id="${escapeAttr(category.id)}"` : ""}>${nodeButton("category", category, ctx, facts(category))}</li>`;
  }).join("")}</ul>`;
  return `
    <section class="metric-classification-section" aria-labelledby="mc-placed-title">
      <h3 id="mc-placed-title">In a domain</h3>
      ${inDomain.length ? listOfCategories(inDomain, domainName) : `<p class="muted">No active category is in a domain yet.</p>`}
    </section>
    <section class="metric-classification-section" aria-labelledby="mc-loose-title">
      <h3 id="mc-loose-title">In no domain</h3>
      ${loose.length ? listOfCategories(loose, () => "") : `<p class="muted">Every active category is in a domain.</p>`}
    </section>
    ${archivedGroup(archived.map((category) => nodeButton("category", category, ctx, domainName(category))), "categories")}`;
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
  // Back to the screen it was opened from.
  const back = `<button class="plain-button ghost metric-variables-back" type="button" data-action="metric-classification-back">← ${s.view === "domains" ? "Domains" : "Categories"}</button>`;
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
        <p class="dc-inline">${link ? (domain ? `${nodeTileHtml("domain", domain, { size: "sm" })}<span>${cut(domain)} ${badges(domain, ctx)}</span>` : "A domain not shown here.") : "In no domain."}</p>
        ${removable ? `<button class="plain-button ghost" type="button" data-action="metric-classification-link-remove-open" data-link-id="${escapeAttr(link.id)}">Remove from the domain</button>` : ""}
        ${canPlace ? `<button class="plain-button" type="button" data-action="metric-classification-place-open" data-node-id="${escapeAttr(node.id)}">Place in a domain</button>` : ""}
        ${placeable && !canPlace ? `<div class="metric-classification-add-note"><p class="muted">There is no active domain to place it in yet. Create one under Domains first.</p><button class="plain-button" type="button" data-action="metric-classification-view" data-view="domains">Open Domains</button></div>` : ""}
      </div>`;
  } else {
    const inside = (t.domains.find((x) => x.domain.id === node.id)?.categories || []).map(({ category }) => category);
    place = `
      <div class="metric-classification-place">
        <h3>Categories in it</h3>
        ${inside.length ? `<ul class="metric-classification-names dc-names">${inside.map((category) => `<li class="dc-inline">${nodeTileHtml("category", category, { size: "sm" })}<span>${cut(category)} ${badges(category, ctx)}</span></li>`).join("")}</ul>`
          : `<p class="muted">${ctx.view === "coach" ? "No categories in it yet." : "No categories in it yet. Place a category in it from the category, under Categories."}</p>`}
      </div>`;
  }
  const readOnly = node.editable === false && ctx.view !== "coach"
    ? `<p class="muted">Read only here: system domains and categories are changed in the platform workspace.</p>` : "";
  return `
    ${back}
    <div class="metric-variables-head">
      <div class="dc-title">
        ${nodeTileHtml(kind, node, { size: "lg" })}
        <div>
          <h2 id="metric-variables-title" tabindex="-1">${cut(node)}</h2>
          <p class="muted">${KIND_TITLE[kind]} ${badges(node, ctx)}</p>
        </div>
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
    else if (tree && !ownActive(tree, "category", ctx).length && !ownActive(tree, "domain", ctx).length) {
      addNote = `<div class="metric-classification-add-note"><p class="muted">To add it to a domain or category, first create one.</p><button class="plain-button" type="button" data-action="metric-classification-view" data-view="categories">Open Categories</button></div>`;
    }
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
