// U4 (J19): the five-step setup guide of the Imports screen, markup side. Pure
// functions of the Imports state; every name is escaped; no id is shown.
import { escapeHtml } from "./utils.js";
import { guideSteps } from "./gpexe-guide-steps.js";
import { guideAdmin, refusalSentence } from "./gpexe-guide-data.js";
import { gpexeTeamOptions } from "./gpexe-import-data.js";

// The team's name from the organization read (never an id); "" when it is not known.
function guideTeamName(gx) {
  return gpexeTeamOptions().find((t) => String(t.id) === String(gx.teamId))?.name || "";
}

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
    suggestions: gx.suggestions || null,
    identityLoad: status?.viewer?.identityLoad === true,
    teamName: guideTeamName(gx),
    switchData: gx.teamSwitch?.data || null,
  };
}

function confirmHtml(gx) {
  const g = gx.guide;
  const w = g.write;
  const team = guideTeamName(gx).trim();
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

function variablesBodyHtml(gx, variables, busy) {
  const g = gx.guide;
  const names = variables.skipped.map((x) => x.label).join(", ");
  const text = variables.state === "done" ? "OptiMove variables are switched on for this team."
    : variables.state === "none" ? "No OptiMove variables are available to switch on yet."
      : variables.state === "unknown" ? "Could not be checked."
        : variables.state === "waiting" ? (g.vars.status === "loading" ? "Checking..." : "Waiting for steps 1 and 2.")
          : variables.state === "attention" ? "No other variable is left to switch on."
            : `${plural(variables.total, "OptiMove variable is", "OptiMove variables are")} not switched on for this team yet.`;
  const skippedLine = variables.skipped.length ? `<p class="muted">${escapeHtml(plural(variables.skipped.length, "variable was", "variables were"))} not accepted: ${escapeHtml(names)}. Switch ${variables.skipped.length === 1 ? "it" : "them"} on in Training Load > Data configuration > Mappings.</p>` : "";
  const purpose = variables.state === "next" ? `<p class="muted">These decide which numbers (for example distance) are taken from GPEXE.</p>` : "";
  const offer = variables.state === "next" && !g.confirm && !g.write;
  const primary = offer ? `<button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-guide-vars-open" ${variables.canSwitchOn && !busy ? "" : "disabled"}>Use the OptiMove GPEXE set</button>` : "";
  // S5: "Choose my own" is the Mappings screen until the J18 board exists.
  const own = variables.state !== "waiting" && variables.state !== "unknown" && !g.confirm && !g.write
    ? `<button type="button" class="plain-button gpexe-button" data-action="training-load-section" data-section="mappings" ${busy ? "disabled" : ""}>Choose my own</button>` : "";
  const actions = primary || own ? `<div class="gpexe-guide-actions">${primary}${own}</div>` : "";
  return `<p class="muted">${escapeHtml(text)}</p>${skippedLine}${purpose}${actions}${g.confirm || g.write ? confirmHtml(gx) : ""}`;
}

function athletesExtraHtml(step) {
  const p = step.pairs;
  if (!p) return "";
  const lines = [];
  if (p.exact > 0) lines.push(`${plural(p.exact, "athlete matches", "athletes match")} by name and date of birth.`);
  if (p.choice > 0 && p.status === "ready" && !p.namesMissing) lines.push(`${plural(p.choice, "athlete needs", "athletes need")} your choice.`);
  if (p.namesMissing) lines.push(p.canLoadNames ? "Load the GPEXE names and dates of birth in Link athletes, and OptiMove suggests the matches." : "An administrator can load the GPEXE names and dates of birth, so that OptiMove suggests the matches.");
  return lines.map((l) => `<p class="muted">${escapeHtml(l)}</p>`).join("");
}

function checklistHtml(step) {
  if (!Array.isArray(step.checklist)) return "";
  return `<ul class="gpexe-guide-checklist">${step.checklist.map((c) => `<li class="${c.ok ? "gpexe-guide-ok" : "gpexe-guide-open"}"><span aria-hidden="true">${c.ok ? "\u2713" : "\u25cb"}</span> ${escapeHtml(c.text)}<span class="visually-hidden">${c.ok ? " (done)" : " (not yet)"}</span></li>`).join("")}</ul>`;
}

// The step shown open: the person's choice, else the first step that is not done (a write in the variables step keeps it open).
export function currentGuideStep(steps, g) {
  if (g?.confirm || g?.write) return 3;
  const ids = steps.map((s) => s.id);
  if (g?.step && ids.includes(g.step)) return g.step;
  return (steps.find((s) => s.state !== "done") || steps[steps.length - 1]).id;
}

export function renderGuideHtml(gx, status) {
  if (!gx.guide || !status) return "";
  const facts = guideFacts(gx, status);
  const { steps, variables, allDone } = guideSteps(facts);
  const g = gx.guide;
  const busy = Boolean(g.write?.sending || g.write?.unknown);
  const folded = allDone && g.open !== true && !g.confirm && !g.write && !busy;
  if (folded) {
    return `<section class="gpexe-guide gpexe-guide-folded" aria-label="GPEXE setup"><p><strong>GPEXE is set up <span aria-hidden="true">\u2713</span></strong></p><button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-guide-toggle">Show setup</button></section>`;
  }
  const current = currentGuideStep(steps, g);
  const rows = steps.map((s) => {
    const num = s.merged ? "1-3" : String(s.id);
    const label = `${escapeHtml(s.title)}`;
    const word = escapeHtml(STATE_WORD[s.state] || "");
    if (s.id !== current) {
      return `<li class="gpexe-guide-step gpexe-guide-collapsed gpexe-guide-${escapeHtml(s.state)}"><button type="button" class="gpexe-guide-head-button" data-action="training-load-gpexe-guide-step" data-step="${s.id}" aria-expanded="false" ${busy || g.confirm || g.write ? "disabled" : ""}><span class="gpexe-guide-num" aria-hidden="true">${s.state === "done" ? "\u2713" : escapeHtml(num)}</span><strong>${label}</strong> <span class="gpexe-guide-state muted">${word}</span></button></li>`;
    }
    const body = s.id === 3 && variables ? variablesBodyHtml(gx, variables, busy)
      : `${s.text ? `<p class="muted">${escapeHtml(s.text)}</p>` : ""}${s.id === 4 ? athletesExtraHtml(s) : ""}${checklistHtml(s)}${s.action ? `<button type="button" class="${s.action.kind === "retry" ? "plain-button" : "primary-button"} gpexe-button" data-action="${ACTION_NAME[s.action.kind]}" ${gx.checkStarting || (s.action.kind === "retry" && g.conn.status === "loading") ? "disabled" : ""}>${escapeHtml(s.action.label)}</button>` : ""}`;
    return `<li class="gpexe-guide-step gpexe-guide-current gpexe-guide-${escapeHtml(s.state)}" aria-current="step"><span class="gpexe-guide-num" aria-hidden="true">${escapeHtml(num)}</span><div class="gpexe-guide-body"><strong>${label}</strong> <span class="gpexe-guide-state muted">${word}</span>${body}</div></li>`;
  }).join("");
  return `<section class="gpexe-guide" aria-label="GPEXE setup"><div class="gpexe-guide-head"><h3>Set up GPEXE imports</h3>${allDone ? `<button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-guide-toggle">Hide setup</button>` : ""}</div><ul class="gpexe-guide-list">${rows}</ul></section>`;
}
