// Training Load -> Data configuration -> Mappings: the markup (phase 8, J16).
// Every text that came from the server, a source or the user is escaped; a
// name written by another administrator or a source is cleaned (control and
// format characters removed, at most 80 characters) before it is escaped in a
// review card. Ids live only in data- attributes and under Technical details.
import {
  ACTS_SENTENCE, END_REASON_LABEL, FREE_TEXT_NOTE, NOT_FOR_IMPORT_SENTENCE, NOTE_MAX, REASON_MAX, REQUIREMENT_LABEL, REQUIREMENT_MEANING,
  STATUS_LABEL, chosenRevision, cleanName, conversionWords, expectedBounds, fieldStatus, hasBound, levelsOf, mappingStateText,
  mappingsContext, mappingsState, notForImport, notForImportBadge, orderedTargets, reversePair, sourceLabel,
} from "./metric-mappings-data.js";
import {
  activateBlocker, activeVersion, bindingFacts, chooserTeams, chosenBindings, fieldOf, fieldTakenBy, flowFacts, inOwnerWorkspace,
  mayTransition, teamNameOf,
} from "./metric-mappings-actions.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const fmtDate = (iso) => {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).replaceAll("/", ".");
};
const code = (value) => `<code class="source-fields-code">${escapeHtml(value)}</code>`;
// A name in a review card: cleaned, then escaped, in quotes.
const named = (value) => `“${escapeHtml(cleanName(value))}”`;
const noticeHtml = (s) => (!s.notice ? ""
  : s.noticeKind === "warning" ? `<p class="metric-variables-notice is-warning" role="alert" tabindex="-1">${escapeHtml(s.notice)}</p>`
  : `<p class="metric-variables-notice" role="status" tabindex="-1">${escapeHtml(s.notice)}</p>`);
const ownerBadge = (mapping, ctx) => (mapping.ownerScope === "system"
  ? `<span class="item-badge">System</span>`
  : `<span class="item-badge metric-mappings-club-badge">${escapeHtml(cleanName(ctx.clubName) || "Club")}</span>`);
const sourceOfMapping = (s, mapping) => sourceLabel(fieldOf(mapping, s)?.sourceSystem || "gpexe");
const levelsWords = (session, drill) => [session ? "Session" : "", drill ? "Drill" : ""].filter(Boolean).join(" and ") || "None";
const OPERATOR_WORDS = { between: "between", ">=": "at least", ">": "more than", "<=": "at most", "<": "less than" };
function boundsWords(kind, p, unit) {
  if (!p) return "";
  if (kind === "zone_bounds") return p.upper !== null && p.upper !== undefined ? `${p.lower}–${p.upper} ${unit}` : `${OPERATOR_WORDS[p.operator] || p.operator} ${p.lower} ${unit}`;
  return `${OPERATOR_WORDS[p.operator] || p.operator} ${p.value ?? p.threshold_value} ${unit}, for at least ${p.duration_seconds} s`;
}

export function renderMappingsHtml() {
  const ctx = mappingsContext();
  if (!ctx) return `<section class="metric-variables metric-mappings"><p class="empty">Mappings are available to administrators in the platform workspace and in a club workspace.</p></section>`;
  const s = mappingsState();
  const body = s.view === "flow" && s.flow ? renderFlowHtml(s, ctx) : s.view === "detail" && s.detail.id ? renderDetailHtml(s, ctx) : renderListHtml(s, ctx);
  return `<section class="metric-variables metric-mappings" aria-labelledby="metric-mappings-title">${body}</section>`;
}

