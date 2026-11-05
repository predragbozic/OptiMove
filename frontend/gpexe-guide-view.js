// U4 (J19): the five-step setup guide of the Imports screen, markup side. Pure
// functions of the Imports state; every name is escaped; no id is shown.
import { escapeHtml } from "./utils.js";
import { guideSteps } from "./gpexe-guide-steps.js";
import { guideAdmin, refusalSentence } from "./gpexe-guide-data.js";

const STATE_WORD = { done: "Done", next: "Next", waiting: "Waiting", running: "In progress", unknown: "Could not be checked", attention: "Needs you", none: "Nothing to switch on" };
const ACTION_NAME = { check: "training-load-gpexe-check", link: "training-load-gpexe-map-open", retry: "training-load-gpexe-guide-reload" };
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
    skipped: g.skipped || [],
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
  if (w?.done) {
    return `<div class="gpexe-link-confirm gpexe-guide-confirm" role="status">
      <p><strong>${escapeHtml(plural(w.results.length, "OptiMove variable is", "OptiMove variables are"))} switched on.</strong></p>
      <p class="muted">Imports use ${w.results.length === 1 ? "it" : "them"} from the next Find new sessions.</p>
      <div class="gpexe-link-actions"><button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-guide-vars-close">Close</button></div>
    </div>`;
  }
  if (w?.refused) {
    return `<div class="gpexe-link-confirm gpexe-guide-confirm" role="alert">
      <p><strong>Stopped</strong></p>
      <p>${escapeHtml(refusalSentence(w.refused, w.results.length))}</p>
      <div class="gpexe-link-actions"><button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-guide-vars-close">Close</button></div>
    </div>`;
  }
  const items = w?.items || g.vars.items;
  const sending = Boolean(w?.sending);
  return `<div class="gpexe-link-confirm gpexe-guide-confirm" role="group" aria-label="Switch on OptiMove variables">
    <p><strong>Switch on ${escapeHtml(plural(items.length, "OptiMove variable", "OptiMove variables"))}?</strong></p>
    <p class="muted">For ${team ? `${escapeHtml(team)}, ` : "this team, "}read from GPEXE${g.conn.hostLabel ? ` (${escapeHtml(g.conn.hostLabel)})` : ""}. If GPEXE has no value for a linked athlete, only that value is left out. Imports use these variables from the next Find new sessions.</p>
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
  const rowList = steps.map((s) => `<li class="gpexe-guide-step gpexe-guide-${escapeHtml(s.state)}"><span class="gpexe-guide-num" aria-hidden="true">${s.merged ? "1-2" : s.id}</span><div class="gpexe-guide-body"><strong>${escapeHtml(s.title)}</strong> <span class="gpexe-guide-state muted">${escapeHtml(STATE_WORD[s.state] || "")}</span>${s.text ? `<p class="muted">${escapeHtml(s.text)}</p>` : ""}${s.action ? `<button type="button" class="${s.action.kind === "retry" ? "plain-button" : "primary-button"} gpexe-button" data-action="${ACTION_NAME[s.action.kind]}" ${gx.checkStarting || (s.action.kind === "retry" && g.conn.status === "loading") ? "disabled" : ""}>${escapeHtml(s.action.label)}</button>` : ""}</div></li>`)
  let variablesHtml = "";
  if (variables) {
    const names = variables.skipped.map((x) => x.label).join(", ");
    const text = variables.state === "done" ? "OptiMove variables are switched on for this team."
      : variables.state === "none" ? "No OptiMove variables are available to switch on yet."
        : variables.state === "unknown" ? "Could not be checked."
          : variables.state === "waiting" ? "Checking..."
            : variables.state === "attention" ? "No other variable is left to switch on."
              : `${plural(variables.total, "OptiMove variable is", "OptiMove variables are")} not switched on for this team yet.`;
    const skippedLine = variables.skipped.length ? `<p class="muted">${escapeHtml(plural(variables.skipped.length, "variable was", "variables were"))} not accepted: ${escapeHtml(names)}. Switch ${variables.skipped.length === 1 ? "it" : "them"} on in Training Load > Data configuration > Mappings.</p>` : "";
    const purpose = variables.state === "next" ? `<p class="muted">These decide which numbers (for example distance) are taken from GPEXE.</p>` : "";
    variablesHtml = `<li class="gpexe-guide-step gpexe-guide-${escapeHtml(variables.state)}"><span class="gpexe-guide-num" aria-hidden="true">+</span><div class="gpexe-guide-body"><strong>Use OptiMove variables</strong> <span class="gpexe-guide-state muted">${escapeHtml(STATE_WORD[variables.state] || "")}</span><p class="muted">${escapeHtml(text)}</p>${skippedLine}${purpose}${variables.state === "next" && !g.confirm && !g.write ? `<button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-guide-vars-open" ${variables.canSwitchOn && !busy ? "" : "disabled"}>Review and switch on</button>` : ""}${g.confirm || g.write ? confirmHtml(gx) : ""}</div></li>`;
  }
  // The variables come right after the two connection steps: imports use them from the next search.
  const at = steps.findIndex((x) => x.id === 2 || x.merged);
  const rows = [...rowList.slice(0, at + 1), ...(variablesHtml ? [variablesHtml] : []), ...rowList.slice(at + 1)].join("");
  return `<section class="gpexe-guide" aria-label="GPEXE setup"><div class="gpexe-guide-head"><h3>Set up GPEXE imports</h3>${allDone ? `<button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-guide-toggle">Hide setup</button>` : ""}</div><ul class="gpexe-guide-list">${rows}</ul></section>`;
}
