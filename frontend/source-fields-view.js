// Training Load -> Data configuration -> Source fields: the markup (phase 6,
// J4). Every text that came from the server or the user is escaped; a unit or
// an evidence reference may hold characters such as `<`, so it is always
// escaped text, never markup and never a link (security review of M2b). Ids
// live only in data- attributes and under Technical details.
import {
  EVIDENCE_EXAMPLE, EVIDENCE_LABEL, EVIDENCE_REF_MAX, OPERATORS, OPERATOR_LABEL, PARAMETER_KIND_LABEL, STATE_LABEL, VALUE_SHAPE_LABEL,
  currentRevision, hasBound, levelsText, meaningActOffered, meaningBlockedByZoneModel, sourceFieldsContext, sourceFieldsState,
  unitActOffered,
} from "./source-fields-data.js";
import { LIMITS } from "./metric-variables-data.js";
import { escapeAttr, escapeHtml } from "./utils.js";
import { fieldTileHtml } from "./data-config-tiles.js";

const fmtDate = (iso) => {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).replaceAll("/", ".");
};
const SOURCE_LABEL = { gpexe: "GPEXE" };
const FAMILY_LABEL = { rest_v1: "REST v1", api: "API" };
const sourceName = (field) => `${escapeHtml(SOURCE_LABEL[field.sourceSystem] || field.sourceSystem || "")} · ${escapeHtml(FAMILY_LABEL[field.apiFamily] || field.apiFamily || "")}`;
const fieldName = (field) => escapeHtml(field.label || field.key || "");
// A unit or a reference: escaped text in a code element, never a link.
const code = (value) => `<code class="source-fields-code">${escapeHtml(value)}</code>`;
// What was saved is a status; a refusal or an unchecked result is a warning,
// never shown like a saved confirmation.
const noticeHtml = (s) => (!s.notice ? ""
  : s.noticeKind === "warning" ? `<p class="metric-variables-notice is-warning" role="alert" tabindex="-1">${escapeHtml(s.notice)}</p>`
  : `<p class="metric-variables-notice" role="status" tabindex="-1">${escapeHtml(s.notice)}</p>`);
const boundUnitLabel = (revision) => (revision.parameterKind === "zone_bounds" ? "Unit of the zone bounds" : "Unit of the threshold");
// The four kinds of evidence, each with its badge (its colour never says it
// alone: every badge keeps its word).
const EVIDENCE_LEGEND = [
  ["unproven", "no evidence yet."],
  ["documented", "described in a document."],
  ["observed", "seen in the source's answers; its unit and meaning are not confirmed."],
  ["verified", "its unit and meaning are confirmed."],
];
function legendHtml() {
  return `
    <ul class="source-fields-legend" aria-label="Evidence">
      ${EVIDENCE_LEGEND.map(([status, text]) => `<li><span class="item-badge source-fields-evidence is-${status}">${escapeHtml(EVIDENCE_LABEL[status])}</span> <span class="muted">${escapeHtml(text)}</span></li>`).join("")}
    </ul>`;
}