// ---------------------------------------------------------------------------
// The write in progress
// ---------------------------------------------------------------------------
function writeHtml(s) {
  const w = s.write;
  if (!w) return "";
  if (w.unconfirmed) {
    return `
      <div class="metric-variables-unconfirmed" role="alert">
        <p><strong>Result not confirmed.</strong> No answer arrived, so it is not known whether the change was saved. Check result sends the same request again: it is never saved twice.</p>
        ${w.checkNote ? `<p>${escapeHtml(w.checkNote)}</p>` : ""}
        <div class="data-sources-form-actions">
          <button class="plain-button data-sources-primary" type="button" data-action="metric-mappings-check-result" ${w.busy ? "disabled" : ""}>${w.busy ? "Checking..." : "Check result"}</button>
          <button class="plain-button ghost" type="button" data-action="metric-mappings-close-unchecked" ${w.busy ? "disabled" : ""}>Close without checking</button>
        </div>
      </div>`;
  }
  if (w.busy) return `<p class="muted" role="status">Saving...</p>`;
  if (w.error) {
    return `<div class="error" role="alert"><p>${escapeHtml(w.error)}</p>
      ${w.code ? `<details class="data-sources-tech"><summary>Technical details</summary><dl><div><dt>Code</dt><dd>${escapeHtml(w.code)}</dd></div></dl></details>` : ""}</div>`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// The list (J16 4.1)
// ---------------------------------------------------------------------------
function anyFieldReady(s) {
  return s.refs.fields.some((f) => fieldStatus(f).choosable);
}
function emptyStateHtml(s, ctx) {
  if (!s.refs.loaded || anyFieldReady(s)) return `<p class="empty">No mappings yet. Start with New mapping.</p>`;
  return ctx.owner === "system"
    ? `<p class="empty">No source field is ready yet. Confirm a field's unit first in <button class="plain-button ghost inline-link" type="button" data-action="training-load-section" data-section="source-fields">Source fields</button>.</p>`
    : `<p class="empty">No source field is ready yet. A platform administrator confirms a field's unit in the platform workspace first.</p>`;
}
function renderListHtml(s, ctx) {
  const list = s.list;
  return `
    <button class="plain-button ghost metric-variables-back" type="button" data-action="training-load-section" data-section="variables" data-dc-home>← Data configuration</button>
    <div class="metric-variables-head">
      <div>
        <h2 id="metric-mappings-title" tabindex="-1">Mappings</h2>
        <p class="muted">A mapping tells OptiMove which source field fills which of your variables.${ctx.owner === "club" ? " System mappings come from a platform administrator; you switch them on for your teams." : ""}</p>
        <p class="muted">${ACTS_SENTENCE}</p>
      </div>
      <button class="plain-button data-sources-primary" type="button" data-action="metric-mappings-new" ${s.write ? "disabled" : ""}>New mapping</button>
    </div>
    ${noticeHtml(s)}
    ${list.loading && !list.loaded ? `<p class="muted" role="status">Loading mappings...</p>` : ""}
    ${list.error ? `<div class="error" role="alert"><p>${escapeHtml(list.error)}</p><button class="plain-button" type="button" data-action="metric-mappings-reload">Try again</button></div>` : ""}
    ${list.loaded && !list.items.length && !list.error ? emptyStateHtml(s, ctx) : ""}
    ${list.items.length ? `<ul class="metric-variables-list">${list.items.map((m) => `
      <li>
        <button type="button" class="metric-variables-item dc-item" data-action="metric-mappings-open" data-mapping-id="${escapeAttr(m.id)}">
          <span class="metric-variables-item-name">${escapeHtml(m.target?.label || m.target?.key || "")} ${ownerBadge(m, ctx)}</span>
          <span class="metric-variables-item-facts muted">from ${escapeHtml(m.sourceMetric?.label || m.sourceMetric?.key || "")} · ${escapeHtml(sourceOfMapping(s, m))} · ${escapeHtml(mappingStateText(m))}</span>
        </button>
      </li>`).join("")}</ul>` : ""}
    ${list.nextCursor ? `<button class="plain-button" type="button" data-action="metric-mappings-more" ${list.loadingMore ? "disabled" : ""}>${list.loadingMore ? "Loading..." : "Load more"}</button>` : ""}
  `;
}

// ---------------------------------------------------------------------------
// The guided flow (J16 4.2–4.5)
// ---------------------------------------------------------------------------
const STEP_NAMES = ["The field", "The variable", "The unit and the details", "Review"];
function stepsHtml(f) {
  const first = f.fixed ? 3 : 1;
  return `<ol class="metric-mappings-steps" aria-label="Steps">${STEP_NAMES.map((name, i) => {
    const step = i + 1;
    if (step < first) return "";
    const current = step === f.step;
    const done = step < f.step;
    return `<li class="${current ? "is-current" : ""}"${current ? ` aria-current="step"` : ""}>${done
      ? `<button class="plain-button ghost" type="button" data-action="metric-mappings-flow-step" data-step="${step}">${escapeHtml(name)}</button>`
      : `<span>${escapeHtml(name)}</span>`}</li>`;
  }).join("")}</ol>
  <p class="muted">Step ${f.step} of 4</p>`;
}
function refsStateHtml(s) {
  if (s.refs.error) return `<div class="error" role="alert"><p>${escapeHtml(s.refs.error)}</p><button class="plain-button" type="button" data-action="metric-mappings-refs-reload">Try again</button></div>`;
  if (!s.refs.loaded) return `<p class="muted" role="status">Loading...</p>`;
  return "";
}
function stepFieldHtml(s, ctx) {
  const groups = new Map();
  for (const field of s.refs.fields) {
    const key = field.sourceSystem;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(field);
  }
  const noneReady = !anyFieldReady(s);
  return `
    <h3>Which source field?</h3>
    ${noneReady ? `<p class="metric-variables-field-note">${ctx.owner === "system"
      ? `No field is ready yet: confirm a field's unit first in <button class="plain-button ghost inline-link" type="button" data-action="training-load-section" data-section="source-fields">Source fields</button>.`
      : "No field is ready yet: a platform administrator confirms a field's unit in the platform workspace first."}</p>` : ""}
    ${[...groups.entries()].map(([source, fields]) => `
      <section class="metric-classification-section" aria-label="${escapeAttr(sourceLabel(source))}">
        <h4>${escapeHtml(sourceLabel(source))}</h4>
        <ul class="metric-variables-list">${fields.map((field) => {
          const st = fieldStatus(field);
          const revision = chosenRevision(field);
          const facts = [
            revision?.sourceUnit ? `Unit ${escapeHtml(revision.sourceUnit)}` : "",
            revision ? levelsWords(revision.supportsSession, revision.supportsDrill) : "",
          ].filter(Boolean).join(" · ");
          return `<li>
            <button type="button" class="metric-variables-item metric-mappings-choice${st.choosable ? "" : " is-unavailable"}" data-action="metric-mappings-flow-field" data-field-id="${escapeAttr(field.id)}" ${st.choosable ? "" : `aria-disabled="true"`}${s.flow.fieldId === field.id ? ` aria-pressed="true"` : ""}>
              <span class="metric-variables-item-name">${escapeHtml(field.label || field.key || "")}</span>
              <span class="metric-variables-item-facts muted">${facts}</span>
              ${st.choosable ? (st.meaningPending ? `<span class="muted">You can save a draft now; it can be activated only once the field's meaning is confirmed.</span>` : "")
                : `<span class="metric-mappings-reason">${escapeHtml(st.reason)}${st.unitMissing && ctx.owner !== "system" ? " A platform administrator confirms it in the platform workspace." : ""}</span>`}
            </button>
          </li>`;
        }).join("")}</ul>
      </section>`).join("")}`;
}
function stepTargetHtml(s, ctx) {
  const { field, revision } = flowFacts(s);
  if (!revision) return "";
  const ordered = orderedTargets(s.refs.targets, revision, s.refs.conversions);
  const taken = fieldTakenBy(s, s.flow.fieldId, s.flow.targetId);
  return `
    <h3>Which variable should ${escapeHtml(field.label || field.key || "this field")} fill?</h3>
    <p class="muted">The field gives ${code(revision.sourceUnit)}. Variables with the same unit come first.</p>
    ${ctx.isPlatformAdmin ? `<p class="muted">Unit conversions cannot be added on this screen yet.</p>` : ""}
    ${taken ? `<p class="metric-variables-field-note">This field already fills ${escapeHtml(taken.target?.label || "another variable")}. Only one of them can be active at a time.</p>` : ""}
    ${ordered.length ? `<ul class="metric-variables-list">${ordered.map(({ target, status }) => `
      <li>
        <button type="button" class="metric-variables-item metric-mappings-choice${status.choosable ? "" : " is-unavailable"}" data-action="metric-mappings-flow-target" data-target-id="${escapeAttr(target.id)}" ${status.choosable ? "" : `aria-disabled="true"`}${s.flow.targetId === target.id ? ` aria-pressed="true"` : ""}>
          <span class="metric-variables-item-name">${escapeHtml(target.label || target.key || "")}
            ${status.choosable ? (status.badge === "same" ? `<span class="item-badge is-suggested">Same unit</span>` : `<span class="item-badge">Converted from ${escapeHtml(revision.sourceUnit)}</span>`) : ""}</span>
          <span class="metric-variables-item-facts muted">${target.currentVersion?.unit ? `Unit ${escapeHtml(target.currentVersion.unit)}` : "No unit"}</span>
          ${status.choosable ? "" : `<span class="metric-mappings-reason">${escapeHtml(status.reason)}</span>`}
        </button>
      </li>`).join("")}</ul>` : `<p class="empty">No variables yet.</p>`}
    <p class="muted">Missing a variable? Create it in <button class="plain-button ghost inline-link" type="button" data-action="training-load-section" data-section="variables" data-dc-view="variables">Variables</button>.</p>`;
}
const fieldError = (f, name) => (f.errors[name] ? `<span class="metric-variables-field-error" id="mm-err-${name}">${escapeHtml(f.errors[name])}</span>` : "");
const invalid = (f, name) => (f.errors[name] ? ` aria-invalid="true" aria-describedby="mm-err-${name}"` : "");
function decimalInput(f, name, label, hint, locked) {
  return `
    <label class="search-field"><span>${escapeHtml(label)}</span>
      <input type="text" inputmode="decimal" data-mm-field="flow.${name}" value="${escapeAttr(f.draft[name] ?? "")}" maxlength="22" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" ${locked ? "disabled" : ""}${invalid(f, name)}>
      ${hint ? `<span class="muted">${hint}</span>` : ""}
      ${fieldError(f, name)}
    </label>`;
}
function stepDetailsHtml(s, locked) {
  const f = s.flow;
  const { revision, target, status } = flowFacts(s);
  if (!revision || !target || !status?.choosable) return `<p class="error" role="alert">This field and variable can no longer be mapped. Go back and choose again.</p>`;
  const unit = target.currentVersion?.unit;
  const levels = levelsOf(revision, target);
  const conversion = status.conversion;
  const back = reversePair(s.refs.conversions, conversion);
  const expected = expectedBounds(revision, target, s.refs.conversions);
  const boundUnit = revision.sourceBoundUnit;
  return `
    ${f.mappingId ? `<p class="metric-variables-field-note">A mapping of this field to this variable exists; this becomes its next version.</p>` : ""}
    <h3>The unit</h3>
    ${conversion ? `<p>${code(revision.sourceUnit)} → ${code(unit)}: ${escapeHtml(conversionWords(conversion))}</p>
      ${back ? `<p class="muted">The way back: ${escapeHtml(conversionWords(back.conversion))}${back.agree === false ? " — the two do not agree; ask a platform administrator to check them." : ""}</p>` : ""}
      <label class="search-field"><span>Conversion note</span>
        <input type="text" data-mm-field="flow.conversionNote" value="${escapeAttr(f.draft.conversionNote)}" maxlength="${NOTE_MAX}" autocomplete="off" ${locked ? "disabled" : ""}${invalid(f, "conversionNote")}>
        <span class="muted">For example: GPEXE gives seconds; the variable is in minutes. Every administrator who can read this mapping sees this note${s.flow && mappingsContext()?.owner === "system" ? ", every club administrator included" : ""}. ${FREE_TEXT_NOTE}</span>
        ${fieldError(f, "conversionNote")}
      </label>`
      : `<p>Same unit: no conversion (${code(revision.sourceUnit)}).</p>`}
    <h3>Levels</h3>
    ${levels.session && levels.drill ? `
      <fieldset class="metric-variables-fieldset"${invalid(f, "levels")}>
        <legend>Which levels does this mapping fill?</legend>
        <label class="source-fields-choice"><input type="checkbox" data-mm-field="flow.session" ${f.draft.session ? "checked" : ""} ${locked ? "disabled" : ""}><span>Session</span></label>
        <label class="source-fields-choice"><input type="checkbox" data-mm-field="flow.drill" ${f.draft.drill ? "checked" : ""} ${locked ? "disabled" : ""}><span>Drill</span></label>
        ${fieldError(f, "levels")}
      </fieldset>`
      : `<p>${levels.session ? "Session" : "Drill"} only: the only level both the field and the variable allow.</p>`}
    ${hasBound(revision) && expected?.exact ? `
      <h3>${revision.parameterKind === "zone_bounds" ? "The zone" : "The threshold"}</h3>
      <p class="muted">The field's operator: ${escapeHtml(OPERATOR_WORDS[revision.boundOperator] || revision.boundOperator)}. Enter the bound GPEXE uses for this field, in ${code(boundUnit)}.</p>
      ${revision.parameterKind === "zone_bounds" ? `
        ${decimalInput(f, "lower", `Lower bound (${boundUnit})`, `The variable's ${escapeHtml(expected.params.lower)} ${escapeHtml(expected.params.unit)} is ${escapeHtml(expected.lower)} ${escapeHtml(boundUnit)}.`, locked)}
        ${revision.boundOperator === "between" ? decimalInput(f, "upper", `Upper bound (${boundUnit})`, `The variable's ${escapeHtml(expected.params.upper)} ${escapeHtml(expected.params.unit)} is ${escapeHtml(expected.upper)} ${escapeHtml(boundUnit)}.`, locked) : ""}`
      : `
        ${decimalInput(f, "thresholdValue", `Threshold (${boundUnit})`, `The variable's ${escapeHtml(expected.params.value)} ${escapeHtml(expected.params.unit)} is ${escapeHtml(expected.thresholdValue)} ${escapeHtml(boundUnit)}.`, locked)}
        ${decimalInput(f, "durationSeconds", "Duration (seconds)", `The variable's duration is ${escapeHtml(expected.durationSeconds)} s.`, locked)}`}
    ` : ""}
    ${f.error ? `<p class="error" role="alert">${escapeHtml(f.error)}</p>` : ""}
    <div class="data-sources-form-actions">
      <button class="plain-button data-sources-primary" type="button" data-action="metric-mappings-flow-review" ${locked ? "disabled" : ""}>Review</button>
      <button class="plain-button ghost" type="button" data-action="metric-mappings-flow-cancel" ${locked ? "disabled" : ""}>Cancel</button>
    </div>`;
}
function stepReviewHtml(s, locked) {
  const f = s.flow;
  const { field, revision, target, status } = flowFacts(s);
  if (!revision || !target || !status?.choosable) return "";
  const levels = levelsOf(revision, target);
  const session = levels.session && levels.drill ? f.draft.session : levels.session;
  const drill = levels.session && levels.drill ? f.draft.drill : levels.drill;
  const bound = revision.parameterKind === "zone_bounds"
    ? boundsWords("zone_bounds", { operator: revision.boundOperator, lower: f.draft.lower, upper: revision.boundOperator === "between" ? f.draft.upper : null }, revision.sourceBoundUnit)
    : revision.parameterKind === "event_threshold"
      ? boundsWords("event_threshold", { operator: revision.boundOperator, value: f.draft.thresholdValue, duration_seconds: f.draft.durationSeconds }, revision.sourceBoundUnit) : "";
  return `
    <div class="metric-mappings-review-card" tabindex="-1">
      <h3>Review the draft</h3>
      <dl class="metric-variables-facts">
        <div><dt>Field</dt><dd>${named(field.label || field.key)} · ${escapeHtml(sourceLabel(field.sourceSystem))}</dd></div>
        <div><dt>Variable</dt><dd>${named(target.label || target.key)}</dd></div>
        <div><dt>Unit</dt><dd>${status.conversion ? escapeHtml(conversionWords(status.conversion)) : `Same unit (${escapeHtml(revision.sourceUnit)})`}</dd></div>
        <div><dt>Levels</dt><dd>${escapeHtml(levelsWords(session, drill))}</dd></div>
        ${bound ? `<div><dt>Bound</dt><dd>${escapeHtml(bound)}</dd></div>` : ""}
        ${status.conversion ? `<div class="source-fields-wide"><dt>Conversion note</dt><dd>${escapeHtml(cleanName(f.draft.conversionNote, 500))}</dd></div>` : ""}
      </dl>
      <p class="muted">A draft changes nothing yet: it is submitted for review, and a platform administrator activates it.</p>
    </div>
    ${writeHtml(s)}
    ${s.write?.unconfirmed ? "" : `
    <div class="data-sources-form-actions">
      <button class="plain-button data-sources-primary" type="button" data-action="metric-mappings-flow-save" ${locked ? "disabled" : ""}>${s.write?.busy ? "Saving..." : "Save draft"}</button>
      <button class="plain-button ghost" type="button" data-action="metric-mappings-flow-cancel" ${locked ? "disabled" : ""}>Cancel</button>
    </div>`}`;
}
function renderFlowHtml(s, ctx) {
  const f = s.flow;
  const locked = Boolean(s.write?.busy || s.write?.unconfirmed);
  const { field, target } = flowFacts(s);
  const title = f.fixed ? `New version of ${escapeHtml(target?.label || "the mapping")} from ${escapeHtml(field?.label || "the field")}` : "New mapping";
  let body = refsStateHtml(s);
  if (!body) {
    if (f.step === 1) body = stepFieldHtml(s, ctx);
    else if (f.step === 2) body = stepTargetHtml(s, ctx);
    else if (f.step === 3) body = stepDetailsHtml(s, locked);
    else body = stepReviewHtml(s, locked);
  }
  return `
    <div class="metric-variables-head metric-mappings-flow">
      <div>
        <h2 id="metric-mappings-title" tabindex="-1">${title}</h2>
        ${stepsHtml(f)}
      </div>
    </div>
    ${noticeHtml(s)}
    <div class="metric-mappings-flow">${body}</div>
    ${f.step < 3 ? `<div class="data-sources-form-actions"><button class="plain-button ghost" type="button" data-action="metric-mappings-flow-cancel">Cancel</button></div>` : ""}
  `;
}

// ---------------------------------------------------------------------------
// The detail (J16 5, 6, 7)
// ---------------------------------------------------------------------------
function versionFactsHtml(s, mapping, v) {
  const kind = v.parameterKind;
  const factor = v.sourceUnit === v.targetUnit ? `Same unit (${escapeHtml(v.sourceUnit || "")})`
    : `${escapeHtml(v.sourceUnit || "")} → ${escapeHtml(v.targetUnit || "")}`;
  const dates = [
    v.createdAt ? `created ${fmtDate(v.createdAt)}` : "",
    v.submittedAt ? `submitted ${fmtDate(v.submittedAt)}` : "",
    v.activatedAt ? `activated ${fmtDate(v.activatedAt)}` : "",
    v.disabledAt ? `disabled ${fmtDate(v.disabledAt)}` : "",
  ].filter(Boolean).join(" · ");
  return `
    <dl class="metric-variables-facts">
      <div><dt>Unit</dt><dd>${factor}</dd></div>
      <div><dt>Levels</dt><dd>${escapeHtml(levelsWords(v.appliesToSession, v.appliesToDrill))}</dd></div>
      ${kind && kind !== "none" ? `<div><dt>Bound</dt><dd>${escapeHtml(boundsWords(kind, v.sourceParameters, v.sourceParameters?.unit || ""))}</dd></div>` : ""}
      ${v.conversionNote ? `<div class="source-fields-wide"><dt>Conversion note</dt><dd>${escapeHtml(v.conversionNote)}</dd></div>` : ""}
      <div class="source-fields-wide"><dt>Dates</dt><dd>${escapeHtml(dates)}</dd></div>
    </dl>`;
}
// The one primary act of the mapping (J16 5): Activate (or Replace) a version
// waiting for review, Submit a draft, Switch on an active version no team uses.
function primaryAct(s, mapping, ctx) {
  const waiting = (mapping.versions || []).find((v) => v.status === "needs_review");
  if (waiting && mayTransition(mapping, ctx) && !activateBlocker(mapping, waiting, s)) return { versionId: waiting.id, act: "activate" };
  const draft = (mapping.versions || []).find((v) => v.status === "draft");
  if (draft && inOwnerWorkspace(mapping, ctx)) return { versionId: draft.id, act: "submit" };
  const active = activeVersion(mapping);
  if (active && s.teams.versionId === active.id && !s.teams.loading && !s.teams.error && !s.teams.rows.some((r) => !r.endedAt)) return { versionId: active.id, act: "switchOn" };
  return null;
}
function actButton(primary, versionId, act, label, action, disabled) {
  const isPrimary = primary && primary.versionId === versionId && primary.act === act;
  return `<button class="plain-button${isPrimary ? " data-sources-primary" : ""}" type="button" data-action="${action}" data-version-id="${escapeAttr(versionId)}" ${disabled ? "disabled" : ""}>${label}</button>`;
}
function versionActsHtml(s, mapping, v, ctx, primary) {
  // While the mapping is read again (after a change), its acts wait for the fresh state.
  const busy = Boolean(s.write || s.panel || s.detail.loading);
  const acts = [];
  const notes = [];
  const active = activeVersion(mapping);
  if (v.status === "draft") {
    if (inOwnerWorkspace(mapping, ctx)) acts.push(actButton(primary, v.id, "submit", "Submit for review", "metric-mappings-submit", busy));
  }
  if (v.status === "needs_review") {
    if (mayTransition(mapping, ctx)) {
      const blocker = activateBlocker(mapping, v, s);
      if (blocker) notes.push(blocker);
      else acts.push(actButton(primary, v.id, "activate", active ? `Replace version ${active.versionNumber}` : "Activate", "metric-mappings-activate-open", busy));
    } else if (mapping.ownerScope === "club" && !ctx.isPlatformAdmin) {
      notes.push(`Ask a platform administrator who also administers ${cleanName(ctx.clubName) || "this club"} to activate it in this workspace.`);
    } else if (mapping.ownerScope === "system" && ctx.owner === "club") {
      notes.push(ctx.isPlatformAdmin ? "Activate it in the platform workspace." : "A platform administrator activates system mappings in the platform workspace.");
    }
  }
  if (v.status === "active") {
    acts.push(actButton(primary, v.id, "switchOn", "Switch on for teams", "metric-mappings-switch-on-open", busy));
  }
  if (["draft", "needs_review", "active"].includes(v.status)) {
    acts.push(`<button class="plain-button" type="button" data-action="metric-mappings-preview-open" data-version-id="${escapeAttr(v.id)}" ${busy ? "disabled" : ""}>Check with a saved session</button>`);
    if (mayTransition(mapping, ctx)) acts.push(`<button class="plain-button ghost" type="button" data-action="metric-mappings-disable-open" data-version-id="${escapeAttr(v.id)}" ${busy ? "disabled" : ""}>Disable</button>`);
  }
  return `${notes.map((n) => `<p class="muted">${escapeHtml(n)}</p>`).join("")}${acts.length ? `<div class="metric-variables-actions">${acts.join("")}</div>` : ""}`;
}
function teamLabel(s, row) {
  const facts = bindingFacts(row.bindingId, s);
  const name = cleanName(facts?.teamName || teamNameOf(row.teamId, s));
  if (!name) return "A team that is no longer listed";
  if (row.bindingState === "ended") return `${name} — no longer linked to GPEXE`;
  return facts?.sourceTeamId ? `${name} — linked to GPEXE team ${cleanName(String(facts.sourceTeamId))}` : name;
}
function clubOfRow(s, row) {
  const team = s.org.teams.find((t) => t.id === row.teamId);
  return cleanName(team?.club_name);
}
function teamsHtml(s, mapping, v, ctx) {
  const t = s.teams;
  if (t.versionId !== v.id) return "";
  const rows = t.rows;
  const open = rows.filter((r) => !r.endedAt);
  const groupByClub = ctx.owner === "system";
  return `
    <div class="metric-mappings-teams">
      <h4>Teams</h4>
      ${t.loading ? `<p class="muted" role="status">Loading the teams...</p>` : ""}
      ${t.error ? `<div class="error" role="alert"><p>${escapeHtml(t.error)}</p></div>` : ""}
      ${!t.loading && !t.error && !open.length ? `<p class="muted">Active, but no team uses it yet.</p>` : ""}
      ${rows.length ? `<ul class="metric-mappings-team-list">${rows.map((row) => `
        <li class="metric-mappings-team-row">
          <span>${groupByClub && clubOfRow(s, row) ? `${escapeHtml(clubOfRow(s, row))} · ` : ""}${escapeHtml(teamLabel(s, row))}</span>
          <span class="muted">${escapeHtml(REQUIREMENT_LABEL[row.requirement] || row.requirement || "")} · ${row.endedAt ? `${escapeHtml(END_REASON_LABEL[row.endReason] || "Switched off")} ${escapeHtml(fmtDate(row.endedAt))}` : `since ${escapeHtml(fmtDate(row.activatedAt))}`}</span>
          ${row.endedAt ? "" : `<button class="plain-button ghost" type="button" data-action="metric-mappings-switch-off-open" data-activation-id="${escapeAttr(row.id)}" ${s.write || s.panel || s.detail.loading || t.loading ? "disabled" : ""}>Switch off</button>`}
        </li>`).join("")}</ul>` : ""}
      ${t.truncated ? `<p class="muted">More teams use this version than this screen lists.</p>` : ""}
      <button class="plain-button ghost" type="button" data-action="metric-mappings-teams-ended">${t.showEnded ? "Hide switched off" : "Show switched off"}</button>
    </div>`;
}

// The clubs read behind a club picker: loading, or failed with Try again.
function orgStateHtml(s) {
  if (s.org.error) return `<div class="error" role="alert"><p>${escapeHtml(s.org.error)}</p><button class="plain-button" type="button" data-action="metric-mappings-org-reload">Try again</button></div>`;
  if (!s.org.loaded) return `<p class="muted" role="status">Loading the clubs...</p>`;
  return "";
}
// The team chooser of switch on and of activate with teams (J16 6).
function chooserHtml(s, p, ctx, version) {
  const c = p.chooser;
  const locked = Boolean(s.write?.busy || s.write?.unconfirmed);
  const clubPicker = ctx.owner === "system" ? `${orgStateHtml(s)}
    <label class="search-field"><span>Club</span>
      <select data-mm-field="club" ${locked ? "disabled" : ""}>
        <option value="">Choose a club...</option>
        ${s.org.clubs.map((club) => `<option value="${escapeAttr(club.id)}" ${c.clubId === club.id ? "selected" : ""}>${escapeHtml(cleanName(club.name))}</option>`).join("")}
      </select>
    </label>` : "";
  const entry = c.clubId ? s.connections[c.clubId] : null;
  const groups = c.clubId ? chooserTeams(s, c, version) : [];
  const chosen = Object.keys(c.selected).length;
  return `
    ${clubPicker}
    ${entry?.loading ? `<p class="muted" role="status">Loading the club's GPEXE teams...</p>` : ""}
    ${entry?.error ? `<div class="error" role="alert"><p>${escapeHtml(entry.error)}</p></div>` : ""}
    ${entry?.loaded && !groups.length ? `<p class="muted">This club has no GPEXE teams linked yet.</p>` : ""}
    ${groups.map(({ connection, teams }) => `
      <fieldset class="metric-variables-fieldset"${p.errors?.teams ? ` aria-invalid="true"` : ""}>
        <legend>${escapeHtml(cleanName(connection.accountLabel || "GPEXE account"))} · ${escapeHtml(connection.hostLabel || "")}</legend>
        ${teams.length ? `<button class="plain-button ghost" type="button" data-action="metric-mappings-every-team" data-connection-id="${escapeAttr(connection.id)}" ${locked ? "disabled" : ""}>Every team of this connection</button>
        <p class="muted">Checks the teams listed now; a team linked later is never included.</p>` : ""}
        ${teams.map(({ team, choosable, reason, note }) => `
          <div class="metric-mappings-team-row">
            <label class="source-fields-choice"><input type="checkbox" data-mm-field="team" data-binding-id="${escapeAttr(team.bindingId)}" ${c.selected[team.bindingId] ? "checked" : ""} ${choosable && !locked ? "" : "disabled"}>
              <span>${escapeHtml(cleanName(team.teamName))} <span class="muted">— linked to GPEXE team ${escapeHtml(cleanName(String(team.sourceTeamId ?? "")))}</span></span></label>
            ${reason ? `<span class="metric-mappings-reason">${escapeHtml(reason)}</span>` : ""}
            ${note ? `<span class="muted">${escapeHtml(note)}</span>` : ""}
            ${c.selected[team.bindingId] && c.requirement ? `<select data-mm-field="teamRequirement" data-binding-id="${escapeAttr(team.bindingId)}" aria-label="Requirement for ${escapeAttr(cleanName(team.teamName))}" ${locked ? "disabled" : ""}>
              ${["required", "optional"].map((r) => `<option value="${r}" ${(c.perTeam[team.bindingId] || c.requirement) === r ? "selected" : ""}>${REQUIREMENT_LABEL[r]}</option>`).join("")}</select>` : ""}
          </div>`).join("")}
      </fieldset>`).join("")}
    ${p.errors?.teams ? `<span class="metric-variables-field-error">${escapeHtml(p.errors.teams)}</span>` : ""}
    ${p.capNote ? `<p class="muted">${escapeHtml(p.capNote)}</p>` : ""}
    ${chosen ? `
    <fieldset class="metric-variables-fieldset"${p.errors?.requirement ? ` aria-invalid="true"` : ""}>
      <legend>Required or Optional for the ${chosen === 1 ? "chosen team" : `${chosen} chosen teams`}?</legend>
      ${["required", "optional"].map((r) => `<label class="source-fields-choice"><input type="radio" name="mm-requirement" data-mm-field="requirement" value="${r}" ${c.requirement === r ? "checked" : ""} ${locked ? "disabled" : ""}><span>${REQUIREMENT_LABEL[r]}</span></label>`).join("")}
      <span class="muted">${escapeHtml(REQUIREMENT_MEANING)}</span>
      ${p.errors?.requirement ? `<span class="metric-variables-field-error">${escapeHtml(p.errors.requirement)}</span>` : ""}
    </fieldset>` : ""}`;
}
function reasonHtml(p, label, locked) {
  return `
    <label class="search-field"><span>${escapeHtml(label)}</span>
      <textarea data-mm-field="reason" rows="2" maxlength="${REASON_MAX}" ${locked ? "disabled" : ""}${p.errors?.reason ? ` aria-invalid="true" aria-describedby="mm-err-reason"` : ""}>${escapeHtml(p.reason || "")}</textarea>
      <span class="muted">For example: GPEXE totals are now used for this team. ${FREE_TEXT_NOTE}</span>
      ${p.errors?.reason ? `<span class="metric-variables-field-error" id="mm-err-reason">${escapeHtml(p.errors.reason)}</span>` : ""}
    </label>`;
}
// The review card of a change that names teams (J16 5.1, 6): the source, the
// mapping version, each team with its link and requirement.
function teamsReviewCardHtml(s, mapping, version, bindings, title) {
  const host = (() => {
    for (const b of bindings) { const f = bindingFacts(b.bindingId, s); if (f?.hostLabel) return f.hostLabel; }
    return "GPEXE";
  })();
  return `
    <div class="metric-mappings-review-card" tabindex="-1">
      <h4>${escapeHtml(title)}</h4>
      <dl class="metric-variables-facts">
        <div><dt>Source</dt><dd>${escapeHtml(cleanName(host))}</dd></div>
        <div><dt>Mapping version</dt><dd>${named(mapping.target?.label || "")} from ${named(mapping.sourceMetric?.label || "")}, version ${escapeHtml(String(version.versionNumber))}</dd></div>
      </dl>
      <ul class="metric-mappings-team-list">${bindings.map((b) => {
        const f = bindingFacts(b.bindingId, s);
        return `<li class="metric-mappings-team-row"><span>${named(f?.teamName || "a team")} — linked to GPEXE team ${escapeHtml(cleanName(String(f?.sourceTeamId ?? "")))}</span><span class="muted">${escapeHtml(REQUIREMENT_LABEL[b.requirement] || "")}</span></li>`;
      }).join("")}</ul>
      <p class="muted">${escapeHtml(REQUIREMENT_MEANING)}</p>
    </div>`;
}
function offListHtml(s, p, ctx) {
  if (p.loading) return `<p class="muted" role="status">Loading the teams it switches off...</p>`;
  if (p.error) return `<div class="error" role="alert"><p>${escapeHtml(p.error)}</p></div>`;
  const groupByClub = ctx.owner === "system";
  return `
    ${p.changed ? `<p class="metric-variables-field-note">${escapeHtml(p.changed)}</p>` : ""}
    ${p.rows.length ? `<p>${p.truncated ? "More than 1,000 teams use this version; all of them are switched off." : `It switches off ${p.rows.length === 1 ? "this team" : `these ${p.rows.length} teams`}:`}</p>
      <ul class="metric-mappings-team-list">${p.rows.map((row) => `
        <li class="metric-mappings-team-row"><span>${groupByClub && clubOfRow(s, row) ? `${escapeHtml(clubOfRow(s, row))} · ` : ""}${escapeHtml(teamLabel(s, row))}</span>
          ${p.kind === "replace" && p.keep ? (p.kept[row.bindingId] ? `<select data-mm-field="keptRequirement" data-binding-id="${escapeAttr(row.bindingId)}" aria-label="Requirement on the new version">
            ${["required", "optional"].map((r) => `<option value="${r}" ${p.kept[row.bindingId] === r ? "selected" : ""}>${REQUIREMENT_LABEL[r]} (kept)</option>`).join("")}</select>`
            : `<span class="muted">is switched off and not kept</span>`) : ""}
        </li>`).join("")}</ul>` : `<p class="muted">No team uses it now.</p>`}
    <p class="muted">Teams of archived clubs that use this version are switched off too; they are not listed.</p>`;
}
function panelHtml(s, mapping, ctx) {
  const p = s.panel;
  if (!p) return "";
  const version = (mapping.versions || []).find((v) => v.id === p.versionId) || null;
  const locked = Boolean(s.write?.busy || s.write?.unconfirmed);
  const close = `<button class="plain-button ghost" type="button" data-action="metric-mappings-panel-close" ${locked ? "disabled" : ""}>Cancel</button>`;
  const refused = p.refusedTeam ? `<p class="metric-variables-field-note" role="alert">${escapeHtml(`“${p.refusedTeam.name}” ${p.refusedTeam.text}, so nothing was saved.`)}</p>` : "";
  let inner = "";
  if (p.kind === "switchOn") {
    const bindings = chosenBindings(p.chooser);
    inner = p.review
      ? `${refused}${teamsReviewCardHtml(s, mapping, version, bindings, `Switch on for ${bindings.length === 1 ? "1 team" : `${bindings.length} teams`}`)}
         ${writeHtml(s)}
         ${s.write?.unconfirmed ? "" : `<div class="data-sources-form-actions">
           <button class="plain-button data-sources-primary" type="button" data-action="metric-mappings-confirm" ${locked || !bindings.length ? "disabled" : ""}>${p.refusedTeam ? `Switch on for the other ${bindings.length}` : `Switch on for ${bindings.length === 1 ? "1 team" : `${bindings.length} teams`}`}</button>
           <button class="plain-button ghost" type="button" data-action="metric-mappings-review-back" ${locked ? "disabled" : ""}>Back</button>${close}</div>`}`
      : `<h4>Switch on for teams</h4>${chooserHtml(s, p, ctx, version)}${reasonHtml(p, "Reason", locked)}
         <div class="data-sources-form-actions"><button class="plain-button data-sources-primary" type="button" data-action="metric-mappings-review" ${locked ? "disabled" : ""}>Review</button>${close}</div>`;
  } else if (p.kind === "activate") {
    const bindings = p.withTeams ? chosenBindings(p.chooser) : [];
    inner = p.review
      ? `${refused}${teamsReviewCardHtml(s, mapping, version, bindings, `Activate version ${version.versionNumber} and switch it on for ${bindings.length === 1 ? "1 team" : `${bindings.length} teams`}`)}
         ${writeHtml(s)}
         ${s.write?.unconfirmed ? "" : `<div class="data-sources-form-actions">
           <button class="plain-button data-sources-primary" type="button" data-action="metric-mappings-confirm" ${locked ? "disabled" : ""}>Activate and switch on</button>
           <button class="plain-button ghost" type="button" data-action="metric-mappings-review-back" ${locked ? "disabled" : ""}>Back</button>${close}</div>`}`
      : `<h4>Activate version ${escapeHtml(String(version?.versionNumber ?? ""))}</h4>
         <p class="muted">${ACTS_SENTENCE}</p>
         <label class="source-fields-choice"><input type="checkbox" data-mm-field="withTeams" ${p.withTeams ? "checked" : ""} ${locked ? "disabled" : ""}><span>Switch on for teams now</span></label>
         ${p.withTeams ? `${chooserHtml(s, p, ctx, version)}${reasonHtml(p, "Reason", locked)}` : ""}
         ${writeHtml(s)}
         ${s.write?.unconfirmed ? "" : `<div class="data-sources-form-actions">
           <button class="plain-button data-sources-primary" type="button" data-action="${p.withTeams ? "metric-mappings-review" : "metric-mappings-confirm"}" ${locked ? "disabled" : ""}>${p.withTeams ? "Review" : "Activate"}</button>${close}</div>`}`;
  } else if (p.kind === "replace" || p.kind === "disable") {
    const kept = p.kind === "replace" && p.keep ? Object.entries(p.kept).map(([bindingId, requirement]) => ({ bindingId, requirement })) : [];
    const title = p.kind === "replace" ? `Replace the active version with version ${version?.versionNumber ?? ""}` : `Disable version ${version?.versionNumber ?? ""}`;
    inner = `
      <h4>${escapeHtml(title)}</h4>
      ${p.kind === "disable" && p.status !== "active" ? "" : offListHtml(s, p, ctx)}
      ${p.kind === "replace" && !p.loading && !p.error ? `<label class="source-fields-choice"><input type="checkbox" data-mm-field="keep" ${p.keep ? "checked" : ""} ${locked || p.review ? "disabled" : ""}><span>Keep these teams on the new version</span></label>` : ""}
      ${refused}
      ${p.review && kept.length ? teamsReviewCardHtml(s, mapping, version, kept, `Replace and keep ${kept.length === 1 ? "1 team" : `${kept.length} teams`}`) : ""}
      ${p.review ? "" : reasonHtml(p, p.kind === "replace" ? "Reason for the replacement" : "Reason for disabling", locked)}
      ${writeHtml(s)}
      ${s.write?.unconfirmed ? "" : `<div class="data-sources-form-actions">
        ${p.review
          ? `<button class="plain-button data-sources-primary" type="button" data-action="metric-mappings-confirm" ${locked || p.loading || p.error ? "disabled" : ""}>${p.kind === "disable" ? "Disable" : p.refusedTeam ? `Replace without keeping ${escapeHtml(p.refusedTeam.name)}` : kept.length ? `Replace and keep ${kept.length === 1 ? "1 team" : `${kept.length} teams`}` : "Replace"}</button>
             <button class="plain-button ghost" type="button" data-action="metric-mappings-review-back" ${locked ? "disabled" : ""}>Back</button>`
          : `<button class="plain-button data-sources-primary" type="button" data-action="metric-mappings-review" ${locked || p.loading || p.error ? "disabled" : ""}>Review</button>`}
        ${close}</div>`}`;
  } else if (p.kind === "switchOff") {
    const row = s.teams.rows.find((r) => r.id === p.activationId);
    inner = `
      <h4>Switch off ${escapeHtml(row ? teamLabel(s, row) : "this team")}</h4>
      ${reasonHtml(p, "Reason", locked)}
      ${writeHtml(s)}
      ${s.write?.unconfirmed ? "" : `<div class="data-sources-form-actions"><button class="plain-button data-sources-primary" type="button" data-action="metric-mappings-review" ${locked ? "disabled" : ""}>Switch off</button>${close}</div>`}`;
  } else if (p.kind === "preview") {
    inner = previewHtml(s, p, ctx, version);
  }
  return `<div class="metric-mappings-panel" role="group" aria-label="${escapeAttr(p.kind)}">${inner}</div>`;
}
function previewHtml(s, p, ctx, version) {
  const entry = p.clubId ? s.connections[p.clubId] : null;
  const teams = (entry?.connections || []).flatMap((c) => (c.boundTeams || []).filter((t) => t.teamActive !== false));
  const chosen = p.candidates.find((c) => c.id === p.candidateId) || null;
  const result = p.result;
  const recheck = p.recheck;
  const marked = recheck ? recheck.marked : chosen ? notForImport(chosen) : false;
  const level = (name, l) => (!l ? "" : `
    <div><dt>${name}</dt><dd>${escapeHtml(`${l.athletesWithValue} athletes have a value`)}${l.min === null
      ? `<br><span class="muted">Fewer than 3 athletes have a value, so no range is shown.</span>`
      : `<br>${escapeHtml(`${l.min}–${l.max} ${result.sourceUnit}`)} · ${escapeHtml(`${l.minCanonical}–${l.maxCanonical} ${result.targetUnit}`)}`}</dd></div>`);
  return `
    <h4>Check version ${escapeHtml(String(version?.versionNumber ?? ""))} with a saved session</h4>
    ${ctx.owner === "system" ? `${orgStateHtml(s)}
      <label class="search-field"><span>Club</span>
        <select data-mm-field="previewClub"><option value="">Choose a club...</option>
          ${s.org.clubs.map((club) => `<option value="${escapeAttr(club.id)}" ${p.clubId === club.id ? "selected" : ""}>${escapeHtml(cleanName(club.name))}</option>`).join("")}</select>
      </label>` : ""}
    ${entry?.loading ? `<p class="muted" role="status">Loading the club's GPEXE teams...</p>` : ""}
    ${entry?.error ? `<div class="error" role="alert"><p>${escapeHtml(entry.error)}</p></div>` : ""}
    ${p.clubId && entry?.loaded ? `
      <label class="search-field"><span>Team</span>
        <select data-mm-field="previewTeam"><option value="">Choose a team...</option>
          ${teams.map((t) => `<option value="${escapeAttr(t.teamId)}" ${p.teamId === t.teamId ? "selected" : ""}>${escapeHtml(cleanName(t.teamName))}</option>`).join("")}</select>
      </label>` : ""}
    ${p.candidatesLoading ? `<p class="muted" role="status">Loading the saved sessions...</p>` : ""}
    ${p.candidatesError ? `<div class="error" role="alert"><p>${escapeHtml(p.candidatesError)}</p></div>` : ""}
    ${p.teamId && !p.candidatesLoading && !p.candidatesError ? (p.candidates.length ? `
      <fieldset class="metric-variables-fieldset"><legend>Saved session</legend>
        ${p.candidates.map((c) => {
          const gone = c.snapshot && c.snapshot.available === false;
          return `<label class="source-fields-choice"><input type="radio" name="mm-candidate" data-mm-field="previewCandidate" value="${escapeAttr(c.id)}" ${p.candidateId === c.id ? "checked" : ""} ${gone ? "disabled" : ""}>
            <span>${escapeHtml(cleanName(c.label) || "GPEXE session")} <span class="muted">${escapeHtml(fmtDate(c.sessionStartedAt))}</span>
            ${notForImport(c) ? `<span class="item-badge is-warning">${escapeHtml(notForImportBadge(c))}</span>` : ""}
            ${gone ? `<span class="muted">Find this session again in Imports.</span>` : ""}</span></label>`;
        }).join("")}
      </fieldset>
      ${chosen && notForImport(chosen) ? `<p class="metric-variables-field-note">${escapeHtml(NOT_FOR_IMPORT_SENTENCE)}</p>` : ""}
      <div class="data-sources-form-actions"><button class="plain-button data-sources-primary" type="button" data-action="metric-mappings-preview-run" ${!p.candidateId || p.loading ? "disabled" : ""}>${p.loading ? "Checking..." : "Check"}</button>
        <button class="plain-button ghost" type="button" data-action="metric-mappings-panel-close">Close</button></div>` : `<p class="muted">This team has no saved sessions.</p>`) : ""}
    ${p.error ? `<div class="error" role="alert"><p>${escapeHtml(p.error)}</p>${p.errorCode ? `<details class="data-sources-tech"><summary>Technical details</summary><dl><div><dt>Code</dt><dd>${escapeHtml(p.errorCode)}</dd></div></dl></details>` : ""}</div>` : ""}
    ${result ? `
      <div class="metric-mappings-review-card">
        ${marked ? `<p class="metric-variables-field-note"><span class="item-badge is-warning">${escapeHtml(notForImportBadge(recheck?.candidate || chosen))}</span> ${escapeHtml(NOT_FOR_IMPORT_SENTENCE)}</p>` : ""}
        ${recheck?.state === "failed" ? `<p class="muted">Could not be checked again.</p>` : ""}
        <dl class="metric-variables-facts">${level("Session", result.levels?.session)}${level("Drill", result.levels?.drill)}</dl>
        <p class="muted">Nothing is saved; no athlete is shown.</p>
      </div>` : ""}
    ${!p.teamId || p.candidatesLoading || p.candidatesError ? `<div class="data-sources-form-actions"><button class="plain-button ghost" type="button" data-action="metric-mappings-panel-close">Close</button></div>` : ""}`;
}
function renderDetailHtml(s, ctx) {
  const d = s.detail;
  const back = `<button class="plain-button ghost metric-variables-back" type="button" data-action="metric-mappings-back">← All mappings</button>`;
  const mapping = d.mapping;
  if (!mapping) {
    if (d.loading) return `${back}<p class="muted" role="status">Loading the mapping...</p>`;
    return `${back}${noticeHtml(s)}${d.error ? `<div class="error" role="alert"><p>${escapeHtml(d.error)}</p><button class="plain-button" type="button" data-action="metric-mappings-detail-reload">Try again</button></div>` : `<p class="empty">This mapping is not available.</p>`}`;
  }
  const primary = primaryAct(s, mapping, ctx);
  const versions = mapping.versions || [];
  return `
    ${back}
    <div class="metric-variables-head">
      <div>
        <h2 id="metric-mappings-title" tabindex="-1">${escapeHtml(mapping.target?.label || "")} ${ownerBadge(mapping, ctx)}</h2>
        <p class="muted">from ${escapeHtml(mapping.sourceMetric?.label || "")} · ${escapeHtml(sourceOfMapping(s, mapping))}</p>
        <p class="muted">${ACTS_SENTENCE}</p>
      </div>
      ${inOwnerWorkspace(mapping, ctx) ? `<button class="plain-button" type="button" data-action="metric-mappings-new-version" ${s.write || s.panel || d.loading ? "disabled" : ""}>New version</button>` : ""}
    </div>
    ${noticeHtml(s)}
    ${s.panel ? "" : writeHtml(s)}
    ${d.error ? `<div class="error" role="alert"><p>${escapeHtml(d.error)} The mapping below may be out of date.</p><button class="plain-button" type="button" data-action="metric-mappings-detail-reload">Try again</button></div>` : ""}
    ${panelHtml(s, mapping, ctx)}
    <h3>Versions</h3>
    ${versions.length ? `<ol class="metric-variables-versions">${versions.map((v) => `
      <li class="metric-variables-version">
        <div class="source-fields-revision-head"><strong>Version ${escapeHtml(String(v.versionNumber))}</strong> <span class="item-badge">${escapeHtml(STATUS_LABEL[v.status] || v.status)}</span></div>
        ${versionFactsHtml(s, mapping, v)}
        ${versionActsHtml(s, mapping, v, ctx, primary)}
        ${v.status === "active" ? teamsHtml(s, mapping, v, ctx) : ""}
      </li>`).join("")}</ol>` : `<p class="muted">No version yet. Use New version to make one.</p>`}
    ${d.nextCursor ? `<button class="plain-button" type="button" data-action="metric-mappings-versions-more" ${d.loadingMore ? "disabled" : ""}>${d.loadingMore ? "Loading..." : "Load more versions"}</button>` : ""}
    <details class="data-sources-tech"><summary>Technical details</summary><dl>
      <div><dt>Mapping id</dt><dd>${escapeHtml(mapping.id)}</dd></div>
      <div><dt>Field key</dt><dd>${escapeHtml(mapping.sourceMetric?.key || "")}</dd></div>
      <div><dt>Data family</dt><dd>${escapeHtml(mapping.sourceMetric?.apiFamily || "")}</dd></div>
      ${versions.map((v) => `<div><dt>Version ${escapeHtml(String(v.versionNumber))}</dt><dd>${escapeHtml(v.id)} · ×${escapeHtml(`${v.scale}/${v.scaleDivisor}`)}${v.offset && String(v.offset) !== "0" ? ` + ${escapeHtml(v.offset)}` : ""} · ${escapeHtml(v.parameterFingerprint || "")}</dd></div>`).join("")}
    </dl></details>
  `;
}

// The start screen's card count (J16 3).
export function mappingsCardSummary(list) {
  if (list.error) return "Could not be loaded. Open to try again.";
  if (!list.loaded) return list.loading ? "Loading..." : "Open";
  const n = list.items.length;
  if (!n) return "No mappings yet";
  return list.nextCursor ? `More than ${n} mappings` : `${n} ${n === 1 ? "mapping" : "mappings"}`;
}
