// Training Load -> Data configuration: the start screen (layout C, PR-1;
// docs/ai/data-configuration-visual-proposal.md section 4). Cards like the
// coach's Home - Variables, Domains, Categories and, for an administrator,
// Source fields - each with its count and its rows, opening its own screen.
// A card shows every row its read already holds, in a list about four and a
// half rows high that scrolls on its own (the owner's request of 2026-10-30).
// It replaces the two look-alike switches of before (Variables |
// Source fields above Variables | Domains & categories). The counts come from
// the reads the screens already make (the variables list, the one read of the
// domains and categories, the source fields list): no read of its own and no
// new API. Every name is escaped.
import { sourceFieldsContext, sourceFieldsState } from "./source-fields-data.js";
import { CHEVRON_HTML, fieldTileHtml, nodeTileHtml, variableTileHtml } from "./data-config-tiles.js";
import { currentRevision } from "./source-fields-data.js";
import { escapeHtml } from "./utils.js";

// Up to four rows fit without scrolling; from the fifth on the list scrolls
// (the CSS height of .dc-card-rows is four and a half rows), and only then is
// it a keyboard stop of its own.
const VISIBLE_ROWS = 4;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function intro(ctx) {
  if (ctx.view === "coach") return "The variables of this team's club and how they are grouped.";
  if (ctx.owner === "system") return "OptiMove's own variables, how they are grouped, and the fields data sources deliver.";
  return `How ${escapeHtml(ctx.clubName || "this club")}'s training data is described: its variables, how they are grouped, and the fields its data sources deliver.`;
}

// One card: its head is the button that opens its screen (the keyboard's and
// the screen reader's way in); a click or a tap anywhere else on the card opens
// it too, through the card's own data-action. Its rows are a list of their own
// that scrolls inside the card: a browser sends no click after a scrolling
// drag, wheel or scrollbar, so scrolling never opens the screen.
function card({ attrs, tile, title, summary, rows = [] }) {
  const scrolls = rows.length > VISIBLE_ROWS;
  const list = rows.length
    ? `<ul class="dc-card-rows${scrolls ? " is-scrolling" : ""}" aria-label="${title}"${scrolls ? ` tabindex="0"` : ""}>${rows.map((row) => `<li class="dc-card-row">${row}</li>`).join("")}</ul>`
    : "";
  return `
    <li class="dc-card" ${attrs}>
      <button type="button" class="dc-card-open" ${attrs}>
        <span class="dc-card-head">
          ${tile}
          <span class="dc-card-title"><strong>${title}</strong><span class="muted">${summary}</span></span>
          ${CHEVRON_HTML}
        </span>
      </button>
      ${list}
    </li>`;
}

// The variables list counts only when it holds the default list: this
// workspace's own active variables, without a filter.
function variablesCard(s) {
  const list = s.list;
  const plain = s.scope === "own" && s.stateFilter === "active" && !s.filter;
  let summary = "Open the list";
  let rows = [];
  if (list.error) summary = "Could not be loaded. Open the list to try again.";
  else if (!list.loaded) summary = list.loading ? "Loading..." : "Open the list";
  else if (plain) {
    const n = list.items.length;
    summary = n ? `${list.nextCursor ? `More than ${n}` : n} active ${n === 1 && !list.nextCursor ? "variable" : "variables"}` : "No active variables yet";
    rows = list.items.map((item) => `${variableTileHtml(item, { size: "sm" })}<span>${escapeHtml(item.label || "")}</span>`);
  }
  return card({ attrs: `data-action="metric-classification-view" data-view="variables"`, tile: variableTileHtml({ icon: "chart-dots" }), title: "Variables", summary, rows });
}

function nodesCard(s, kind) {
  const c = s.classification;
  const nodes = c.tree ? c.tree[kind === "domain" ? "domains" : "categories"] || [] : [];
  const active = nodes.filter((n) => n.state === "active");
  const archived = nodes.length - active.length;
  const noun = kind === "domain" ? ["domain", "domains"] : ["category", "categories"];
  let summary = "Open";
  if (c.error && !c.tree) summary = "Could not be loaded. Open to try again.";
  else if (!c.tree) summary = c.loading ? "Loading..." : "Open";
  else summary = `${active.length ? plural(active.length, noun[0], noun[1]) : `No ${noun[1]} yet`}${archived ? ` · ${archived} archived` : ""}`;
  const rows = active.map((n) => `${nodeTileHtml(kind, n, { size: "sm" })}<span>${escapeHtml(n.name || "")}</span>`);
  return card({
    attrs: `data-action="metric-classification-view" data-view="${kind === "domain" ? "domains" : "categories"}"`,
    tile: nodeTileHtml(kind, null),
    title: kind === "domain" ? "Domains" : "Categories",
    summary,
    rows,
  });
}

function sourceFieldsCard() {
  const list = sourceFieldsState().list;
  let summary = "Open";
  let rows = [];
  if (list.error) summary = "Could not be loaded. Open to try again.";
  else if (!list.loaded) summary = list.loading ? "Loading..." : "Open";
  else {
    summary = list.items.length ? plural(list.items.length, "field", "fields") : "No source fields yet";
    rows = list.items.map((field) => `${fieldTileHtml(currentRevision(field), { size: "sm" })}<span>${escapeHtml(field.label || field.key || "")}</span>`);
  }
  return card({ attrs: `data-action="training-load-section" data-section="source-fields"`, tile: fieldTileHtml({ valueShape: "number" }), title: "Source fields", summary, rows });
}

export function renderDataConfigHomeHtml(s, ctx) {
  return `
    <div class="metric-variables-head">
      <div>
        <h2 id="metric-variables-title" tabindex="-1">Data configuration</h2>
        <p class="muted">${intro(ctx)}</p>
      </div>
    </div>
    ${s.notice ? `<p class="metric-variables-notice" role="status">${escapeHtml(s.notice)}</p>` : ""}
    <ul class="dc-home-grid">
      ${variablesCard(s)}
      ${nodesCard(s, "domain")}
      ${nodesCard(s, "category")}
      ${sourceFieldsContext() ? sourceFieldsCard() : ""}
    </ul>
  `;
}