export function renderSourceFieldsHtml() {
  const ctx = sourceFieldsContext();
  if (!ctx) return `<section class="metric-variables source-fields"><p class="empty">Source fields are available to administrators in the platform workspace and in a club workspace.</p></section>`;
  const s = sourceFieldsState();
  return `
    <section class="metric-variables source-fields" aria-labelledby="source-fields-title">
      ${s.form ? renderFormHtml(s) : s.detail.id ? renderDetailHtml(s, ctx) : renderListHtml(s, ctx)}
    </section>
  `;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------
function intro(ctx) {
  return ctx.mayVerify
    ? "The fields a data source delivers, with the evidence behind each one. Confirm a field's unit or meaning only with a document under docs/ that proves it."
    : "The fields a data source delivers, with the evidence behind each one. A platform administrator confirms their units and meanings in the platform workspace.";
}
function meaningSummary(revision) {
  if (revision.meaningVerifiedAt) return "Meaning confirmed";
  return revision.parameterKind === "zone_bounds" ? "Meaning waits for the zone decision" : "Meaning not confirmed";
}
function unitSummary(revision) {
  if (!revision) return "No revision";
  if (revision.sourceUnit) return `Unit ${escapeHtml(revision.sourceUnit)} (confirmed)`;
  if (revision.expectedSourceUnit) return `Expected unit ${escapeHtml(revision.expectedSourceUnit)} (not proven)`;
  return "Unit not known yet";
}
function evidenceBadge(revision) {
  if (!revision) return "";
  return `<span class="item-badge source-fields-evidence is-${escapeAttr(revision.evidenceStatus || "")}">Evidence: ${escapeHtml(EVIDENCE_LABEL[revision.evidenceStatus] || revision.evidenceStatus || "")}</span>`;
}

function renderListHtml(s, ctx) {
  const list = s.list;
  const groups = new Map();
  for (const field of list.items) {
    const key = `${field.sourceSystem} ${field.apiFamily}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(field);
  }
  return `
    <button class="plain-button ghost metric-variables-back" type="button" data-action="training-load-section" data-section="variables" data-dc-home>← Data configuration</button>
    <div class="metric-variables-head">
      <div>
        <h2 id="source-fields-title">Source fields</h2>
        <p class="muted">${intro(ctx)}</p>
        ${legendHtml()}
      </div>
    </div>
    ${noticeHtml(s)}
    ${list.loading && !list.loaded ? `<p class="muted" role="status">Loading source fields...</p>` : ""}
    ${list.error ? `<div class="error" role="alert"><p>${escapeHtml(list.error)}</p><button class="plain-button" type="button" data-action="source-fields-reload">Try again</button></div>` : ""}
    ${list.loaded && !list.items.length && !list.error ? `<p class="empty">No source fields yet.</p>` : ""}
    ${[...groups.values()].map((fields) => `
      <section class="metric-classification-section" aria-label="${escapeAttr(`${SOURCE_LABEL[fields[0].sourceSystem] || fields[0].sourceSystem} ${FAMILY_LABEL[fields[0].apiFamily] || fields[0].apiFamily}`)}">
        <h3>${sourceName(fields[0])}</h3>
        <ul class="metric-variables-list">
          ${fields.map((field) => {
            const revision = currentRevision(field);
            return `
            <li>
              <button type="button" class="metric-variables-item dc-item" data-action="source-fields-open" data-field-id="${escapeAttr(field.id)}">
                ${fieldTileHtml(revision)}
                <span class="metric-variables-item-name">${fieldName(field)} ${field.state === "retired" ? `<span class="item-badge">Retired</span>` : ""}</span>
                <span class="metric-variables-item-facts muted">${unitSummary(revision)} · ${revision ? `${meaningSummary(revision)} · ` : ""}${escapeHtml(levelsText(revision))}</span>
                ${evidenceBadge(revision)}
              </button>
            </li>`;
          }).join("")}
        </ul>
      </section>`).join("")}
  `;
}

// ---------------------------------------------------------------------------
// One field with its revisions and its history
// ---------------------------------------------------------------------------
function unitText(revision) {
  if (revision.sourceUnit) return `${code(revision.sourceUnit)} <span class="muted">confirmed ${escapeHtml(fmtDate(revision.unitVerifiedAt))}</span>`;
  if (revision.expectedSourceUnit) return `Not confirmed <span class="muted">(expected ${code(revision.expectedSourceUnit)}, not proven)</span>`;
  return "Not confirmed";
}
function boundUnitText(revision) {
  if (revision.sourceBoundUnit) return code(revision.sourceBoundUnit);
  if (revision.expectedSourceBoundUnit) return `Not confirmed <span class="muted">(expected ${code(revision.expectedSourceBoundUnit)}, not proven)</span>`;
  return "Not confirmed";
}
function meaningText(revision) {
  if (revision.meaningVerifiedAt) return `Confirmed <span class="muted">${escapeHtml(fmtDate(revision.meaningVerifiedAt))}</span>`;
  return revision.parameterKind === "zone_bounds" ? "Not confirmed yet: waits for a decision on zones" : "Not confirmed";
}

// `stale`: the field on the screen may be out of date (a read failed or runs),
// so no act is offered on it.
function renderRevisionHtml(revision, field, ctx, stale) {
  const facts = [
    ["Value", escapeHtml(VALUE_SHAPE_LABEL[revision.valueShape] || revision.valueShape || "")],
    ["Recorded for", escapeHtml(levelsText(revision))],
    ["Parameter", escapeHtml(PARAMETER_KIND_LABEL[revision.parameterKind] || revision.parameterKind || "")],
    ["Unit", unitText(revision)],
    ...(hasBound(revision) ? [[boundUnitLabel(revision), boundUnitText(revision)]] : []),
    ...(revision.parameterKind === "event_threshold" ? [["Operator", revision.boundOperator ? escapeHtml(OPERATOR_LABEL[revision.boundOperator] || revision.boundOperator) : "Not confirmed"]] : []),
    ["Meaning", meaningText(revision)],
    // References are long docs/ paths: each takes the whole row.
    ...(revision.unitEvidenceRef ? [["Unit evidence", code(revision.unitEvidenceRef), true]] : []),
    ...(revision.meaningEvidenceRef ? [["Meaning evidence", code(revision.meaningEvidenceRef), true]] : []),
    ...(revision.evidenceRef && revision.evidenceRef !== revision.unitEvidenceRef && revision.evidenceRef !== revision.meaningEvidenceRef ? [["First evidence", code(revision.evidenceRef), true]] : []),
  ];
  const unitOffered = !stale && unitActOffered(ctx, field, revision);
  const meaningOffered = !stale && meaningActOffered(ctx, field, revision);
  const zoneBlocked = !stale && meaningBlockedByZoneModel(ctx, field, revision);
  return `
    <li class="metric-variables-version source-fields-revision">
      <div class="source-fields-revision-head">
        <strong>Revision ${escapeHtml(String(revision.revisionNumber ?? ""))}</strong>
        <span class="item-badge">${escapeHtml(STATE_LABEL[revision.state] || revision.state || "")}</span>
        ${evidenceBadge(revision)}
      </div>
      <dl class="metric-variables-facts">
        ${facts.map(([name, value, wide]) => `<div${wide ? ` class="source-fields-wide"` : ""}><dt>${name}</dt><dd>${value}</dd></div>`).join("")}
      </dl>
      ${unitOffered || meaningOffered || zoneBlocked ? `<div class="metric-variables-actions source-fields-acts">
        ${unitOffered ? `<button class="plain-button" type="button" data-action="source-fields-act-open" data-act="unit" data-revision-id="${escapeAttr(revision.id)}">Confirm the unit</button>` : ""}
        ${meaningOffered ? `<button class="plain-button" type="button" data-action="source-fields-act-open" data-act="meaning" data-revision-id="${escapeAttr(revision.id)}">Confirm the meaning</button>` : ""}
        ${zoneBlocked ? `<button class="plain-button" type="button" disabled aria-describedby="sf-zone-${escapeAttr(revision.id)}">Confirm the meaning</button>` : ""}
      </div>` : ""}
      ${zoneBlocked ? `<p class="muted" id="sf-zone-${escapeAttr(revision.id)}">The meaning of a zone cannot be confirmed yet: how closed and open zones share one bound operator is not decided. <span class="source-fields-code-label">Code: ${code("verification_model_unresolved")}</span></p>` : ""}
    </li>`;
}

function renderDetailHtml(s, ctx) {
  const d = s.detail;
  const back = `<button class="plain-button ghost metric-variables-back" type="button" data-action="source-fields-back">← All source fields</button>`;
  if (!d.field) {
    if (d.loading) return `${back}<p class="muted" role="status">Loading the field...</p>`;
    return `${back}${noticeHtml(s)}
      ${d.error ? `<div class="error" role="alert"><p>${escapeHtml(d.error)}</p><button class="plain-button" type="button" data-action="source-fields-detail-reload">Try again</button></div>` : `<p class="empty">This field is not available.</p>`}`;
  }
  const field = d.field;
  const stale = Boolean(d.error) || d.loading;
  const revisionNumber = new Map((field.revisions || []).map((r) => [r.id, r.revisionNumber]));
  return `
    ${back}
    <div class="metric-variables-head">
      <div>
        <h2 id="source-fields-title">${fieldName(field)}</h2>
        <p class="muted">${sourceName(field)} · ${code(field.key || "")} ${field.state === "retired" ? `<span class="item-badge">Retired</span>` : ""}</p>
      </div>
    </div>
    ${noticeHtml(s)}
    ${d.loading ? `<p class="muted" role="status">Loading the field...</p>` : ""}
    ${d.error ? `<div class="error" role="alert"><p>${escapeHtml(d.error)} The field below may be out of date.</p><button class="plain-button" type="button" data-action="source-fields-detail-reload">Try again</button></div>` : ""}
    ${ctx.mayVerify ? "" : `<p class="muted">Read only here: a platform administrator confirms units and meanings in the platform workspace.</p>`}
    <h3>Revisions</h3>
    ${(field.revisions || []).length ? `<ol class="metric-variables-versions">${field.revisions.map((r) => renderRevisionHtml(r, field, ctx, stale)).join("")}</ol>` : `<p class="muted">No revisions.</p>`}
    <h3>Confirmations</h3>
    ${d.verifications.length ? `<ul class="metric-variables-versions source-fields-history">${d.verifications.map((v) => `
      <li class="metric-variables-version">
        <span>Revision ${escapeHtml(String(revisionNumber.get(v.revisionId) ?? "?"))} · ${v.act === "unit" ? "Unit confirmed" : "Meaning confirmed"} · ${escapeHtml(fmtDate(v.at))}</span>
        ${v.evidenceRef ? `<span class="muted">Evidence ${code(v.evidenceRef)}</span>` : ""}
      </li>`).join("")}</ul>` : `<p class="muted">Nothing confirmed yet.</p>`}
    <details class="data-sources-tech"><summary>Technical details</summary><dl>
      <div><dt>Field id</dt><dd>${escapeHtml(field.id)}</dd></div>
      ${(field.revisions || []).map((r) => `<div><dt>Revision ${escapeHtml(String(r.revisionNumber ?? ""))} id</dt><dd>${escapeHtml(r.id)}</dd></div>`).join("")}
    </dl></details>
  `;
}

// ---------------------------------------------------------------------------
// The two acts
// ---------------------------------------------------------------------------
const fieldError = (form, field) => (form.errors[field] ? `<span class="metric-variables-field-error" id="sf-err-${field}">${escapeHtml(form.errors[field])}</span>` : "");
const described = (form, field, hint) => {
  const ids = [hint ? `sf-hint-${field}` : "", form.errors[field] ? `sf-err-${field}` : ""].filter(Boolean).join(" ");
  return ids ? ` aria-describedby="${ids}"` : "";
};
const invalid = (form, field) => (form.errors[field] ? ` aria-invalid="true"` : "");
const TOKEN_ATTRS = ` autocapitalize="none" autocorrect="off" spellcheck="false"`;
function textInput(form, field, label, { max, hint = "" } = {}) {
  const locked = form.busy || form.unconfirmed;
  return `
    <label class="search-field"><span>${escapeHtml(label)}</span>
      <input type="text" data-sf-field="${field}" value="${escapeAttr(form.draft[field] ?? "")}" maxlength="${max}" autocomplete="off"${TOKEN_ATTRS} ${locked ? "disabled" : ""}${described(form, field, hint)}${invalid(form, field)}>
      ${hint ? `<span class="muted" id="sf-hint-${field}">${hint}</span>` : ""}
      ${fieldError(form, field)}
    </label>`;
}
function unconfirmedHtml(form) {
  return `
    <div class="metric-variables-unconfirmed" role="alert">
      <p><strong>Result not confirmed.</strong> No answer arrived, so it is not known whether the confirmation was saved. Check result sends the same request again: it is never saved twice.</p>
      ${form.checkNote ? `<p>${escapeHtml(form.checkNote)}</p>` : ""}
      <div class="data-sources-form-actions">
        <button class="plain-button data-sources-primary" type="button" data-action="source-fields-check-result" ${form.busy ? "disabled" : ""}>${form.busy ? "Checking..." : "Check result"}</button>
        <button class="plain-button ghost" type="button" data-action="source-fields-cancel" ${form.busy ? "disabled" : ""}>Close without checking</button>
      </div>
    </div>`;
}
const EVIDENCE_HINT = `A path under docs/ with one heading anchor, for example ${EVIDENCE_EXAMPLE}. The document must already be merged.`;
const SOURCE_NAME_TEXT = (form) => `${SOURCE_LABEL[form.sourceSystem] || form.sourceSystem} · ${FAMILY_LABEL[form.apiFamily] || form.apiFamily}`;

function renderFormHtml(s) {
  const form = s.form;
  const name = `${escapeHtml(form.fieldName)} (revision ${escapeHtml(String(form.revisionNumber ?? ""))})`;
  const bound = form.parameterKind === "zone_bounds" || form.parameterKind === "event_threshold";
  const locked = form.busy || form.unconfirmed;
  let body = "";
  let submit = [];
  if (form.act === "unit") {
    body = `
      ${textInput(form, "sourceUnit", "Unit the source delivers", { max: LIMITS.unit, hint: form.expectedSourceUnit ? `Expected, not proven: ${escapeHtml(form.expectedSourceUnit)}. Enter what the evidence shows.` : "Enter what the evidence shows, for example s, m or km/h." })}
      ${bound ? textInput(form, "sourceBoundUnit", form.parameterKind === "zone_bounds" ? "Unit of the zone bounds" : "Unit of the threshold", { max: LIMITS.unit, hint: form.expectedSourceBoundUnit ? `Expected, not proven: ${escapeHtml(form.expectedSourceBoundUnit)}.` : "The unit of the bound the source applies." }) : ""}
      ${textInput(form, "evidenceRef", "Evidence (a document under docs/)", { max: EVIDENCE_REF_MAX, hint: EVIDENCE_HINT })}`;
    submit = ["Confirm the unit", "Confirming..."];
  } else {
    const threshold = form.parameterKind === "event_threshold";
    body = `
      <p class="metric-variables-field-note">The meaning itself is kept in the evidence document. Confirm only when that document holds this field's definition from GPEXE documentation or written GPEXE support.</p>
      ${threshold ? `
      <label class="search-field"><span>When does GPEXE count an event?</span>
        <select data-sf-field="boundOperator" ${locked ? "disabled" : ""}${described(form, "boundOperator", "hint")}${invalid(form, "boundOperator")}>
          <option value="" ${form.draft.boundOperator ? "" : "selected"}>Choose...</option>
          ${OPERATORS.map((op) => `<option value="${escapeAttr(op)}" ${form.draft.boundOperator === op ? "selected" : ""}>${escapeHtml(OPERATOR_LABEL[op])}</option>`).join("")}
        </select>
        <span class="muted" id="sf-hint-boundOperator">As GPEXE's documentation or written support states.</span>
        ${fieldError(form, "boundOperator")}
      </label>` : ""}
      ${textInput(form, "evidenceRef", "Evidence (a document under docs/)", { max: EVIDENCE_REF_MAX, hint: EVIDENCE_HINT })}`;
    submit = ["Confirm the meaning", "Confirming..."];
  }
  return `
    <form class="data-sources-form metric-variables-form source-fields-form" data-source-fields-form="${form.act}" novalidate autocomplete="off">
      <h2 id="source-fields-title">${form.act === "unit" ? "Confirm the unit of" : "Confirm the meaning of"} ${name}</h2>
      <p class="muted source-fields-summary">${escapeHtml(form.fieldName)} · ${code(form.fieldKey)} · ${escapeHtml(SOURCE_NAME_TEXT(form))} · ${escapeHtml(VALUE_SHAPE_LABEL[form.valueShape] || form.valueShape || "")} · ${escapeHtml(form.levels)} · Parameter: ${escapeHtml(PARAMETER_KIND_LABEL[form.parameterKind] || form.parameterKind || "")}</p>
      <p class="metric-variables-field-note">A confirmation is saved once and never changed: a correction is a new revision. Confirm only what the evidence document proves.</p>
      <p class="muted">Do not enter athlete names, ids, dates of birth or measured values.</p>
      ${body}
      ${form.error ? `<p class="error" role="alert">${escapeHtml(form.error)}</p>` : ""}
      ${form.unconfirmed ? unconfirmedHtml(form) : `
      <div class="data-sources-form-actions">
        <button class="plain-button data-sources-primary" type="submit" ${form.busy ? "disabled" : ""}>${form.busy ? submit[1] : submit[0]}</button>
        <button class="plain-button ghost" type="button" data-action="source-fields-cancel" ${form.busy ? "disabled" : ""}>Cancel</button>
      </div>`}
    </form>`;
}
