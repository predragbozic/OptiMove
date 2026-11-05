// U4 (J19): the five-step setup guide of the Imports screen, markup side. Pure
// functions of the Imports state; every name is escaped; no id is shown.
import { escapeHtml } from "./utils.js";
import { guideSteps } from "./gpexe-guide-steps.js";
import { guideAdmin, refusalSentence } from "./gpexe-guide-data.js";

const STATE_WORD = { done: "Done", next: "Next", waiting: "Waiting", running: "In progress", unknown: "Could not be checked" };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function guideFacts(gx, status) {
  const g = gx.guide || {};
  return {
    admin: guideAdmin(gx),
    conn: g.conn,
    check: gx.check || status?.lastCheck || null,
    candidates: gx.candidates,
    sourceAthletes: gx.sourceAthletes,
    sourceAthletesError: gx.sourceAthletesError,
    links: gx.links,
    teamSwitch: status?.teamImportSwitch || null,
    vars: g.vars || null,
  };
}

function confirmHtml(gx) {
  const g = gx.guide;
  const w = g.write;
  const team = (gx.teamName || "").trim();
  if (w?.unknown) {
    return `<div class="gpexe-link-confirm gpexe-guide-confirm" role="group" aria-label="Result not confirmed">
      <p><strong>Result not confirmed</strong></p>
      <p>The answer for ${escapeHtml(w.unknown.label)} did not arrive, so it may or may not be on. ${w.results.length ? `${escapeHtml(plural(w.results.length, "variable is", "variables are"))} on before it. ` : ""}Check result asks again with the same request; nothing else is switched on until then.</p>
      <div class="gpexe-link-actions"><button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-guide-vars-check">Check result</button></div>
    </div>`;
  }
  if (w?.refused) {
    return `<div class="gpexe-link-confirm gpexe-guide-confirm" role="alert">
      <p><strong>Stopped</strong></p>
      <p>${escapeHtml(refusalSentence(w.refused))}</p>
      ${w.results.length ? `<p class="muted">${escapeHtml(plural(w.results.length, "variable is", "variables are"))} on.</p>` : ""}
      <div class="gpexe-link-actions"><button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-guide-vars-close">Close</button></div>
    </div>`;
  }
  const items = w?.items || g.vars.items;
  const sending = Boolean(w?.sending);
  return `<div class="gpexe-link-confirm gpexe-guide-confirm" role="group" aria-label="Switch on OptiMove variables">
    <p><strong>Switch on ${escapeHtml(plural(items.length, "OptiMove variable", "OptiMove variables"))}?</strong></p>
    <p class="muted">For ${team ? `${escapeHtml(team)}, ` : "this team, "}read from GPEXE${g.conn.hostLabel ? ` (${escapeHtml(g.conn.hostLabel)})` : ""}. Required: if GPEXE has no value for a linked athlete, only that value is left out. Imports use these variables from the next Find new sessions.</p>
    <ul class="gpexe-guide-vars">${items.map((i, n) => `<li>${escapeHtml(i.label)}${sending && w.results.length > n ? ` <span class="muted">· on</span>` : ""}</li>`).join("")}</ul>
    ${sending ? `<p class="muted" role="status">Switching on ${escapeHtml(String(Math.min(w.results.length + 1, items.length)))} of ${escapeHtml(String(items.length))}...</p>` : ""}
    <div class="gpexe-link-actions">
      <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-guide-vars-cancel" ${sending ? "disabled" : ""}>Back</button>
      <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-guide-vars-send" ${sending ? "disabled" : ""}>${sending ? "Switching on..." : `Switch on ${escapeHtml(plural(items.length, "variable", "variables"))}`}</button>
    </div>
  </div>`;
}

export function renderGuideHtml(gx, status) {
  if (!gx.guide || !status) return "";
  const facts = guideFacts(gx, status);
  const { steps, variables, allDone } = guideSteps(facts);
  const g = gx.guide;
  const busy = Boolean(g.write?.sending || g.write?.unknown);
  const folded = allDone && g.open !== true && !g.confirm && !busy;
  if (folded) {
    return `<section class="gpexe-guide gpexe-guide-folded" aria-label="GPEXE setup"><p><strong>GPEXE setup is complete.</strong></p><button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-guide-toggle">Show setup</button></section>`;
  }
  const rows = steps.map((s) => `<li class="gpexe-guide-step gpexe-guide-${escapeHtml(s.state)}"><span class="gpexe-guide-num" aria-hidden="true">${s.merged ? "1-2" : s.id}</span><div class="gpexe-guide-body"><strong>${escapeHtml(s.title)}</strong> <span class="gpexe-guide-state muted">${escapeHtml(STATE_WORD[s.state] || "")}</span>${s.text ? `<p class="muted">${escapeHtml(s.text)}</p>` : ""}${s.action ? `<button type="button" class="${s.action.kind === "link" || s.action.kind === "check" ? "primary-button" : "plain-button"} gpexe-button" data-action="${s.action.kind === "check" ? "training-load-gpexe-check" : "training-load-gpexe-map-open"}" ${gx.checkStarting ? "disabled" : ""}>${escapeHtml(s.action.label)}</button>` : ""}</div></li>`).join("");
  let variablesHtml = "";
  if (variables) {
    const text = variables.state === "done" ? (variables.onCount ? "OptiMove variables are switched on for this team." : "No OptiMove variables are available to switch on yet.")
      : variables.state === "unknown" ? "Could not be checked."
        : variables.state === "waiting" ? "Checking..."
          : `${plural(variables.total, "OptiMove variable is", "OptiMove variables are")} not switched on for this team yet.`;
    variablesHtml = `<li class="gpexe-guide-step gpexe-guide-${escapeHtml(variables.state)}"><span class="gpexe-guide-num" aria-hidden="true">+</span><div class="gpexe-guide-body"><strong>Use OptiMove variables</strong> <span class="gpexe-guide-state muted">${escapeHtml(STATE_WORD[variables.state] || "")}</span><p class="muted">${escapeHtml(text)}</p>${variables.state === "next" && !g.confirm ? `<button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-guide-vars-open" ${variables.canSwitchOn && !busy ? "" : "disabled"}>Use OptiMove variables</button>` : ""}${g.confirm || g.write ? confirmHtml(gx) : ""}</div></li>`;
  }
  return `<section class="gpexe-guide" aria-label="GPEXE setup"><div class="gpexe-guide-head"><h3>Set up GPEXE imports</h3>${allDone ? `<button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-guide-toggle">Hide setup</button>` : ""}</div><ul class="gpexe-guide-list">${rows}${variablesHtml}</ul></section>`;
}
